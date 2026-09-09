import { Router } from 'express';
import type { SqlParam } from '../db/index.ts';
import { getDb } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound, route } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import {
  oneOf,
  optionalString,
  optionalUrl,
  positiveInt,
  requiredString,
} from '../lib/validate.ts';
import { auth, requireAuth, requireEditor } from '../middleware/auth.ts';
import { ORG_STATUSES, ORG_TYPES, contactOut, organizationOut } from '../records.ts';

export const organizationsRouter = Router();
organizationsRouter.use(requireAuth);

const SELECT_ORG = `
  SELECT o.*,
         (SELECT COUNT(*) FROM contacts c
            WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS contact_count,
         (SELECT COUNT(*) FROM documents d
            WHERE d.organization_id = o.id AND d.deleted_at IS NULL) AS document_count,
         (SELECT MAX(n.created_at) FROM notes n
            JOIN contacts c2 ON c2.id = n.contact_id
            WHERE c2.organization_id = o.id AND n.deleted_at IS NULL) AS last_activity_at
    FROM organizations o`;

const SORTS: Record<string, string> = {
  name: 'LOWER(o.name) ASC',
  name_desc: 'LOWER(o.name) DESC',
  activity: 'CASE WHEN last_activity_at IS NULL THEN 1 ELSE 0 END ASC, last_activity_at DESC',
  people: 'contact_count DESC, LOWER(o.name) ASC',
};

organizationsRouter.get(
  '/',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const where: string[] = ['o.customer_id = ?', 'o.deleted_at IS NULL'];
    const params: SqlParam[] = [customerId];

    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const like = `%${req.query.q.trim().toLowerCase()}%`;
      where.push(
        `(LOWER(o.name) LIKE ? OR LOWER(COALESCE(o.location, '')) LIKE ?
          OR LOWER(COALESCE(o.relationship, '')) LIKE ?)`,
      );
      params.push(like, like, like);
    }
    if (typeof req.query.orgType === 'string' && req.query.orgType && req.query.orgType !== 'all') {
      where.push('o.org_type = ?');
      params.push(oneOf(req.query.orgType, 'Type', ORG_TYPES));
    }
    if (typeof req.query.status === 'string' && req.query.status && req.query.status !== 'all') {
      where.push('o.status = ?');
      params.push(oneOf(req.query.status, 'Status', ORG_STATUSES));
    }

    const clause = where.join(' AND ');
    const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'name';
    const limit = positiveInt(req.query.limit, 20, 200);
    const page = positiveInt(req.query.page, 1, 10000);

    const totalRow = await db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM organizations o WHERE ${clause}`,
      params,
    );
    const rows = await db.all(
      `${SELECT_ORG} WHERE ${clause} ORDER BY ${SORTS[sortKey] ?? SORTS.name} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );

    const total = Number(totalRow?.total ?? 0);
    res.json({
      organizations: rows.map(organizationOut),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  }),
);

/** Detail view: the organization plus every linked person and their role. */
organizationsRouter.get(
  '/:id',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const row = await db.get(
      `${SELECT_ORG} WHERE o.id = ? AND o.customer_id = ? AND o.deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!row) throw notFound('That organization no longer exists.');

    const contacts = await db.all(
      `SELECT c.*, o.name AS organization_name,
              (SELECT MAX(n.created_at) FROM notes n
                 WHERE n.contact_id = c.id AND n.deleted_at IS NULL) AS last_interaction_at
         FROM contacts c
         LEFT JOIN organizations o ON o.id = c.organization_id
        WHERE c.organization_id = ? AND c.customer_id = ? AND c.deleted_at IS NULL
        ORDER BY LOWER(c.last_name) ASC, LOWER(c.first_name) ASC`,
      [req.params.id!, customerId],
    );

    res.json({ organization: organizationOut(row), contacts: contacts.map(contactOut) });
  }),
);

function parseOrganization(body: Record<string, unknown>) {
  return {
    name: requiredString(body.name, 'Organization name', { max: 200 }),
    orgType: oneOf(body.orgType, 'Type', ORG_TYPES, 'other'),
    location: optionalString(body.location, 'Location', { max: 200 }),
    website: optionalUrl(body.website, 'Website'),
    relationship: optionalString(body.relationship, 'Our relationship', { max: 5000 }),
    status: oneOf(body.status, 'Status', ORG_STATUSES, 'active'),
  };
}

organizationsRouter.post(
  '/',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const fields = parseOrganization((req.body ?? {}) as Record<string, unknown>);
    const db = await getDb();
    const id = newId();
    const timestamp = nowIso();

    await db.run(
      `INSERT INTO organizations
         (id, customer_id, name, org_type, location, website, relationship, status,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customerId,
        fields.name,
        fields.orgType,
        fields.location,
        fields.website,
        fields.relationship,
        fields.status,
        timestamp,
        timestamp,
        userId,
        userId,
      ],
    );

    const row = await db.get(`${SELECT_ORG} WHERE o.id = ?`, [id]);
    res.status(201).json({ organization: organizationOut(row!) });
  }),
);

