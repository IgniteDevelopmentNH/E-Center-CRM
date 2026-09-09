import type { Db, SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { csvFilename, toCsv } from '../lib/csv.ts';
import { badRequest, jsonResponse, notFound, readJson } from '../lib/http.ts';
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
import { requireAuth, requireEditor } from '../middleware/auth.ts';
import {
  REMINDER_OFFSETS,
  TASK_PRIORITIES,
  TASK_RECURRENCES,
  TASK_STATUSES,
  taskOut,
} from '../records.ts';
import type { Ctx, Router } from '../router.ts';

const SELECT_TASK = `
  SELECT t.*,
         CASE WHEN c.id IS NULL THEN NULL ELSE (c.first_name || ' ' || c.last_name) END AS contact_name,
         assignee.name AS assigned_to_name
    FROM tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN users assignee ON assignee.id = t.assigned_to`;

const SORTS: Record<string, string> = {
  due: `CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END ASC, t.due_date ASC`,
  due_desc: `CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END ASC, t.due_date DESC`,
  priority: `CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC, t.due_date ASC`,
  contact: `LOWER(COALESCE(c.last_name, 'zzz')) ASC, t.due_date ASC`,
  status: `CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END ASC, t.due_date ASC`,
};

function buildFilters(customerId: string, query: URLSearchParams) {
  const where: string[] = ['t.customer_id = ?', 't.deleted_at IS NULL'];
  const params: SqlParam[] = [customerId];

  const status = query.get('status') ?? '';
  if (status === 'overdue') {
    where.push(`t.status <> 'complete' AND t.due_date < ?`);
    params.push(todayDate());
  } else if (status === 'incomplete') {
    where.push(`t.status <> 'complete'`);
  } else if (status && status !== 'all') {
    where.push('t.status = ?');
    params.push(oneOf(status, 'Status', TASK_STATUSES));
  }

  const assignedTo = query.get('assignedTo');
  if (assignedTo && assignedTo !== 'all') {
    where.push('t.assigned_to = ?');
    params.push(assignedTo);
  }

  const priority = query.get('priority');
  if (priority && priority !== 'all') {
    where.push('t.priority = ?');
    params.push(oneOf(priority, 'Priority', TASK_PRIORITIES));
  }

  const contactId = query.get('contactId');
  if (contactId) {
    where.push('t.contact_id = ?');
    params.push(contactId);
  }

  const q = query.get('q');
  if (q && q.trim()) {
    const like = `%${q.trim().toLowerCase()}%`;
    where.push(
      `(LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.context_notes, '')) LIKE ?
        OR LOWER(COALESCE(c.first_name, '')) LIKE ? OR LOWER(COALESCE(c.last_name, '')) LIKE ?)`,
    );
    params.push(like, like, like, like);
  }

  const dueBefore = query.get('dueBefore');
  if (dueBefore) {
    where.push('t.due_date <= ?');
    params.push(dueBefore);
  }
  const dueAfter = query.get('dueAfter');
  if (dueAfter) {
    where.push('t.due_date >= ?');
    params.push(dueAfter);
  }

  return { clause: where.join(' AND '), params };
}

export function register(router: Router): void {
  router.get('/api/tasks', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const { clause, params } = buildFilters(customerId, ctx.query);
    const sortKey = ctx.query.get('sort') ?? 'due';
    const orderBy = SORTS[sortKey] ?? SORTS.due;
    const limit = positiveInt(ctx.query.get('limit'), 25, 200);
    const page = positiveInt(ctx.query.get('page'), 1, 10000);

    const totalRow = await ctx.db.get<{ total: unknown }>(
      `SELECT COUNT(*) AS total FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id WHERE ${clause}`,
      params,
    );
    const rows = await ctx.db.all(`${SELECT_TASK} WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      (page - 1) * limit,
    ]);

    // Counts for the filter chips, independent of the current page.
    const summary = await ctx.db.get<Record<string, unknown>>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN t.status <> 'complete' AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN t.status <> 'complete' AND t.due_date >= ? AND t.due_date <= ? THEN 1 ELSE 0 END) AS due_soon,
         SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) AS complete
       FROM tasks t WHERE t.customer_id = ? AND t.deleted_at IS NULL`,
      [todayDate(), todayDate(), addDaysToDate(todayDate(), 7), customerId],
    );

    const total = Number(totalRow?.total ?? 0);
    return jsonResponse({
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
  });

  router.get('/api/tasks/export.csv', async (ctx: Ctx) => {
    const { customerId, userId } = requireAuth(ctx);
    const { clause, params } = buildFilters(customerId, ctx.query);
    const rows = await ctx.db.all(`${SELECT_TASK} WHERE ${clause} ORDER BY ${SORTS.due}`, params);
    const tasks = rows.map(taskOut);

    await audit(ctx.db, {
      customerId,
      userId,
      action: 'export.csv',
      entityType: 'tasks',
      metadata: { count: tasks.length },
      req: ctx.req,
    });

    const csv = toCsv(tasks, [
      { key: 'title', label: 'Task' },
      { key: 'dueDate', label: 'Due date' },
      { key: 'displayStatus', label: 'Status' },
      { key: 'priority', label: 'Priority' },
      { key: 'contactName', label: 'Contact' },
      { key: 'assignedToName', label: 'Assigned to' },
      { key: 'recurrence', label: 'Repeats' },
      { key: 'contextNotes', label: 'Context' },
      { key: 'completedAt', label: 'Completed' },
    ]);

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename('ecenter-tasks')}"`,
      },
    });
  });

  router.post('/api/tasks', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const body = await readJson(ctx.req);
    const fields = await parseTask(ctx.db, body, customerId);
    const id = newId();
    const timestamp = nowIso();

    await ctx.db.run(
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

    const row = await ctx.db.get(`${SELECT_TASK} WHERE t.id = ?`, [id]);
    return jsonResponse({ task: taskOut(row!) }, { status: 201 });
  });

  router.put('/api/tasks/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get<{ status: string; completed_at: string | null }>(
      `SELECT status, completed_at FROM tasks WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That task no longer exists.');

    const body = await readJson(ctx.req);
    const fields = await parseTask(ctx.db, body, customerId);
    const timestamp = nowIso();
    const completedAt = fields.status === 'complete' ? existing.completed_at ?? timestamp : null;

    await ctx.db.run(
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
        ctx.params.id!,
        customerId,
      ],
    );

    const row = await ctx.db.get(`${SELECT_TASK} WHERE t.id = ?`, [ctx.params.id!]);
    return jsonResponse({ task: taskOut(row!) });
  });

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
   * occurrence, so a standing follow-up never falls off the list. The read that
   * decides whether a next occurrence is needed happens first; only the actual
   * writes go into the atomic batch.
   */
  router.post('/api/tasks/:id/toggle', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get<{
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
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That task no longer exists.');

    const complete = existing.status !== 'complete';
    const timestamp = nowIso();
    let nextTaskId: string | null = null;

    const writes: { sql: string; params: SqlParam[] }[] = [
      {
        sql: `UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?, last_edited_by = ?
                WHERE id = ? AND customer_id = ?`,
        params: [complete ? 'complete' : 'open', complete ? timestamp : null, timestamp, userId, existing.id, customerId],
      },
    ];

    if (complete && existing.recurrence !== 'none') {
      const nextDue = nextDueDate(existing.due_date, existing.recurrence);
      if (nextDue) {
        // Do not create a duplicate if this occurrence was already generated.
        const seriesId = existing.recurrence_parent_id ?? existing.id;
        const already = await ctx.db.get(
          `SELECT id FROM tasks
            WHERE customer_id = ? AND due_date = ? AND deleted_at IS NULL
              AND (recurrence_parent_id = ? OR id = ?)`,
          [customerId, nextDue, seriesId, seriesId],
        );
        if (!already) {
          nextTaskId = newId();
          writes.push({
            sql: `INSERT INTO tasks
                    (id, customer_id, title, due_date, contact_id, assigned_to, status, priority,
                     reminder_enabled, reminder_offset, context_notes, recurrence, recurrence_parent_id,
                     created_at, updated_at, created_by, last_edited_by)
                  VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
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
          });
        }
      }
    }

    await ctx.db.batch(writes);

    const row = await ctx.db.get(`${SELECT_TASK} WHERE t.id = ?`, [existing.id]);
    const nextRow = nextTaskId ? await ctx.db.get(`${SELECT_TASK} WHERE t.id = ?`, [nextTaskId]) : null;
    return jsonResponse({ task: taskOut(row!), nextOccurrence: nextRow ? taskOut(nextRow) : null });
  });

  router.delete('/api/tasks/:id', async (ctx: Ctx) => {
    const { customerId, userId } = requireEditor(ctx);
    const existing = await ctx.db.get<{ title: string }>(
      `SELECT title FROM tasks WHERE id = ? AND customer_id = ? AND deleted_at IS NULL`,
      [ctx.params.id!, customerId],
    );
    if (!existing) throw notFound('That task no longer exists.');

    await ctx.db.run(
      `UPDATE tasks SET deleted_at = ?, updated_at = ?, last_edited_by = ? WHERE id = ? AND customer_id = ?`,
      [nowIso(), nowIso(), userId, ctx.params.id!, customerId],
    );
    await audit(ctx.db, {
      customerId,
      userId,
      action: 'task.delete',
      entityType: 'task',
      entityId: ctx.params.id!,
      metadata: { title: existing.title },
      req: ctx.req,
    });
    return jsonResponse({ ok: true });
  });
}

async function parseTask(db: Db, body: Record<string, unknown>, customerId: string) {
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
