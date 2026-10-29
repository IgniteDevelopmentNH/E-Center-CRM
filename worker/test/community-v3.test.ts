import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

/**
 * Community portal v3: event options (21+, attendee lists, guest visibility),
 * guest access, blocked emails, groups and group-only posts, businesses,
 * competitions, and staff community identities. Same harness as
 * community-v2.test.ts.
 */

// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeD1 } from '../dev/fakeD1.mjs';
// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeR2 } from '../dev/fakeR2.mjs';
import { createD1Db } from '../src/db/d1.ts';
import worker from '../src/index.ts';
import { seedDemoData } from '../scripts/seed.ts';

const testDbPath = path.join(os.tmpdir(), `ecenter-community-v3-test-${process.pid}.db`);
const uploadDir = path.join(os.tmpdir(), `ecenter-community-v3-uploads-${process.pid}`);
fs.rmSync(testDbPath, { force: true });
fs.rmSync(uploadDir, { recursive: true, force: true });

interface SentMail {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}
const outbox: SentMail[] = [];
const fakeD1 = createFakeD1(testDbPath);
const env = {
  DB: fakeD1,
  DOCS: createFakeR2(uploadDir),
  ASSETS: { fetch: async () => new Response('not used in tests', { status: 404 }) },
  EMAIL: {
    async send(message: SentMail) {
      outbox.push({ to: message.to, subject: message.subject, text: message.text, headers: message.headers });
      return { messageId: `test-${outbox.length}` };
    },
  },
  MAIL_FROM: 'noreply@example.test',
  DEFAULT_CUSTOMER_SLUG: 'unh-ecenter',
  DEFAULT_CUSTOMER_NAME: 'UNH Entrepreneurship Center',
  DOWNLOAD_URL_TTL_SECONDS: '900',
  UPLOAD_MAX_BYTES: '52428800',
  JWT_TTL_SECONDS: '43200',
  JWT_TTL_REMEMBER_SECONDS: '2592000',
  APP_URL: 'http://localhost:5173',
  JWT_SECRET: 'test-token-secret',
  ENCRYPTION_KEY: 'test-encryption-key',
};

let ownerToken = '';
let editorToken = '';
let viewerToken = '';
let ipCounter = 0;

async function api(method: string, routePath: string, body?: unknown, authToken: string | null = ownerToken) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': `10.1.0.${(ipCounter++ % 250) + 1}` };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`http://localhost${routePath}`, { method, headers, body: payload }), env as never);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as any };
  } catch {
    return { status: response.status, body: text as any };
  }
}

function raw() {
  return fakeD1._raw as { prepare(sql: string): { all(...a: unknown[]): any[]; get(...a: unknown[]): any; run(...a: unknown[]): any } };
}

/** Runs the cron handler, after making everything queued due now. */
async function runOutbox() {
  raw().prepare(`UPDATE email_outbox SET send_after = '2000-01-01T00:00:00.000Z' WHERE status = 'queued'`).run();
  await worker.scheduled({}, env as never);
}

function mailTo(email: string) {
  return outbox.filter((m) => m.to === email);
}

interface Member {
  token: string;
  userId: string;
  email: string;
}

async function createMember(accountType: 'student' | 'mentor', first: string, last: string, email: string, profile: Record<string, unknown> = {}): Promise<Member> {
  const created = await api('POST', '/api/community/signup', { accountType, firstName: first, lastName: last, email, password: 'longpassword1' }, null);
  assert.ok(created.status === 201, JSON.stringify(created.body));
  const message = [...outbox].reverse().find((m) => m.to === email && m.text.includes('/verify-email?'))!;
  const token = /token=([a-f0-9]+)/.exec(message.text)![1]!;
  assert.equal((await api('POST', '/api/auth/verify-email', { token }, null)).status, 200);
  assert.equal((await api('PUT', '/api/community/profile', { firstName: first, lastName: last, ...profile }, created.body.token)).status, 200);
  const done = await api('POST', '/api/community/onboarding/complete', undefined, created.body.token);
  assert.equal(done.body.community.status, 'active');
  return { token: created.body.token, userId: created.body.user.id, email };
}

const mention = (m: Member, name: string) => `@[${name}](user:${m.userId})`;


function pngFile(name: string): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  return new File([bytes], name, { type: 'image/png' });
}

