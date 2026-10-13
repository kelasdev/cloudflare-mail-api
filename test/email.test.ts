/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { beforeAll, it, expect } from "vitest";
import { handleEmail } from "../src/email-handler";
import { createInbox } from "../src/store";
import { schemaSql } from "./schema-sql";

const rfc822 = (to: string, subject: string, body: string) =>
  new ReadableStream({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          `From: Sender <sender@example.net>\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
        ),
      );
      c.close();
    },
  });

const garbageRaw = () =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("this is not valid mime at all:::"));
      c.close();
    },
  });

const fakeMsg = (to: string, subject = "Hi", body = "hello world") =>
  ({ from: "sender@example.net", to, headers: new Headers(), raw: rfc822(to, subject, body) }) as never;

const count = async () => (await env.DB.prepare("SELECT count(*) n FROM messages").first<{ n: number }>())!.n;

beforeAll(async () => {
  await env.DB.exec(schemaSql);
});

it("stores mail for a live inbox with inbox's expires_at", async () => {
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  const inbox = await createInbox(env.DB, "alice", "alice@mail.example.com", 1_700_000_000);
  await handleEmail(fakeMsg("alice@mail.example.com", "Verify", "code 123"), env, 1_700_000_500);
  expect(await count()).toBe(1);
  const row = await env.DB.prepare("SELECT * FROM messages").first<any>();
  expect(row.subject).toBe("Verify");
  expect(row.text).toContain("code 123");
  expect(row.expires_at).toBe(inbox.expires_at); // NOT received_at + 86400
});

it("silent drop: unknown recipient and expired inbox store nothing, no throw", async () => {
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  await handleEmail(fakeMsg("nobody@mail.example.com"), env, 1_700_000_500);
  expect(await count()).toBe(0);
  await createInbox(env.DB, "old", "old@mail.example.com", 1_700_000_000 - 86401);
  await handleEmail(fakeMsg("old@mail.example.com"), env, 1_700_000_500);
  expect(await count()).toBe(0);
});

it("garbage MIME still stores; oversized body truncates at 256 KB", async () => {
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  await createInbox(env.DB, "alice", "alice@mail.example.com", 1_700_000_000);
  // garbage: not valid MIME at all
  await handleEmail({ from: "s@example.net", to: "alice@mail.example.com", headers: new Headers(), raw: garbageRaw() } as never, env, 1_700_000_500);
  expect(await count()).toBe(1);
  const g = await env.DB.prepare("SELECT subject, text, truncated FROM messages").first<any>();
  expect(g.subject).toBe("(no subject)");
  expect(g.text).not.toBeNull();
  expect(g.truncated).toBe(0);

  // oversized
  const huge = "x".repeat(300 * 1024);
  await handleEmail({ from: "s@example.net", to: "alice@mail.example.com", headers: new Headers(), raw: rfc822("alice@mail.example.com", "big", huge) } as never, env, 1_700_000_500);
  const big = await env.DB.prepare("SELECT text, truncated FROM messages ORDER BY id DESC LIMIT 1").first<any>();
  expect(big.truncated).toBe(1);
  expect(big.text.length).toBe(256 * 1024);
});

it("folded Subject header is unfolded before storage (fallback parser path)", async () => {
  await env.DB.exec("DELETE FROM messages; DELETE FROM inboxes;");
  await createInbox(env.DB, "alice", "alice@mail.example.com", 1_000_000_000);
  // Garbage body that makes PostalMime.parse throw -> extractSubject fallback.
  // Subject is RFC 5322 folded across two lines (continuation starts with space).
  const folded = "this is not valid mime:::\r\nSubject: Hello\r\n World\r\n\r\nbody";
  await handleEmail({
    from: "s@example.net", to: "alice@mail.example.com", headers: new Headers(),
    raw: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(folded)); c.close(); } }),
  } as never, env, 1_000_000_500);
  const row = await env.DB.prepare("SELECT subject FROM messages").first<any>();
  expect(row.subject).toBe("Hello World");
});
