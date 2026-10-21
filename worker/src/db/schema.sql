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
  role           TEXT NOT NULL DEFAULT 'editor',   -- owner | editor | viewer (staff) | member (community only)
  email_verified_at TEXT,                          -- set when an emailed link proves the address
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
  -- A contact can belong to several organizations (see contact_organizations).
  -- This column mirrors the PRIMARY org for headline display, sorting and search.
  organization_id    TEXT REFERENCES organizations(id),
  org_role           TEXT,                          -- role at the primary organization
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

-- Many-to-many contact <-> organization membership. The source of truth for who
-- belongs to an organization; contacts.organization_id mirrors the primary one.
CREATE TABLE IF NOT EXISTS contact_organizations (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  contact_id      TEXT NOT NULL REFERENCES contacts(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  org_role        TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (contact_id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_orgs_contact ON contact_organizations(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_orgs_org ON contact_organizations(organization_id);

CREATE TABLE IF NOT EXISTS notes (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  -- A note can reference several contacts, or none (see note_contacts). This
  -- column mirrors the PRIMARY contact (nullable) for existing single-contact views.
  contact_id     TEXT REFERENCES contacts(id),
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

-- Many-to-many note <-> contact. Source of truth for which contacts a note is
-- filed under; notes.contact_id mirrors the primary one.
CREATE TABLE IF NOT EXISTS note_contacts (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  note_id     TEXT NOT NULL REFERENCES notes(id),
  contact_id  TEXT NOT NULL REFERENCES contacts(id),
  created_at  TEXT NOT NULL,
  UNIQUE (note_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_note_contacts_note ON note_contacts(note_id);
CREATE INDEX IF NOT EXISTS idx_note_contacts_contact ON note_contacts(contact_id);

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
  community_visible INTEGER NOT NULL DEFAULT 0,  -- shown in the community portal only when 1
  community_details TEXT,                        -- public description for the portal
  community_rsvp INTEGER NOT NULL DEFAULT 0,     -- "I'll be there!" enabled
  community_notified_at TEXT,
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
  note_id         TEXT REFERENCES notes(id),        -- attachments filed under a note
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
CREATE INDEX IF NOT EXISTS idx_documents_organization ON documents(organization_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_documents_note ON documents(note_id, deleted_at);
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

-- ===========================================================================
-- Community portal (students, mentors, and staff community identities).
--
-- Data is split three ways on purpose:
--   * community_profiles   PUBLIC  -- what other signed-in members may see.
--   * community_accounts   PRIVATE -- account state, CRM link, resume; visible
--                                     to the member themself and to staff only.
--   * contacts/notes/...    STAFF   -- the CRM. Never read by a community route.
--
-- A community-only login is a `users` row with role = 'member'. That role is
-- NOT an administrative role: every CRM route requires owner/editor/viewer
-- (see middleware/auth.ts requireStaff), so a member session is refused there.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS community_accounts (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id),
  customer_id              TEXT NOT NULL REFERENCES customers(id),
  account_type             TEXT NOT NULL,                    -- student | mentor | staff
  status                   TEXT NOT NULL DEFAULT 'pending',  -- pending | active | deactivated
  onboarding_completed_at  TEXT,
  activated_at             TEXT,
  -- CRM link. contact_id is unique across accounts (partial index below), so a
  -- contact can never be linked to two accounts, even under concurrent requests.
  contact_id               TEXT REFERENCES contacts(id),
  link_state               TEXT NOT NULL DEFAULT 'pending',  -- pending | linked | conflict | unlinked | not_applicable
  link_candidates          TEXT,                             -- JSON array of contact ids when link_state = 'conflict'
  linked_at                TEXT,
  created_account_tagged_at TEXT,
  -- Private resume (R2). Owner + staff only; never in directory responses.
  resume_key               TEXT,
  resume_name              TEXT,
  resume_type              TEXT,
  resume_size              INTEGER,
  resume_uploaded_at       TEXT,
  deactivated_at           TEXT,
  deactivated_by           TEXT REFERENCES users(id),
  deactivation_reason      TEXT,
  -- NULL = account-type default (students and mentors: none).
  post_permission          TEXT,                             -- none | approval | direct
  resume_public            INTEGER NOT NULL DEFAULT 0,
  notify_messages          INTEGER NOT NULL DEFAULT 1,
  notify_mentions          INTEGER NOT NULL DEFAULT 1,
  notify_announcements     INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_accounts_contact
  ON community_accounts(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_accounts_status
  ON community_accounts(customer_id, status, account_type);
CREATE INDEX IF NOT EXISTS idx_community_accounts_link
  ON community_accounts(customer_id, link_state);

CREATE TABLE IF NOT EXISTS community_profiles (
  user_id          TEXT PRIMARY KEY REFERENCES users(id),
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  bio              TEXT,
  linkedin_url     TEXT,
  photo_key        TEXT,
  photo_type       TEXT,
  major            TEXT,             -- students, optional
  graduation_year  INTEGER,          -- students, optional
  role_title       TEXT,             -- mentors, optional
  company          TEXT,             -- mentors, optional
  scheduling_url   TEXT,             -- mentors, optional; validated https URL
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_profiles_customer ON community_profiles(customer_id);

-- Shared PUBLIC matching taxonomy. Deliberately separate from contacts.tags
-- (internal CRM tags), which are never shown to the community.
CREATE TABLE IF NOT EXISTS interest_tags (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  slug        TEXT NOT NULL,
  label       TEXT NOT NULL,
  featured    INTEGER NOT NULL DEFAULT 1,      -- 0 = shown behind "See more"
  created_at  TEXT NOT NULL,
  UNIQUE (customer_id, slug)
);

-- kind = 'interest': a student's interests / a mentor's expertise.
-- kind = 'help':     what a student wants help with / what a mentor offers.
CREATE TABLE IF NOT EXISTS community_profile_tags (
  user_id     TEXT NOT NULL REFERENCES users(id),
  tag_id      TEXT NOT NULL REFERENCES interest_tags(id),
  kind        TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, tag_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_profile_tags_tag ON community_profile_tags(tag_id);

-- Single-use emailed tokens (only a SHA-256 hash is stored).
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  purpose     TEXT NOT NULL,          -- verify_email | reset_password | change_email
  token_hash  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,          -- the address the link was sent to
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose);

-- Admin-authored community feed.
CREATE TABLE IF NOT EXISTS posts (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  link_url       TEXT,
  image_key      TEXT,
  image_type     TEXT,
  event_id       TEXT REFERENCES events(id),
  status         TEXT NOT NULL DEFAULT 'draft',   -- draft | pending | published | rejected | archived
  published_at   TEXT,
  author_id      TEXT REFERENCES users(id),
  author_kind    TEXT NOT NULL DEFAULT 'staff',   -- staff | member
  review_note    TEXT,
  reviewed_by    TEXT REFERENCES users(id),
  reviewed_at    TEXT,
  event_starts_at TEXT,
  event_ends_at  TEXT,
  event_location TEXT,
  rsvp_enabled   INTEGER NOT NULL DEFAULT 0,
  notified_at    TEXT,
  deleted_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  created_by     TEXT,
  last_edited_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(customer_id, status, published_at);

-- One-to-one private messaging. pair_key is the two user ids, sorted and
-- joined, so the same pair can only ever have one conversation.
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  pair_key        TEXT NOT NULL,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  last_message_at TEXT,
  UNIQUE (customer_id, pair_key)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  last_read_at    TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_id       TEXT NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'text',   -- text | meeting_request
  -- Client-generated idempotency key: a retried send returns the original
  -- message instead of inserting a duplicate.
  client_key      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (sender_id, client_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at);

-- Lightweight fixed-window rate limiting (signups, resends, resets, new chats).
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id         TEXT PRIMARY KEY,
  bucket     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket ON rate_limit_events(bucket, created_at);

-- Case-insensitive, whitespace-trimmed email lookups for CRM contact linking.
CREATE INDEX IF NOT EXISTS idx_contacts_email_norm ON contacts(customer_id, lower(trim(email)));
CREATE INDEX IF NOT EXISTS idx_events_community ON events(customer_id, community_visible, starts_at);

-- Failed-sign-in counters for brute-force protection (see lib/throttle.ts).
-- One row per key ("email:<address>" or "ip:<address>"); a successful sign-in
-- clears the email row. Keyed by the *attempted* address whether or not the
-- account exists, so lockouts reveal nothing about who has an account.
CREATE TABLE IF NOT EXISTS login_throttle (
  key              TEXT PRIMARY KEY,
  failures         INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  locked_until     TEXT
);

-- ===========================================================================
-- Community portal v2: post history, comments, likes, mentions, RSVPs and an
-- email outbox (see services/notifications.ts).
-- ===========================================================================

-- Every edit, takedown and restore of a post, with the content as it was
-- BEFORE the change, so staff can review history in Admin > Settings.
CREATE TABLE IF NOT EXISTS post_revisions (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  post_id        TEXT NOT NULL REFERENCES posts(id),
  action         TEXT NOT NULL,           -- edit | delete | restore | approve | reject
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  link_url       TEXT,
  status         TEXT NOT NULL,
  event_starts_at TEXT,
  event_ends_at  TEXT,
  event_location TEXT,
  changed_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_revisions_post ON post_revisions(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_post_revisions_customer ON post_revisions(customer_id, created_at);

-- One level of replies: parent_id points at a top-level comment.
CREATE TABLE IF NOT EXISTS post_comments (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  post_id     TEXT NOT NULL REFERENCES posts(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  parent_id   TEXT REFERENCES post_comments(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  deleted_by  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_post_comments_deleted ON post_comments(customer_id, deleted_at);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id     TEXT NOT NULL REFERENCES posts(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

-- Who was @mentioned where (a post or a comment), so each person is
-- notified once per post/comment.
CREATE TABLE IF NOT EXISTS post_mentions (
  source_type TEXT NOT NULL,              -- post | comment
  source_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (source_type, source_id, user_id)
);

-- "I'll be there!" responses, for an event post or a community-visible CRM event.
CREATE TABLE IF NOT EXISTS event_rsvps (
  target_type TEXT NOT NULL,              -- post | event
  target_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id, user_id)
);

-- Notification emails are queued here and sent a few at a time by the
-- Worker's scheduled (cron) handler, so a large announcement never runs into
-- per-request limits, and every send is retried and deduplicated.
CREATE TABLE IF NOT EXISTS email_outbox (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  kind        TEXT NOT NULL,              -- message | mention | announcement
  to_user_id  TEXT NOT NULL REFERENCES users(id),
  ref_type    TEXT NOT NULL,              -- conversation | post | comment | event
  ref_id      TEXT NOT NULL,
  actor_id    TEXT REFERENCES users(id),
  dedupe_key  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'queued', -- queued | sending | sent | skipped | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  send_after  TEXT NOT NULL,
  claimed_at  TEXT,
  sent_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox(status, send_after);
CREATE INDEX IF NOT EXISTS idx_email_outbox_ref ON email_outbox(kind, ref_id, to_user_id);
