/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF, env } from "cloudflare:test";
import { beforeAll, it, expect } from "vitest";
import { schemaSql } from "./schema-sql";

const H = { "X-API-Key": "test-key", "Content-Type": "application/json" };
const call = (p: string, init?: RequestInit) => SELF.fetch("http://x" + p, init);
const post = (username: string) =>
  call("/api/v1/userlist", { method: "POST", headers: H, body: JSON.stringify({ username }) });
const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  await env.DB.exec(schemaSql);
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
});

it("401 without or with wrong key", async () => {
  expect((await call("/api/v1/userlist")).status).toBe(401);
  expect((await call("/api/v1/userlist", { headers: { "X-API-Key": "wrong" } })).status).toBe(401);
});

it("many inboxes coexist: create alice + bob, duplicate username 409, list shows both", async () => {
  const r1 = await post("Alice");
  expect(r1.status).toBe(201);
  const b1 = (await r1.json()) as { address: string; ttl_seconds: number };
  expect(b1.address).toBe("alice@mail.example.com");
  expect(b1.ttl_seconds).toBe(86400);

  const r2 = await post("bob");
  expect(r2.status).toBe(201);
  expect(((await r2.json()) as { address: string }).address).toBe("bob@mail.example.com");

  // same username while its inbox is live -> 409 with the existing address
  const dup = await post("alice");
  expect(dup.status).toBe(409);
  const dupBody = (await dup.json()) as { error: string; address: string };
  expect(dupBody.error).toBe("user_exists");
  expect(dupBody.address).toBe("alice@mail.example.com");

  const list = (await (await call("/api/v1/userlist", { headers: H })).json()) as {
    username: string;
    message_count: number;
  }[];
  expect(list.map((i) => i.username).sort()).toEqual(["alice", "bob"]);
  expect(list.every((i) => i.message_count === 0)).toBe(true);

  const g = (await (await call("/api/v1/user/alice", { headers: H })).json()) as { username: string };
  expect(g.username).toBe("alice");
});

it("message endpoints scope to the named inbox only", async () => {
  const t = now();
  expect((await post("carol")).status).toBe(201);
  expect((await post("dave")).status).toBe(201);
  const idOf = async (u: string) =>
    (await env.DB.prepare("SELECT id FROM inboxes WHERE username = ?").bind(u).first<{ id: number }>())!.id;
  const daveId = await idOf("dave");
  const carolId = await idOf("carol");
  const seed = (inboxId: number, addr: string, subject: string) =>
    env.DB
      .prepare(
        "INSERT INTO messages (inbox_id, sender, recipient, subject, text, html, received_at, expires_at, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(inboxId, "s@x.y", addr, subject, "t", null, t, t + 86400, 0)
      .run();
  await seed(daveId, "dave@mail.example.com", "hi");
  await seed(carolId, "carol@mail.example.com", "yo");

  const daveList = (await (await call("/api/v1/user/dave/messages", { headers: H })).json()) as {
    id: number;
    subject: string;
  }[];
  expect(daveList).toHaveLength(1);
  expect(daveList[0]!.subject).toBe("hi");
  const msgId = daveList[0]!.id;
  expect(await (await call("/api/v1/user/alice/messages", { headers: H })).json()).toEqual([]);

  // message id belongs to dave: via alice -> 404, via dave -> 200
  expect((await call(`/api/v1/user/alice/messages/${msgId}`, { headers: H })).status).toBe(404);
  expect((await call(`/api/v1/user/dave/messages/${msgId}`, { headers: H })).status).toBe(200);

  // delete via alice must NOT touch dave's message (inbox_id scoping)
  expect((await call(`/api/v1/user/alice/messages/${msgId}`, { method: "DELETE", headers: H })).status).toBe(204);
  expect((await call(`/api/v1/user/dave/messages/${msgId}`, { headers: H })).status).toBe(200);
  // delete via the owning inbox works, idempotent second delete still 204
  expect((await call(`/api/v1/user/dave/messages/${msgId}`, { method: "DELETE", headers: H })).status).toBe(204);
  expect((await call(`/api/v1/user/dave/messages/${msgId}`, { method: "DELETE", headers: H })).status).toBe(204);

  // DELETE all messages empties only the named inbox
  expect((await call("/api/v1/user/dave/messages", { method: "DELETE", headers: H })).status).toBe(204);
  expect(await (await call("/api/v1/user/dave/messages", { headers: H })).json()).toEqual([]);
  const carolList = (await (await call("/api/v1/user/carol/messages", { headers: H })).json()) as unknown[];
  expect(carolList).toHaveLength(1);
});

it("error contract: 400 invalid username, 422 bad json, 404 unknown inbox, 405 bad method", async () => {
  const r = await post("a..b");
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toBe("invalid_username");
  const r2 = await call("/api/v1/userlist", { method: "POST", headers: H, body: "{oops" });
  expect(r2.status).toBe(422);
  expect((await call("/api/v1/user/nobody/messages", { headers: H })).status).toBe(404);
  // an invalid username in the path can never name an inbox -> 404, not 400
  expect((await call("/api/v1/user/a..b/messages", { headers: H })).status).toBe(404);
  expect((await call("/api/v1/user/alice/messages/999999", { headers: H })).status).toBe(404);
  expect((await call("/api/v1/user/alice", { method: "PATCH", headers: H })).status).toBe(405);
  expect((await call("/api/v1/userlist", { method: "PATCH", headers: H })).status).toBe(405);
});

it("stale inbox self-heals per username on POST without touching other inboxes", async () => {
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  const past = now() - 86401;
  const seedInbox = (username: string, created: number, expires: number) =>
    env.DB
      .prepare("INSERT INTO inboxes (username, address, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(username, `${username}@mail.example.com`, created, expires)
      .run();
  // live neighbour that must survive the self-heal, plus another expired row
  await seedInbox("stale", past - 86400, past); // expired row still in DB (cron lag)
  await seedInbox("keep", past, past + 86400 * 2); // live: expires ~now+86399
  await seedInbox("dead2", past - 86400, past - 1); // expired
  const oldRow = await env.DB
    .prepare("SELECT id FROM inboxes WHERE username = ?")
    .bind("stale")
    .first<{ id: number }>();

  const r = await post("stale");
  expect(r.status).toBe(201);
  const b = (await r.json()) as { address: string; expires_at: number };
  expect(b.address).toBe("stale@mail.example.com");
  expect(b.expires_at).toBeGreaterThan(now());

  // old row physically replaced: same address, new row id, fresh created_at
  const freshRow = await env.DB
    .prepare("SELECT id, created_at FROM inboxes WHERE username = ?")
    .bind("stale")
    .first<{ id: number; created_at: number }>();
  expect(freshRow!.id).not.toBe(oldRow!.id);
  expect(freshRow!.created_at).toBe(now());
  // neighbour untouched and still readable; expired inboxes read as 404 everywhere
  expect(
    await env.DB.prepare("SELECT id FROM inboxes WHERE username = ?").bind("keep").first(),
  ).not.toBeNull();
  expect((await call("/api/v1/user/keep", { headers: H })).status).toBe(200);
  expect((await call("/api/v1/user/dead2", { headers: H })).status).toBe(404);
  expect((await call("/api/v1/user/dead2/messages", { headers: H })).status).toBe(404);
});
