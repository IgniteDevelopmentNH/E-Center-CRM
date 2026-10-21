import type { Db, SqlParam } from '../db/driver.ts';
import { audit } from '../lib/audit.ts';
import { normaliseEmail } from '../lib/communityValidate.ts';
import { bufToHex } from '../lib/encoding.ts';
import { isUniqueViolation } from '../lib/http.ts';
import { newId } from '../lib/ids.ts';
import { signValue } from '../lib/signedToken.ts';
import { formatDisplayDate, nowIso } from '../lib/time.ts';
import type { Ctx } from '../router.ts';

/**
 * Community accounts <-> CRM contacts.
 *
 * FIELD OWNERSHIP
 *   Member-managed (community_profiles): name as shown in the portal, bio,
 *     LinkedIn, photo, major/graduation year, role/company, scheduling link,
 *     public interest/help tags. Staff see these read-only on the contact.
 *   Staff-managed (contacts and everything hanging off it): the contact's name,
 *     email, phone, status, relationship story, organizations, notes,
 *     follow-ups, documents and internal tags. Signup and profile edits NEVER
 *     write these on an existing contact.
 *   System-managed: the "Created Account" contact tag and the link itself.
 *   A brand-new contact (no match) is seeded once from the account: first and
 *   last name, the verified email, and a one-line "how we connected".
 *
 * LINKING uses only a VERIFIED email, normalised by trimming and lowercasing
 * (no provider-specific rewriting): exactly one matching contact -> link it;
 * none -> create one and link it; several -> flag a conflict for staff.
 *
 * IDEMPOTENCY: every step is safe to retry or race.
 *   * A new contact's id is derived from the user id, and inserted with
 *     INSERT OR IGNORE, so retries can never create a second contact.
 *   * The link UPDATE only applies from the expected link_state, and a partial
 *     unique index stops one contact being linked to two accounts.
 *   * The tag is added with a single conditional json_insert, so it can only
 *     ever appear once.
 */

export const CREATED_ACCOUNT_TAG = 'Created Account';
export const ACCOUNT_TYPES = ['student', 'mentor'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number] | 'staff';

/**
 * The shared public matching taxonomy, created per tenant on first use.
 * Featured topics are shown first; the rest sit behind "See more".
 */
export const DEFAULT_INTEREST_TAGS = [
  'Entrepreneurship',
  'Marketing',
  'Technology',
  'Product development',
  'Finance',
  'Fundraising',
  'Design',
  'Career development',
  'Sales',
  'Social impact',
  'Operations',
  'Legal & IP',
  'Leadership',
  'Data & analytics',
] as const;

