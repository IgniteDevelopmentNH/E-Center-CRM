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
         (c.first_name || ' ' || c.last_name) AS contact_name,
         author.name AS created_by_name
    FROM notes n
    JOIN contacts c ON c.id = n.contact_id
    LEFT JOIN users author ON author.id = n.created_by`;

function buildFilters(customerId: string, query: URLSearchParams) {
  const where: string[] = ['n.customer_id = ?', 'n.deleted_at IS NULL'];
  const params: SqlParam[] = [customerId];

  const contactId = query.get('contactId');
  if (contactId) {
    where.push('n.contact_id = ?');
    params.push(contactId);
  }

  const q = (query.get('q') ?? '').trim().toLowerCase();
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(LOWER(n.content) LIKE ? OR LOWER(n.tags) LIKE ?
        OR LOWER(c.first_name) LIKE ? OR LOWER(c.last_name) LIKE ?)`,
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
      `SELECT COUNT(*) AS total FROM notes n JOIN contacts c ON c.id = n.contact_id WHERE ${clause}`,
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
    const contactId = requiredString(body.contactId, 'Contact', { max: 64 });
    const content = requiredString(body.content, 'Note', { max: 20000 });
    const noteType = oneOf(body.noteType, 'Note type', NOTE_TYPES, 'other');
    const tags = tagList(body.tags);

    const contact = await ctx.db.get(
      `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [contactId, customerId],
    );
    if (!contact) throw badRequest('That contact was not found.', 'Contact');

    // The timestamp is generated here and never accepted from the client -- a
    // hand-typed date was the single biggest gap in the old process.
    const timestamp = nowIso();
    const id = newId();
    await ctx.db.run(
      `INSERT INTO notes
         (id, customer_id, contact_id, note_type, content, tags, source,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      [id, customerId, contactId, noteType, content, JSON.stringify(tags), timestamp, timestamp, userId, userId],
    );

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
    await ctx.db.run(
      `UPDATE notes SET content = ?, note_type = ?, tags = ?, updated_at = ?, last_edited_by = ?
        WHERE id = ? AND customer_id = ?`,
      [
        requiredString(body.content, 'Note', { max: 20000 }),
        oneOf(body.noteType, 'Note type', NOTE_TYPES, 'other'),
        JSON.stringify(tagList(body.tags)),
        nowIso(),
        userId,
        ctx.params.id!,
        customerId,
      ],
    );

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

    await ctx.db.run(`UPDATE notes SET deleted_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`, [
      nowIso(),
      userId,
      ctx.params.id!,
      customerId,
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
  return id;
}
