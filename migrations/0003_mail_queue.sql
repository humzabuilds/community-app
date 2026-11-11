-- Outgoing mail waiting for the relay (production sender until a domain sender exists).
CREATE TABLE mail_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX mail_queue_unsent ON mail_queue (sent_at, id);
