// D1 store layer. All timestamps are epoch seconds passed in as bound
// parameters (no unixepoch()/Date.now() inside SQL) so tests can inject clocks.
// Reads that must hide stale rows filter `expires_at > <now>`; DELETE on
// messages intentionally has no expiry filter (idempotent, rows-affected).
// The multi-inbox model: every inbox row is addressed by username; there is
// no singleton row.

export interface InboxRow {
  id: number;
  username: string;
  address: string;
  created_at: number;
  expires_at: number;
}

export interface InboxListRow extends InboxRow {
  message_count: number;
}

export interface MessageRow {
  id: number;
  inbox_id: number;
  sender: string;
  recipient: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  received_at: number;
  expires_at: number;
  truncated: number;
}

export type MessageMeta = Pick<MessageRow, "id" | "sender" | "subject" | "received_at">;

const INBOX_COLUMNS = "id, username, address, created_at, expires_at";
const MESSAGE_COLUMNS =
  "id, inbox_id, sender, recipient, subject, text, html, received_at, expires_at, truncated";

/** One inbox by username (lowercased). No expiry filter — caller decides. */
export async function getInboxByUsername(
  db: D1Database,
  username: string,
): Promise<InboxRow | null> {
  return db
    .prepare(`SELECT ${INBOX_COLUMNS} FROM inboxes WHERE username = ? LIMIT 1`)
    .bind(username)
    .first<InboxRow>();
}

/** All live inboxes (expires_at > now), newest first, with live message counts. */
export async function listInboxes(db: D1Database, now: number): Promise<InboxListRow[]> {
  const res = await db
    .prepare(
      `SELECT ${INBOX_COLUMNS},
 (SELECT COUNT(*) FROM messages m WHERE m.inbox_id = inboxes.id AND m.expires_at > ?) AS message_count
       FROM inboxes WHERE expires_at > ? ORDER BY created_at DESC, id DESC`,
    )
    .bind(now, now)
    .all<InboxListRow>();
  return res.results;
}

/** Delete one inbox: its messages, then the inbox, then any orphaned messages. */
export async function deleteInboxCascade(db: D1Database, inboxId: number): Promise<void> {
  await db.prepare("DELETE FROM messages WHERE inbox_id = ?").bind(inboxId).run();
  await db.prepare("DELETE FROM inboxes WHERE id = ?").bind(inboxId).run();
  // Orphans (parent inbox already gone — e.g. a prior partial cascade).
  await db
    .prepare("DELETE FROM messages WHERE inbox_id NOT IN (SELECT id FROM inboxes)")
    .run();
}

/** Create an inbox with TTL = now + 86400; returns the inserted row. */
export async function createInbox(
  db: D1Database,
  username: string,
  address: string,
  now: number,
): Promise<InboxRow> {
  const row = await db
    .prepare(
      `INSERT INTO inboxes (username, address, created_at, expires_at) VALUES (?, ?, ?, ?) RETURNING ${INBOX_COLUMNS}`,
    )
    .bind(username, address, now, now + 86400)
    .first<InboxRow>();
  if (!row) throw new Error("createInbox: INSERT ... RETURNING produced no row");
  return row;
}

/** Message metadata for an inbox, newest first, hiding expired rows. */
export async function listMessages(
  db: D1Database,
  inboxId: number,
  now: number,
  limit: number,
  offset: number,
): Promise<MessageMeta[]> {
  const res = await db
    .prepare(
      "SELECT id, sender, subject, received_at FROM messages WHERE inbox_id = ? AND expires_at > ? ORDER BY received_at DESC LIMIT ? OFFSET ?",
    )
    .bind(inboxId, now, limit, offset)
    .all<MessageMeta>();
  return res.results;
}

/** Full message row; expired rows read as null. */
export async function getMessage(
  db: D1Database,
  id: number,
  inboxId: number,
  now: number,
): Promise<MessageRow | null> {
  return db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND inbox_id = ? AND expires_at > ?`,
    )
    .bind(id, inboxId, now)
    .first<MessageRow>();
}

/** Delete one message scoped to its inbox. No expiry filter; returns rows affected (0 when absent). */
export async function deleteMessage(
  db: D1Database,
  id: number,
  inboxId: number,
): Promise<number> {
  const res = await db
    .prepare("DELETE FROM messages WHERE id = ? AND inbox_id = ?")
    .bind(id, inboxId)
    .run();
  return res.meta.changes;
}

/** Delete every message in an inbox. */
export async function deleteAllMessages(db: D1Database, inboxId: number): Promise<void> {
  await db.prepare("DELETE FROM messages WHERE inbox_id = ?").bind(inboxId).run();
}

/** Insert a message; caller sets expires_at (messages.expires_at = inboxes.expires_at). Returns new id. */
export async function insertMessage(db: D1Database, row: Omit<MessageRow, "id">): Promise<number> {
  const inserted = await db
    .prepare(
      `INSERT INTO messages (inbox_id, sender, recipient, subject, text, html, received_at, expires_at, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      row.inbox_id,
      row.sender,
      row.recipient,
      row.subject,
      row.text,
      row.html,
      row.received_at,
      row.expires_at,
      row.truncated,
    )
    .first<{ id: number }>();
  if (!inserted) throw new Error("insertMessage: INSERT ... RETURNING produced no row");
  return inserted.id;
}

/** Look up an inbox by address. No expiry filter — caller decides. */
export async function getInboxByAddress(
  db: D1Database,
  address: string,
): Promise<InboxRow | null> {
  return db
    .prepare(`SELECT ${INBOX_COLUMNS} FROM inboxes WHERE address = ?`)
    .bind(address)
    .first<InboxRow>();
}

/** Cron purge: expired messages first, then expired inboxes (two ordered statements). */
export async function purgeExpired(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM messages WHERE expires_at <= ?").bind(now).run();
  await db.prepare("DELETE FROM inboxes WHERE expires_at <= ?").bind(now).run();
}

/** Non-expired message count for GET /inboxes/:username. */
export async function countLiveMessages(
  db: D1Database,
  inboxId: number,
  now: number,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ? AND expires_at > ?")
    .bind(inboxId, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