export const MORE_INTEREST_TAGS = [
  'Accounting',
  'Artificial intelligence',
  'Arts & entertainment',
  'Biotech & life sciences',
  'Consulting',
  'Cybersecurity',
  'E-commerce',
  'Education',
  'Energy & sustainability',
  'Engineering',
  'Food & agriculture',
  'Healthcare',
  'Hospitality & tourism',
  'Human resources',
  'Manufacturing',
  'Media & communications',
  'Nonprofit management',
  'Public policy',
  'Real estate',
  'Research',
  'Software engineering',
  'Sports business',
  'Supply chain',
  'UX & user research',
  'Venture capital',
  'Writing & content',
] as const;

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Adds any default topics this tenant is missing (idempotent; existing topics are untouched). */
export async function ensureDefaultTags(db: Db, customerId: string): Promise<void> {
  const total = DEFAULT_INTEREST_TAGS.length + MORE_INTEREST_TAGS.length;
  const existing = await db.get<{ total: unknown }>(
    `SELECT COUNT(*) AS total FROM interest_tags WHERE customer_id = ?`,
    [customerId],
  );
  if (Number(existing?.total ?? 0) >= total) return;
  const timestamp = nowIso();
  await db.batch(
    [
      ...DEFAULT_INTEREST_TAGS.map((label) => ({ label, featured: 1 })),
      ...MORE_INTEREST_TAGS.map((label) => ({ label, featured: 0 })),
    ].map(({ label, featured }) => ({
      sql: `INSERT OR IGNORE INTO interest_tags (id, customer_id, slug, label, featured, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [newId(), customerId, slugify(label), label, featured, timestamp],
    })),
  );
}

/** A UUID-shaped id derived from the user id: the same user always maps to the same new contact. */
async function deterministicContactId(userId: string): Promise<string> {
  const hex = bufToHex(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`community-contact:${userId}`)),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface AccountForLink {
  user_id: string;
  customer_id: string;
  account_type: AccountType;
  status: string;
  onboarding_completed_at: string | null;
  link_state: string;
  contact_id: string | null;
  email: string;
  email_verified_at: string | null;
  first_name: string;
  last_name: string;
}

async function loadAccountForLink(db: Db, userId: string): Promise<AccountForLink | undefined> {
  return db.get<AccountForLink>(
    `SELECT ca.user_id, ca.customer_id, ca.account_type, ca.status, ca.onboarding_completed_at,
            ca.link_state, ca.contact_id, u.email, u.email_verified_at, p.first_name, p.last_name
       FROM community_accounts ca
       JOIN users u ON u.id = ca.user_id
       JOIN community_profiles p ON p.user_id = ca.user_id
      WHERE ca.user_id = ? AND u.deleted_at IS NULL`,
    [userId],
  );
}

/**
 * Moves an account forward as far as its state allows. Safe to call any number
 * of times, from any request (email verification, finishing onboarding, a
 * later /me, a staff "retry"): it activates a verified, onboarded pending
 * account, then attempts the CRM link if one is still pending. A failure while
 * linking is logged and left `pending`, to be retried on the next call.
 */
export async function finalizeAccount(ctx: Ctx, userId: string): Promise<void> {
  const account = await loadAccountForLink(ctx.db, userId);
  if (!account || account.status === 'deactivated') return;

  if (account.status === 'pending' && account.email_verified_at && account.onboarding_completed_at) {
    const timestamp = nowIso();
    const activated = await ctx.db.get<{ user_id: string }>(
      `UPDATE community_accounts SET status = 'active', activated_at = ?, updated_at = ?
        WHERE user_id = ? AND status = 'pending' RETURNING user_id`,
      [timestamp, timestamp, userId],
    );
    if (activated) {
      await audit(ctx.db, {
        customerId: account.customer_id,
        userId,
        action: 'community.activated',
        entityType: 'user',
        entityId: userId,
        metadata: { accountType: account.account_type },
        req: ctx.req,
      });
    }
  }

  if (account.account_type !== 'staff' && account.email_verified_at && account.link_state === 'pending') {
    try {
      await linkByVerifiedEmail(ctx, account);
    } catch (error) {
      console.error('[community] CRM link failed; will retry', error);
      await audit(ctx.db, {
        customerId: account.customer_id,
        userId,
        action: 'community.link_failed',
        entityType: 'user',
        entityId: userId,
        metadata: { message: String((error as Error)?.message ?? error).slice(0, 300) },
        req: ctx.req,
      });
    }
  }
}

async function linkByVerifiedEmail(ctx: Ctx, account: AccountForLink): Promise<void> {
  const { db } = ctx;
  const email = normaliseEmail(account.email);
  const matches = await db.all<{ id: string; linked_user: string | null }>(
    `SELECT c.id, ca.user_id AS linked_user
       FROM contacts c
       LEFT JOIN community_accounts ca ON ca.contact_id = c.id
      WHERE c.customer_id = ? AND c.deleted_at IS NULL AND lower(trim(c.email)) = ?
      ORDER BY c.created_at ASC, c.id ASC`,
    [account.customer_id, email],
  );

  // A previous attempt may have got as far as linking; finish (tag) and stop.
  const mine = matches.find((m) => m.linked_user === account.user_id);
  if (mine) {
    await commitLink(ctx, account, mine.id, 'auto');
    return;
  }

  if (matches.length > 1 || (matches.length === 1 && matches[0]!.linked_user)) {
    await flagConflict(ctx, account, matches.map((m) => m.id));
    return;
  }

  let contactId: string;
  let created = false;
  if (matches.length === 1) {
    contactId = matches[0]!.id;
  } else {
    contactId = await deterministicContactId(account.user_id);
    const timestamp = nowIso();
    const label = account.account_type === 'mentor' ? 'a mentor' : 'a student';
    await db.run(
      `INSERT OR IGNORE INTO contacts
         (id, customer_id, first_name, last_name, email, how_we_connected, tags, status,
          is_student_founder, created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'active', 0, ?, ?, NULL, NULL)`,
      [
        contactId,
        account.customer_id,
        account.first_name,
        account.last_name,
        email,
        `Joined the ECenter community portal as ${label} on ${formatDisplayDate(timestamp)}.`,
        timestamp,
        timestamp,
      ],
    );
    created = true;
  }

  await commitLink(ctx, account, contactId, created ? 'created' : 'auto');
}

async function flagConflict(ctx: Ctx, account: AccountForLink, candidateIds: string[]): Promise<void> {
  const flagged = await ctx.db.get<{ user_id: string }>(
    `UPDATE community_accounts SET link_state = 'conflict', link_candidates = ?, updated_at = ?
      WHERE user_id = ? AND link_state = 'pending' RETURNING user_id`,
    [JSON.stringify(candidateIds), nowIso(), account.user_id],
  );
  if (flagged) {
    await audit(ctx.db, {
      customerId: account.customer_id,
      userId: account.user_id,
      action: 'community.link_conflict',
      entityType: 'user',
      entityId: account.user_id,
      metadata: { candidateCount: candidateIds.length },
      req: ctx.req,
    });
  }
}

/** Adds the system tag once. Only applies while the contact is actually linked to an account. */
function addCreatedAccountTagWrite(contactId: string): { sql: string; params: SqlParam[] } {
  return {
    sql: `UPDATE contacts SET tags = json_insert(COALESCE(json(tags), '[]'), '$[#]', ?), updated_at = ?
           WHERE id = ?
             AND EXISTS (SELECT 1 FROM community_accounts ca WHERE ca.contact_id = contacts.id)
             AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json(contacts.tags), '[]')) WHERE value = ?)`,
    params: [CREATED_ACCOUNT_TAG, nowIso(), contactId, CREATED_ACCOUNT_TAG],
  };
}

export function removeCreatedAccountTagWrite(contactId: string): { sql: string; params: SqlParam[] } {
  return {
    sql: `UPDATE contacts
             SET tags = (SELECT json_group_array(value) FROM json_each(COALESCE(json(contacts.tags), '[]'))
                          WHERE value <> ?),
                 updated_at = ?
           WHERE id = ?
             AND EXISTS (SELECT 1 FROM json_each(COALESCE(json(contacts.tags), '[]')) WHERE value = ?)`,
    params: [CREATED_ACCOUNT_TAG, nowIso(), contactId, CREATED_ACCOUNT_TAG],
  };
}

async function commitLink(
  ctx: Ctx,
  account: { user_id: string; customer_id: string },
  contactId: string,
  how: 'auto' | 'created' | 'staff',
  allowedStates: string[] = ['pending', 'linked'],
): Promise<boolean> {
  const timestamp = nowIso();
  const placeholders = allowedStates.map(() => '?').join(', ');
  try {
    await ctx.db.batch([
      {
        sql: `UPDATE community_accounts
                 SET contact_id = ?, link_state = 'linked', link_candidates = NULL,
                     linked_at = COALESCE(linked_at, ?), updated_at = ?
               WHERE user_id = ? AND link_state IN (${placeholders})
                 AND (contact_id IS NULL OR contact_id = ?)`,
        params: [contactId, timestamp, timestamp, account.user_id, ...allowedStates, contactId],
      },
      addCreatedAccountTagWrite(contactId),
      {
        sql: `UPDATE community_accounts SET created_account_tagged_at = COALESCE(created_account_tagged_at, ?)
               WHERE user_id = ? AND contact_id = ?`,
        params: [timestamp, account.user_id, contactId],
      },
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another account claimed this contact in the meantime: never steal it.
    const full = await loadAccountForLink(ctx.db, account.user_id);
    if (full && how !== 'staff') await flagConflict(ctx, full, [contactId]);
    return false;
  }

  const linked = await ctx.db.get<{ contact_id: string | null }>(
    `SELECT contact_id FROM community_accounts WHERE user_id = ?`,
    [account.user_id],
  );
  if (linked?.contact_id !== contactId) return false;

  await audit(ctx.db, {
    customerId: account.customer_id,
    userId: how === 'staff' ? (ctx.auth?.userId ?? null) : account.user_id,
    action: 'community.linked',
    entityType: 'contact',
    entityId: contactId,
    metadata: { accountUserId: account.user_id, how },
    req: ctx.req,
  });
  return true;
}

/** Staff resolution of a conflict (or re-link after an unlink): link to a chosen contact or a new one. */
export async function staffLinkAccount(
  ctx: Ctx,
  input: { userId: string; customerId: string; contactId: string | null },
): Promise<'linked' | 'contact_taken' | 'not_found'> {
  const account = await loadAccountForLink(ctx.db, input.userId);
  if (!account || account.customer_id !== input.customerId || account.account_type === 'staff') return 'not_found';

  let contactId = input.contactId;
  if (contactId) {
    const contact = await ctx.db.get<{ linked_user: string | null }>(
      `SELECT ca.user_id AS linked_user FROM contacts c
         LEFT JOIN community_accounts ca ON ca.contact_id = c.id
        WHERE c.id = ? AND c.customer_id = ? AND c.deleted_at IS NULL`,
      [contactId, input.customerId],
    );
    if (!contact) return 'not_found';
    if (contact.linked_user && contact.linked_user !== input.userId) return 'contact_taken';
  } else {
    contactId = await deterministicContactId(account.user_id);
    const timestamp = nowIso();
    await ctx.db.run(
      `INSERT OR IGNORE INTO contacts
         (id, customer_id, first_name, last_name, email, how_we_connected, tags, status,
          is_student_founder, created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'active', 0, ?, ?, ?, ?)`,
      [
        contactId,
        input.customerId,
        account.first_name,
        account.last_name,
        normaliseEmail(account.email),
        `Joined the ECenter community portal on ${formatDisplayDate(timestamp)}.`,
        timestamp,
        timestamp,
        ctx.auth?.userId ?? null,
        ctx.auth?.userId ?? null,
      ],
    );
  }

  // Staff may resolve from any non-staff state; an existing different link is
  // released first (and its system tag removed) in the same request.
  if (account.contact_id && account.contact_id !== contactId) {
    await ctx.db.batch([
      {
        sql: `UPDATE community_accounts SET contact_id = NULL, link_state = 'unlinked', updated_at = ? WHERE user_id = ?`,
        params: [nowIso(), account.user_id],
      },
      removeCreatedAccountTagWrite(account.contact_id),
    ]);
  }
  const ok = await commitLink(ctx, account, contactId, 'staff', ['pending', 'linked', 'conflict', 'unlinked']);
  return ok ? 'linked' : 'contact_taken';
}

/**
 * Keeps the system tag accurate on staff edits: staff cannot add or remove
 * "Created Account" by hand; it is present exactly when the contact is linked
 * to a community account.
 */
export async function withSystemTags(db: Db, contactId: string | null, tags: string[]): Promise<string[]> {
  const cleaned = tags.filter((tag) => tag !== CREATED_ACCOUNT_TAG);
  if (!contactId) return cleaned;
  const linked = await db.get(`SELECT 1 AS linked FROM community_accounts WHERE contact_id = ?`, [contactId]);
  return linked ? [...cleaned, CREATED_ACCOUNT_TAG] : cleaned;
}

/* ------------------------------------------------------- public shapes -- */

export interface ProfileTag {
  slug: string;
  label: string;
}

export interface MemberTags {
  interests: ProfileTag[];
  help: ProfileTag[];
}

export async function loadTags(db: Db, userIds: string[]): Promise<Map<string, MemberTags>> {
  const result = new Map<string, MemberTags>();
  for (const id of userIds) result.set(id, { interests: [], help: [] });
  // Chunked to stay well under SQLite's bound-parameter limit.
  for (let i = 0; i < userIds.length; i += 90) {
    const chunk = userIds.slice(i, i + 90);
    const rows = await db.all<{ user_id: string; kind: string; slug: string; label: string }>(
      `SELECT pt.user_id, pt.kind, t.slug, t.label
         FROM community_profile_tags pt JOIN interest_tags t ON t.id = pt.tag_id
        WHERE pt.user_id IN (${chunk.map(() => '?').join(', ')})
        ORDER BY t.label ASC`,
      chunk,
    );
    for (const row of rows) {
      const entry = result.get(row.user_id);
      if (!entry) continue;
      (row.kind === 'help' ? entry.help : entry.interests).push({ slug: row.slug, label: row.label });
    }
  }
  return result;
}

/** Columns a public profile is built from. Nothing private or staff-only is selected. */
export const PUBLIC_PROFILE_COLUMNS = `
  p.user_id, p.first_name, p.last_name, p.bio, p.linkedin_url, p.photo_key, p.major,
  p.graduation_year, p.role_title, p.company, p.scheduling_url, ca.account_type, ca.status,
  (ca.resume_public = 1 AND ca.resume_key IS NOT NULL) AS public_resume`;

const PHOTO_URL_TTL_SECONDS = 60 * 60 * 6;

export async function photoUrl(ctx: Ctx, userId: string, photoKey: unknown): Promise<string | null> {
  if (!photoKey) return null;
  const token = await signValue({ k: 'photo', u: userId }, ctx.config.tokenSecret, PHOTO_URL_TTL_SECONDS);
  return `/api/community/files/photo/${userId}?token=${encodeURIComponent(token)}`;
}

/**
 * The ONLY shape a member is ever shown to other members in. It is an explicit
 * allow-list: no email, no resume, no CRM contact id, no internal tags.
 */
export async function publicMemberOut(ctx: Ctx, row: Record<string, unknown>, tags: MemberTags | undefined) {
  const type = String(row.account_type) as AccountType;
  const available = String(row.status) === 'active';
  return {
    id: String(row.user_id),
    firstName: String(row.first_name),
    lastName: String(row.last_name),
    fullName: `${String(row.first_name)} ${String(row.last_name)}`.trim(),
    accountType: type,
    bio: row.bio ? String(row.bio) : null,
    linkedinUrl: row.linkedin_url ? String(row.linkedin_url) : null,
    photoUrl: available ? await photoUrl(ctx, String(row.user_id), row.photo_key) : null,
    major: type === 'student' && row.major ? String(row.major) : null,
    graduationYear: type === 'student' && row.graduation_year ? Number(row.graduation_year) : null,
    roleTitle: type !== 'student' && row.role_title ? String(row.role_title) : null,
    company: type !== 'student' && row.company ? String(row.company) : null,
    schedulingUrl: type === 'mentor' && row.scheduling_url ? String(row.scheduling_url) : null,
    interests: tags?.interests ?? [],
    help: tags?.help ?? [],
    // Only true when the member chose to share it; the file itself is fetched separately.
    hasPublicResume: available && Number(row.public_resume ?? 0) === 1,
    available,
  };
}

/** Replaces a user's tags of one kind with the given slugs (unknown slugs are rejected by the caller). */
export function replaceTagWrites(
  userId: string,
  customerId: string,
  kind: 'interest' | 'help',
  tagIds: string[],
): { sql: string; params: SqlParam[] }[] {
  const timestamp = nowIso();
  return [
    { sql: `DELETE FROM community_profile_tags WHERE user_id = ? AND kind = ?`, params: [userId, kind] },
    ...tagIds.map((tagId) => ({
      sql: `INSERT OR IGNORE INTO community_profile_tags (user_id, tag_id, kind, customer_id, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [userId, tagId, kind, customerId, timestamp] as SqlParam[],
    })),
  ];
}
