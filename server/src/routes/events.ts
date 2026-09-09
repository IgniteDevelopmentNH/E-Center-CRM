import { Router } from 'express';
import type { Db, SqlParam } from '../db/index.ts';
import { getDb } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound, route } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { formatDisplayDate, nowIso } from '../lib/time.ts';
import {
  oneOf,
  optionalString,
  optionalTimestamp,
  requiredString,
  requiredTimestamp,
} from '../lib/validate.ts';
import { auth, requireAuth, requireEditor } from '../middleware/auth.ts';
import { EVENT_TYPES, contactOut, eventOut } from '../records.ts';
import { createSystemNote } from './notes.ts';

export const eventsRouter = Router();
eventsRouter.use(requireAuth);

const SELECT_EVENT = `
  SELECT e.*,
         m.external_id,
         (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id) AS attendee_count
    FROM events e
    LEFT JOIN event_external_mapping m ON m.event_id = e.id`;

eventsRouter.get(
  '/',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const where: string[] = ['e.customer_id = ?', 'e.deleted_at IS NULL'];
    const params: SqlParam[] = [customerId];

    if (typeof req.query.from === 'string' && req.query.from) {
      where.push('e.starts_at >= ?');
      params.push(`${req.query.from}T00:00:00.000Z`);
    }
    if (typeof req.query.to === 'string' && req.query.to) {
      where.push('e.starts_at <= ?');
      params.push(`${req.query.to}T23:59:59.999Z`);
    }
    if (typeof req.query.eventType === 'string' && req.query.eventType && req.query.eventType !== 'all') {
      where.push('e.event_type = ?');
      params.push(oneOf(req.query.eventType, 'Event type', EVENT_TYPES));
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const like = `%${req.query.q.trim().toLowerCase()}%`;
      where.push(`(LOWER(e.name) LIKE ? OR LOWER(COALESCE(e.location, '')) LIKE ?)`);
      params.push(like, like);
    }
    if (req.query.upcoming === 'true') {
      where.push('e.starts_at >= ?');
      params.push(nowIso());
    }

    const order = req.query.order === 'desc' ? 'DESC' : 'ASC';
    const rows = await db.all(
      `${SELECT_EVENT} WHERE ${where.join(' AND ')} ORDER BY e.starts_at ${order} LIMIT 500`,
      params,
    );
    res.json({ events: rows.map(eventOut) });
  }),
);

