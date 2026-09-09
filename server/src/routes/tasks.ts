import { Router } from 'express';
import type { Db, SqlParam } from '../db/index.ts';
import { getDb } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { csvFilename, toCsv } from '../lib/csv.ts';
import { badRequest, notFound, route } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { addDaysToDate, addMonthsToDate, nowIso, todayDate } from '../lib/time.ts';
import {
  flag,
  oneOf,
  optionalId,
  optionalString,
  positiveInt,
  requiredDate,
  requiredString,
} from '../lib/validate.ts';
import { auth, requireAuth, requireEditor } from '../middleware/auth.ts';
import {
  REMINDER_OFFSETS,
  TASK_PRIORITIES,
  TASK_RECURRENCES,
  TASK_STATUSES,
  taskOut,
} from '../records.ts';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const SELECT_TASK = `
  SELECT t.*,
         CASE WHEN c.id IS NULL THEN NULL ELSE (c.first_name || ' ' || c.last_name) END AS contact_name,
         assignee.name AS assigned_to_name
    FROM tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN users assignee ON assignee.id = t.assigned_to`;

const SORTS: Record<string, string> = {
  // Incomplete work first, then soonest due.
  due: `CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END ASC, t.due_date ASC`,
  due_desc: `CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END ASC, t.due_date DESC`,
  priority: `CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, t.due_date ASC`,
  contact: `LOWER(COALESCE(c.last_name, 'zzz')) ASC, t.due_date ASC`,
  status: `CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END ASC, t.due_date ASC`,
};

function buildFilters(customerId: string, query: Record<string, unknown>) {
  const where: string[] = ['t.customer_id = ?', 't.deleted_at IS NULL'];
  const params: SqlParam[] = [customerId];

  const status = typeof query.status === 'string' ? query.status : '';
  if (status === 'overdue') {
    where.push(`t.status <> 'complete' AND t.due_date < ?`);
    params.push(todayDate());
  } else if (status === 'incomplete') {
    where.push(`t.status <> 'complete'`);
  } else if (status && status !== 'all') {
    where.push('t.status = ?');
    params.push(oneOf(status, 'Status', TASK_STATUSES));
  }

  if (typeof query.assignedTo === 'string' && query.assignedTo && query.assignedTo !== 'all') {
    where.push('t.assigned_to = ?');
    params.push(query.assignedTo);
  }

  if (typeof query.priority === 'string' && query.priority && query.priority !== 'all') {
    where.push('t.priority = ?');
    params.push(oneOf(query.priority, 'Priority', TASK_PRIORITIES));
  }

  if (typeof query.contactId === 'string' && query.contactId) {
    where.push('t.contact_id = ?');
    params.push(query.contactId);
  }

  if (typeof query.q === 'string' && query.q.trim()) {
    const like = `%${query.q.trim().toLowerCase()}%`;
    where.push(
      `(LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.context_notes, '')) LIKE ?
        OR LOWER(COALESCE(c.first_name, '')) LIKE ? OR LOWER(COALESCE(c.last_name, '')) LIKE ?)`,
    );
    params.push(like, like, like, like);
  }

  if (typeof query.dueBefore === 'string' && query.dueBefore) {
    where.push('t.due_date <= ?');
    params.push(query.dueBefore);
  }
  if (typeof query.dueAfter === 'string' && query.dueAfter) {
    where.push('t.due_date >= ?');
    params.push(query.dueAfter);
  }

  return { clause: where.join(' AND '), params };
}

