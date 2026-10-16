import type { Db } from '../db/driver.ts';
import { clientIp, userAgent } from './http.ts';
import { newId } from './ids.ts';
import { nowIso } from './time.ts';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'contact.delete'
  | 'organization.delete'
  | 'note.delete'
  | 'task.delete'
  | 'event.delete'
  | 'document.upload'
  | 'document.download'
  | 'document.delete'
  | 'calendar.connect'
  | 'calendar.disconnect'
  | 'calendar.sync'
  | 'export.csv'
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'auth.password_reset_requested'
  | 'auth.password_reset'
  | 'community.signup'
  | 'community.email_verified'
  | 'community.email_change_requested'
  | 'community.email_changed'
  | 'community.activated'
  | 'community.linked'
  | 'community.link_conflict'
  | 'community.link_failed'
  | 'community.unlinked'
  | 'community.deactivated'
  | 'community.reactivated'
  | 'community.staff_identity_created'
  | 'community.resume_download'
  | 'post.create'
  | 'post.update'
  | 'post.publish'
  | 'post.unpublish'
  | 'post.archive';

interface AuditInput {
  customerId: string;
  userId?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  req?: Request;
}

/**
 * Append-only audit trail for sensitive operations: document access, calendar
 * syncs, deletions, exports and sign-ins.
 */
export async function audit(db: Db, input: AuditInput): Promise<void> {
  await db.run(
    `INSERT INTO audit_logs
       (id, customer_id, user_id, action, entity_type, entity_id, metadata, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      input.customerId,
      input.userId ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.req ? clientIp(input.req) : null,
      input.req ? userAgent(input.req) : null,
      nowIso(),
    ],
  );
}
