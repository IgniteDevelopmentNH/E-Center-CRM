import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

/**
 * Community portal v4: student school details, the events-only feed, event
 * icons, registration questions, guest RSVPs, organization history, and the
 * efficiency work. Same harness as community-v3.test.ts.
 */

// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeD1 } from '../dev/fakeD1.mjs';
// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeR2 } from '../dev/fakeR2.mjs';
import { createD1Db } from '../src/db/d1.ts';
import worker from '../src/index.ts';
import { seedDemoData } from '../scripts/seed.ts';
import { EVENT_ICON_KEYS } from '../src/services/eventOptions.ts';
import { purgeExpiredData } from '../src/services/notifications.ts';

const testDbPath = path.join(os.tmpdir(), `ecenter-community-v4-test-${process.pid}.db`);
const uploadDir = path.join(os.tmpdir(), `ecenter-community-v4-uploads-${process.pid}`);
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
  assert.equal((await api('PUT', '/api/community/profile', { firstName: first, lastName: last, ...(accountType === 'student' ? { graduationYear: 2028, schoolType: 'unh' } : {}), ...profile }, created.body.token)).status, 200);
  const done = await api('POST', '/api/community/onboarding/complete', undefined, created.body.token);
  assert.equal(done.body.community.status, 'active');
  return { token: created.body.token, userId: created.body.user.id, email };
}



function pngFile(name: string): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  return new File([bytes], name, { type: 'image/png' });
}

const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const eventPost = (title: string, extra: Record<string, unknown> = {}) => ({
  title, body: 'Details', isEvent: true, eventStartsAt: inDays(5), rsvpEnabled: true, ...extra,
});

const QUESTIONS = [
  { id: 'plus-one', type: 'yesno', label: 'Are you bringing a plus one?', required: true },
  { id: 'photo', type: 'choice', label: 'Can we take your picture?', required: true, options: ['Yes', 'Only group shots', 'No'] },
  { id: 'diet', type: 'checkboxes', label: 'Dietary restrictions', required: false, options: ['Vegetarian', 'Vegan', 'Gluten free'] },
  { id: 'notes', type: 'text', label: 'Anything else?', required: false },
];
const GOOD_ANSWERS = { 'plus-one': 'Yes', photo: 'Only group shots', diet: ['Vegan'] };

let student: Member;
let mentor: Member;
let other: Member;

