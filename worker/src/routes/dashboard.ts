import { jsonResponse } from '../lib/http.ts';
import { addDaysToDate, daysAgoIso, isoDaysFromNow, nowIso, todayDate } from '../lib/time.ts';
import { requireAuth } from '../middleware/auth.ts';
import { eventOut, taskOut } from '../records.ts';
import type { Ctx, Router } from '../router.ts';

const SELECT_TASK = `
  SELECT t.*,
         CASE WHEN c.id IS NULL THEN NULL ELSE (c.first_name || ' ' || c.last_name) END AS contact_name,
         assignee.name AS assigned_to_name
    FROM tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN users assignee ON assignee.id = t.assigned_to`;

interface ActivityItem {
  type: 'note' | 'contact' | 'task';
  at: string;
  title: string;
  detail: string | null;
  contactId: string | null;
  entityId: string;
}

/** Everything the dashboard renders, in one request. */
export function register(router: Router): void {
  router.get('/api/dashboard', async (ctx: Ctx) => {
    const { customerId } = requireAuth(ctx);
    const { db } = ctx;
    const today = todayDate();
    const weekOut = addDaysToDate(today, 7);
    const since = daysAgoIso(7);

    const [counts, nextEvent, overdue, thisWeek, upcoming, team, recentNotes, newContacts, doneTasks] =
      await Promise.all([
        db.get<Record<string, unknown>>(
          `SELECT
             (SELECT COUNT(*) FROM contacts
               WHERE customer_id = ? AND deleted_at IS NULL AND status = 'active') AS active_contacts,
             (SELECT COUNT(*) FROM contacts WHERE customer_id = ? AND deleted_at IS NULL) AS total_contacts,
             (SELECT COUNT(*) FROM tasks
               WHERE customer_id = ? AND deleted_at IS NULL AND status <> 'complete'
                 AND due_date >= ? AND due_date <= ?) AS tasks_this_week,
             (SELECT COUNT(*) FROM tasks
               WHERE customer_id = ? AND deleted_at IS NULL AND status <> 'complete'
                 AND due_date < ?) AS overdue_tasks,
             (SELECT COUNT(*) FROM events
               WHERE customer_id = ? AND deleted_at IS NULL AND starts_at >= ? AND starts_at <= ?) AS upcoming_events,
             (SELECT COUNT(*) FROM users WHERE customer_id = ? AND deleted_at IS NULL) AS team_members,
             (SELECT COUNT(*) FROM organizations WHERE customer_id = ? AND deleted_at IS NULL) AS organizations`,
          [
            customerId,
            customerId,
            customerId,
            today,
            weekOut,
            customerId,
            today,
            customerId,
            nowIso(),
            isoDaysFromNow(30),
            customerId,
            customerId,
          ],
        ),

        db.get<{ starts_at: string; name: string }>(
          `SELECT starts_at, name FROM events
            WHERE customer_id = ? AND deleted_at IS NULL AND starts_at >= ?
            ORDER BY starts_at ASC LIMIT 1`,
          [customerId, nowIso()],
        ),

        db.all(
          `${SELECT_TASK}
            WHERE t.customer_id = ? AND t.deleted_at IS NULL AND t.status <> 'complete' AND t.due_date < ?
            ORDER BY t.due_date ASC LIMIT 25`,
          [customerId, today],
        ),

        db.all(
          `${SELECT_TASK}
            WHERE t.customer_id = ? AND t.deleted_at IS NULL AND t.status <> 'complete'
              AND t.due_date >= ? AND t.due_date <= ?
            ORDER BY t.due_date ASC,
                     CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC
            LIMIT 25`,
          [customerId, today, weekOut],
        ),

        db.all(
          `SELECT e.*, NULL AS external_id,
                  (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id) AS attendee_count
             FROM events e
            WHERE e.customer_id = ? AND e.deleted_at IS NULL AND e.starts_at >= ? AND e.starts_at <= ?
            ORDER BY e.starts_at ASC LIMIT 10`,
          [customerId, nowIso(), isoDaysFromNow(30)],
        ),

        db.all(
          `SELECT u.id, u.name, u.email, u.role,
                  (SELECT COUNT(*) FROM tasks t
                    WHERE t.assigned_to = u.id AND t.deleted_at IS NULL AND t.status <> 'complete')
                    AS open_task_count,
                  (SELECT COUNT(*) FROM tasks t
                    WHERE t.assigned_to = u.id AND t.deleted_at IS NULL
                      AND t.status <> 'complete' AND t.due_date < ?) AS overdue_task_count
             FROM users u
            WHERE u.customer_id = ? AND u.deleted_at IS NULL
            ORDER BY LOWER(u.name) ASC`,
          [today, customerId],
        ),

        db.all<Record<string, unknown>>(
          `SELECT n.id, n.contact_id, n.content, n.created_at, n.note_type,
                  CASE WHEN c.id IS NULL THEN NULL ELSE (c.first_name || ' ' || c.last_name) END AS contact_name
             FROM notes n LEFT JOIN contacts c ON c.id = n.contact_id
            WHERE n.customer_id = ? AND n.deleted_at IS NULL AND n.created_at >= ?
            ORDER BY n.created_at DESC LIMIT 10`,
          [customerId, since],
        ),

        db.all<Record<string, unknown>>(
          `SELECT id, first_name, last_name, created_at FROM contacts
            WHERE customer_id = ? AND deleted_at IS NULL AND created_at >= ?
            ORDER BY created_at DESC LIMIT 10`,
          [customerId, since],
        ),

        db.all<Record<string, unknown>>(
          `SELECT t.id, t.title, t.completed_at, u.name AS completed_by
             FROM tasks t LEFT JOIN users u ON u.id = t.last_edited_by
            WHERE t.customer_id = ? AND t.deleted_at IS NULL AND t.status = 'complete'
              AND t.completed_at >= ?
            ORDER BY t.completed_at DESC LIMIT 10`,
          [customerId, since],
        ),
      ]);

    // Merge the three activity streams into one reverse-chronological feed.
    const activity: ActivityItem[] = [
      ...recentNotes.map((row) => ({
        type: 'note' as const,
        at: String(row.created_at),
        title: row.contact_name ? String(row.contact_name) : 'Note',
        detail: String(row.content).replace(/\s+/g, ' ').slice(0, 140),
        contactId: row.contact_id ? String(row.contact_id) : null,
        entityId: String(row.id),
      })),
      ...newContacts.map((row) => ({
        type: 'contact' as const,
        at: String(row.created_at),
        title: `${String(row.first_name)} ${String(row.last_name)}`,
        detail: 'Added to contacts',
        contactId: String(row.id),
        entityId: String(row.id),
      })),
      ...doneTasks.map((row) => ({
        type: 'task' as const,
        at: String(row.completed_at),
        title: String(row.title),
        detail: row.completed_by ? `Completed by ${String(row.completed_by)}` : 'Completed',
        contactId: null,
        entityId: String(row.id),
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 12);

    return jsonResponse({
      stats: {
        activeContacts: Number(counts?.active_contacts ?? 0),
        totalContacts: Number(counts?.total_contacts ?? 0),
        tasksDueThisWeek: Number(counts?.tasks_this_week ?? 0),
        overdueTasks: Number(counts?.overdue_tasks ?? 0),
        upcomingEvents: Number(counts?.upcoming_events ?? 0),
        teamMembers: Number(counts?.team_members ?? 0),
        organizations: Number(counts?.organizations ?? 0),
        nextEventAt: nextEvent?.starts_at ?? null,
        nextEventName: nextEvent?.name ?? null,
      },
      overdueTasks: overdue.map(taskOut),
      thisWeek: thisWeek.map(taskOut),
      upcomingEvents: upcoming.map(eventOut),
      team: team.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        email: String(row.email),
        role: String(row.role),
        openTaskCount: Number(row.open_task_count ?? 0),
        overdueTaskCount: Number(row.overdue_task_count ?? 0),
      })),
      activity,
      generatedAt: nowIso(),
    });
  });
}
