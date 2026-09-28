import type { Db } from '../db/driver.ts';
import type { SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { csvFilename, toCsv } from '../lib/csv.ts';
import { badRequest, jsonResponse, notFound, readJson } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, positiveInt, requiredString, tagList } from '../lib/validate.ts';
import { requireAuth, requireEditor } from '../middleware/auth.ts';
import { NOTE_TYPES, noteOut } from '../records.ts';
import type { Ctx, Router } from '../router.ts';

const SELECT_NOTE = `
  SELECT n.*,
         CASE WHEN c.id IS NULL THEN NULL ELSE (c.first_name || ' ' || c.last_name) END AS contact_name,
         author.name AS created_by_name,
         (SELECT json_group_array(json_object('id', ct.id, 'name', ct.first_name || ' ' || ct.last_name))
            FROM note_contacts nc
            JOIN contacts ct ON ct.id = nc.contact_id AND ct.deleted_at IS NULL
           WHERE nc.note_id = n.id) AS contacts_json,
         (SELECT json_group_array(json_object('id', d.id, 'name', d.file_name, 'size', d.file_size))
            FROM documents d WHERE d.note_id = n.id AND d.deleted_at IS NULL) AS attachments_json
    FROM notes n
    LEFT JOIN contacts c ON c.id = n.contact_id
    LEFT JOIN users author ON author.id = n.created_by`;

function buildFilters(customerId: string, query: URLSearchParams) {
  const where: string[] = ['n.customer_id = ?', 'n.deleted_at IS NULL'];
  const params: SqlParam[] = [customerId];

  const contactId = query.get('contactId');
  if (contactId) {
    // Match the note's primary contact OR any contact it is filed under.
    where.push(
      `(n.contact_id = ? OR EXISTS (SELECT 1 FROM note_contacts nc WHERE nc.note_id = n.id AND nc.contact_id = ?))`,
    );
    params.push(contactId, contactId);
  }

  const q = (query.get('q') ?? '').trim().toLowerCase();
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(LOWER(n.content) LIKE ? OR LOWER(n.tags) LIKE ?
        OR EXISTS (SELECT 1 FROM note_contacts nc JOIN contacts ncc ON ncc.id = nc.contact_id
                    WHERE nc.note_id = n.id
                      AND (LOWER(ncc.first_name) LIKE ? OR LOWER(ncc.last_name) LIKE ?)))`,
    );
    params.push(like, like, like, like);
  }

  const noteType = query.get('noteType');
  if (noteType && noteType !== 'all') {
    where.push('n.note_type = ?');
    params.push(oneOf(noteType, 'Note type', NOTE_TYPES));
  }

  const tag = query.get('tag');
  if (tag && tag !== 'all') {
    where.push('LOWER(n.tags) LIKE ?');
    params.push(`%"${tag.toLowerCase()}"%`);
  }

  const createdBy = query.get('createdBy');
  if (createdBy && createdBy !== 'all') {
    where.push('n.created_by = ?');
    params.push(createdBy);
  }

  const from = query.get('from');
  if (from) {
    where.push('n.created_at >= ?');
    params.push(`${from}T00:00:00.000Z`);
  }
  const to = query.get('to');
  if (to) {
    where.push('n.created_at <= ?');
    params.push(`${to}T23:59:59.999Z`);
  }

  return { clause: where.join(' AND '), params };
}

export function register(router: Router): void {
  router.get('/api/notes', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const { clause, params } = buildFilters(customerId, ctx.query);
    const order = ctx.query.get('order') === 'oldest' ? 'ASC' : 'DESC';
    const limit = positiveInt(ctx.query.get('limit'), 25, 200);
    const page = positiveInt(ctx.query.get('page'), 1, 10000);

    const totalRow = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM notes n LEFT JOIN contacts c ON c.id = n.contact_id WHERE ${clause}`,
      params,
    );
    const rows = await ctx.db.all(
      `${SELECT_NOTE} WHERE ${clause} ORDER BY n.created_at ${order} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );

    const total = Number(totalRow?.total ?? 0);
    return jsonResponse({ notes: rows.map(noteOut), page, limit, total, hasMore: page * limit < total });
  });

  /** Note tags in use, for the filter dropdown. */
  router.get('/api/notes/facets', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const rows = await ctx.db.all<{ tags: string }>(
      `SELECT tags FROM notes WHERE customer_id = ? AND deleted_at IS NULL`,
      [customerId],
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      try {
        for (const tag of JSON.parse(row.tags) as string[]) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      } catch {
        // Ignore a malformed cell rather than dropping the whole facet list.
      }
    }
    return jsonResponse({
      tags: [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    });
  });

  router.get('/api/notes/export.csv', async (ctx: Ctx) => {
    const { customerId, userId } = requireAuth(ctx);
    const { clause, params } = buildFilters(customerId, ctx.query);
    const rows = await ctx.db.all(`${SELECT_NOTE} WHERE ${clause} ORDER BY n.created_at DESC`, params);
    const notes = rows.map(noteOut);

    await audit(ctx.db, {
      customerId,
      userId,
      action: 'export.csv',
      entityType: 'notes',
      metadata: { count: notes.length },
      req: ctx.req,
    });

    const csv = toCsv(
      notes.map((n) => ({ ...n, tags: n.tags.join('; ') })),
      [
        { key: 'createdAt', label: 'Timestamp' },
        { key: 'contactName', label: 'Contact' },
        { key: 'noteType', label: 'Type' },
        { key: 'content', label: 'Note' },
        { key: 'tags', label: 'Tags' },
        { key: 'createdByName', label: 'Created by' },
      ],
    );

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename('ecenter-notes')}"`,
      },
    });
  });

  router.post('/api/notes', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const content = requiredString(body.content, 'Note', { max: 20000 });
    const noteType = oneOf(body.noteType, 'Note type', NOTE_TYPES, 'other');
    const tags = tagList(body.tags);
    // A note can be filed under several contacts, or none at all.
    const contactIds = await resolveContactIds(ctx, body, customerId);

    // The timestamp is generated here and never accepted from the client -- a
    // hand-typed date was the single biggest gap in the old process.
    const timestamp = nowIso();
    const id = newId();
    await ctx.db.run(
      `INSERT INTO notes
         (id, customer_id, contact_id, note_type, content, tags, source,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      [id, customerId, contactIds[0] ?? null, noteType, content, JSON.stringify(tags), timestamp, timestamp, userId, userId],
    );
    await syncNoteContacts(ctx, { customerId, noteId: id, contactIds });

    const row = await ctx.db.get(`${SELECT_NOTE} WHERE n.id = ?`, [id]);
    return jsonResponse({ note: noteOut(row!) }, { status: 201 });
  });

  /** Content, type and tags are editable; `created_at` is not. */
  router.put('/api/notes/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get(
      `SELECT id FROM notes WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That note no longer exists.');

    const body = await readJson(ctx.req);
    // Contacts are only rewritten when the caller sends them, so edits that omit
    // the field leave the existing links untouched.
    const contactsProvided = 'contactIds' in body || 'contactId' in body;
    const contactIds = contactsProvided ? await resolveContactIds(ctx, body, customerId) : null;

    await ctx.db.run(
      `UPDATE notes SET content = ?, note_type = ?, tags = ?, updated_at = ?, last_edited_by = ?${
        contactIds ? ', contact_id = ?' : ''
      }
        WHERE id = ? AND customer_id = ?`,
      [
        requiredString(body.content, 'Note', { max: 20000 }),
        oneOf(body.noteType, 'Note type', NOTE_TYPES, 'other'),
        JSON.stringify(tagList(body.tags)),
        nowIso(),
        userId,
        ...(contactIds ? [contactIds[0] ?? null] : []),
        ctx.params.id!,
        customerId,
      ],
    );
    if (contactIds) await syncNoteContacts(ctx, { customerId, noteId: ctx.params.id!, contactIds });

    const row = await ctx.db.get(`${SELECT_NOTE} WHERE n.id = ?`, [ctx.params.id!]);
    return jsonResponse({ note: noteOut(row!) });
  });

  router.delete('/api/notes/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get<{ contact_id: string }>(
      `SELECT contact_id FROM notes WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That note no longer exists.');

    const timestamp = nowIso();
    await ctx.db.batch([
      {
        sql: `UPDATE notes SET deleted_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
        params: [timestamp, userId, ctx.params.id!, customerId],
      },
      {
        // Attachments filed under this note go with it.
        sql: `UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE note_id = ? AND deleted_at IS NULL`,
        params: [timestamp, userId, ctx.params.id!],
      },
    ]);
    await audit(ctx.db, {
      customerId,
      userId,
      action: 'note.delete',
      entityType: 'note',
      entityId: ctx.params.id!,
      metadata: { contactId: existing.contact_id },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });
}

