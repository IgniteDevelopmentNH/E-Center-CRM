import { Router } from 'express';
import type { SqlParam } from '../db/index.ts';
import { getDb } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { csvFilename, toCsv } from '../lib/csv.ts';
import { badRequest, notFound, route } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { oneOf, positiveInt, requiredString, tagList } from '../lib/validate.ts';
import { auth, requireAuth, requireEditor } from '../middleware/auth.ts';
import { NOTE_TYPES, noteOut } from '../records.ts';

export const notesRouter = Router();
notesRouter.use(requireAuth);

const SELECT_NOTE = `
  SELECT n.*,
         (c.first_name || ' ' || c.last_name) AS contact_name,
         author.name AS created_by_name
    FROM notes n
    JOIN contacts c ON c.id = n.contact_id
    LEFT JOIN users author ON author.id = n.created_by`;

function buildFilters(customerId: string, query: Record<string, unknown>) {
  const where: string[] = ['n.customer_id = ?', 'n.deleted_at IS NULL'];
  const params: SqlParam[] = [customerId];

  if (typeof query.contactId === 'string' && query.contactId) {
    where.push('n.contact_id = ?');
    params.push(query.contactId);
  }

  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(LOWER(n.content) LIKE ? OR LOWER(n.tags) LIKE ?
        OR LOWER(c.first_name) LIKE ? OR LOWER(c.last_name) LIKE ?)`,
    );
    params.push(like, like, like, like);
  }

  if (typeof query.noteType === 'string' && query.noteType && query.noteType !== 'all') {
    where.push('n.note_type = ?');
    params.push(oneOf(query.noteType, 'Note type', NOTE_TYPES));
  }

  if (typeof query.tag === 'string' && query.tag && query.tag !== 'all') {
    where.push('LOWER(n.tags) LIKE ?');
    params.push(`%"${query.tag.toLowerCase()}"%`);
  }

  if (typeof query.createdBy === 'string' && query.createdBy && query.createdBy !== 'all') {
    where.push('n.created_by = ?');
    params.push(query.createdBy);
  }

  if (typeof query.from === 'string' && query.from) {
    where.push('n.created_at >= ?');
    params.push(`${query.from}T00:00:00.000Z`);
  }
  if (typeof query.to === 'string' && query.to) {
    where.push('n.created_at <= ?');
    params.push(`${query.to}T23:59:59.999Z`);
  }

  return { clause: where.join(' AND '), params };
}

notesRouter.get(
  '/',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const { clause, params } = buildFilters(customerId, req.query as Record<string, unknown>);
    const order = req.query.order === 'oldest' ? 'ASC' : 'DESC';
    const limit = positiveInt(req.query.limit, 25, 200);
    const page = positiveInt(req.query.page, 1, 10000);

    const totalRow = await db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM notes n JOIN contacts c ON c.id = n.contact_id WHERE ${clause}`,
      params,
    );
    const rows = await db.all(
      `${SELECT_NOTE} WHERE ${clause} ORDER BY n.created_at ${order} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );

    const total = Number(totalRow?.total ?? 0);
    res.json({ notes: rows.map(noteOut), page, limit, total, hasMore: page * limit < total });
  }),
);

/** Note tags in use, for the filter dropdown. */
notesRouter.get(
  '/facets',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const rows = await db.all<{ tags: string }>(
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
    res.json({
      tags: [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    });
  }),
);

notesRouter.get(
  '/export.csv',
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const { clause, params } = buildFilters(customerId, req.query as Record<string, unknown>);
    const rows = await db.all(`${SELECT_NOTE} WHERE ${clause} ORDER BY n.created_at DESC`, params);
    const notes = rows.map(noteOut);

    await audit(db, {
      customerId,
      userId,
      action: 'export.csv',
      entityType: 'notes',
      metadata: { count: notes.length },
      req,
    });

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="${csvFilename('ecenter-notes')}"`);
    res.send(
      toCsv(
        notes.map((n) => ({ ...n, tags: n.tags.join('; ') })),
        [
          { key: 'createdAt', label: 'Timestamp' },
          { key: 'contactName', label: 'Contact' },
          { key: 'noteType', label: 'Type' },
          { key: 'content', label: 'Note' },
          { key: 'tags', label: 'Tags' },
          { key: 'createdByName', label: 'Created by' },
        ],
      ),
    );
  }),
);

notesRouter.post(
  '/',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contactId = requiredString(body.contactId, 'Contact', { max: 64 });
    const content = requiredString(body.content, 'Note', { max: 20000 });
    const noteType = oneOf(body.noteType, 'Note type', NOTE_TYPES, 'other');
    const tags = tagList(body.tags);

    const db = await getDb();
    const contact = await db.get(
      `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [contactId, customerId],
    );
    if (!contact) throw badRequest('That contact was not found.', 'Contact');

    // The timestamp is generated here and never accepted from the client -- a
    // hand-typed date was the single biggest gap in the old process.
    const timestamp = nowIso();
    const id = newId();
    await db.run(
      `INSERT INTO notes
         (id, customer_id, contact_id, note_type, content, tags, source,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      [
        id,
        customerId,
        contactId,
        noteType,
        content,
        JSON.stringify(tags),
        timestamp,
        timestamp,
        userId,
        userId,
      ],
    );

    const row = await db.get(`${SELECT_NOTE} WHERE n.id = ?`, [id]);
    res.status(201).json({ note: noteOut(row!) });
  }),
);

/** Content, type and tags are editable; `created_at` is not. */
notesRouter.put(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get(
      `SELECT id FROM notes WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That note no longer exists.');

    const body = (req.body ?? {}) as Record<string, unknown>;
    await db.run(
      `UPDATE notes SET content = ?, note_type = ?, tags = ?, updated_at = ?, last_edited_by = ?
        WHERE id = ? AND customer_id = ?`,
      [
        requiredString(body.content, 'Note', { max: 20000 }),
        oneOf(body.noteType, 'Note type', NOTE_TYPES, 'other'),
        JSON.stringify(tagList(body.tags)),
        nowIso(),
        userId,
        req.params.id!,
        customerId,
      ],
    );

    const row = await db.get(`${SELECT_NOTE} WHERE n.id = ?`, [req.params.id!]);
    res.json({ note: noteOut(row!) });
  }),
);

notesRouter.delete(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get<{ contact_id: string }>(
      `SELECT contact_id FROM notes WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That note no longer exists.');

    await db.run(`UPDATE notes SET deleted_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`, [
      nowIso(),
      userId,
      req.params.id!,
      customerId,
    ]);
    await audit(db, {
      customerId,
      userId,
      action: 'note.delete',
      entityType: 'note',
      entityId: req.params.id!,
      metadata: { contactId: existing.contact_id },
      req,
    });
    res.json({ ok: true });
  }),
);

/**
 * Writes a system-sourced note. Used when a contact is linked to an event so the
 * attendance lands in that contact's timeline automatically.
 */
export async function createSystemNote(
  db: Awaited<ReturnType<typeof getDb>>,
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