const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

let student: Member;
let mentor: Member;
let other: Member;

before(async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  fakeD1._raw.exec(fs.readFileSync(path.join(here, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  await seedDemoData(createD1Db(fakeD1 as never), 'unh-ecenter', 'UNH Entrepreneurship Center');
  ownerToken = (await api('POST', '/api/auth/login', { email: 'lisa@unh.edu', password: 'test123' }, null)).body.token;
  editorToken = (await api('POST', '/api/auth/login', { email: 'bella@unh.edu', password: 'test123' }, null)).body.token;
  await api('POST', '/api/settings/users', { email: 'viewer@unh.edu', name: 'Vera Viewer', role: 'viewer', password: 'viewerpass12' });
  viewerToken = (await api('POST', '/api/auth/login', { email: 'viewer@unh.edu', password: 'viewerpass12' }, null)).body.token;

  student = await createMember('student', 'Stella', 'Student', 'stella@example.org');
  mentor = await createMember('mentor', 'Manny', 'Mentor', 'manny@example.org');
  other = await createMember('student', 'Otis', 'Other', 'otis@example.org');
  assert.equal((await api('PUT', `/api/admin/community/accounts/${mentor.userId}/permissions`, { postPermission: 'direct' }, editorToken)).status, 200);
});

after(() => {
  fakeD1._close();
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

describe('defaults', () => {
  it('students and mentors cannot post or create groups until staff allow it', async () => {
    const fresh = await createMember('mentor', 'Nora', 'New', 'nora.new@example.org');
    const me = await api('GET', '/api/auth/me', undefined, fresh.token);
    assert.equal(me.body.community.postPermission, 'none');
    assert.equal(me.body.community.canCreateGroups, false);
    const post = await api('POST', '/api/community/posts', { title: 'Hi', body: 'Hello' }, fresh.token);
    assert.equal(post.status, 403);
  });

  it('staff appear under ECenter staff once they create their community profile', async () => {
    await api('GET', '/api/auth/me', undefined, ownerToken);
    assert.equal(raw().prepare(`SELECT 1 FROM community_accounts WHERE user_id = (SELECT id FROM users WHERE email = 'lisa@unh.edu')`).get(), undefined);
    assert.equal((await api('POST', '/api/community/staff-identity', undefined, ownerToken)).status, 201);
    const staff = await api('GET', '/api/community/members?type=staff', undefined, student.token);
    assert.equal(staff.status, 200);
    const names = staff.body.members.map((m: { fullName?: string; firstName?: string; name?: string }) => JSON.stringify(m));
    assert.ok(names.some((n: string) => n.includes('Lisa')), names.join());
    assert.ok(staff.body.members.every((m: { accountType: string }) => m.accountType === 'staff'));
  });

  it('new staff users do not get a community identity until they create one', async () => {
    const created = await api('POST', '/api/settings/users', { email: 'newstaff@unh.edu', name: 'Nick Staff', role: 'editor', password: 'staffpass1234' });
    assert.equal(created.status, 201);
    assert.equal(raw().prepare(`SELECT 1 FROM community_accounts WHERE user_id = ?`).get(created.body.user.id), undefined);
  });
});

describe('event options', () => {
  it('21+ events require the over-21 confirmation and record it', async () => {
    const created = await api('POST', '/api/community/posts', {
      title: 'Founders night', body: 'Drinks downtown', isEvent: true, eventStartsAt: inDays(5),
      rsvpEnabled: true, eventAge21: true, rsvpListPublic: true,
    }, mentor.token);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.post.event.age21, true);
    assert.equal(created.body.post.event.attendeesPublic, true);
    const id = created.body.post.id;

    const refused = await api('POST', `/api/community/posts/${id}/rsvp`, { going: true }, student.token);
    assert.equal(refused.status, 400);
    const ok = await api('POST', `/api/community/posts/${id}/rsvp`, { going: true, over21: true }, student.token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.rsvpCount, 1);
    const stored = raw().prepare(`SELECT over21_confirmed FROM event_rsvps WHERE target_id = ? AND user_id = ?`).get(id, student.userId);
    assert.equal(stored.over21_confirmed, 1);

    const attendees = await api('GET', `/api/community/posts/${id}/attendees`, undefined, other.token);
    assert.equal(attendees.status, 200);
    assert.deepEqual(attendees.body.attendees.map((a: { id: string }) => a.id), [student.userId]);
  });

  it('a private attendee list is visible only to the organiser and staff', async () => {
    const created = await api('POST', '/api/community/posts', {
      title: 'Quiet meetup', body: 'Small group', isEvent: true, eventStartsAt: inDays(3), rsvpEnabled: true,
    }, mentor.token);
    const id = created.body.post.id;
    await api('POST', `/api/community/posts/${id}/rsvp`, { going: true }, student.token);
    assert.equal((await api('GET', `/api/community/posts/${id}/attendees`, undefined, other.token)).status, 403);
    assert.equal((await api('GET', `/api/community/posts/${id}/attendees`, undefined, mentor.token)).status, 200);
    assert.equal((await api('GET', `/api/community/posts/${id}/attendees`, undefined, editorToken)).status, 200);
  });

  it('CRM events carry the same options', async () => {
    const event = await api('POST', '/api/events', {
      name: 'Pitch night', startsAt: inDays(7), communityVisible: true, communityRsvp: true,
      communityAge21: true, communityRsvpPublic: true, communityGuestVisible: false,
    }, editorToken);
    assert.equal(event.status, 201);
    assert.equal(event.body.event.communityAge21, true);
    assert.equal(event.body.event.communityGuestVisible, false);
    const id = event.body.event.id;
    assert.equal((await api('POST', `/api/community/events/${id}/rsvp`, { going: true }, other.token)).status, 400);
    assert.equal((await api('POST', `/api/community/events/${id}/rsvp`, { going: true, over21: true }, other.token)).status, 200);
    const list = await api('GET', `/api/community/events/${id}/attendees`, undefined, student.token);
    assert.equal(list.body.attendees.length, 1);
    // Hidden from guests.
    assert.equal((await api('GET', `/api/public/events/${id}`, undefined, null)).status, 404);
    const guestEvents = await api('GET', '/api/public/events?limit=30', undefined, null);
    assert.ok(!guestEvents.body.events.some((e: { id: string }) => e.id === id));
  });
});

describe('guest access', () => {
  it('guests read the feed without an account, minus hidden and group-only posts', async () => {
    const shown = await api('POST', '/api/community/posts', { title: 'Open to all', body: 'Everyone welcome' }, mentor.token);
    const hidden = await api('POST', '/api/community/posts', { title: 'Members only', body: 'Shh', guestVisible: false }, mentor.token);
    assert.equal(hidden.body.post.guestVisible, false);

    const feed = await api('GET', '/api/public/feed?limit=30', undefined, null);
    assert.equal(feed.status, 200);
    const ids = feed.body.posts.map((p: { id: string }) => p.id);
    assert.ok(ids.includes(shown.body.post.id));
    assert.ok(!ids.includes(hidden.body.post.id));
    const post = feed.body.posts.find((p: { id: string }) => p.id === shown.body.post.id);
    // Member authors: first name and last initial, no profile link or photo.
    assert.equal(post.author.name, 'Manny M.');
    assert.equal(post.author.id, null);

    assert.equal((await api('GET', `/api/public/posts/${hidden.body.post.id}`, undefined, null)).status, 404);
    const detail = await api('GET', `/api/public/posts/${shown.body.post.id}`, undefined, null);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.comments, []);
    // Members still see the hidden post.
    assert.equal((await api('GET', `/api/community/posts/${hidden.body.post.id}`, undefined, student.token)).status, 200);
  });

  it('guests cannot act or reach member-only data', async () => {
    assert.equal((await api('GET', '/api/community/feed', undefined, null)).status, 401);
    assert.equal((await api('GET', '/api/community/members', undefined, null)).status, 401);
    assert.equal((await api('GET', '/api/community/groups', undefined, null)).status, 401);
    assert.equal((await api('GET', '/api/community/businesses', undefined, null)).status, 401);
  });
});

describe('blocked emails', () => {
  it('a removed member cannot sign up again until staff unblock them', async () => {
    const gone = await createMember('student', 'Gus', 'Gone', 'gus.gone@example.org');
    assert.equal((await api('POST', `/api/admin/community/accounts/${gone.userId}/deactivate`, { reason: 'Spam' }, editorToken)).status, 200);

    // Same email (any case) is refused, even after the old user is deleted.
    raw().prepare(`UPDATE users SET deleted_at = '2026-01-01T00:00:00.000Z', email = 'old-' || email WHERE id = ?`).run(gone.userId);
    const again = await api('POST', '/api/community/signup', {
      accountType: 'student', firstName: 'Gus', lastName: 'Gone', email: 'GUS.GONE@example.org', password: 'longpassword1',
    }, null);
    assert.equal(again.status, 403);
    raw().prepare(`UPDATE users SET deleted_at = NULL, email = substr(email, 5) WHERE id = ?`).run(gone.userId);

    const list = await api('GET', '/api/admin/blocked-emails', undefined, viewerToken);
    assert.equal(list.status, 200);
    const entry = list.body.blocked.find((b: { email: string }) => b.email === 'gus.gone@example.org');
    assert.ok(entry);
    assert.equal(entry.reason, 'Spam');

    assert.equal((await api('DELETE', `/api/admin/blocked-emails/${entry.id}`, undefined, viewerToken)).status, 403);
    const undone = await api('DELETE', `/api/admin/blocked-emails/${entry.id}`, undefined, editorToken);
    assert.equal(undone.status, 200);
    assert.equal(undone.body.reactivated, true);
    const account = raw().prepare(`SELECT status FROM community_accounts WHERE user_id = ?`).get(gone.userId);
    assert.equal(account.status, 'active');
    assert.equal((await api('POST', '/api/auth/login', { email: 'gus.gone@example.org', password: 'longpassword1' }, null)).status, 200);
  });

  it('reactivating from the member page also unblocks', async () => {
    const back = await createMember('mentor', 'Bea', 'Back', 'bea.back@example.org');
    await api('POST', `/api/admin/community/accounts/${back.userId}/deactivate`, {}, editorToken);
    assert.ok(raw().prepare(`SELECT 1 FROM blocked_emails WHERE email = 'bea.back@example.org'`).get());
    await api('POST', `/api/admin/community/accounts/${back.userId}/reactivate`, {}, editorToken);
    assert.equal(raw().prepare(`SELECT 1 FROM blocked_emails WHERE email = 'bea.back@example.org'`).get(), undefined);
  });
});

describe('groups', () => {
  let groupId = '';

  it('lists the default groups and lets members join public ones', async () => {
    const list = await api('GET', '/api/community/groups', undefined, student.token);
    assert.equal(list.status, 200);
    const names = list.body.groups.map((g: { name: string }) => g.name);
    for (const name of ['Finance', 'Accounting', 'Marketing']) assert.ok(names.includes(name), name);
    assert.equal(list.body.canCreate, false);
    const finance = list.body.groups.find((g: { name: string }) => g.name === 'Finance');
    const joined = await api('POST', `/api/community/groups/${finance.id}/join`, undefined, student.token);
    assert.equal(joined.body.group.membership.status, 'active');
  });

  it('only members staff allow can create groups; creators moderate them', async () => {
    assert.equal((await api('POST', '/api/community/groups', { name: 'Founders Circle' }, mentor.token)).status, 403);
    const granted = await api('PUT', `/api/admin/community/accounts/${mentor.userId}/permissions`, { canCreateGroups: true }, editorToken);
    assert.equal(granted.body.account.canCreateGroups, true);
    assert.equal(granted.body.account.postPermission, 'direct');
    const created = await api('POST', '/api/community/groups', { name: 'Founders Circle', description: 'Invite only', privacy: 'private' }, mentor.token);
    assert.equal(created.status, 201);
    assert.equal(created.body.group.membership.role, 'moderator');
    assert.equal(created.body.group.privacy, 'private');
    groupId = created.body.group.id;
  });

  it('private groups take join requests that moderators approve', async () => {
    const asked = await api('POST', `/api/community/groups/${groupId}/join`, undefined, student.token);
    assert.equal(asked.body.group.membership.status, 'pending');
    assert.equal((await api('GET', `/api/community/groups/${groupId}/posts`, undefined, student.token)).status, 403);
    assert.equal((await api('POST', `/api/community/groups/${groupId}/requests/${student.userId}/approve`, undefined, other.token)).status, 403);
    const members = await api('GET', `/api/community/groups/${groupId}/members`, undefined, mentor.token);
    assert.deepEqual(members.body.requests.map((r: { id: string }) => r.id), [student.userId]);
    const approved = await api('POST', `/api/community/groups/${groupId}/requests/${student.userId}/approve`, undefined, mentor.token);
    assert.equal(approved.status, 200);
    assert.equal((await api('GET', `/api/community/groups/${groupId}/posts`, undefined, student.token)).status, 200);
  });

  it('group-only posts stay out of the main feed and away from non-members', async () => {
    assert.equal((await api('POST', '/api/community/posts', {
      title: 'Wrong group', body: 'x', audience: 'groups', groupIds: [groupId],
    }, other.token)).status, 403); // other cannot post at all
    const outsiderGroups = await api('GET', '/api/community/groups', undefined, mentor.token);
    const marketing = outsiderGroups.body.groups.find((g: { name: string }) => g.name === 'Marketing');
    assert.equal((await api('POST', '/api/community/posts', {
      title: 'Not joined', body: 'x', audience: 'groups', groupIds: [marketing.id],
    }, mentor.token)).status, 400);

    const post = await api('POST', '/api/community/posts', {
      title: 'Circle update', body: 'Members only news', audience: 'groups', groupIds: [groupId],
    }, mentor.token);
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.equal(post.body.post.audience, 'groups');
    assert.equal(post.body.post.groups[0].id, groupId);
    const id = post.body.post.id;

    const feed = await api('GET', '/api/community/feed?limit=30', undefined, student.token);
    assert.ok(!feed.body.posts.some((p: { id: string }) => p.id === id));
    const groupFeed = await api('GET', `/api/community/groups/${groupId}/posts`, undefined, student.token);
    assert.ok(groupFeed.body.posts.some((p: { id: string }) => p.id === id));
    assert.equal((await api('GET', `/api/community/posts/${id}`, undefined, student.token)).status, 200);
    assert.equal((await api('GET', `/api/community/posts/${id}`, undefined, other.token)).status, 404);
    assert.equal((await api('POST', `/api/community/posts/${id}/like`, {}, other.token)).status, 404);
    assert.equal((await api('GET', `/api/public/posts/${id}`, undefined, null)).status, 404);
    // Staff moderators see it.
    assert.equal((await api('GET', `/api/community/posts/${id}`, undefined, editorToken)).status, 200);
  });

  it('making a group public lets waiting requests in', async () => {
    await api('POST', `/api/community/groups/${groupId}/join`, undefined, other.token);
    const updated = await api('PUT', `/api/community/groups/${groupId}`, { name: 'Founders Circle', privacy: 'public' }, mentor.token);
    assert.equal(updated.status, 200);
    const row = raw().prepare(`SELECT status FROM group_members WHERE group_id = ? AND user_id = ?`).get(groupId, other.userId);
    assert.equal(row.status, 'active');
  });

  it('staff manage every group from Admin', async () => {
    const list = await api('GET', '/api/admin/groups', undefined, viewerToken);
    assert.equal(list.status, 200);
    const circle = list.body.groups.find((g: { id: string }) => g.id === groupId);
    assert.deepEqual(circle.moderators.map((m: { id: string }) => m.id), [mentor.userId]);
    const promoted = await api('PUT', `/api/community/groups/${groupId}/members/${student.userId}/role`, { role: 'moderator' }, editorToken);
    assert.equal(promoted.status, 200);
    assert.equal((await api('DELETE', `/api/community/groups/${groupId}`, undefined, editorToken)).status, 200);
    assert.equal((await api('GET', `/api/community/groups/${groupId}`, undefined, student.token)).status, 404);
    assert.equal((await api('POST', `/api/admin/groups/${groupId}/restore`, undefined, editorToken)).status, 200);
  });
});

describe('businesses', () => {
  let businessId = '';

  it('members create a business profile with a logo and photos', async () => {
    const created = await api('POST', '/api/community/businesses', {
      name: 'Wildcat Widgets', tagline: 'Better widgets', description: 'We make widgets.', industry: 'Manufacturing',
      website: 'wildcatwidgets.example', hiring: true, hiringDetails: 'Two interns', networking: true, lookingFor: 'Suppliers',
    }, student.token);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.business.website, 'https://wildcatwidgets.example/');
    businessId = created.body.business.id;

    const logo = new FormData();
    logo.append('file', pngFile('logo.png'));
    const withLogo = await api('POST', `/api/community/businesses/${businessId}/logo`, logo, student.token);
    assert.equal(withLogo.status, 200);
    assert.ok(withLogo.body.business.logoUrl);
    const image = await worker.fetch(new Request(`http://localhost${withLogo.body.business.logoUrl}`), env as never);
    assert.equal(image.status, 200);

    const photo = new FormData();
    photo.append('file', pngFile('shop.png'));
    const withPhoto = await api('POST', `/api/community/businesses/${businessId}/photos?caption=Our%20shop`, photo, student.token);
    assert.equal(withPhoto.status, 201);
    assert.equal(withPhoto.body.business.photos[0].caption, 'Our shop');
  });

  it('lists and filters businesses; only the owner or staff can change one', async () => {
    const hiring = await api('GET', '/api/community/businesses?hiring=1', undefined, other.token);
    assert.ok(hiring.body.businesses.some((b: { id: string }) => b.id === businessId));
    assert.deepEqual(hiring.body.industries, ['Manufacturing']);
    const mine = await api('GET', '/api/community/businesses?owner=me', undefined, other.token);
    assert.equal(mine.body.businesses.length, 0);
    assert.equal((await api('PUT', `/api/community/businesses/${businessId}`, { name: 'Hijacked' }, other.token)).status, 403);
    assert.equal((await api('PUT', `/api/community/businesses/${businessId}`, { name: 'Wildcat Widgets Co' }, editorToken)).status, 200);
  });

  it('removed owners take their business out of the directory', async () => {
    await api('POST', `/api/admin/community/accounts/${student.userId}/deactivate`, {}, editorToken);
    assert.equal((await api('GET', `/api/community/businesses/${businessId}`, undefined, other.token)).status, 404);
    await api('POST', `/api/admin/community/accounts/${student.userId}/reactivate`, {}, editorToken);
    assert.equal((await api('GET', `/api/community/businesses/${businessId}`, undefined, other.token)).status, 200);
  });
});

describe('competitions', () => {
  it('staff post competitions whose deadlines show up as events', async () => {
    assert.equal((await api('POST', '/api/admin/competitions', { title: 'Nope' }, viewerToken)).status, 403);
    const created = await api('POST', '/api/admin/competitions', {
      title: 'Holloway Prize', summary: 'Pitch your venture', prize: '$40,000', publish: true,
      deadlines: [{ label: 'Applications due', dueAt: inDays(10) }, { label: 'Finals', dueAt: inDays(30) }],
    }, editorToken);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.competition.deadlines.length, 2);
    assert.equal(created.body.competition.nextDeadline.label, 'Applications due');
    const draft = await api('POST', '/api/admin/competitions', { title: 'Secret draft', deadlines: [{ label: 'Due', dueAt: inDays(4) }] }, editorToken);

    const list = await api('GET', '/api/community/competitions', undefined, other.token);
    const ids = list.body.competitions.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(created.body.competition.id));
    assert.ok(!ids.includes(draft.body.competition.id));
    assert.equal((await api('GET', `/api/community/competitions/${draft.body.competition.id}`, undefined, other.token)).status, 404);

    const events = await api('GET', '/api/community/events?limit=30', undefined, other.token);
    const deadlines = events.body.events.filter((e: { source: string }) => e.source === 'deadline');
    assert.deepEqual(deadlines.map((e: { name: string }) => e.name), ['Holloway Prize: Applications due', 'Holloway Prize: Finals']);
    assert.equal(deadlines[0].competitionId, created.body.competition.id);

    // Guests see published competitions and their deadlines too.
    const guest = await api('GET', '/api/public/competitions', undefined, null);
    assert.ok(guest.body.competitions.some((c: { id: string }) => c.id === created.body.competition.id));
    const guestEvents = await api('GET', '/api/public/events?limit=30', undefined, null);
    assert.ok(guestEvents.body.events.some((e: { source: string }) => e.source === 'deadline'));

    // Unpublishing removes the deadlines from events.
    await api('POST', `/api/admin/competitions/${created.body.competition.id}/unpublish`, undefined, editorToken);
    const after = await api('GET', '/api/community/events?limit=30', undefined, other.token);
    assert.ok(!after.body.events.some((e: { source: string }) => e.source === 'deadline'));
  });
});
