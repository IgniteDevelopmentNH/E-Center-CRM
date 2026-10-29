-- Migration: community portal v3 -- event options, guest browsing, blocked
-- emails, groups, businesses, competitions, and staff in the directory.
--
-- Purely ADDITIVE: new columns (all defaulted) and new tables, plus two data
-- inserts that only ADD rows (staff community identities, blocked emails for
-- already-deactivated members). Nothing existing is rewritten or dropped.
--
-- Apply ONCE, after 2026-10-20-community-v2.sql and BEFORE deploying the
-- matching Worker build:
--
--   npx wrangler d1 execute ecenter-crm --remote --yes \
--     --file=./worker/src/db/migrations/2026-10-28-community-v3.sql
--
-- The ALTER TABLE lines are not repeatable: "duplicate column name" means it
-- was already applied.

-- 1. Columns on existing tables. ----------------------------------------------

-- Event options on event posts.
ALTER TABLE posts ADD COLUMN event_age21 INTEGER NOT NULL DEFAULT 0;        -- 21+: RSVPs must confirm "I'm over 21"
ALTER TABLE posts ADD COLUMN rsvp_list_public INTEGER NOT NULL DEFAULT 0;   -- members can see who is going
-- Visibility: guests (no account) see a post only if guest_visible = 1 AND it
-- is for everyone (not group-only).
ALTER TABLE posts ADD COLUMN guest_visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE posts ADD COLUMN audience TEXT NOT NULL DEFAULT 'everyone';    -- everyone | groups

-- The same event options on CRM events shown in the portal.
ALTER TABLE events ADD COLUMN community_age21 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN community_rsvp_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN community_guest_visible INTEGER NOT NULL DEFAULT 1;

-- RSVPs to a 21+ event record the attendee's "I'm over 21" confirmation.
ALTER TABLE event_rsvps ADD COLUMN over21_confirmed INTEGER NOT NULL DEFAULT 0;

-- Staff can let individual members create (and so moderate) groups.
ALTER TABLE community_accounts ADD COLUMN group_permission TEXT;           -- NULL/none | create

-- 2. New tables. ----------------------------------------------------------------
-- ===========================================================================
-- Community portal v3: blocked emails, groups, businesses, competitions.
-- ===========================================================================

-- Emails that may not sign up again. Added when staff remove (deactivate) a
-- member; removed when staff unblock them from Admin > Settings.
CREATE TABLE IF NOT EXISTS blocked_emails (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  email       TEXT NOT NULL,                  -- trimmed + lowercased
  user_id     TEXT REFERENCES users(id),      -- the removed account, if any
  reason      TEXT,
  blocked_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  UNIQUE (customer_id, email)
);

-- Interest groups. Members join public groups directly; private groups need a
-- moderator to approve a request. Group-only posts appear only in their groups.
CREATE TABLE IF NOT EXISTS community_groups (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  privacy     TEXT NOT NULL DEFAULT 'public', -- public | private
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (customer_id, slug)
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id     TEXT NOT NULL REFERENCES community_groups(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  role         TEXT NOT NULL DEFAULT 'member',  -- member | moderator
  status       TEXT NOT NULL DEFAULT 'active',  -- active | pending (join request)
  requested_at TEXT NOT NULL,
  joined_at    TEXT,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id, status);

-- Which groups a group-only post (posts.audience = 'groups') is shared to.
CREATE TABLE IF NOT EXISTS post_groups (
  post_id     TEXT NOT NULL REFERENCES posts(id),
  group_id    TEXT NOT NULL REFERENCES community_groups(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  PRIMARY KEY (post_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_post_groups_group ON post_groups(group_id);

-- Member-owned business profiles.
CREATE TABLE IF NOT EXISTS businesses (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  owner_id      TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  tagline       TEXT,
  description   TEXT,
  industry      TEXT,
  website       TEXT,
  location      TEXT,
  hiring        INTEGER NOT NULL DEFAULT 0,
  hiring_details TEXT,
  networking    INTEGER NOT NULL DEFAULT 0,
  looking_for   TEXT,
  logo_key      TEXT,
  logo_type     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  deleted_by    TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_businesses_customer ON businesses(customer_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses(owner_id);

CREATE TABLE IF NOT EXISTS business_photos (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  image_key   TEXT NOT NULL,
  image_type  TEXT NOT NULL,
  caption     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_photos_business ON business_photos(business_id, created_at);

-- ECenter competitions. Each deadline also appears in Upcoming events.
CREATE TABLE IF NOT EXISTS competitions (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  title        TEXT NOT NULL,
  summary      TEXT,
  description  TEXT,
  prize        TEXT,
  eligibility  TEXT,
  link_url     TEXT,
  image_key    TEXT,
  image_type   TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | published | archived
  published_at TEXT,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_competitions_customer ON competitions(customer_id, status, deleted_at);

CREATE TABLE IF NOT EXISTS competition_deadlines (
  id             TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id),
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  label          TEXT NOT NULL,
  due_at         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_competition_deadlines_due ON competition_deadlines(customer_id, due_at);

-- 3. Data (inserts only). --------------------------------------------------------

-- Every existing staff user gets an active "ECenter staff" community identity,
-- so they appear under ECenter staff in the Network directory. Names are split
-- at the first space. (New staff get one automatically from the app.)
INSERT INTO community_accounts
  (user_id, customer_id, account_type, status, onboarding_completed_at, activated_at, link_state, created_at, updated_at)
SELECT u.id, u.customer_id, 'staff', 'active',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'not_applicable',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM users u
 WHERE u.role IN ('owner', 'editor', 'viewer') AND u.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM community_accounts ca WHERE ca.user_id = u.id);

INSERT INTO community_profiles (user_id, customer_id, first_name, last_name, updated_at)
SELECT u.id, u.customer_id,
       CASE WHEN instr(trim(u.name), ' ') > 0 THEN substr(trim(u.name), 1, instr(trim(u.name), ' ') - 1) ELSE trim(u.name) END,
       CASE WHEN instr(trim(u.name), ' ') > 0 THEN trim(substr(trim(u.name), instr(trim(u.name), ' ') + 1)) ELSE '' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM users u
 WHERE u.role IN ('owner', 'editor', 'viewer') AND u.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM community_profiles p WHERE p.user_id = u.id);

-- Members who were already removed stay blocked from signing up again.
INSERT OR IGNORE INTO blocked_emails (id, customer_id, email, user_id, reason, blocked_by, created_at)
SELECT lower(hex(randomblob(16))), ca.customer_id, lower(trim(u.email)), u.id, ca.deactivation_reason, ca.deactivated_by,
       COALESCE(ca.deactivated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM community_accounts ca JOIN users u ON u.id = ca.user_id
 WHERE ca.status = 'deactivated' AND u.role = 'member';
