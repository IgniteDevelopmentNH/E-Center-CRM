import type { SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, optionalString, optionalUrl, positiveInt, requiredString } from '../lib/validate.ts';
import { requireAuth, requireEditor } from '../middleware/auth.ts';
import { ORG_STATUSES, ORG_TYPES, contactOut, organizationOut } from '../records.ts';
import type { Ctx, Router } from '../router.ts';

const SELECT_ORG = `
  SELECT o.*,
         (SELECT COUNT(*) FROM contact_organizations co
            JOIN contacts c ON c.id = co.contact_id AND c.deleted_at IS NULL
           WHERE co.organization_id = o.id) AS contact_count,
         (SELECT COUNT(*) FROM documents d
            WHERE d.organization_id = o.id AND d.deleted_at IS NULL) AS document_count,
         (SELECT MAX(n.created_at) FROM notes n
            WHERE n.deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM contact_organizations co
                 WHERE co.organization_id = o.id
                   AND (co.contact_id = n.contact_id
                        OR EXISTS (SELECT 1 FROM note_contacts nc
                                    WHERE nc.note_id = n.id AND nc.contact_id = co.contact_id)))) AS last_activity_at
    FROM organizations o`;

const SORTS: Record<string, string> = {
  name: 'LOWER(o.name) ASC',
  name_desc: 'LOWER(o.name) DESC',
  activity: 'CASE WHEN last_activity_at IS NULL THEN 1 ELSE 0 END ASC, last_activity_at DESC',
  people: 'contact_count DESC, LOWER(o.name) ASC',
};