before(async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  fakeD1._raw.exec(fs.readFileSync(path.join(here, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  await seedDemoData(createD1Db(fakeD1 as never), 'unh-ecenter', 'UNH Entrepreneurship Center');
  ownerToken = (await api('POST', '/api/auth/login', { email: 'lisa@unh.edu', password: 'test123' }, null)).body.token;
  editorToken = (await api('POST', '/api/auth/login', { email: 'bella@unh.edu', password: 'test123' }, null)).body.token;
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

describe('student signup', () => {
  async function startStudent(email: string) {
    const created = await api('POST', '/api/community/signup', { accountType: 'student', firstName: 'New', lastName: 'Student', email, password: 'longpassword1' }, null);
    assert.equal(created.status, 201);
    const message = [...outbox].reverse().find((m) => m.to === email && m.text.includes('/verify-email?'))!;
    assert.equal((await api('POST', '/api/auth/verify-email', { token: /token=([a-f0-9]+)/.exec(message.text)![1]! }, null)).status, 200);
    return created.body.token as string;
  }

  it('students cannot finish without a graduation year and a school', async () => {
    const token = await startStudent('needs.details@example.org');
    assert.equal((await api('POST', '/api/community/onboarding/complete', undefined, token)).body.field, 'Graduation year');
    await api('PUT', '/api/community/profile', { firstName: 'New', lastName: 'Student', graduationYear: 2029 }, token);
    assert.equal((await api('POST', '/api/community/onboarding/complete', undefined, token)).body.field, 'School');
    await api('PUT', '/api/community/profile', { firstName: 'New', lastName: 'Student', graduationYear: 2029, schoolType: 'other', schoolName: 'Keene State' }, token);
    const done = await api('POST', '/api/community/onboarding/complete', undefined, token);
    assert.equal(done.status, 200);
    assert.equal(done.body.community.status, 'active');
    assert.equal(done.body.community.profile.schoolName, 'Keene State');
    const blanked = await api('PUT', '/api/community/profile', { firstName: 'New', lastName: 'Student', schoolType: 'other' }, token);
    assert.equal(blanked.status, 400);
  });

  it('mentors are not asked for either', async () => {
    await createMember('mentor', 'Mo', 'Mentor', 'mo.mentor@example.org');
  });

  it('a school appears on the public profile', async () => {
    const profile = await api('GET', `/api/community/members/${student.userId}`, undefined, other.token);
    assert.equal(profile.body.member.school, 'UNH');
  });
});

describe('the feed is events', () => {
  it('rejects posts that are not events, but leaves older ones readable and editable', async () => {
    const created = await api('POST', '/api/community/posts', { title: 'Just news', body: 'Hello' }, mentor.token);
    assert.equal(created.status, 400);
    assert.equal((await api('POST', '/api/admin/posts', { title: 'Just news', body: 'Hello', publish: true }, editorToken)).status, 400);

    const id = 'legacy-post-id';
    const now = new Date().toISOString();
    const customer = raw().prepare(`SELECT id FROM customers LIMIT 1`).get().id;
    raw().prepare(`INSERT INTO posts (id, customer_id, title, body, status, published_at, author_id, author_kind, created_at, updated_at) VALUES (?, ?, 'Old news', 'Body', 'published', ?, ?, 'member', ?, ?)`).run(id, customer, now, mentor.userId, now, now);
    assert.equal((await api('GET', `/api/community/posts/${id}`, undefined, student.token)).status, 200);
    assert.equal((await api('PUT', `/api/community/posts/${id}`, { title: 'Old news, edited', body: 'Body' }, mentor.token)).status, 200);
    const feed = await api('GET', '/api/community/feed?limit=30', undefined, student.token);
    assert.ok(!feed.body.items.some((item: any) => item.post?.id === id));
  });

  it('merges event posts, CRM events and competition deadlines soonest first, across pages', async () => {
    const soon = await api('POST', '/api/community/posts', eventPost('Soonest', { eventStartsAt: inDays(1) }), mentor.token);
    const crm = await api('POST', '/api/events', { name: 'CRM night', startsAt: inDays(2), communityVisible: true }, editorToken);
    const hidden = await api('POST', '/api/events', { name: 'Internal only', startsAt: inDays(2) }, editorToken);
    await api('POST', '/api/admin/competitions', { title: 'Big Pitch', publish: true, deadlines: [{ label: 'Apply by', dueAt: inDays(3) }] }, editorToken);

    const first = await api('GET', '/api/community/feed?limit=2', undefined, student.token);
    assert.deepEqual(first.body.items.map((item: any) => item.kind), ['post', 'event']);
    assert.equal(first.body.items[0].post.id, soon.body.post.id);
    assert.equal(first.body.items[1].event.id, crm.body.event.id);
    const second = await api('GET', `/api/community/feed?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, undefined, student.token);
    assert.equal(second.body.items[0].kind, 'deadline');
    assert.equal(second.body.items[0].deadline.title, 'Big Pitch');
    const all = await api('GET', '/api/community/feed?limit=30', undefined, student.token);
    assert.ok(!all.body.items.some((item: any) => item.event?.id === hidden.body.event.id));
    const starts = all.body.items.map((item: any) => item.startsAt);
    assert.deepEqual(starts, [...starts].sort());
  });

  it('past events are listed separately, latest first', async () => {
    const past = await api('POST', '/api/community/posts', eventPost('Last week', { eventStartsAt: inDays(-7) }), mentor.token);
    const upcoming = await api('GET', '/api/community/feed?limit=30', undefined, student.token);
    assert.ok(!upcoming.body.items.some((item: any) => item.post?.id === past.body.post.id));
    const history = await api('GET', '/api/community/feed?when=past', undefined, student.token);
    assert.ok(history.body.items.some((item: any) => item.post?.id === past.body.post.id));
  });

  it('group-only events stay out of the main feed', async () => {
    const groups = await api('GET', '/api/community/groups', undefined, mentor.token);
    const finance = groups.body.groups.find((g: any) => g.name === 'Finance');
    await api('POST', `/api/community/groups/${finance.id}/join`, undefined, mentor.token);
    const made = await api('POST', '/api/community/posts', eventPost('Finance only', { audience: 'groups', groupIds: [finance.id] }), mentor.token);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const feed = await api('GET', '/api/community/feed?limit=30', undefined, student.token);
    assert.ok(!feed.body.items.some((item: any) => item.post?.id === made.body.post.id));
    const groupFeed = await api('GET', `/api/community/groups/${finance.id}/posts`, undefined, student.token);
    assert.ok(groupFeed.body.posts.some((p: any) => p.id === made.body.post.id));
  });
});

describe('event icons', () => {
  it('stores chosen icons and rejects unknown ones or too many', async () => {
    const made = await api('POST', '/api/community/posts', eventPost('Pizza night', { eventIcons: ['food', 'cash-prize', 'food'] }), mentor.token);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.post.event.icons, ['food', 'cash-prize']);
    assert.equal((await api('POST', '/api/community/posts', eventPost('Bad', { eventIcons: ['not-a-thing'] }), mentor.token)).status, 400);
    const tooMany = ['food', 'pizza', 'snacks', 'coffee', 'drinks', 'alcohol', 'vegetarian', 'trophy', 'swag'];
    assert.equal((await api('POST', '/api/community/posts', eventPost('Bad', { eventIcons: tooMany }), mentor.token)).status, 400);
  });

  it('server and client agree on the palette', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const client = fs.readFileSync(path.join(here, '..', '..', 'client', 'src', 'lib', 'eventIcons.ts'), 'utf8');
    const clientKeys = [...client.matchAll(/key: '([a-z0-9-]+)'/g)].map((m) => m[1]!).sort();
    assert.deepEqual(clientKeys, [...EVENT_ICON_KEYS].sort());
  });
});

describe('registration questions', () => {
  let postId = '';

  it('organisers add custom questions, which are validated', async () => {
    const noOptions = await api('POST', '/api/community/posts', eventPost('Bad', { rsvpQuestions: [{ type: 'choice', label: 'Pick', options: ['Only one'] }] }), mentor.token);
    assert.equal(noOptions.status, 400);
    const made = await api('POST', '/api/community/posts', eventPost('Gala', { rsvpQuestions: QUESTIONS }), mentor.token);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.post.event.questions.length, 4);
    postId = made.body.post.id;
  });

  it('required questions must be answered before an RSVP counts', async () => {
    assert.equal((await api('POST', `/api/community/posts/${postId}/rsvp`, { going: true }, student.token)).status, 400);
    assert.equal((await api('POST', `/api/community/posts/${postId}/rsvp`, { going: true, answers: { ...GOOD_ANSWERS, photo: 'Maybe' } }, student.token)).status, 400);
    assert.equal((await api('POST', `/api/community/posts/${postId}/rsvp`, { going: true, answers: { ...GOOD_ANSWERS, diet: ['Pescatarian'] } }, student.token)).status, 400);
    const ok = await api('POST', `/api/community/posts/${postId}/rsvp`, { going: true, answers: GOOD_ANSWERS }, student.token);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.rsvpCount, 1);
    const mine = await api('GET', `/api/community/posts/${postId}/rsvp`, undefined, student.token);
    assert.deepEqual(mine.body.answers, GOOD_ANSWERS);
  });

  it('answers go to the organiser and staff only', async () => {
    assert.equal((await api('GET', `/api/community/posts/${postId}/responses`, undefined, other.token)).status, 403);
    const organiser = await api('GET', `/api/community/posts/${postId}/responses`, undefined, mentor.token);
    assert.equal(organiser.body.responses[0].name, 'Stella Student');
    assert.deepEqual(organiser.body.responses[0].answers, GOOD_ANSWERS);
    const csv = await api('GET', `/api/community/posts/${postId}/responses?format=csv`, undefined, editorToken);
    assert.ok(String(csv.body).includes('Are you bringing a plus one?'));
    assert.ok(String(csv.body).includes('Stella Student'));
  });

  it('CRM events take questions too', async () => {
    const event = await api('POST', '/api/events', {
      name: 'Dinner', startsAt: inDays(4), communityVisible: true, communityRsvp: true, communityIcons: ['food'],
      communityQuestions: [QUESTIONS[0]],
    }, editorToken);
    assert.equal(event.status, 201, JSON.stringify(event.body));
    assert.deepEqual(event.body.event.communityIcons, ['food']);
    const id = event.body.event.id;
    assert.equal((await api('POST', `/api/community/events/${id}/rsvp`, { going: true }, student.token)).status, 400);
    assert.equal((await api('POST', `/api/community/events/${id}/rsvp`, { going: true, answers: { 'plus-one': 'No' } }, student.token)).status, 200);
    assert.equal((await api('GET', `/api/community/events/${id}/responses`, undefined, student.token)).status, 403);
    const responses = await api('GET', `/api/community/events/${id}/responses`, undefined, editorToken);
    assert.equal(responses.body.responses[0].answers['plus-one'], 'No');
  });
});

describe('guest RSVPs', () => {
  const guest = { name: 'Gail Guest', email: 'Gail@Example.org' };

  before(() => {
    // These tests create more events than the hourly limit allows one person.
    raw().prepare(`DELETE FROM rate_limit_events`).run();
  });

  it('only events opened to guests accept them', async () => {
    const closed = await api('POST', '/api/community/posts', eventPost('Accounts only'), mentor.token);
    assert.equal(closed.body.post.event.guestRsvp, false);
    assert.equal((await api('POST', `/api/public/posts/${closed.body.post.id}/rsvp`, guest, null)).status, 404);
    // Hiding an event from guests also turns off guest RSVPs.
    const hidden = await api('POST', '/api/community/posts', eventPost('Hidden', { guestVisible: false, rsvpGuests: true }), mentor.token);
    assert.equal(hidden.body.post.event.guestRsvp, false);
  });

  it('guests RSVP with a name, email and required answers, once per email', async () => {
    const made = await api('POST', '/api/community/posts', eventPost('Open house', { rsvpGuests: true, rsvpQuestions: [QUESTIONS[0]], eventAge21: true }), mentor.token);
    const id = made.body.post.id;
    assert.equal(made.body.post.event.guestRsvp, true);
    assert.equal((await api('POST', `/api/public/posts/${id}/rsvp`, { ...guest, over21: true }, null)).status, 400);
    assert.equal((await api('POST', `/api/public/posts/${id}/rsvp`, { ...guest, answers: { 'plus-one': 'No' } }, null)).status, 400);
    const saved = await api('POST', `/api/public/posts/${id}/rsvp`, { ...guest, over21: true, answers: { 'plus-one': 'No' } }, null);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.rsvpCount, 1);
    const again = await api('POST', `/api/public/posts/${id}/rsvp`, { ...guest, email: 'gail@example.org', over21: true, answers: { 'plus-one': 'Yes' } }, null);
    assert.equal(again.body.rsvpCount, 1, 'a second send updates the first');

    // Guests count towards the total, are hidden from the public list, and show to the organiser without their email.
    const detail = await api('GET', `/api/community/posts/${id}`, undefined, student.token);
    assert.equal(detail.body.post.event.rsvpCount, 1);
    const organiser = await api('GET', `/api/community/posts/${id}/responses`, undefined, mentor.token);
    assert.equal(organiser.body.responses[0].name, 'Gail Guest');
    assert.equal(organiser.body.responses[0].email, null);
    const staff = await api('GET', `/api/community/posts/${id}/responses`, undefined, editorToken);
    assert.equal(staff.body.responses[0].email, 'gail@example.org');

    const cancelled = await api('POST', '/api/public/rsvp/cancel', { token: again.body.cancelToken }, null);
    assert.equal(cancelled.body.rsvpCount, 0);
    assert.equal((await api('POST', '/api/public/rsvp/cancel', { token: 'forged.token' }, null)).status, 401);
  });

  it('a filled-in hidden field is treated as a bot and stores nothing', async () => {
    const made = await api('POST', '/api/community/posts', eventPost('Trap', { rsvpGuests: true }), mentor.token);
    const trapped = await api('POST', `/api/public/posts/${made.body.post.id}/rsvp`, { ...guest, website: 'spam.example' }, null);
    assert.equal(trapped.body.rsvpCount, 0);
  });

  it('blocked emails cannot RSVP as guests', async () => {
    const gone = await createMember('student', 'Gus', 'Gone', 'gus.gone@example.org');
    await api('POST', `/api/admin/community/accounts/${gone.userId}/deactivate`, {}, editorToken);
    const made = await api('POST', '/api/community/posts', eventPost('Blocked check', { rsvpGuests: true }), mentor.token);
    assert.equal((await api('POST', `/api/public/posts/${made.body.post.id}/rsvp`, { name: 'Gus', email: 'gus.gone@example.org' }, null)).status, 403);
  });

  it('CRM events can open RSVPs to guests', async () => {
    const event = await api('POST', '/api/events', { name: 'Open CRM', startsAt: inDays(4), communityVisible: true, communityRsvp: true, communityRsvpGuests: true }, editorToken);
    assert.equal(event.body.event.communityRsvpGuests, true);
    assert.equal((await api('POST', `/api/public/events/${event.body.event.id}/rsvp`, guest, null)).status, 200);
    const feed = await api('GET', '/api/public/feed?limit=30', undefined, null);
    const item = feed.body.items.find((entry: any) => entry.event?.id === event.body.event.id);
    assert.equal(item.event.guestRsvp, true);
    assert.equal(item.event.rsvpCount, 1);
  });
});

describe('contact organizations', () => {
  let contactId = '';
  let orgId = '';

  it('adds an organization typed into a contact, reusing one that already exists', async () => {
    const made = await api('POST', '/api/contacts', { firstName: 'Olive', lastName: 'Org', email: 'olive@example.org', newOrganizationNames: ['Brand New Co'], orgRole: 'CEO' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    contactId = made.body.contact.id;
    assert.equal(made.body.contact.organizations[0].name, 'Brand New Co');
    orgId = made.body.contact.organizations[0].id;
    const orgs = await api('GET', '/api/organizations?limit=200');
    assert.ok(orgs.body.organizations.some((o: any) => o.id === orgId));

    const second = await api('POST', '/api/contacts', { firstName: 'Bo', lastName: 'Org', email: 'bo@example.org', newOrganizationNames: ['  brand new co '] });
    assert.equal(second.body.contact.organizations[0].id, orgId);
  });

  it('a rejected contact form creates no organization', async () => {
    assert.equal((await api('POST', '/api/contacts', { firstName: '', lastName: 'X', email: 'x@example.org', newOrganizationNames: ['Ghost LLC'] })).status, 400);
    const orgs = await api('GET', '/api/organizations?limit=200');
    assert.ok(!orgs.body.organizations.some((o: any) => o.name === 'Ghost LLC'));
  });

  it('leaving an organization moves it to the archive, and the next one becomes main', async () => {
    const second = await api('POST', '/api/organizations', { name: 'Second Co' });
    await api('PUT', `/api/contacts/${contactId}`, {
      firstName: 'Olive', lastName: 'Org', email: 'olive@example.org', organizationIds: [orgId, second.body.organization.id], orgRole: 'CEO',
    });
    const left = await api('POST', `/api/contacts/${contactId}/leave-organization`, { organizationId: orgId }, editorToken);
    assert.equal(left.status, 200, JSON.stringify(left.body));
    assert.deepEqual(left.body.contact.organizations.map((o: any) => o.name), ['Second Co']);
    assert.equal(left.body.contact.organizationName, 'Second Co');
    const past = await api('GET', `/api/contacts/${contactId}/past-organizations`);
    assert.equal(past.body.organizations[0].name, 'Brand New Co');
    assert.equal(past.body.organizations[0].role, 'CEO');
    assert.equal(past.body.organizations[0].organizationId, orgId);
  });

  it('unticking an organization in the form archives it too, and the name survives deletion', async () => {
    const orgs = await api('GET', `/api/contacts/${contactId}`);
    const secondId = orgs.body.contact.organizations[0].id;
    await api('PUT', `/api/contacts/${contactId}`, { firstName: 'Olive', lastName: 'Org', email: 'olive@example.org', organizationIds: [] });
    await api('DELETE', `/api/organizations/${secondId}`);
    const past = await api('GET', `/api/contacts/${contactId}/past-organizations`);
    const entry = past.body.organizations.find((o: any) => o.name === 'Second Co');
    assert.ok(entry);
    assert.equal(entry.organizationId, null);
    assert.equal((await api('DELETE', `/api/contacts/${contactId}/past-organizations/${entry.id}`)).status, 200);
    assert.equal((await api('GET', `/api/contacts/${contactId}/past-organizations`)).body.organizations.length, 1);
  });

  it('members cannot touch any of it', async () => {
    assert.equal((await api('GET', `/api/contacts/${contactId}/past-organizations`, undefined, student.token)).status, 403);
    assert.equal((await api('POST', `/api/contacts/${contactId}/leave-organization`, { organizationId: orgId }, student.token)).status, 403);
  });
});

describe('efficiency', () => {
  it('image links stay the same between requests, and change when the image does', async () => {
    const form = new FormData();
    form.append('file', pngFile('a.png'));
    await api('POST', '/api/community/profile/photo', form, student.token);
    const first = (await api('GET', `/api/community/members/${student.userId}`, undefined, other.token)).body.member.photoUrl;
    const again = (await api('GET', `/api/community/members/${student.userId}`, undefined, other.token)).body.member.photoUrl;
    assert.equal(first, again);
    assert.equal((await worker.fetch(new Request(`http://localhost${first}`), env as never)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replace = new FormData();
    replace.append('file', pngFile('b.png'));
    await api('POST', '/api/community/profile/photo', replace, student.token);
    const changed = (await api('GET', `/api/community/members/${student.userId}`, undefined, other.token)).body.member.photoUrl;
    assert.notEqual(changed, first);
  });

  it('guest pages can be cached; signed-in pages never are', async () => {
    const guestFeed = await worker.fetch(new Request('http://localhost/api/public/feed'), env as never);
    assert.match(guestFeed.headers.get('Cache-Control') ?? '', /public/);
    const memberFeed = await worker.fetch(new Request('http://localhost/api/community/feed', { headers: { Authorization: `Bearer ${student.token}` } }), env as never);
    assert.equal(memberFeed.headers.get('Cache-Control'), 'no-store');
  });

  it('housekeeping removes expired sessions and old rate-limit rows only', async () => {
    const customer = raw().prepare(`SELECT id FROM customers LIMIT 1`).get().id;
    raw().prepare(`INSERT INTO sessions (id, token_hash, user_id, customer_id, expires_at, created_at) VALUES ('old', 'old-hash', ?, ?, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`).run(student.userId, customer);
    raw().prepare(`INSERT INTO rate_limit_events (id, bucket, created_at) VALUES ('old-rl', 'x', '2000-01-01T00:00:00.000Z')`).run();
    await purgeExpiredData(createD1Db(fakeD1 as never));
    assert.equal(raw().prepare(`SELECT 1 FROM sessions WHERE id = 'old'`).get(), undefined);
    assert.equal(raw().prepare(`SELECT 1 FROM rate_limit_events WHERE id = 'old-rl'`).get(), undefined);
    assert.equal((await api('GET', '/api/auth/me', undefined, other.token)).status, 200);
  });

  it('the busiest queries use indexes, not full table scans', () => {
    const plan = (sql: string, ...params: unknown[]) =>
      (raw().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail).join(' | ');
    for (const [label, detail] of [
      ['login lookup', plan(`SELECT id FROM users WHERE lower(email) = ?`, 'a')],
      ['session check', plan(`SELECT id FROM sessions WHERE token_hash = ?`, 'a')],
      ['feed events', plan(`SELECT id FROM posts p WHERE p.customer_id = ? AND p.status = 'published' AND p.event_starts_at >= ?`, 'a', 'b')],
      ['organization lookup', plan(`SELECT id FROM organizations WHERE customer_id = ? AND lower(trim(name)) = ?`, 'a', 'b')],
      ['guest rsvp count', plan(`SELECT COUNT(*) FROM event_guest_rsvps WHERE target_type = ? AND target_id = ?`, 'a', 'b')],
    ] as const) {
      assert.match(detail, /USING (COVERING )?INDEX/, `${label}: ${detail}`);
    }
  });
});