organizationsRouter.put(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get(
      `SELECT id FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That organization no longer exists.');

    const fields = parseOrganization((req.body ?? {}) as Record<string, unknown>);
    await db.run(
      `UPDATE organizations SET
         name = ?, org_type = ?, location = ?, website = ?, relationship = ?, status = ?,
         updated_at = ?, last_edited_by = ?
       WHERE id = ? AND customer_id = ?`,
      [
        fields.name,
        fields.orgType,
        fields.location,
        fields.website,
        fields.relationship,
        fields.status,
        nowIso(),
        userId,
        req.params.id!,
        customerId,
      ],
    );

    const row = await db.get(`${SELECT_ORG} WHERE o.id = ?`, [req.params.id!]);
    res.json({ organization: organizationOut(row!) });
  }),
);

/** Links an existing contact to this organization, optionally setting their role. */
organizationsRouter.post(
  '/:id/contacts',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const contactId = requiredString(req.body?.contactId, 'Contact', { max: 64 });
    const orgRole = optionalString(req.body?.orgRole, 'Role', { max: 120 });

    const org = await db.get(
      `SELECT id FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!org) throw notFound('That organization no longer exists.');

    const contact = await db.get(
      `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [contactId, customerId],
    );
    if (!contact) throw badRequest('That contact was not found.', 'Contact');

    await db.run(
      `UPDATE contacts SET organization_id = ?, org_role = ?, updated_at = ?, last_edited_by = ?
        WHERE id = ? AND customer_id = ?`,
      [req.params.id!, orgRole, nowIso(), userId, contactId, customerId],
    );
    res.json({ ok: true });
  }),
);

organizationsRouter.delete(
  '/:id/contacts/:contactId',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    await db.run(
      `UPDATE contacts SET organization_id = NULL, org_role = NULL, updated_at = ?, last_edited_by = ?
        WHERE id = ? AND organization_id = ? AND customer_id = ?`,
      [nowIso(), userId, req.params.contactId!, req.params.id!, customerId],
    );
    res.json({ ok: true });
  }),
);

organizationsRouter.delete(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get<{ name: string }>(
      `SELECT name FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That organization no longer exists.');

    const timestamp = nowIso();
    await db.tx(async (tx) => {
      await tx.run(
        `UPDATE organizations SET deleted_at = ?, updated_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
        [timestamp, timestamp, userId, req.params.id!, customerId],
      );
      // Contacts survive the organization; only the link is cleared so their
      // cards do not point at a record that is no longer visible.
      await tx.run(
        `UPDATE contacts SET organization_id = NULL, org_role = NULL, updated_at = ?
          WHERE organization_id = ? AND customer_id = ?`,
        [timestamp, req.params.id!, customerId],
      );
    });

    await audit(db, {
      customerId,
      userId,
      action: 'organization.delete',
      entityType: 'organization',
      entityId: req.params.id!,
      metadata: { name: existing.name },
      req,
    });
    res.json({ ok: true });
  }),
);
