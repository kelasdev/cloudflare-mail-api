CREATE TABLE inboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,          -- part before '@', lowercased
    address TEXT NOT NULL UNIQUE,    -- username@MAIL_DOMAIN
    created_at INTEGER NOT NULL,     -- epoch seconds
    expires_at INTEGER NOT NULL      -- created_at + 86400
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT,
    text TEXT,
    html TEXT,
    received_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,   -- 1 when body hit the 256 KB cap
    FOREIGN KEY (inbox_id) REFERENCES inboxes(id)
);

CREATE INDEX idx_messages_inbox_received ON messages(inbox_id, received_at);
CREATE INDEX idx_messages_expires ON messages(expires_at);
CREATE INDEX idx_inboxes_expires ON inboxes(expires_at);
