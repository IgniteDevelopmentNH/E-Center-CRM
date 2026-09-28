-- Migration: multi-organization contacts, multi/zero-contact notes, note attachments.
--
-- Apply ONCE to an existing production D1 database that predates these features,
-- BEFORE (or right after) deploying the matching Worker build:
--
--   npx wrangler d1 execute ecenter-crm --remote \
--     --file=./worker/src/db/migrations/2026-09-28-multi-links-and-attachments.sql
--
-- Fresh databases created from worker/src/db/schema.sql already include everything
-- here and should NOT run this file.
--
-- D1 notes:
--   * No PRAGMA foreign_keys toggling -- D1 does not honor it via `d1 execute`.
--   * The notes table is rebuilt (to drop NOT NULL on contact_id) BEFORE note_contacts
--     and documents.note_id exist, so nothing references notes when it is dropped.
--   * Run this file exactly once.

-- 1. Contact <-> organization membership (many-to-many). ----------------------
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

-- Backfill one membership per existing contact that already has a primary org.
INSERT INTO contact_organizations (id, customer_id, contact_id, organization_id, org_role, created_at)
SELECT lower(hex(randomblob(16))), c.customer_id, c.id, c.organization_id, c.org_role, c.created_at
  FROM contacts c
 WHERE c.organization_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM contact_organizations co
      WHERE co.contact_id = c.id AND co.organization_id = c.organization_id);

-- 2. Allow a note to have no contact (drop NOT NULL on notes.contact_id). ------
-- Done before note_contacts / documents.note_id exist so no FK references notes.
CREATE TABLE notes_new (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  contact_id     TEXT REFERENCES contacts(id),
  note_type      TEXT NOT NULL DEFAULT 'other',
  content        TEXT NOT NULL,
  tags           TEXT NOT NULL DEFAULT '[]',
  source         TEXT NOT NULL DEFAULT 'manual',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  created_by     TEXT,
  last_edited_by TEXT
);
INSERT INTO notes_new
  SELECT id, customer_id, contact_id, note_type, content, tags, source,
         created_at, updated_at, deleted_at, created_by, last_edited_by
    FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;
CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_customer ON notes(customer_id, created_at);

-- 3. Note <-> contact links (many-to-many). ----------------------------------
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

-- Backfill one link per existing note from its current contact_id.
INSERT INTO note_contacts (id, customer_id, note_id, contact_id, created_at)
SELECT lower(hex(randomblob(16))), n.customer_id, n.id, n.contact_id, n.created_at
  FROM notes n
 WHERE n.contact_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM note_contacts nc
      WHERE nc.note_id = n.id AND nc.contact_id = n.contact_id);

-- 4. Attachments on notes. ---------------------------------------------------
ALTER TABLE documents ADD COLUMN note_id TEXT REFERENCES notes(id);
CREATE INDEX IF NOT EXISTS idx_documents_organization ON documents(organization_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_documents_note ON documents(note_id, deleted_at);
