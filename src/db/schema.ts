/** Database schema. Mirrors the TRD data model; SQLite stands in for PostgreSQL in the prototype. */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  aliases       TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
  unit          TEXT NOT NULL DEFAULT 'kg',
  pack_size_kg  REAL,
  packaging     TEXT NOT NULL DEFAULT '',
  location      TEXT NOT NULL DEFAULT '',
  gst_pct       REAL NOT NULL DEFAULT 18,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS price_rows (
  id               INTEGER PRIMARY KEY,
  product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  origin           TEXT NOT NULL,                -- from the fixed ORIGINS list
  brand            TEXT NOT NULL DEFAULT '',
  rate             REAL,                         -- per unit, before GST
  status           TEXT NOT NULL DEFAULT 'In Stock',
  freshness_hours  INTEGER NOT NULL DEFAULT 24,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by       TEXT
);

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY,
  wa_jid      TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'broker',    -- broker | internal | test | vip
  auto_reply  INTEGER NOT NULL DEFAULT 0,
  members     INTEGER NOT NULL DEFAULT 0,
  synced_at   TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  wa_msg_id    TEXT NOT NULL UNIQUE,
  group_id     INTEGER NOT NULL REFERENCES groups(id),
  sender       TEXT NOT NULL,
  sender_name  TEXT,
  from_me      INTEGER NOT NULL DEFAULT 0,
  text         TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  parse_json   TEXT,
  intent       TEXT,
  confidence   TEXT,
  outcome      TEXT                              -- quoted | booking | held | ignored | unmatched | skipped
);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);

CREATE TABLE IF NOT EXISTS replies (
  id                INTEGER PRIMARY KEY,
  message_id        INTEGER NOT NULL REFERENCES messages(id),
  group_id          INTEGER NOT NULL REFERENCES groups(id),
  kind              TEXT NOT NULL,              -- quote | booking
  body              TEXT NOT NULL,
  template_version  INTEGER,
  status            TEXT NOT NULL,              -- scheduled | sending | sent | held | failed | cancelled
  reason            TEXT,
  send_at           TEXT,
  typing_started    INTEGER NOT NULL DEFAULT 0,
  sent_at           TEXT,
  sent_msg_id       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status, send_at);
CREATE INDEX IF NOT EXISTS idx_replies_sent_msg ON replies(sent_msg_id);

CREATE TABLE IF NOT EXISTS approvals (
  id           INTEGER PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES messages(id),
  product_id   INTEGER REFERENCES products(id),
  quantity     TEXT,
  quantity_kg  REAL,
  status       TEXT NOT NULL DEFAULT 'new',      -- new | contacted | won | lost
  assignee     TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY,
  mode        TEXT NOT NULL,                     -- quote_item | quote_footer | booking | ...
  body        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL                           -- JSON
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role           TEXT NOT NULL,                  -- owner | operator | viewer
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER,
  user_name    TEXT,
  action       TEXT NOT NULL,
  entity       TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id       INTEGER PRIMARY KEY,
  level    TEXT NOT NULL,                        -- info | warn | critical
  text     TEXT NOT NULL,
  at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  seen     INTEGER NOT NULL DEFAULT 0
);
`;
