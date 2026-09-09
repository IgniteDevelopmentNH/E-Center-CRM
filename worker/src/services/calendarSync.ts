import type { Db } from '../db/driver.ts';
import type { Config } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { newId } from '../lib/ids.ts';
import { isoDaysFromNow, nowIso } from '../lib/time.ts';
import {
  createRemoteEvent,
  getAccessToken,
  graphDateToIso,
  listRemoteEvents,
  updateRemoteEvent,
} from './graph.ts';

export interface SyncResult {
  pulled: number;
  pushed: number;
  updatedLocally: number;
  updatedRemotely: number;
  lastSyncAt: string;
}

interface LocalEventRow {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  description: string | null;
  updated_at: string;
  external_id: string | null;
  last_synced_at: string | null;
}

/**
 * Two-way sync over a 30-day window.
 *
 * Conflicts resolve last-write-wins: whichever side changed after the previous
 * successful sync stamp wins, and Outlook wins a genuine tie because it is the
 * calendar the team lives in day to day.
 */
export async function syncCalendar(
  db: Db,
  customerId: string,
  userId: string | null,
  config: Config,
): Promise<SyncResult> {
  const startedAt = nowIso();
  try {
    const accessToken = await getAccessToken(db, customerId, config);
    const remoteEvents = await listRemoteEvents(accessToken, 30);

    const locals = await db.all<LocalEventRow>(
      `SELECT e.id, e.name, e.starts_at, e.ends_at, e.location, e.description, e.updated_at,
              m.external_id, m.last_synced_at
         FROM events e
         LEFT JOIN event_external_mapping m ON m.event_id = e.id
        WHERE e.customer_id = ? AND e.deleted_at IS NULL
          AND e.starts_at >= ? AND e.starts_at <= ?`,
      [customerId, startedAt, isoDaysFromNow(30)],
    );
    const byExternalId = new Map(
      locals.filter((row) => row.external_id).map((row) => [row.external_id!, row]),
    );

    let pulled = 0;
    let updatedLocally = 0;

    for (const remote of remoteEvents) {
      const startsAt = graphDateToIso(remote.start);
      if (!startsAt) continue;
      const endsAt = graphDateToIso(remote.end);
      const existing = byExternalId.get(remote.id);
      const timestamp = nowIso();

      if (!existing) {
        const eventId = newId();
        // Event and its external-id mapping either both land or neither does.
        await db.batch([
          {
            sql: `INSERT INTO events
                    (id, customer_id, name, starts_at, ends_at, event_type, location, description,
                     created_at, updated_at, created_by, last_edited_by)
                  VALUES (?, ?, ?, ?, ?, 'other', ?, ?, ?, ?, ?, ?)`,
            params: [
              eventId,
              customerId,
              remote.subject ?? 'Untitled Outlook event',
              startsAt,
              endsAt,
              remote.location?.displayName ?? null,
              remote.bodyPreview ?? null,
              timestamp,
              timestamp,
              userId,
              userId,
            ],
          },
          {
            sql: `INSERT INTO event_external_mapping
                    (id, customer_id, event_id, external_id, external_etag, last_synced_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            params: [newId(), customerId, eventId, remote.id, remote.lastModifiedDateTime ?? null, timestamp],
          },
        ]);
        pulled += 1;
        continue;
      }

      const remoteChanged =
        !!remote.lastModifiedDateTime &&
        (!existing.last_synced_at || remote.lastModifiedDateTime > existing.last_synced_at);
      const localChanged = !existing.last_synced_at || existing.updated_at > existing.last_synced_at;

      if (remoteChanged && !(localChanged && existing.updated_at > (remote.lastModifiedDateTime ?? ''))) {
        await db.batch([
          {
            sql: `UPDATE events SET name = ?, starts_at = ?, ends_at = ?, location = ?, updated_at = ?
                    WHERE id = ? AND customer_id = ?`,
            params: [
              remote.subject ?? existing.name,
              startsAt,
              endsAt,
              remote.location?.displayName ?? existing.location,
              timestamp,
              existing.id,
              customerId,
            ],
          },
          {
            sql: `UPDATE event_external_mapping SET external_etag = ?, last_synced_at = ?
                    WHERE customer_id = ? AND external_id = ?`,
            params: [remote.lastModifiedDateTime ?? null, timestamp, customerId, remote.id],
          },
        ]);
        updatedLocally += 1;
      }
    }

    let pushed = 0;
    let updatedRemotely = 0;

    for (const local of locals) {
      const payload = {
        name: local.name,
        startsAt: local.starts_at,
        endsAt: local.ends_at,
        location: local.location,
        description: local.description,
      };

      if (!local.external_id) {
        const created = await createRemoteEvent(accessToken, payload);
        await db.run(
          `INSERT INTO event_external_mapping
             (id, customer_id, event_id, external_id, external_etag, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [newId(), customerId, local.id, created.id, created.lastModifiedDateTime ?? null, nowIso()],
        );
        pushed += 1;
        continue;
      }

      const localChanged = !local.last_synced_at || local.updated_at > local.last_synced_at;
      if (localChanged) {
        const updated = await updateRemoteEvent(accessToken, local.external_id, payload);
        await db.run(
          `UPDATE event_external_mapping SET external_etag = ?, last_synced_at = ?
            WHERE customer_id = ? AND external_id = ?`,
          [updated.lastModifiedDateTime ?? null, nowIso(), customerId, local.external_id],
        );
        updatedRemotely += 1;
      }
    }

    const finishedAt = nowIso();
    await writeSyncMetadata(db, customerId, {
      status: 'success',
      error: null,
      pulled,
      pushed,
      at: finishedAt,
    });
    await audit(db, {
      customerId,
      userId,
      action: 'calendar.sync',
      metadata: { pulled, pushed, updatedLocally, updatedRemotely },
    });

    return { pulled, pushed, updatedLocally, updatedRemotely, lastSyncAt: finishedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSyncMetadata(db, customerId, {
      status: 'error',
      error: message,
      pulled: 0,
      pushed: 0,
      at: nowIso(),
    });
    throw error;
  }
}

async function writeSyncMetadata(
  db: Db,
  customerId: string,
  input: { status: string; error: string | null; pulled: number; pushed: number; at: string },
): Promise<void> {
  const existing = await db.get(`SELECT customer_id FROM calendar_sync_metadata WHERE customer_id = ?`, [
    customerId,
  ]);
  if (existing) {
    await db.run(
      `UPDATE calendar_sync_metadata
          SET last_sync_at = ?, sync_status = ?, error_message = ?, events_pulled = ?, events_pushed = ?
        WHERE customer_id = ?`,
      [input.at, input.status, input.error, input.pulled, input.pushed, customerId],
    );
    return;
  }
  await db.run(
    `INSERT INTO calendar_sync_metadata
       (customer_id, last_sync_at, sync_status, error_message, events_pulled, events_pushed)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [customerId, input.at, input.status, input.error, input.pulled, input.pushed],
  );
}