tasksRouter.get(
  '/',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const db = await getDb();
    const { clause, params } = buildFilters(customerId, req.query as Record<string, unknown>);
    const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'due';
    const orderBy = SORTS[sortKey] ?? SORTS.due;
    const limit = positiveInt(req.query.limit, 25, 200);
    const page = positiveInt(req.query.page, 1, 10000);

    const totalRow = await db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id WHERE ${clause}`,
      params,
    );
    const rows = await db.all(`${SELECT_TASK} WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      (page - 1) * limit,
    ]);

    // Counts for the filter chips, independent of the current page.
    const summary = await db.get<Record<string, unknown>>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN t.status <> 'complete' AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN t.status <> 'complete' AND t.due_date >= ? AND t.due_date <= ? THEN 1 ELSE 0 END) AS due_soon,
         SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) AS complete
       FROM tasks t WHERE t.customer_id = ? AND t.deleted_at IS NULL`,
      [todayDate(), todayDate(), addDaysToDate(todayDate(), 7), customerId],
    );

    const total = Number(totalRow?.total ?? 0);
    res.json({
      tasks: rows.map(taskOut),
      page,
      limit,
      total,
      hasMore: page * limit < total,
      summary: {
        total: Number(summary?.total ?? 0),
        overdue: Number(summary?.overdue ?? 0),
        dueSoon: Number(summary?.due_soon ?? 0),
        complete: Number(summary?.complete ?? 0),
      },
    });
  }),
);

tasksRouter.get(
  '/export.csv',
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const { clause, params } = buildFilters(customerId, req.query as Record<string, unknown>);
    const rows = await db.all(`${SELECT_TASK} WHERE ${clause} ORDER BY ${SORTS.due}`, params);
    const tasks = rows.map(taskOut);

    await audit(db, {
      customerId,
      userId,
      action: 'export.csv',
      entityType: 'tasks',
      metadata: { count: tasks.length },
      req,
    });

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', `attachment; filename="${csvFilename('ecenter-tasks')}"`);
    res.send(
      toCsv(tasks, [
        { key: 'title', label: 'Task' },
        { key: 'dueDate', label: 'Due date' },
        { key: 'displayStatus', label: 'Status' },
        { key: 'priority', label: 'Priority' },
        { key: 'contactName', label: 'Contact' },
        { key: 'assignedToName', label: 'Assigned to' },
        { key: 'recurrence', label: 'Repeats' },
        { key: 'contextNotes', label: 'Context' },
        { key: 'completedAt', label: 'Completed' },
      ]),
    );
  }),
);

async function parseTask(body: Record<string, unknown>, customerId: string, db: Db) {
  const contactId = optionalId(body.contactId, 'Contact');
  if (contactId) {
    const contact = await db.get(
      `SELECT id FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [contactId, customerId],
    );
    if (!contact) throw badRequest('That contact was not found.', 'Contact');
  }

  const assignedTo = optionalId(body.assignedTo, 'Assigned to');
  if (assignedTo) {
    const user = await db.get(
      `SELECT id FROM users WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [assignedTo, customerId],
    );
    if (!user) throw badRequest('That team member was not found.', 'Assigned to');
  }

  return {
    title: requiredString(body.title, 'Task title', { max: 300 }),
    dueDate: requiredDate(body.dueDate, 'Due date'),
    contactId,
    assignedTo,
    status: oneOf(body.status, 'Status', TASK_STATUSES, 'open'),
    priority: oneOf(body.priority, 'Priority', TASK_PRIORITIES, 'medium'),
    reminderEnabled: flag(body.reminderEnabled),
    reminderOffset: oneOf(body.reminderOffset, 'Reminder', REMINDER_OFFSETS, 'on_date'),
    contextNotes: optionalString(body.contextNotes, 'Context notes', { max: 5000 }),
    recurrence: oneOf(body.recurrence, 'Repeat', TASK_RECURRENCES, 'none'),
  };
}

tasksRouter.post(
  '/',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const fields = await parseTask((req.body ?? {}) as Record<string, unknown>, customerId, db);
    const id = newId();
    const timestamp = nowIso();

    await db.run(
      `INSERT INTO tasks
         (id, customer_id, title, due_date, contact_id, assigned_to, status, priority,
          reminder_enabled, reminder_offset, context_notes, recurrence,
          completed_at, created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customerId,
        fields.title,
        fields.dueDate,
        fields.contactId,
        fields.assignedTo,
        fields.status,
        fields.priority,
        fields.reminderEnabled,
        fields.reminderOffset,
        fields.contextNotes,
        fields.recurrence,
        fields.status === 'complete' ? timestamp : null,
        timestamp,
        timestamp,
        userId,
        userId,
      ],
    );

    const row = await db.get(`${SELECT_TASK} WHERE t.id = ?`, [id]);
    res.status(201).json({ task: taskOut(row!) });
  }),
);

tasksRouter.put(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at FROM tasks WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That task no longer exists.');

    const fields = await parseTask((req.body ?? {}) as Record<string, unknown>, customerId, db);
    const timestamp = nowIso();
    const completedAt =
      fields.status === 'complete' ? existing.completed_at ?? timestamp : null;

    await db.run(
      `UPDATE tasks SET
         title = ?, due_date = ?, contact_id = ?, assigned_to = ?, status = ?, priority = ?,
         reminder_enabled = ?, reminder_offset = ?, context_notes = ?, recurrence = ?,
         completed_at = ?, updated_at = ?, last_edited_by = ?
       WHERE id = ? AND customer_id = ?`,
      [
        fields.title,
        fields.dueDate,
        fields.contactId,
        fields.assignedTo,
        fields.status,
        fields.priority,
        fields.reminderEnabled,
        fields.reminderOffset,
        fields.contextNotes,
        fields.recurrence,
        completedAt,
        timestamp,
        userId,
        req.params.id!,
        customerId,
      ],
    );

    const row = await db.get(`${SELECT_TASK} WHERE t.id = ?`, [req.params.id!]);
    res.json({ task: taskOut(row!) });
  }),
);

