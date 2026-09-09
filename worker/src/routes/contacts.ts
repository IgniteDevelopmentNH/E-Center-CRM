import type { SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { csvFilename, toCsv } from '../lib/csv.ts';
import { badRequest, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import {
  flag,
  oneOf,
  optionalId,
  optionalString,
  positiveInt,
  requiredEmail,
  requiredString,
  tagList,
} from '../lib/validate.ts';
import { requireAuth, requireEditor } from '../middleware/auth.ts';
import { CONTACT_STATUSES, contactOut } from '../records.ts';
import type { Ctx, Router } from '../router.ts';

/**
 * Aggregates every contact card needs in one pass: linked organization,
 * last interaction (newest note), the note snippet, and badge counts.
 */
const SELECT_CONTACT = `
  SELECT c.*,
         o.name AS organization_name,
         creator.name AS created_by_name,
         (SELECT MAX(n.created_at) FROM notes n
            WHERE n.contact_id = c.id AND n.deleted_at IS NULL) AS last_interaction_at,
         (SELECT COUNT(*) FROM notes n
            WHERE n.contact_id = c.id AND n.deleted_at IS NULL) AS note_count,
         (SELECT COUNT(*) FROM tasks t
            WHERE t.contact_id = c.id AND t.deleted_at IS NULL AND t.status <> 'complete') AS open_task_count,
         (SELECT COUNT(*) FROM documents d
            WHERE d.contact_id = c.id AND d.deleted_at IS NULL) AS document_count,
         (SELECT n.content FROM notes n
            WHERE n.contact_id = c.id AND n.deleted_at IS NULL
            ORDER BY n.created_at DESC LIMIT 1) AS latest_note
    FROM contacts c
    LEFT JOIN organizations o ON o.id = c.organization_id
    LEFT JOIN users creator ON creator.id = c.created_by`;

const SORTS: Record<string, string> = {
  name: 'LOWER(c.last_name) ASC, LOWER(c.first_name) ASC',
  name_desc: 'LOWER(c.last_name) DESC, LOWER(c.first_name) DESC',
  added: 'c.created_at DESC',
  added_asc: 'c.created_at ASC',
  interaction: 'CASE WHEN last_interaction_at IS NULL THEN 1 ELSE 0 END ASC, last_interaction_at DESC',
  interaction_asc: 'CASE WHEN last_interaction_at IS NULL THEN 1 ELSE 0 END ASC, last_interaction_at ASC',
};

/** Shared WHERE builder for the list and CSV export endpoints. */
function buildFilters(customerId: string, query: URLSearchParams) {
  const where: string[] = ['c.customer_id = ?', 'c.deleted_at IS NULL'];
  const params: SqlParam[] = [customerId];

  const q = (query.get('q') ?? '').trim().toLowerCase();
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(LOWER(c.first_name) LIKE ? OR LOWER(c.last_name) LIKE ? OR LOWER(c.email) LIKE ?
        OR LOWER(c.tags) LIKE ? OR LOWER(COALESCE(o.name, '')) LIKE ?
        OR LOWER(COALESCE(c.how_we_connected, '')) LIKE ?)`,
    );
    params.push(like, like, like, like, like, like);
  }

  const status = query.get('status');
  if (status && status !== 'all') {
    where.push('c.status = ?');
    params.push(oneOf(status, 'Status', CONTACT_STATUSES));
  }

  const tag = query.get('tag');
  if (tag && tag !== 'all') {
    // Tags are a JSON array in TEXT; match the quoted member to avoid partial hits.
    where.push('LOWER(c.tags) LIKE ?');
    params.push(`%"${tag.toLowerCase()}"%`);
  }

  const organizationId = query.get('organizationId');
  if (organizationId) {
    where.push('c.organization_id = ?');
    params.push(organizationId);
  }

  if (query.get('studentFoundersOnly') === 'true') where.push('c.is_student_founder = 1');

  const interactionFrom = query.get('interactionFrom');
  if (interactionFrom) {
    where.push(
      `(SELECT MAX(n.created_at) FROM notes n WHERE n.contact_id = c.id AND n.deleted_at IS NULL) >= ?`,
    );
    params.push(`${interactionFrom}T00:00:00.000Z`);
  }
  const interactionTo = query.get('interactionTo');
  if (interactionTo) {
    where.push(
      `(SELECT MAX(n.created_at) FROM notes n WHERE n.contact_id = c.id AND n.deleted_at IS NULL) <= ?`,
    );
    params.push(`${interactionTo}T23:59:59.999Z`);
  }

  return { clause: where.join(' AND '), params };
}

export function register(router: Router): void {
  router.get('/api/contacts', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const { clause, params } = buildFilters(customerId, ctx.query);

    const sortKey = ctx.query.get('sort') ?? 'name';
    const orderBy = SORTS[sortKey] ?? SORTS.name;
    const limit = positiveInt(ctx.query.get('limit'), 20, 200);
    const page = positiveInt(ctx.query.get('page'), 1, 10000);

    const totalRow = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM contacts c
         LEFT JOIN organizations o ON o.id = c.organization_id
        WHERE ${clause}`,
      params,
    );
    const rows = await ctx.db.all(
      `${SELECT_CONTACT} WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );

    const total = Number(totalRow?.total ?? 0);
    return jsonResponse({
      contacts: rows.map(contactOut),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  });

  /** Tag and organization values in use, for populating filter dropdowns. */
  router.get('/api/contacts/facets', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const rows = await ctx.db.all<{ tags: string }>(
      `SELECT tags FROM contacts WHERE customer_id = ? AND deleted_at IS NULL`,
      [customerId],
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      try {
        for (const tag of JSON.parse(row.tags) as string[]) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      } catch {
        // A malformed tags cell should not break the whole facet list.
      }
    }
    return jsonResponse({
      tags: [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    });
  });

  router.get('/api/contacts/export.csv', async (ctx: Ctx) => {
    const { customerId, userId } = requireAuth(ctx);
    const { clause, params } = buildFilters(customerId, ctx.query);
    const rows = await ctx.db.all(`${SELECT_CONTACT} WHERE ${clause} ORDER BY ${SORTS.name}`, params);
    const contacts = rows.map(contactOut);

    await audit(ctx.db, {
      customerId,
      userId,
      action: 'export.csv',
      entityType: 'contacts',
      metadata: { count: contacts.length },
      req: ctx.req,
    });

    const csv = toCsv(
      contacts.map((c) => ({ ...c, tags: c.tags.join('; ') })),
      [
        { key: 'firstName', label: 'First name' },
        { key: 'lastName', label: 'Last name' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'organizationName', label: 'Organization' },
        { key: 'orgRole', label: 'Role' },
        { key: 'tags', label: 'Tags' },
        { key: 'status', label: 'Status' },
        { key: 'isStudentFounder', label: 'Student founder' },
        { key: 'howWeConnected', label: 'How we connected' },
        { key: 'lastInteractionAt', label: 'Last interaction' },
        { key: 'noteCount', label: 'Notes' },
        { key: 'dateAdded', label: 'Date added' },
      ],
    );

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename('ecenter-contacts')}"`,
      },
    });
  });

  router.get('/api/contacts/:id', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const row = await ctx.db.get(
      `${SELECT_CONTACT} WHERE c.id = ? AND c.customer_id = ? AND c.deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!row) throw notFound('That contact no longer exists.');
    return jsonResponse({ contact: contactOut(row) });
  });

  router.post('/api/contacts', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const fields = await parseContact(ctx, body, customerId);
    const id = newId();
    const timestamp = nowIso();

    await ctx.db.run(
      `INSERT INTO contacts
         (id, customer_id, first_name, last_name, email, phone, how_we_connected, tags,
          organization_id, org_role, status, is_student_founder,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customerId,
        fields.firstName,
        fields.lastName,
        fields.email,
        fields.phone,
        fields.howWeConnected,
        fields.tags,
        fields.organizationId,
        fields.orgRole,
        fields.status,
        fields.isStudentFounder,
        timestamp,
        timestamp,
        userId,
        userId,
      ],
    );

    const row = await ctx.db.get(`${SELECT_CONTACT} WHERE c.id = ?`, [id]);
    return jsonResponse({ contact: contactOut(row!) }, { status: 201 });
  });

  router.put('/api/contacts/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get(
      `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That contact no longer exists.');

    const body = await readJson(ctx.req);
    const fields = await parseContact(ctx, body, customerId);
    await ctx.db.run(
      `UPDATE contacts SET
         first_name = ?, last_name = ?, email = ?, phone = ?, how_we_connected = ?, tags = ?,
         organization_id = ?, org_role = ?, status = ?, is_student_founder = ?,
         updated_at = ?, last_edited_by = ?
       WHERE id = ? AND customer_id = ?`,
      [
        fields.firstName,
        fields.lastName,
        fields.email,
        fields.phone,
        fields.howWeConnected,
        fields.tags,
        fields.organizationId,
        fields.orgRole,
        fields.status,
        fields.isStudentFounder,
        nowIso(),
        userId,
        ctx.params.id!,
        customerId,
      ],
    );

    const row = await ctx.db.get(`${SELECT_CONTACT} WHERE c.id = ?`, [ctx.params.id!]);
    return jsonResponse({ contact: contactOut(row!) });
  });

  /** Adds and/or removes tags across many contacts in one request. */
  router.post('/api/contacts/bulk-tags', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const ids = Array.isArray(body.ids)
      ? (body.ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];
    if (!ids.length) throw badRequest('Select at least one contact.', 'Contacts');

    const add = tagList(body.add, 'Tags to add');
    const remove = tagList(body.remove, 'Tags to remove');
    if (!add.length && !remove.length) throw badRequest('Choose at least one tag to add or remove.', 'Tags');

    let updated = 0;
    const timestamp = nowIso();

    for (const id of ids) {
      const row = await ctx.db.get<{ tags: string }>(
        `SELECT tags FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
        [id, customerId],
      );
      if (!row) continue;

      let tags: string[] = [];
      try {
        tags = JSON.parse(row.tags) as string[];
      } catch {
        tags = [];
      }
      const next = [...new Set([...tags.filter((t) => !remove.includes(t)), ...add])];
      await ctx.db.run(
        `UPDATE contacts SET tags = ?, is_student_founder = ?, updated_at = ?, last_edited_by = ?
          WHERE id = ? AND customer_id = ?`,
        [JSON.stringify(next), next.includes('Student Founder') ? 1 : 0, timestamp, userId, id, customerId],
      );
      updated += 1;
    }

    return jsonResponse({ updated });
  });

  /** Soft delete. The row is retained for the audit trail and simply stops being returned. */
  router.delete('/api/contacts/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get<{ first_name: string; last_name: string }>(
      `SELECT first_name, last_name FROM contacts
        WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That contact no longer exists.');

    const timestamp = nowIso();
    // Cascades the soft delete atomically so the timeline and task lists stay consistent.
    await ctx.db.batch([
      {
        sql: `UPDATE contacts SET deleted_at = ?, updated_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
        params: [timestamp, timestamp, userId, ctx.params.id!, customerId],
      },
      {
        sql: `UPDATE notes SET deleted_at = ? WHERE contact_id = ? AND deleted_at IS NULL`,
        params: [timestamp, ctx.params.id!],
      },
      {
        sql: `UPDATE tasks SET deleted_at = ? WHERE contact_id = ? AND deleted_at IS NULL`,
        params: [timestamp, ctx.params.id!],
      },
    ]);

    await audit(ctx.db, {
      customerId,
      userId,
      action: 'contact.delete',
      entityType: 'contact',
      entityId: ctx.params.id!,
      metadata: { name: `${existing.first_name} ${existing.last_name}` },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });
}