export function register(router: Router): void {
  router.get('/api/organizations', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const where: string[] = ['o.customer_id = ?', 'o.deleted_at IS NULL'];
    const params: SqlParam[] = [customerId];

    const q = ctx.query.get('q');
    if (q && q.trim()) {
      const like = `%${q.trim().toLowerCase()}%`;
      where.push(
        `(LOWER(o.name) LIKE ? OR LOWER(COALESCE(o.location, '')) LIKE ?
          OR LOWER(COALESCE(o.relationship, '')) LIKE ?)`,
      );
      params.push(like, like, like);
    }
    const orgType = ctx.query.get('orgType');
    if (orgType && orgType !== 'all') {
      where.push('o.org_type = ?');
      params.push(oneOf(orgType, 'Type', ORG_TYPES));
    }
    const status = ctx.query.get('status');
    if (status && status !== 'all') {
      where.push('o.status = ?');
      params.push(oneOf(status, 'Status', ORG_STATUSES));
    }

    const clause = where.join(' AND ');
    const sortKey = ctx.query.get('sort') ?? 'name';
    const limit = positiveInt(ctx.query.get('limit'), 20, 200);
    const page = positiveInt(ctx.query.get('page'), 1, 10000);

    const totalRow = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM organizations o WHERE ${clause}`,
      params,
    );
    const rows = await ctx.db.all(
      `${SELECT_ORG} WHERE ${clause} ORDER BY ${SORTS[sortKey] ?? SORTS.name} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );

    const total = Number(totalRow?.total ?? 0);
    return jsonResponse({
      organizations: rows.map(organizationOut),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  });

  /** Detail view: the organization plus every linked person and their role. */
  router.get('/api/organizations/:id', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const row = await ctx.db.get(
      `${SELECT_ORG} WHERE o.id = ? AND o.customer_id = ? AND o.deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!row) throw notFound('That organization no longer exists.');

    const contacts = await ctx.db.all(
      `SELECT c.*, o.name AS organization_name,
              co.org_role AS org_role,
              (SELECT MAX(n.created_at) FROM notes n
                 WHERE n.deleted_at IS NULL
                   AND (n.contact_id = c.id
                        OR EXISTS (SELECT 1 FROM note_contacts nc WHERE nc.note_id = n.id AND nc.contact_id = c.id))) AS last_interaction_at,
              (SELECT json_group_array(json_object('id', org.id, 'name', org.name, 'role', co2.org_role))
                 FROM contact_organizations co2
                 JOIN organizations org ON org.id = co2.organization_id AND org.deleted_at IS NULL
                WHERE co2.contact_id = c.id) AS organizations_json
         FROM contact_organizations co
         JOIN contacts c ON c.id = co.contact_id AND c.deleted_at IS NULL
         LEFT JOIN organizations o ON o.id = c.organization_id
        WHERE co.organization_id = ? AND co.customer_id = ?
        ORDER BY LOWER(c.last_name) ASC, LOWER(c.first_name) ASC`,
      [ctx.params.id!, customerId],
    );

    return jsonResponse({ organization: organizationOut(row), contacts: contacts.map(contactOut) });
  });

  router.post('/api/organizations', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const fields = parseOrganization(body);
    const id = newId();
    const timestamp = nowIso();

    await ctx.db.run(
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

    const row = await ctx.db.get(`${SELECT_ORG} WHERE o.id = ?`, [id]);
    return jsonResponse({ organization: organizationOut(row!) }, { status: 201 });
  });

  router.put('/api/organizations/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get(
      `SELECT id FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That organization no longer exists.');

    const body = await readJson(ctx.req);
    const fields = parseOrganization(body);
    await ctx.db.run(
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
        ctx.params.id!,
        customerId,
      ],
    );

    const row = await ctx.db.get(`${SELECT_ORG} WHERE o.id = ?`, [ctx.params.id!]);
    return jsonResponse({ organization: organizationOut(row!) });
  });

  /** Links an existing contact to this organization, optionally setting their role. */
  router.post('/api/organizations/:id/contacts', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const contactId = requiredString(body.contactId, 'Contact', { max: 64 });
    const orgRole = optionalString(body.orgRole, 'Role', { max: 120 });

    const org = await ctx.db.get(
      `SELECT id FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!org) throw notFound('That organization no longer exists.');

    const contact = await ctx.db.get(
      `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [contactId, customerId],
    );
    if (!contact) throw badRequest('That contact was not found.', 'Contact');

    const existingLink = await ctx.db.get(
      `SELECT id FROM contact_organizations WHERE contact_id = ? AND organization_id = ?`,
      [contactId, ctx.params.id!],
    );
    if (existingLink) throw badRequest('That contact is already linked here.', 'Contact');

    const timestamp = nowIso();
    // Add the membership, and adopt this org as the contact's primary if they had none.
    await ctx.db.batch([
      {
        sql: `INSERT INTO contact_organizations (id, customer_id, contact_id, organization_id, org_role, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [newId(), customerId, contactId, ctx.params.id!, orgRole, timestamp],
      },
      {
        sql: `UPDATE contacts SET organization_id = ?, org_role = ?, updated_at = ?, last_edited_by = ?
                WHERE id = ? AND customer_id = ? AND organization_id IS NULL`,
        params: [ctx.params.id!, orgRole, timestamp, userId, contactId, customerId],
      },
    ]);
    return jsonResponse({ ok: true });
  });

  router.delete('/api/organizations/:id/contacts/:contactId', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const timestamp = nowIso();
    const orgId = ctx.params.id!;
    const contactId = ctx.params.contactId!;
    // Remove the membership; if it was the primary org, repoint to another (or none).
    await ctx.db.batch([
      {
        sql: `DELETE FROM contact_organizations WHERE contact_id = ? AND organization_id = ? AND customer_id = ?`,
        params: [contactId, orgId, customerId],
      },
      {
        sql: `UPDATE contacts SET
                 organization_id = (SELECT co.organization_id FROM contact_organizations co
                                      WHERE co.contact_id = ? ORDER BY co.created_at ASC LIMIT 1),
                 org_role = (SELECT co.org_role FROM contact_organizations co
                               WHERE co.contact_id = ? ORDER BY co.created_at ASC LIMIT 1),
                 updated_at = ?, last_edited_by = ?
               WHERE id = ? AND customer_id = ? AND organization_id = ?`,
        params: [contactId, contactId, timestamp, userId, contactId, customerId, orgId],
      },
    ]);
    return jsonResponse({ ok: true });
  });

  router.delete('/api/organizations/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get<{ name: string }>(
      `SELECT name FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That organization no longer exists.');

    const timestamp = nowIso();
    const orgId = ctx.params.id!;
    // Contacts survive the organization; their membership here is removed and any
    // whose primary org was this one are repointed to another membership (or none).
    await ctx.db.batch([
      {
        sql: `UPDATE organizations SET deleted_at = ?, updated_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
        params: [timestamp, timestamp, userId, orgId, customerId],
      },
      {
        sql: `UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE organization_id = ? AND deleted_at IS NULL`,
        params: [timestamp, userId, orgId],
      },
      {
        sql: `DELETE FROM contact_organizations WHERE organization_id = ? AND customer_id = ?`,
        params: [orgId, customerId],
      },
      {
        sql: `UPDATE contacts SET
                 organization_id = (SELECT co.organization_id FROM contact_organizations co
                                      WHERE co.contact_id = contacts.id ORDER BY co.created_at ASC LIMIT 1),
                 org_role = (SELECT co.org_role FROM contact_organizations co
                               WHERE co.contact_id = contacts.id ORDER BY co.created_at ASC LIMIT 1),
                 updated_at = ?
               WHERE organization_id = ? AND customer_id = ?`,
        params: [timestamp, orgId, customerId],
      },
    ]);

    await audit(ctx.db, {
      customerId,
      userId,
      action: 'organization.delete',
      entityType: 'organization',
      entityId: ctx.params.id!,
      metadata: { name: existing.name },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });
}

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
