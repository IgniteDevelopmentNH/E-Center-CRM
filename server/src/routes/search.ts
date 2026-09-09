import { Router } from 'express';
import { getDb } from '../db/index.ts';
import { route } from '../lib/http.ts';
import { auth, requireAuth } from '../middleware/auth.ts';
import { contactOut, eventOut, noteOut, organizationOut, taskOut } from '../records.ts';

export const searchRouter = Router();
searchRouter.use(requireAuth);

/** Global search across contacts, organizations, notes, tasks and events. */
searchRouter.get(
  '/',
  route(async (req, res) => {
    const { customerId } = auth(req);
    const term = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    if (term.length < 2) {
      res.json({ query: term, contacts: [], organizations: [], notes: [], tasks: [], events: [] });
      return;
    }

    const like = `%${term}%`;
    const db = await getDb();

    const [contacts, organizations, notes, tasks, events] = await Promise.all([
      db.all(
        `SELECT c.*, o.name AS organization_name,
                (SELECT MAX(n.created_at) FROM notes n
                   WHERE n.contact_id = c.id AND n.deleted_at IS NULL) AS last_interaction_at
           FROM contacts c
           LEFT JOIN organizations o ON o.id = c.organization_id
          WHERE c.customer_id = ? AND c.deleted_at IS NULL
            AND (LOWER(c.first_name) LIKE ? OR LOWER(c.last_name) LIKE ? OR LOWER(c.email) LIKE ?
                 OR LOWER(c.tags) LIKE ? OR LOWER(COALESCE(c.how_we_connected, '')) LIKE ?)
          ORDER BY LOWER(c.last_name) ASC LIMIT 8`,
        [customerId, like, like, like, like, like],
      ),

      db.all(
        `SELECT o.*,
                (SELECT COUNT(*) FROM contacts c
                   WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS contact_count
           FROM organizations o
          WHERE o.customer_id = ? AND o.deleted_at IS NULL
            AND (LOWER(o.name) LIKE ? OR LOWER(COALESCE(o.relationship, '')) LIKE ?)
          ORDER BY LOWER(o.name) ASC LIMIT 6`,
        [customerId, like, like],
      ),

      db.all(
        `SELECT n.*, (c.first_name || ' ' || c.last_name) AS contact_name, u.name AS created_by_name
           FROM notes n
           JOIN contacts c ON c.id = n.contact_id
           LEFT JOIN users u ON u.id = n.created_by
          WHERE n.customer_id = ? AND n.deleted_at IS NULL
            AND (LOWER(n.content) LIKE ? OR LOWER(n.tags) LIKE ?)
          ORDER BY n.created_at DESC LIMIT 8`,
        [customerId, like, like],
      ),

      db.all(
        `SELECT t.*,
                CASE WHEN c.id IS NULL THEN NULL ELSE (c.first_name || ' ' || c.last_name) END AS contact_name,
                u.name AS assigned_to_name
           FROM tasks t
           LEFT JOIN contacts c ON c.id = t.contact_id
           LEFT JOIN users u ON u.id = t.assigned_to
          WHERE t.customer_id = ? AND t.deleted_at IS NULL
            AND (LOWER(t.title) LIKE ? OR LOWER(COALESCE(t.context_notes, '')) LIKE ?)
          ORDER BY t.due_date ASC LIMIT 6`,
        [customerId, like, like],
      ),

      db.all(
        `SELECT e.*, NULL AS external_id,
                (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id) AS attendee_count
           FROM events e
          WHERE e.customer_id = ? AND e.deleted_at IS NULL
            AND (LOWER(e.name) LIKE ? OR LOWER(COALESCE(e.location, '')) LIKE ?)
          ORDER BY e.starts_at DESC LIMIT 6`,
        [customerId, like, like],
      ),
    ]);

    res.json({
      query: term,
      contacts: contacts.map(contactOut),
      organizations: organizations.map(organizationOut),
      notes: notes.map(noteOut),
      tasks: tasks.map(taskOut),
      events: events.map(eventOut),
    });
  }),
);
