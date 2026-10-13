// D1's exec() splits its input on newlines (one statement per line), so each
// statement must be collapsed onto a single line — comments stripped.
// Statements are identical to schema.sql (2 CREATE TABLE + 3 CREATE INDEX).
export const schemaSql = [
  "CREATE TABLE inboxes (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, address TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);",
  "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, inbox_id INTEGER NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, text TEXT, html TEXT, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (inbox_id) REFERENCES inboxes(id));",
  "CREATE INDEX idx_messages_inbox_received ON messages(inbox_id, received_at);",
  "CREATE INDEX idx_messages_expires ON messages(expires_at);",
  "CREATE INDEX idx_inboxes_expires ON inboxes(expires_at);",
].join("\n");
