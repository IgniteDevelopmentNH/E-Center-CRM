-- Migration: community portal v4 -- student school details, event icons,
-- registration questions, guest RSVPs, organization history, and performance
-- indexes.
--
-- Purely ADDITIVE: new columns (all defaulted), new tables and new indexes.
-- Nothing existing is rewritten or dropped.
--
-- Apply ONCE, after 2026-10-28-community-v3.sql and BEFORE deploying the
-- matching Worker build:
--
--   npx wrangler d1 execute ecenter-crm --remote --yes \
--     --file=./worker/src/db/migrations/2026-11-08-community-v4.sql
--
-- The ALTER TABLE lines are not repeatable: "duplicate column name" means it
-- was already applied.

-- 1. Columns on existing tables. ----------------------------------------------

-- Students say where they study when they complete signup.
ALTER TABLE community_profiles ADD COLUMN school_type TEXT;                 -- unh | other
ALTER TABLE community_profiles ADD COLUMN school_name TEXT;                 -- when school_type = other

-- Event options on event posts.
ALTER TABLE posts ADD COLUMN rsvp_guests INTEGER NOT NULL DEFAULT 0;        -- guests without an account may RSVP
ALTER TABLE posts ADD COLUMN event_icons TEXT NOT NULL DEFAULT '[]';        -- JSON array of icon keys
ALTER TABLE posts ADD COLUMN rsvp_questions TEXT NOT NULL DEFAULT '[]';     -- JSON array of registration questions

-- The same options on CRM events shown in the portal.
ALTER TABLE events ADD COLUMN community_rsvp_guests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN community_icons TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN community_questions TEXT NOT NULL DEFAULT '[]';

-- Answers to an event's registration questions.
ALTER TABLE event_rsvps ADD COLUMN answers_json TEXT NOT NULL DEFAULT '{}';

-- 2. New tables. ----------------------------------------------------------------
-- ===========================================================================
-- Community portal v4: guest RSVPs and organization history.
-- ===========================================================================

-- RSVPs from people without an account, on events that allow them.
CREATE TABLE IF NOT EXISTS event_guest_rsvps (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  target_type  TEXT NOT NULL,                  -- post | event
  target_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,                  -- trimmed + lowercased
  over21_confirmed INTEGER NOT NULL DEFAULT 0,
  answers_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (target_type, target_id, email)
);

-- Organizations a contact used to belong to. The name is kept as text so the
-- history survives the organization itself being deleted.
CREATE TABLE IF NOT EXISTS contact_org_history (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  contact_id        TEXT NOT NULL REFERENCES contacts(id),
  organization_id   TEXT REFERENCES organizations(id),
  organization_name TEXT NOT NULL,
  org_role          TEXT,
  joined_at         TEXT,
  left_at           TEXT NOT NULL,
  recorded_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_org_history_contact ON contact_org_history(contact_id, left_at);

-- 3. Indexes for the busiest queries. ------------------------------------------

CREATE INDEX IF NOT EXISTS idx_posts_events ON posts(customer_id, status, event_starts_at);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
CREATE INDEX IF NOT EXISTS idx_orgs_name_norm ON organizations(customer_id, lower(trim(name)));