/** Shared field parsing for create and update. */
async function parseContact(ctx: Ctx, body: Record<string, unknown>, customerId: string) {
  const tags = tagList(body.tags);
  const organizationId = optionalId(body.organizationId, 'Organization');

  if (organizationId) {
    const org = await ctx.db.get(
      `SELECT id FROM organizations WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [organizationId, customerId],
    );
    if (!org) throw badRequest('That organization was not found.', 'Organization');
  }

  // "Student Founder" is a business relationship, not a student record: the schema
  // deliberately has no student fields (no ID, major, class year, advisor), so a
  // founder is stored the same way any other business contact is.
  const isStudentFounder = flag(body.isStudentFounder) === 1 || tags.includes('Student Founder');

  return {
    firstName: requiredString(body.firstName, 'First name', { max: 100 }),
    lastName: requiredString(body.lastName, 'Last name', { max: 100 }),
    email: requiredEmail(body.email),
    phone: optionalString(body.phone, 'Phone', { max: 50 }),
    howWeConnected: optionalString(body.howWeConnected, 'How we connected', { max: 5000 }),
    tags: JSON.stringify(
      isStudentFounder && !tags.includes('Student Founder') ? [...tags, 'Student Founder'] : tags,
    ),
    organizationId,
    orgRole: optionalString(body.orgRole, 'Role', { max: 120 }),
    status: oneOf(body.status, 'Status', CONTACT_STATUSES, 'active'),
    isStudentFounder: isStudentFounder ? 1 : 0,
  };
}
