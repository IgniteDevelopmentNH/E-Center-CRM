-- UNH ECenter CRM -- canonical schema.
--
-- Written in a deliberately portable SQL subset so ONE schema file drives both
-- PostgreSQL (production) and node:sqlite (local dev / demo):
--   * Primary keys are application-generated UUID TEXT (no SERIAL / AUTOINCREMENT).
--   * Timestamps are ISO-8601 UTC strings in TEXT columns. They sort and compare
--     correctly with lexicographic operators in both engines, which keeps a single
--     query layer honest with zero dialect drift.
--   * Booleans are INTEGER 0/1 (SQLite has no boolean type).
--   * List-valued fields (tags) are JSON stored as TEXT and parsed in the app.
--
-- MULTI-TENANCY: every business table carries customer_id, and every read/write
-- goes through the customer-scoped helpers in src/db/scope.ts.

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  email          TEXT NOT NULL UNIQUE,
  -- Format: pbkdf2:<iterations>:<saltHex>:<hashHex> (Web Crypto PBKDF2-SHA256).
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'editor',   -- owner | editor | viewer
  last_login_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_customer ON users(customer_id);

-- DB-backed sessions (replaces a stateless JWT): removing a team member or
-- signing out invalidates access immediately, rather than waiting out a token's
-- lifetime. token_hash is SHA-256 of the bearer token, so a leaked database
-- dump does not itself hand out live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id            TEXT PRIMARY KEY REFERENCES users(id),
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  email_digest       TEXT NOT NULL DEFAULT 'off',   -- off | daily | weekly
  reminder_lead_days INTEGER NOT NULL DEFAULT 1,
  timezone           TEXT NOT NULL DEFAULT 'America/New_York',
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  name           TEXT NOT NULL,
  org_type       TEXT NOT NULL DEFAULT 'other',    -- startup | established | club | nonprofit | other
  location       TEXT,
  website        TEXT,
  relationship   TEXT,                             -- how and why the ECenter works with them
  status         TEXT NOT NULL DEFAULT 'active',   -- active | inactive | prospect
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  created_by     TEXT,
  last_edited_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_orgs_customer ON organizations(customer_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_orgs_status ON organizations(customer_id, status);

CREATE TABLE IF NOT EXISTS contacts (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT,
  how_we_connected   TEXT,                          -- relationship origin story (top requirement)
  tags               TEXT NOT NULL DEFAULT '[]',    -- JSON array
  organization_id    TEXT REFERENCES organizations(id),
  org_role           TEXT,                          -- role at the linked organization
  status             TEXT NOT NULL DEFAULT 'active',-- active | past | on_hold
  is_student_founder INTEGER NOT NULL DEFAULT 0,    -- business data only; no student PII
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  created_by         TEXT,
  last_edited_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(customer_id, created_at);

CREATE TABLE IF NOT EXISTS notes (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  contact_id     TEXT NOT NULL REFERENCES contacts(id),
  note_type      TEXT NOT NULL DEFAULT 'other',   -- email | call | meeting | workshop | referral | other
  content        TEXT NOT NULL,
  tags           TEXT NOT NULL DEFAULT '[]',
  source         TEXT NOT NULL DEFAULT 'manual',  -- manual | event | system
  created_at     TEXT NOT NULL,                   -- AUTO-STAMPED ON INSERT. Never client-supplied.
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  created_by     TEXT,
  last_edited_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_customer ON notes(customer_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT PRIMARY KEY,
  customer_id          TEXT NOT NULL REFERENCES customers(id),
  title                TEXT NOT NULL,
  due_date             TEXT NOT NULL,                  -- YYYY-MM-DD
  contact_id           TEXT REFERENCES contacts(id),
  assigned_to          TEXT REFERENCES users(id),
  status               TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | complete
  priority             TEXT NOT NULL DEFAULT 'medium', -- high | medium | low
  reminder_enabled     INTEGER NOT NULL DEFAULT 0,
  reminder_offset      TEXT NOT NULL DEFAULT 'on_date',-- one_day | three_days | on_date
  context_notes        TEXT,
  recurrence           TEXT NOT NULL DEFAULT 'none',   -- none | weekly | biweekly | monthly
  recurrence_parent_id TEXT,
  completed_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT,
  created_by           TEXT,
  last_edited_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_customer ON tasks(customer_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(customer_id, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  name           TEXT NOT NULL,
  starts_at      TEXT NOT NULL,                   -- ISO-8601 UTC
  ends_at        TEXT,
  event_type     TEXT NOT NULL DEFAULT 'other',   -- workshop | speaker_series | ideathon | networking | one_on_one | other
  location       TEXT,
  description    TEXT,
  followup_notes TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  created_by     TEXT,
  last_edited_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_customer ON events(customer_id, starts_at);

CREATE TABLE IF NOT EXISTS event_attendees (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  event_id    TEXT NOT NULL REFERENCES events(id),
  contact_id  TEXT NOT NULL REFERENCES contacts(id),
  created_at  TEXT NOT NULL,
  UNIQUE (event_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_attendees_event ON event_attendees(event_id);
CREATE INDEX IF NOT EXISTS idx_attendees_contact ON event_attendees(contact_id);

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  contact_id      TEXT REFERENCES contacts(id),
  organization_id TEXT REFERENCES organizations(id),
  file_name       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  file_type       TEXT NOT NULL,
  storage_key     TEXT NOT NULL,                  -- customers/{customerId}/documents/{ts}-{name}
  uploaded_by     TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  deleted_at      TEXT,
  deleted_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_contact ON documents(contact_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents(customer_id, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  user_id     TEXT,
  action      TEXT NOT NULL,                      -- document.upload | document.download | calendar.sync | contact.delete | ...
  entity_type TEXT,
  entity_id   TEXT,
  metadata    TEXT,                               -- JSON
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_customer ON audit_logs(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(customer_id, action);

CREATE TABLE IF NOT EXISTS microsoft_oauth_credentials (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL UNIQUE REFERENCES customers(id),
  client_id         TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,               -- AES-256-GCM
  tenant_id         TEXT NOT NULL DEFAULT 'common',
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  expires_at        TEXT,
  account_email     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_sync_metadata (
  customer_id   TEXT PRIMARY KEY REFERENCES customers(id),
  last_sync_at  TEXT,
  sync_status   TEXT,                             -- success | error | never
  error_message TEXT,
  events_pulled INTEGER NOT NULL DEFAULT 0,
  events_pushed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_external_mapping (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  event_id       TEXT NOT NULL REFERENCES events(id),
  external_id    TEXT NOT NULL,
  external_etag  TEXT,
  last_synced_at TEXT NOT NULL,
  UNIQUE (customer_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_extmap_event ON event_external_mapping(event_id);
