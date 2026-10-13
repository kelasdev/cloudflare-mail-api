/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF, env } from "cloudflare:test";
import { beforeAll, it, expect } from "vitest";
import { createInbox, insertMessage } from "../src/store";
import { handleEmail } from "../src/email-handler";
import { scheduled } from "../src/index";
import { schemaSql } from "./schema-sql";

const H = { "X-API-Key": "test-key", "Content-Type": "application/json" };
const T0 = 1_700_000_000;

beforeAll(async () => {
  await env.DB.exec(schemaSql);
});

it("EXPIRY GATE: expired data invisible on every read path before cron runs", async () => {
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  const inbox = await createInbox(env.DB, "gate", "gate@mail.example.com", T0); // expires T0+86400
  const msgId = await insertMessage(env.DB, {
    inbox_id: inbox.id, sender: "s@x.y", recipient: inbox.address,
    subject: "old", text: "x", html: null, received_at: T0, expires_at: T0 + 86400, truncated: 0,
  });

  // Reads "now" = T0+86401 — cron has NOT run (no purgeExpired call anywhere in
  // this test). The inbox itself is expired, so every scoped read 404s it: the
  // strongest form of the gate — nothing about it is addressable, let alone
  // readable — and the inbox list hides the row entirely.
  const list = await SELF.fetch("http://x/api/v1/user/gate/messages", { headers: H });
  expect(list.status).toBe(404);
  const detail = await SELF.fetch(`http://x/api/v1/user/gate/messages/${msgId}`, { headers: H });
  expect(detail.status).toBe(404);
  expect((await SELF.fetch("http://x/api/v1/user/gate", { headers: H })).status).toBe(404);
  const all = (await (await SELF.fetch("http://x/api/v1/userlist", { headers: H })).json()) as unknown[];
  expect(all).toEqual([]);

  // Expired inbox: POST a NEW username starts a fresh cycle alongside it
  // (multi-inbox: the stale "gate" row simply waits for the cron).
  const post = await SELF.fetch("http://x/api/v1/userlist", {
    method: "POST", headers: H,
    body: JSON.stringify({ username: "gate2" }),
  });
  expect(post.status).toBe(201);
  // Mail to the OLD address now silently drops: its inbox row is past expiry.
  await handleEmail({
    from: "s@x.y", to: "gate@mail.example.com", headers: new Headers(),
    raw: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("Subject: x\r\n\r\nbody")); c.close(); },
    }),
  } as never, env, T0 + 86401);
  // No NEW row landed: the only message in the DB is the pre-cascade "old" one
  // (multi-inbox keeps the expired gate row + its message until the cron).
  expect(
    (await env.DB.prepare("SELECT count(*) n FROM messages WHERE received_at = ?").bind(T0 + 86401).first<any>())!.n,
  ).toBe(0);

  // Message-level filter with a LIVE inbox (real clock): a past-due message row
  // (direct-seed / clock-skew scenario) is still invisible on every read path.
  const realNow = Math.floor(Date.now() / 1000);
  await createInbox(env.DB, "okay", "okay@mail.example.com", realNow);
  const okRow = (await env.DB.prepare("SELECT id FROM inboxes WHERE username = ?").bind("okay").first<{ id: number }>())!;
  const pastDue = await insertMessage(env.DB, {
    inbox_id: okRow.id, sender: "s@x.y", recipient: "okay@mail.example.com",
    subject: "due", text: "x", html: null, received_at: realNow, expires_at: realNow - 1, truncated: 0,
  });
  expect(await (await SELF.fetch("http://x/api/v1/user/okay/messages", { headers: H })).json()).toEqual([]);
  expect((await SELF.fetch(`http://x/api/v1/user/okay/messages/${pastDue}`, { headers: H })).status).toBe(404);
  const okInbox = (await (await SELF.fetch("http://x/api/v1/user/okay", { headers: H })).json()) as { message_count: number };
  expect(okInbox.message_count).toBe(0); // inbox live; expired message excluded from the count
});

it("PURGE: scheduled path deletes physically, messages before inboxes", async () => {
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  const stale = await createInbox(env.DB, "gone", "gone@mail.example.com", T0 - 86401);
  await insertMessage(env.DB, {
    inbox_id: stale.id, sender: "s@x.y", recipient: stale.address,
    subject: "", text: "", html: null, received_at: T0 - 86401, expires_at: T0 - 1, truncated: 0,
  });
  const live = await createInbox(env.DB, "stay", "stay@mail.example.com", T0);
  // invoke the scheduled handler itself (exported named fn; pool 0.22 has no `worker` export)
  await scheduled({} as ScheduledController, env as any, T0); // now=T0: stale(T0-1) purged, live(T0+86400) kept
  const gone = await env.DB.prepare("SELECT id FROM inboxes WHERE address = ?").bind("gone@mail.example.com").first();
  expect(gone).toBeNull();
  const still = await env.DB.prepare("SELECT id FROM inboxes WHERE address = ?").bind("stay@mail.example.com").first();
  expect(still).not.toBeNull();
  expect((await env.DB.prepare("SELECT count(*) n FROM messages WHERE inbox_id = ?").bind(live.id).first<any>())!.n).toBe(0);
});
