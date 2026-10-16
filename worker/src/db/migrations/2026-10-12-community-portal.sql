-- Migration: student/mentor community portal.
--
-- Purely ADDITIVE: two new nullable/defaulted columns on existing tables and a
-- set of new tables. No existing row is rewritten, no table is rebuilt, and no
-- column is dropped, so it is safe to apply to a database holding live CRM data.
--
-- Apply ONCE to an existing D1 database that predates the community portal,
-- BEFORE deploying the matching Worker build:
--
--   npx wrangler d1 execute ecenter-crm --remote \
--     --file=./worker/src/db/migrations/2026-10-12-community-portal.sql
--
-- (Try it against a local copy or a preview database first.) Fresh databases
-- created from worker/src/db/schema.sql already include everything here.
--
-- The two ALTER TABLE statements are the only non-idempotent lines: SQLite has
-- no ADD COLUMN IF NOT EXISTS, so re-running this file fails on them with
-- "duplicate column name" -- which is harmless, but means run it exactly once.

-- 1. Columns on existing tables. ----------------------------------------------

-- When the address on the account was proven to belong to the person (a click
-- on an emailed link). CRM contact linking only ever uses a verified address.
-- Existing staff accounts were created by an owner and keep NULL here; nothing
-- about staff sign-in depends on it.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

-- Events are staff records. Only ones explicitly flagged here are shown to the
-- community; every existing event defaults to hidden.
ALTER TABLE events ADD COLUMN community_visible INTEGER NOT NULL DEFAULT 0;

-- 2. New tables. ----------------------------------------------------------------
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
  status         TEXT NOT NULL DEFAULT 'draft',   -- draft | published | archived
  published_at   TEXT,
  author_id      TEXT REFERENCES users(id),
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
