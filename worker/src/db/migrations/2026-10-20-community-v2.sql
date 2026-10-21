-- Migration: community portal v2 -- member posting with approval, comments,
-- likes, @mentions, event RSVPs, public resumes, email notifications.
--
-- Purely ADDITIVE: new columns (all nullable or defaulted) and new tables.
-- No existing row is rewritten and nothing is dropped.
--
-- Apply ONCE to a database that already has 2026-10-12-community-portal.sql,
-- BEFORE deploying the matching Worker build:
--
--   npx wrangler d1 execute ecenter-crm --remote \
--     --file=./worker/src/db/migrations/2026-10-20-community-v2.sql
--
-- Fresh databases created from worker/src/db/schema.sql already include all
-- of this. The ALTER TABLE lines are not repeatable (SQLite has no
-- ADD COLUMN IF NOT EXISTS): if a run reports "duplicate column name", the
-- migration was already applied -- check before re-running.

-- 1. Columns on existing tables. ----------------------------------------------

-- Posting permission per member: NULL = the default for their account type
-- (students cannot post; mentors post with approval). Otherwise
-- 'none' | 'approval' | 'direct', set by staff in Admin > Members.
ALTER TABLE community_accounts ADD COLUMN post_permission TEXT;
-- Members choose whether their (otherwise private) resume shows on their profile.
ALTER TABLE community_accounts ADD COLUMN resume_public INTEGER NOT NULL DEFAULT 0;
-- Email notification preferences (each can be turned off from the profile
-- page or a one-click unsubscribe link).
ALTER TABLE community_accounts ADD COLUMN notify_messages INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_accounts ADD COLUMN notify_mentions INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_accounts ADD COLUMN notify_announcements INTEGER NOT NULL DEFAULT 1;

-- Featured topics show first; the rest appear behind "See more".
ALTER TABLE interest_tags ADD COLUMN featured INTEGER NOT NULL DEFAULT 1;

-- Posts can now be written by members, reviewed by staff, and carry event details.
ALTER TABLE posts ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'staff';   -- staff | member
ALTER TABLE posts ADD COLUMN review_note TEXT;                            -- reason shown to the author on rejection
ALTER TABLE posts ADD COLUMN reviewed_by TEXT REFERENCES users(id);
ALTER TABLE posts ADD COLUMN reviewed_at TEXT;
ALTER TABLE posts ADD COLUMN event_starts_at TEXT;                        -- set when the post is an event
ALTER TABLE posts ADD COLUMN event_ends_at TEXT;
ALTER TABLE posts ADD COLUMN event_location TEXT;
ALTER TABLE posts ADD COLUMN rsvp_enabled INTEGER NOT NULL DEFAULT 0;     -- "I'll be there!" button
ALTER TABLE posts ADD COLUMN notified_at TEXT;                            -- members were emailed about it
ALTER TABLE posts ADD COLUMN deleted_by TEXT REFERENCES users(id);

-- CRM events shown in the portal can carry a public description and RSVPs.
ALTER TABLE events ADD COLUMN community_details TEXT;
ALTER TABLE events ADD COLUMN community_rsvp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN community_notified_at TEXT;

-- 2. New tables. ----------------------------------------------------------------
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