/** Advances a due date by one recurrence interval. */
function nextDueDate(dueDate: string, recurrence: string): string | null {
  switch (recurrence) {
    case 'weekly':
      return addDaysToDate(dueDate, 7);
    case 'biweekly':
      return addDaysToDate(dueDate, 14);
    case 'monthly':
      return addMonthsToDate(dueDate, 1);
    default:
      return null;
  }
}

/**
 * Toggles completion. Completing a recurring task also schedules the next
 * occurrence, so a standing follow-up never falls off the list.
 */
tasksRouter.post(
  '/:id/toggle',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get<{
      id: string;
      status: string;
      due_date: string;
      recurrence: string;
      recurrence_parent_id: string | null;
      title: string;
      contact_id: string | null;
      assigned_to: string | null;
      priority: string;
      reminder_enabled: number;
      reminder_offset: string;
      context_notes: string | null;
    }>(
      `SELECT id, status, due_date, recurrence, recurrence_parent_id, title, contact_id,
              assigned_to, priority, reminder_enabled, reminder_offset, context_notes
         FROM tasks WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That task no longer exists.');

    const complete = existing.status !== 'complete';
    const timestamp = nowIso();
    let nextTaskId: string | null = null;

    await db.tx(async (tx) => {
      await tx.run(
        `UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?, last_edited_by = ?
          WHERE id = ? AND customer_id = ?`,
        [
          complete ? 'complete' : 'open',
          complete ? timestamp : null,
          timestamp,
          userId,
          existing.id,
          customerId,
        ],
      );

      if (!complete || existing.recurrence === 'none') return;

      const nextDue = nextDueDate(existing.due_date, existing.recurrence);
      if (!nextDue) return;

      // Do not create a duplicate if this occurrence was already generated.
      const seriesId = existing.recurrence_parent_id ?? existing.id;
      const already = await tx.get(
        `SELECT id FROM tasks
          WHERE customer_id = ? AND due_date = ? AND deleted_at IS NULL
            AND (recurrence_parent_id = ? OR id = ?)`,
        [customerId, nextDue, seriesId, seriesId],
      );
      if (already) return;

      nextTaskId = newId();
      await tx.run(
        `INSERT INTO tasks
           (id, customer_id, title, due_date, contact_id, assigned_to, status, priority,
            reminder_enabled, reminder_offset, context_notes, recurrence, recurrence_parent_id,
            created_at, updated_at, created_by, last_edited_by)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nextTaskId,
          customerId,
          existing.title,
          nextDue,
          existing.contact_id,
          existing.assigned_to,
          existing.priority,
          existing.reminder_enabled,
          existing.reminder_offset,
          existing.context_notes,
          existing.recurrence,
          seriesId,
          timestamp,
          timestamp,
          userId,
          userId,
        ],
      );
    });

    const row = await db.get(`${SELECT_TASK} WHERE t.id = ?`, [existing.id]);
    const nextRow = nextTaskId ? await db.get(`${SELECT_TASK} WHERE t.id = ?`, [nextTaskId]) : null;
    res.json({ task: taskOut(row!), nextOccurrence: nextRow ? taskOut(nextRow) : null });
  }),
);

tasksRouter.delete(
  '/:id',
  requireEditor,
  route(async (req, res) => {
    const { customerId, userId } = auth(req);
    const db = await getDb();
    const existing = await db.get<{ title: string }>(
      `SELECT title FROM tasks WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [req.params.id!, customerId],
    );
    if (!existing) throw notFound('That task no longer exists.');

    await db.run(
      `UPDATE tasks SET deleted_at = ?, updated_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
      [nowIso(), nowIso(), userId, req.params.id!, customerId],
    );
    await audit(db, {
      customerId,
      userId,
      action: 'task.delete',
      entityType: 'task',
      entityId: req.params.id!,
      metadata: { title: existing.title },
      req,
    });
    res.json({ ok: true });
  }),
);