/** Validates and de-duplicates the contact ids a note is being filed under (zero allowed). */
async function resolveContactIds(
  ctx: Ctx,
  body: Record<string, unknown>,
  customerId: string,
): Promise<string[]> {
  const raw = Array.isArray(body.contactIds)
    ? (body.contactIds as unknown[])
    : body.contactId != null
      ? [body.contactId]
      : [];
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !value) continue;
    if (!ids.includes(value)) ids.push(value);
  }
  for (const id of ids) {
    const contact = await ctx.db.get(
      `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [id, customerId],
    );
    if (!contact) throw badRequest('That contact was not found.', 'Contact');
  }
  return ids;
}

/** Rewrites a note's contact links to exactly `contactIds`. */
async function syncNoteContacts(
  ctx: Ctx,
  input: { customerId: string; noteId: string; contactIds: string[] },
): Promise<void> {
  const writes: { sql: string; params: SqlParam[] }[] = [
    { sql: `DELETE FROM note_contacts WHERE note_id = ?`, params: [input.noteId] },
  ];
  const timestamp = nowIso();
  for (const contactId of input.contactIds) {
    writes.push({
      sql: `INSERT INTO note_contacts (id, customer_id, note_id, contact_id, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [newId(), input.customerId, input.noteId, contactId, timestamp],
    });
  }
  await ctx.db.batch(writes);
}

/**
 * Writes a system-sourced note. Used when a contact is linked to an event so the
 * attendance lands in that contact's timeline automatically.
 */
export async function createSystemNote(
  db: Db,
  input: {
    customerId: string;
    contactId: string;
    content: string;
    noteType?: (typeof NOTE_TYPES)[number];
    tags?: string[];
    userId?: string | null;
  },
): Promise<string> {
  const id = newId();
  const timestamp = nowIso();
  await db.run(
    `INSERT INTO notes
       (id, customer_id, contact_id, note_type, content, tags, source,
        created_at, updated_at, created_by, last_edited_by)
     VALUES (?, ?, ?, ?, ?, ?, 'event', ?, ?, ?, ?)`,
    [
      id,
      input.customerId,
      input.contactId,
      input.noteType ?? 'workshop',
      input.content,
      JSON.stringify(input.tags ?? []),
      timestamp,
      timestamp,
      input.userId ?? null,
      input.userId ?? null,
    ],
  );
  await db.run(
    `INSERT INTO note_contacts (id, customer_id, note_id, contact_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    [newId(), input.customerId, id, input.contactId, timestamp],
  );
  return id;
}
