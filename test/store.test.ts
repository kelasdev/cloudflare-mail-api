/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { beforeAll, it, expect } from "vitest";
import { schemaSql } from "./schema-sql";
import {
  createInbox,
  listInboxes,
  listMessages,
  getMessage,
  deleteMessage,
  purgeExpired,
  insertMessage,
  getInboxByAddress,
  getInboxByUsername,
  deleteInboxCascade,
  deleteAllMessages,
  countLiveMessages,
} from "../src/store";

beforeAll(async () => {
  await env.DB.exec(schemaSql);
});

it("create + get by username and by address", async () => {
  const now = 1_700_000_000;
  await createInbox(env.DB, "alice", "alice@mail.example.com", now);
  const byAddr = await getInboxByAddress(env.DB, "alice@mail.example.com");
  expect(byAddr?.expires_at).toBe(now + 86400);
  const byUser = await getInboxByUsername(env.DB, "alice");
  expect(byUser).toMatchObject({ username: "alice", address: "alice@mail.example.com" });
  expect(await getInboxByUsername(env.DB, "ghost")).toBeNull();
});

it("listInboxes: live only, newest first, counts live messages only", async () => {
  const now = 1_700_000_000;
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  const fresh = await createInbox(env.DB, "n1", "n1@mail.example.com", now);
  const older = await createInbox(env.DB, "n0", "n0@mail.example.com", now - 100);
  await env.DB
    .prepare("INSERT INTO inboxes (username, address, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind("dead", "dead@mail.example.com", now - 90_000, now - 1)
    .run(); // expired row still in DB
  await insertMessage(env.DB, { inbox_id: older.id, sender: "a@x.y", recipient: older.address, subject: "live", text: "", html: null, received_at: now, expires_at: now + 500, truncated: 0 });
  await insertMessage(env.DB, { inbox_id: older.id, sender: "b@x.y", recipient: older.address, subject: "old", text: "", html: null, received_at: now, expires_at: now - 1, truncated: 0 });
  await insertMessage(env.DB, { inbox_id: fresh.id, sender: "c@x.y", recipient: fresh.address, subject: "x", text: "", html: null, received_at: now, expires_at: now + 500, truncated: 0 });

  const rows = await listInboxes(env.DB, now);
  expect(rows.map((r) => r.username)).toEqual(["n1", "n0"]); // expired hidden; newest first
  expect(rows[0]!.message_count).toBe(1);
  expect(rows[1]!.message_count).toBe(1); // expired message excluded from the count
});

it("list and get respect expiry; delete does not", async () => {
  const now = 1_700_000_000;
  const inbox = await createInbox(env.DB, "bob", "bob@mail.example.com", now);
  const live = await insertMessage(env.DB, { inbox_id: inbox.id, sender: "a@x.y", recipient: inbox.address, subject: "hi", text: "t", html: null, received_at: now, expires_at: now + 100, truncated: 0 });
  const dead = await insertMessage(env.DB, { inbox_id: inbox.id, sender: "b@x.y", recipient: inbox.address, subject: "bye", text: "t", html: null, received_at: now, expires_at: now + 1, truncated: 0 });
  expect(await listMessages(env.DB, inbox.id, now + 50, 20, 0)).toHaveLength(1);
  expect(await getMessage(env.DB, dead, inbox.id, now + 50)).toBeNull();
  expect(await getMessage(env.DB, live, inbox.id, now + 50)).not.toBeNull();
  expect(await deleteMessage(env.DB, dead, inbox.id)).toBe(1);  // idempotent path: row exists, expired, still deletable
  expect(await deleteMessage(env.DB, 999999, inbox.id)).toBe(0); // no row -> 0 -> API maps to 204
});

it("cross-inbox scoping: other inbox id never matches", async () => {
  const now = 1_700_000_000;
  const a = await createInbox(env.DB, "a1", "a1@mail.example.com", now);
  const b = await createInbox(env.DB, "b1", "b1@mail.example.com", now);
  const mid = await insertMessage(env.DB, { inbox_id: a.id, sender: "s@x.y", recipient: a.address, subject: "", text: "", html: null, received_at: now, expires_at: now + 999, truncated: 0 });
  expect(await getMessage(env.DB, mid, b.id, now)).toBeNull();
  expect(await deleteMessage(env.DB, mid, b.id)).toBe(0);
});

it("purge deletes expired only, messages before inboxes", async () => {
  const now = 1_700_000_000;
  const old = await createInbox(env.DB, "old1", "old1@mail.example.com", now - 86401);
  await insertMessage(env.DB, { inbox_id: old.id, sender: "s@x.y", recipient: old.address, subject: "", text: "", html: null, received_at: now - 86401, expires_at: now - 1, truncated: 0 });
  const fresh = await createInbox(env.DB, "new1", "new1@mail.example.com", now);
  await purgeExpired(env.DB, now);
  expect(await getInboxByAddress(env.DB, "old1@mail.example.com")).toBeNull();
  expect(await getInboxByAddress(env.DB, "new1@mail.example.com")).not.toBeNull();
});

it("deleteInboxCascade removes one inbox and its messages only", async () => {
  const now = 1_700_000_000;
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  const a = await createInbox(env.DB, "c1", "c1@mail.example.com", now);
  const b = await createInbox(env.DB, "c2", "c2@mail.example.com", now);
  await insertMessage(env.DB, { inbox_id: a.id, sender: "s@x.y", recipient: a.address, subject: "", text: "", html: null, received_at: now, expires_at: now + 999, truncated: 0 });
  await insertMessage(env.DB, { inbox_id: b.id, sender: "s@x.y", recipient: b.address, subject: "", text: "", html: null, received_at: now, expires_at: now + 999, truncated: 0 });
  await deleteInboxCascade(env.DB, a.id);
  expect(await getInboxByUsername(env.DB, "c1")).toBeNull();
  expect(await getInboxByUsername(env.DB, "c2")).not.toBeNull();
  const countFor = async (id: number) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ?").bind(id).first<{ n: number }>())!.n;
  expect(await countFor(a.id)).toBe(0);
  expect(await countFor(b.id)).toBe(1);
});

it("live count, deleteAllMessages, cascade leaves no orphans", async () => {
  const now = 1_700_000_000;
  const inbox = await createInbox(env.DB, "carol", "carol@mail.example.com", now);
  await insertMessage(env.DB, { inbox_id: inbox.id, sender: "a@x.y", recipient: inbox.address, subject: "live", text: "t", html: null, received_at: now, expires_at: now + 100, truncated: 0 });
  await insertMessage(env.DB, { inbox_id: inbox.id, sender: "b@x.y", recipient: inbox.address, subject: "old", text: "t", html: null, received_at: now, expires_at: now - 1, truncated: 0 });
  expect(await countLiveMessages(env.DB, inbox.id, now + 50)).toBe(1);
  expect(await countLiveMessages(env.DB, inbox.id, now + 200)).toBe(0);
  await deleteAllMessages(env.DB, inbox.id);
  expect(await countLiveMessages(env.DB, inbox.id, now + 50)).toBe(0);
  await insertMessage(env.DB, { inbox_id: inbox.id, sender: "c@x.y", recipient: inbox.address, subject: "back", text: "t", html: null, received_at: now, expires_at: now + 100, truncated: 0 });
  await deleteInboxCascade(env.DB, inbox.id);
  expect(await getInboxByUsername(env.DB, "carol")).toBeNull();
  // True-orphan sweep: messages whose inbox row is gone. (Plain COUNT(*) would
  // also count messages belonging to inboxes seeded by earlier tests in this
  // file — per-file storage is shared across `it` blocks.)
  const orphans = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id NOT IN (SELECT id FROM inboxes)")
    .first<{ n: number }>();
  expect(orphans?.n).toBe(0);
});

// --- Cross-`it` row persistence proof (fix round 1, task 3) ----------------
// These two tests PROVE that D1 storage persists across separate `it` blocks
// within this file. If miniflare reset storage per-test, the second test would
// find its seeded row gone and FAIL. Neither test wipes the OTHER's seed row:
// the first establishes a clean slate then seeds; the second only reads.
it("persists across tests: seeds row for cross-it proof", async () => {
  const now = 1_700_000_000;
  // Clean slate for determinism, THEN seed exactly one row.
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  const inbox = await createInbox(env.DB, "persist", "persist@mail.example.com", now);
  expect(inbox.id).toBeGreaterThan(0);
});

it("persists across tests: reads row seeded by earlier test", async () => {
  // NO wipe here — reading proves persistence across the `it` boundary.
  const row = await getInboxByAddress(env.DB, "persist@mail.example.com");
  expect(row).not.toBeNull();
  expect(row?.username).toBe("persist");
  expect(row?.expires_at).toBe(1_700_000_000 + 86400);
});
