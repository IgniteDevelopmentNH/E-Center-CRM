import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

/**
 * Community portal v2: member posting with approval, comments, likes,
 * @mentions, RSVPs, public resumes, and notification emails through the
 * outbox. Same harness as community.test.ts (real Worker fetch handler,
 * throwaway D1/R2 shims, a fake EMAIL binding that records every send).
 */

// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeD1 } from '../dev/fakeD1.mjs';
// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeR2 } from '../dev/fakeR2.mjs';
import { createD1Db } from '../src/db/d1.ts';
import worker from '../src/index.ts';
import { seedDemoData } from '../scripts/seed.ts';

const testDbPath = path.join(os.tmpdir(), `ecenter-community-v2-test-${process.pid}.db`);
const uploadDir = path.join(os.tmpdir(), `ecenter-community-v2-uploads-${process.pid}`);
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
});

after(() => {
  fakeD1._close();
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

describe('posting permissions and approval', () => {
  it('defaults: students cannot post, mentors post with approval', async () => {
    assert.equal((await api('GET', '/api/auth/me', undefined, student.token)).body.community.postPermission, 'none');
    assert.equal((await api('GET', '/api/auth/me', undefined, mentor.token)).body.community.postPermission, 'approval');
    const denied = await api('POST', '/api/community/posts', { title: 'Hi', body: 'Hello' }, student.token);
    assert.equal(denied.status, 403);
  });

  it("a mentor's post waits for staff approval and is invisible until approved", async () => {
    const created = await api('POST', '/api/community/posts', { title: 'Office hours', body: 'Ask me anything' }, mentor.token);
    assert.equal(created.status, 201);
    assert.equal(created.body.post.status, 'pending');
    const id = created.body.post.id;

    const feed = await api('GET', '/api/community/feed', undefined, other.token);
    assert.ok(!feed.body.posts.some((p: any) => p.id === id));
    assert.equal((await api('GET', `/api/community/posts/${id}`, undefined, other.token)).status, 404);
    assert.equal((await api('GET', `/api/community/posts/${id}`, undefined, mentor.token)).status, 200, 'author can see it');

    // Members and viewers cannot approve; editors can.
    assert.equal((await api('POST', `/api/admin/posts/${id}/approve`, undefined, mentor.token)).status, 403);
    assert.equal((await api('POST', `/api/admin/posts/${id}/approve`, undefined, viewerToken)).status, 403);
    const queue = await api('GET', '/api/admin/posts?status=pending', undefined, viewerToken);
    assert.ok(queue.body.posts.some((p: any) => p.id === id && p.authorName === 'Manny Mentor'));
    assert.ok(queue.body.pendingCount >= 1);
    const approved = await api('POST', `/api/admin/posts/${id}/approve`, undefined, editorToken);
    assert.equal(approved.body.post.status, 'published');

    const after = await api('GET', '/api/community/feed', undefined, other.token);
    const live = after.body.posts.find((p: any) => p.id === id);
    assert.ok(live);
    assert.equal(live.author.name, 'Manny Mentor');
    assert.equal(live.author.id, mentor.userId);
    assert.equal(live.canEdit, false);
  });

  it('rejection is visible to the author with a note, and never to others', async () => {
    const created = await api('POST', '/api/community/posts', { title: 'Buy my course', body: 'Link in bio' }, mentor.token);
    const id = created.body.post.id;
    await api('POST', `/api/admin/posts/${id}/reject`, { note: 'Promotional content is not allowed.' }, editorToken);
    const mine = await api('GET', '/api/community/my-posts', undefined, mentor.token);
    const rejected = mine.body.posts.find((p: any) => p.id === id);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reviewNote, 'Promotional content is not allowed.');
    assert.equal((await api('GET', `/api/community/posts/${id}`, undefined, other.token)).status, 404);
  });

  it('staff can change an individual to none / approval / direct, or back to the default', async () => {
    const set = (who: Member, postPermission: string, token = editorToken) =>
      api('PUT', `/api/admin/community/accounts/${who.userId}/permissions`, { postPermission }, token);
    assert.equal((await set(student, 'direct', viewerToken)).status, 403, 'viewers cannot change permissions');
    assert.equal((await set(student, 'direct', student.token)).status, 403);

    const updated = await set(student, 'direct');
    assert.equal(updated.body.account.postPermission, 'direct');
    const post = await api('POST', '/api/community/posts', { title: 'Study group', body: 'Thursdays at 6' }, student.token);
    assert.equal(post.body.post.status, 'published', 'direct posting skips approval');

    await set(mentor, 'none');
    assert.equal((await api('POST', '/api/community/posts', { title: 'x', body: 'y' }, mentor.token)).status, 403);
    const back = await set(mentor, 'default');
    assert.equal(back.body.account.postPermission, 'approval');
    assert.equal(back.body.account.postPermissionOverride, null);
    await set(student, 'default');
  });

  it('editing an approved post sends it back for review and keeps the previous version', async () => {
    const created = await api('POST', '/api/community/posts', { title: 'Original title', body: 'Original body' }, mentor.token);
    const id = created.body.post.id;
    await api('POST', `/api/admin/posts/${id}/approve`, undefined, editorToken);
    const edited = await api('PUT', `/api/community/posts/${id}`, { title: 'Edited title', body: 'Edited body' }, mentor.token);
    assert.equal(edited.body.post.status, 'pending');
    assert.equal((await api('GET', `/api/community/posts/${id}`, undefined, other.token)).status, 404);

    const history = await api('GET', '/api/admin/posts/history', undefined, viewerToken);
    const edit = history.body.revisions.find((r: any) => r.postId === id && r.action === 'edit');
    assert.equal(edit.previous.title, 'Original title');
    assert.equal(edit.previous.status, 'published');
  });

  it('authors take down their own posts; staff can see and restore them', async () => {
    const created = await api('POST', '/api/community/posts', { title: 'Temporary', body: 'Soon gone' }, mentor.token);
    const id = created.body.post.id;
    await api('POST', `/api/admin/posts/${id}/approve`, undefined, editorToken);
    assert.equal((await api('DELETE', `/api/community/posts/${id}`, undefined, other.token)).status, 403);
    assert.equal((await api('DELETE', `/api/community/posts/${id}`, undefined, mentor.token)).status, 200);
    const feed = await api('GET', '/api/community/feed', undefined, other.token);
    assert.ok(!feed.body.posts.some((p: any) => p.id === id));

    const history = await api('GET', '/api/admin/posts/history', undefined, viewerToken);
    const removal = history.body.revisions.find((r: any) => r.postId === id && r.action === 'delete');
    assert.ok(removal && removal.postDeleted);
    assert.equal(removal.changedByName, 'Manny Mentor');

    assert.equal((await api('POST', `/api/admin/posts/${id}/restore`, undefined, editorToken)).status, 200);
    const restored = await api('GET', '/api/community/feed', undefined, other.token);
    assert.ok(restored.body.posts.some((p: any) => p.id === id));
  });
});

describe('comments and likes', () => {
  let postId = '';

  before(async () => {
    const created = await api('POST', '/api/admin/posts', { title: 'Welcome week', body: 'Say hi below!', publish: true }, editorToken);
    postId = created.body.post.id;
  });

  it('members like and unlike posts', async () => {
    const liked = await api('POST', `/api/community/posts/${postId}/like`, { liked: true }, student.token);
    assert.deepEqual(liked.body, { likeCount: 1, likedByMe: true });
    await api('POST', `/api/community/posts/${postId}/like`, { liked: true }, student.token);
    await api('POST', `/api/community/posts/${postId}/like`, { liked: true }, other.token);
    const unliked = await api('POST', `/api/community/posts/${postId}/like`, { liked: false }, student.token);
    assert.deepEqual(unliked.body, { likeCount: 1, likedByMe: false });
  });

  it('comments and one-level replies; deletion rules for author, post author and staff', async () => {
    const first = await api('POST', `/api/community/posts/${postId}/comments`, { body: 'Hi everyone' }, student.token);
    assert.equal(first.status, 201);
    const commentId = first.body.comments[0].id;
    const reply = await api('POST', `/api/community/posts/${postId}/comments`, { body: 'Welcome!', parentId: commentId }, other.token);
    const replyId = reply.body.comments[0].replies[0].id;
    // A reply to a reply attaches to the top-level comment.
    const nested = await api('POST', `/api/community/posts/${postId}/comments`, { body: 'Thanks', parentId: replyId }, student.token);
    assert.equal(nested.body.comments[0].replies.length, 2);

    // Someone else's comment: a member who is neither author cannot remove it.
    assert.equal((await api('DELETE', `/api/community/comments/${commentId}`, undefined, other.token)).status, 403);
    assert.equal((await api('DELETE', `/api/community/comments/${replyId}`, undefined, other.token)).status, 200, 'own comment');
    // Staff moderators can remove any comment, even without a community identity.
    assert.equal((await api('DELETE', `/api/community/comments/${commentId}`, undefined, editorToken)).status, 200);
    const detail = await api('GET', `/api/community/posts/${postId}`, undefined, other.token);
    assert.equal(detail.body.comments.length, 0);
    const history = await api('GET', '/api/admin/posts/history', undefined, viewerToken);
    assert.ok(history.body.removedComments.some((c: any) => c.id === commentId && c.removedByName === 'Bella Kenoyer'));
  });

  it('the author of a post can remove comments on it', async () => {
    const created = await api('POST', '/api/community/posts', { title: 'My event recap', body: 'Thanks all' }, mentor.token);
    await api('POST', `/api/admin/posts/${created.body.post.id}/approve`, undefined, editorToken);
    const comment = await api('POST', `/api/community/posts/${created.body.post.id}/comments`, { body: 'Off-topic' }, other.token);
    const id = comment.body.comments[0].id;
    assert.equal(comment.body.comments[0].canDelete, true);
    assert.equal((await api('DELETE', `/api/community/comments/${id}`, undefined, mentor.token)).status, 200);
  });

  it('comments are refused on posts that are not published', async () => {
    const pending = await api('POST', '/api/community/posts', { title: 'Pending', body: 'Not yet' }, mentor.token);
    const response = await api('POST', `/api/community/posts/${pending.body.post.id}/comments`, { body: 'Early' }, other.token);
    assert.equal(response.status, 404);
  });
});

describe('@mentions', () => {
  it('keeps real mentions, downgrades forged ones, and emails the mentioned member once published', async () => {
    const forged = '@[Fake Person](user:00000000-0000-4000-8000-000000000000)';
    const created = await api(
      'POST',
      '/api/community/posts',
      { title: 'Shout-outs', body: `Thanks ${mention(student, 'Stella Student')} and ${forged}` },
      mentor.token,
    );
    const id = created.body.post.id;
    assert.ok(created.body.post.body.includes(`(user:${student.userId})`));
    assert.ok(created.body.post.body.includes('@Fake Person'));
    assert.ok(!created.body.post.body.includes('00000000-0000'));

    await runOutbox();
    assert.equal(mailTo(student.email).filter((m) => m.subject.includes('mentioned you')).length, 0, 'not while pending');

    await api('POST', `/api/admin/posts/${id}/approve`, undefined, editorToken);
    await runOutbox();
    await api('PUT', `/api/admin/posts/${id}`, { title: 'Shout-outs!', body: `Thanks ${mention(student, 'Stella Student')}` }, editorToken);
    await runOutbox();
    const mails = mailTo(student.email).filter((m) => m.subject.includes('mentioned you'));
    assert.equal(mails.length, 1, 'one email per mention, even after edits');
    assert.match(mails[0]!.text, /Manny Mentor mentioned you/);
    assert.match(mails[0]!.text, /@Stella Student/);
  });
});

describe('notification emails', () => {
  it('emails a direct message recipient only while it is still unread', async () => {
    const convo = await api('POST', '/api/community/conversations', { recipientId: other.userId }, student.token);
    const id = convo.body.conversationId;
    await api('POST', `/api/community/conversations/${id}/messages`, { body: 'First' }, student.token);
    await api('POST', `/api/community/conversations/${id}/messages`, { body: 'Second' }, student.token);
    await runOutbox();
    const mails = mailTo(other.email).filter((m) => m.subject.includes('sent you a message'));
    assert.equal(mails.length, 1, 'a burst of messages is one email');
    assert.match(mails[0]!.text, /Second/);
    assert.ok(mails[0]!.headers?.['List-Unsubscribe']);

    // Read before the email goes out: nothing is sent.
    await api('POST', `/api/community/conversations/${id}/read`, undefined, other.token);
    await api('POST', `/api/community/conversations/${id}/messages`, { body: 'Third' }, student.token);
    await api('POST', `/api/community/conversations/${id}/read`, undefined, other.token);
    await runOutbox();
    assert.equal(mailTo(other.email).filter((m) => m.subject.includes('sent you a message')).length, 1);
  });

  it('announcements go to opted-in members once, and unsubscribing works without signing in', async () => {
    const post = await api('POST', '/api/admin/posts', { title: 'Pitch night', body: 'Join us Friday', publish: true }, editorToken);
    const id = post.body.post.id;
    assert.equal((await api('POST', `/api/admin/posts/${id}/notify`, undefined, viewerToken)).status, 403);
    const first = await api('POST', `/api/admin/posts/${id}/notify`, undefined, editorToken);
    await api('POST', `/api/admin/posts/${id}/notify`, undefined, editorToken);
    assert.ok(first.body.queued >= 3);
    await runOutbox();
    const announcement = mailTo(other.email).filter((m) => m.subject.includes('Pitch night'));
    assert.equal(announcement.length, 1, 'never twice');

    const token = /unsubscribe\?token=([^\s]+)/.exec(announcement[0]!.text)![1]!;
    assert.equal((await api('POST', `/api/community/unsubscribe?token=${token}`, undefined, null)).status, 200);
    const me = await api('GET', '/api/auth/me', undefined, other.token);
    assert.equal(me.body.community.notifications.announcements, false);
    assert.equal(me.body.community.notifications.messages, true);

    const next = await api('POST', '/api/admin/posts', { title: 'Second news', body: 'More', publish: true }, editorToken);
    await api('POST', `/api/admin/posts/${next.body.post.id}/notify`, undefined, editorToken);
    await runOutbox();
    assert.equal(mailTo(other.email).filter((m) => m.subject.includes('Second news')).length, 0);
    assert.equal(mailTo(student.email).filter((m) => m.subject.includes('Second news')).length, 1);
  });

  it('a post taken down before sending is not emailed', async () => {
    const post = await api('POST', '/api/admin/posts', { title: 'Oops post', body: 'Wrong', publish: true }, editorToken);
    await api('POST', `/api/admin/posts/${post.body.post.id}/notify`, undefined, editorToken);
    await api('DELETE', `/api/admin/posts/${post.body.post.id}`, undefined, editorToken);
    await runOutbox();
    assert.equal(outbox.filter((m) => m.subject.includes('Oops post')).length, 0);
  });

  it('members can turn notification emails off from their profile', async () => {
    const updated = await api('PUT', '/api/community/profile/notifications', { messages: false }, student.token);
    assert.equal(updated.body.community.notifications.messages, false);
    const convo = await api('POST', '/api/community/conversations', { recipientId: student.userId }, mentor.token);
    await api('POST', `/api/community/conversations/${convo.body.conversationId}/messages`, { body: 'Ping' }, mentor.token);
    const before = mailTo(student.email).length;
    await runOutbox();
    assert.equal(mailTo(student.email).length, before);
  });
});

describe('events and RSVPs', () => {
  it('event posts take "I\'ll be there!" RSVPs and appear in upcoming events', async () => {
    const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const created = await api(
      'POST',
      '/api/admin/posts',
      { title: 'Founder dinner', body: 'Food and stories', publish: true, isEvent: true, eventStartsAt: startsAt, eventLocation: 'Paul College', rsvpEnabled: true },
      editorToken,
    );
    const id = created.body.post.id;
    const going = await api('POST', `/api/community/posts/${id}/rsvp`, { going: true }, student.token);
    assert.deepEqual(going.body, { going: true, rsvpCount: 1 });
    await api('POST', `/api/community/posts/${id}/rsvp`, { going: true }, student.token);
    const detail = await api('GET', `/api/community/posts/${id}`, undefined, student.token);
    assert.equal(detail.body.post.event.rsvpCount, 1);
    assert.equal(detail.body.post.event.going, true);

    const upcoming = await api('GET', '/api/community/events?limit=30', undefined, other.token);
    assert.ok(upcoming.body.events.some((e: any) => e.id === id && e.source === 'post'));
    const staffView = await api('GET', `/api/admin/posts/${id}`, undefined, viewerToken);
    assert.deepEqual(staffView.body.rsvps.map((r: any) => r.name), ['Stella Student']);
  });

  it('CRM events can take RSVPs only when staff enable it', async () => {
    const startsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const plain = await api('POST', '/api/events', { name: 'Info session', startsAt, communityVisible: true });
    assert.equal((await api('POST', `/api/community/events/${plain.body.event.id}/rsvp`, { going: true }, student.token)).status, 400);
    const open = await api('POST', '/api/events', {
      name: 'Demo day', startsAt, communityVisible: true, communityRsvp: true, communityDetails: 'Teams present their projects.',
    });
    const eventId = open.body.event.id;
    assert.equal((await api('POST', `/api/community/events/${eventId}/rsvp`, { going: true }, other.token)).status, 200);
    const detail = await api('GET', `/api/community/events/${eventId}`, undefined, student.token);
    assert.equal(detail.body.event.details, 'Teams present their projects.');
    assert.equal(detail.body.event.rsvpCount, 1);
    const crm = await api('GET', `/api/events/${eventId}`);
    assert.deepEqual(crm.body.communityRsvps.map((r: any) => r.name), ['Otis Other']);
    assert.equal(crm.body.event.communityRsvpCount, 1);
  });
});

describe('profiles and topics', () => {
  it('a resume is shared on the profile only when its owner opts in', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'cv.pdf', { type: 'application/pdf' }));
    await api('POST', '/api/community/profile/resume', form, mentor.token);
    assert.equal((await api('GET', `/api/community/members/${mentor.userId}/resume`, undefined, student.token)).status, 404);
    assert.equal((await api('GET', `/api/community/members/${mentor.userId}`, undefined, student.token)).body.member.hasPublicResume, false);

    await api('PUT', '/api/community/profile/resume-visibility', { public: true }, mentor.token);
    assert.equal((await api('GET', `/api/community/members/${mentor.userId}`, undefined, student.token)).body.member.hasPublicResume, true);
    const link = await api('GET', `/api/community/members/${mentor.userId}/resume`, undefined, student.token);
    assert.equal((await api('GET', link.body.url, undefined, null)).status, 200);

    await api('PUT', '/api/community/profile/resume-visibility', { public: false }, mentor.token);
    assert.equal((await api('GET', `/api/community/members/${mentor.userId}/resume`, undefined, student.token)).status, 404);
  });

  it('offers featured topics plus more behind "See more"', async () => {
    const tags = (await api('GET', '/api/community/tags', undefined, student.token)).body.tags;
    assert.equal(tags.filter((t: any) => t.featured).length, 14);
    assert.ok(tags.filter((t: any) => !t.featured).length >= 20);
    assert.ok(tags.some((t: any) => t.slug === 'artificial-intelligence' && !t.featured));
    const saved = await api('PUT', '/api/community/profile', { firstName: 'Stella', lastName: 'Student', interests: ['artificial-intelligence', 'marketing'] }, student.token);
    assert.equal(saved.status, 200);
  });
});

describe('verification links opened twice', () => {
  it('a second open of a used link reports "already confirmed" instead of an error', async () => {
    const created = await api('POST', '/api/community/signup', { accountType: 'student', firstName: 'Tw', lastName: 'Ice', email: 'twice@example.org', password: 'longpassword1' }, null);
    assert.equal(created.status, 201);
    const message = [...outbox].reverse().find((m) => m.to === 'twice@example.org' && m.text.includes('/verify-email?'))!;
    const token = /token=([a-f0-9]+)/.exec(message.text)![1]!;

    const first = await api('POST', '/api/auth/verify-email', { token }, null);
    assert.deepEqual(first.body, { ok: true });
    const second = await api('POST', '/api/auth/verify-email', { token }, null);
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyVerified, true);

    // A token that was never issued is still rejected.
    assert.equal((await api('POST', '/api/auth/verify-email', { token: 'f'.repeat(64) }, null)).status, 400);
  });
});