eventsRouter.get(
  '/:id',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const row = await db.get(
      `${SELECT_EVENT} WHERE e.id = ? AND e.customer_id = ? AND e.deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!row) throw notFound('That event no longer exists.');

    const attendees = await db.all(
      `SELECT c.*, o.name AS organization_name
         FROM event_attendees a
         JOIN contacts c ON c.id = a.contact_id
         LEFT JOIN organizations o ON o.id = c.organization_id
        WHERE a.event_id = ? AND c.deleted_at IS NULL
        ORDER BY LOWER(c.last_name) ASC`,
      [req.params.id!],
    );

    res.json({ event: eventOut(row), attendees: attendees.map(contactOut) });
  }),
);

function parseEvent(body: Record<string, unknown>) {
  const startsAt = requiredTimestamp(body.startsAt, 'Event date');
  const endsAt = optionalTimestamp(body.endsAt, 'End time');
  if (endsAt && endsAt < startsAt) throw badRequest('The end time is before the start time.', 'End time');
  return {
    name: requiredString(body.name, 'Event name', { max: 200 }),
    startsAt,
    endsAt,
    eventType: oneOf(body.eventType, 'Event type', EVENT_TYPES, 'other'),
    location: optionalString(body.location, 'Location', { max: 200 }),
    description: optionalString(body.description, 'Description', { max: 5000 }),
    followupNotes: optionalString(body.followupNotes, 'Follow-up notes', { max: 5000 }),
  };
}

/**
 * Links a contact to an event and writes the attendance into that contact's
 * timeline, so event participation shows up in relationship history without
 * anyone having to remember to log it.
 */
async function addAttendee(
  db: Db,
  input: {
    customerId: string;
    userId: string;
    eventId: string;
    contactId: string;
    eventName: string;
    startsAt: string;
  },
): Promise<boolean> {
  const contact = await db.get(
    `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
    [input.contactId, input.customerId],
  );
  if (!contact) return false;

  const existing = await db.get(`SELECT id FROM event_attendees WHERE event_id = ? AND contact_id = ?`, [
    input.eventId,
    input.contactId,
  ]);
  if (existing) return false;

  await db.run(
    `INSERT INTO event_attendees (id, customer_id, event_id, contact_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newId(), input.customerId, input.eventId, input.contactId, nowIso()],
  );

  await createSystemNote(db, {
    customerId: input.customerId,
    contactId: input.contactId,
    content: `Attended ${input.eventName} on ${formatDisplayDate(input.startsAt)}`,
    noteType: 'workshop',
    tags: ['Event'],
    userId: input.userId,
  });
  return true;
}

eventsRouter.post(
  '/',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = parseEvent(body);
    const contactIds = Array.isArray(body.contactIds)
      ? (body.contactIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];

    const db = await getDb();
    const id = newId();
    const timestamp = nowIso();

    await db.run(
      `INSERT INTO events
         (id, customer_id, name, starts_at, ends_at, event_type, location, description,
          followup_notes, created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customerId,
        fields.name,
        fields.startsAt,
        fields.endsAt,
        fields.eventType,
        fields.location,
        fields.description,
        fields.followupNotes,
        timestamp,
        timestamp,
        userId,
        userId,
      ],
    );

    for (const contactId of contactIds) {
      await addAttendee(db, {
        customerId,
        userId,
        eventId: id,
        contactId,
        eventName: fields.name,
        startsAt: fields.startsAt,
      });
    }

    const row = await db.get(`${SELECT_EVENT} WHERE e.id = ?`, [id]);
    res.status(201).json({ event: eventOut(row!) });
  }),
);

eventsRouter.put(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get(
      `SELECT id FROM events WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That event no longer exists.');

    const fields = parseEvent((req.body ?? {}) as Record<string, unknown>);
    await db.run(
      `UPDATE events SET
         name = ?, starts_at = ?, ends_at = ?, event_type = ?, location = ?, description = ?,
         followup_notes = ?, updated_at = ?, last_edited_by = ?
       WHERE id = ? AND customer_id = ?`,
      [
        fields.name,
        fields.startsAt,
        fields.endsAt,
        fields.eventType,
        fields.location,
        fields.description,
        fields.followupNotes,
        nowIso(),
        userId,
        req.params.id!,
        customerId,
      ],
    );

    const row = await db.get(`${SELECT_EVENT} WHERE e.id = ?`, [req.params.id!]);
    res.json({ event: eventOut(row!) });
  }),
);

eventsRouter.post(
  '/:id/attendees',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const event = await db.get<{ name: string; starts_at: string }>(
      `SELECT name, starts_at FROM events WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!event) throw notFound('That event no longer exists.');

    const contactId = requiredString(req.body?.contactId, 'Contact', { max: 64 });
    const added = await addAttendee(db, {
      customerId,
      userId,
      eventId: req.params.id!,
      contactId,
      eventName: event.name,
      startsAt: event.starts_at,
    });
    if (!added) throw badRequest('That contact is already linked to this event.', 'Contact');

    res.status(201).json({ ok: true });
  }),
);

/** Unlinking leaves the generated note in place: it is a record of what happened. */
eventsRouter.delete(
  '/:id/attendees/:contactId',
  requireEditor,
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    await db.run(
      `DELETE FROM event_attendees WHERE event_id = ? AND contact_id = ? AND customer_id = ?`,
      [req.params.id!, req.params.contactId!, customerId],
    );
    res.json({ ok: true });
  }),
);

eventsRouter.delete(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get<{ name: string }>(
      `SELECT name FROM events WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That event no longer exists.');

    await db.run(
      `UPDATE events SET deleted_at = ?, updated_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
      [nowIso(), nowIso(), userId, req.params.id!, customerId],
    );
    await audit(db, {
      customerId,
      userId,
      action: 'event.delete',
      entityType: 'event',
      entityId: req.params.id!,
      metadata: { name: existing.name },
      req,
    });
    res.json({ ok: true });
  }),
);
