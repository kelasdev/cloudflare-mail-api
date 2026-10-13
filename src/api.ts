import { validateUsername, buildAddress } from "./username";
import {
  getInboxByUsername,
  listInboxes,
  createInbox,
  deleteInboxCascade,
  listMessages,
  getMessage,
  deleteMessage,
  deleteAllMessages,
  countLiveMessages,
} from "./store";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === null || !Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** Decode + validate a :username path segment. Invalid names can never
 * address an inbox, so they read as not_found rather than invalid_username. */
function pathUsername(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const v = validateUsername(decoded);
  return v.ok ? v.username : null;
}

/** Timing-safe comparison of two strings.
 * Both values are SHA-256 digested then compared byte-by-byte with a
 * constant-time accumulation so no length or early-exit leak is exposed
 * to the API key check. A missing key is handled by the caller before
 * this runs. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const da = await crypto.subtle.digest("SHA-256", enc.encode(a));
  const db = await crypto.subtle.digest("SHA-256", enc.encode(b));
  const ba = new Uint8Array(da);
  const bb = new Uint8Array(db);
  if (ba.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ba.byteLength; i++) diff |= (ba[i]!) ^ (bb[i]!);
  return diff === 0;
}

export async function handleApi(request: Request, env: Env, now: number): Promise<Response> {
  const key = request.headers.get("X-API-Key");
  if (key === null || !(await safeEqual(key, env.API_KEY))) return json(401, { error: "unauthorized" });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  const method = request.method;

  if (path === "/api/v1/userlist") {
    if (method === "GET") {
      return json(200, await listInboxes(env.DB, now));
    }
    if (method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return json(422, { error: "invalid_json" }); }
      const v = validateUsername((body as { username?: string })?.username ?? "");
      if (!v.ok) return json(400, { error: "invalid_username", reason: v.reason });
      const existing = await getInboxByUsername(env.DB, v.username);
      if (existing) {
        if (existing.expires_at > now) return json(409, { error: "user_exists", address: existing.address, expires_at: existing.expires_at });
        await deleteInboxCascade(env.DB, existing.id);
      }
      try {
        const created = await createInbox(env.DB, v.username, buildAddress(v.username, env.MAIL_DOMAIN), now);
        return json(201, { username: created.username, address: created.address, created_at: created.created_at, expires_at: created.expires_at, ttl_seconds: 86400 });
      } catch {
        // UNIQUE(address) race: another request created this username first.
        return json(409, { error: "user_exists" });
      }
    }
    return json(405, { error: "method_not_allowed" });
  }

  const mInbox = path.match(/^\/api\/v1\/user\/([^/]+)$/);
  if (mInbox) {
    const username = pathUsername(mInbox[1]!);
    if (username === null) return json(404, { error: "not_found" });
    if (method !== "GET") return json(405, { error: "method_not_allowed" });
    const inbox = await getInboxByUsername(env.DB, username);
    if (!inbox || inbox.expires_at <= now) return json(404, { error: "not_found" });
    const count = await countLiveMessages(env.DB, inbox.id, now);
    return json(200, { username: inbox.username, address: inbox.address, expires_at: inbox.expires_at, message_count: count });
  }

  const mMsgs = path.match(/^\/api\/v1\/user\/([^/]+)\/messages$/);
  if (mMsgs) {
    const username = pathUsername(mMsgs[1]!);
    if (username === null) return json(404, { error: "not_found" });
    const inbox = await getInboxByUsername(env.DB, username);
    if (!inbox || inbox.expires_at <= now) return json(404, { error: "not_found" });
    if (method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
      const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
      return json(200, await listMessages(env.DB, inbox.id, now, limit, offset));
    }
    if (method === "DELETE") {
      await deleteAllMessages(env.DB, inbox.id);
      return new Response(null, { status: 204 });
    }
    return json(405, { error: "method_not_allowed" });
  }

  const mMsg = path.match(/^\/api\/v1\/user\/([^/]+)\/messages\/(\d+)$/);
  if (mMsg) {
    const username = pathUsername(mMsg[1]!);
    if (username === null) return json(404, { error: "not_found" });
    const id = Number(mMsg[2]);
    const inbox = await getInboxByUsername(env.DB, username);
    if (!inbox || inbox.expires_at <= now) return json(404, { error: "not_found" });
    if (method === "GET") {
      const row = await getMessage(env.DB, id, inbox.id, now);
      return row ? json(200, row) : json(404, { error: "not_found" });
    }
    if (method === "DELETE") {
      await deleteMessage(env.DB, id, inbox.id); // idempotent: 0 rows still 204
      return new Response(null, { status: 204 });
    }
    return json(405, { error: "method_not_allowed" });
  }

  return json(404, { error: "not_found" });
}
