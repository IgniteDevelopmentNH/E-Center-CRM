import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

/**
 * Community portal tests: onboarding, CRM linking, permissions, posts,
 * matching, messaging and deactivation. Same harness as api.test.ts -- the
 * REAL Worker fetch handler against throwaway D1/R2 shims -- plus a fake
 * Email Service binding that captures outgoing mail so the tests can follow
 * the verification links exactly as a person would.
 */

// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeD1 } from '../dev/fakeD1.mjs';
// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeR2 } from '../dev/fakeR2.mjs';
import { createD1Db } from '../src/db/d1.ts';
import worker from '../src/index.ts';
import { recommendMentors } from '../src/services/matching.ts';
import { seedDemoData } from '../scripts/seed.ts';

const testDbPath = path.join(os.tmpdir(), `ecenter-community-test-${process.pid}.db`);
const uploadDir = path.join(os.tmpdir(), `ecenter-community-test-uploads-${process.pid}`);
fs.rmSync(testDbPath, { force: true });
fs.rmSync(uploadDir, { recursive: true, force: true });

const outbox: { to: string; subject: string; text: string }[] = [];
const fakeD1 = createFakeD1(testDbPath);
const env = {
  DB: fakeD1,
  DOCS: createFakeR2(uploadDir),
  ASSETS: { fetch: async () => new Response('not used in tests', { status: 404 }) },
  EMAIL: {
    async send(message: { to: string; subject: string; text: string }) {
      outbox.push({ to: message.to, subject: message.subject, text: message.text });
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

async function api(
  method: string,
  routePath: string,
  body?: unknown,
  authToken: string | null = ownerToken,
): Promise<{ status: number; body: any }> {
  // A distinct client IP per request keeps the per-IP signup limit out of the way.
  const headers: Record<string, string> = { 'CF-Connecting-IP': `10.0.0.${(ipCounter++ % 250) + 1}` };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await worker.fetch(
    new Request(`http://localhost${routePath}`, { method, headers, body: payload }),
    env as never,
  );
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

function lastLinkTo(email: string, kind: 'verify-email' | 'reset-password' = 'verify-email'): string {
  const message = [...outbox].reverse().find((m) => m.to === email && m.text.includes(`/${kind}?`));
  assert.ok(message, `expected an email with a ${kind} link to ${email}`);
  const match = /token=([a-f0-9]+)/.exec(message.text);
  assert.ok(match);
  return decodeURIComponent(match[1]!);
}

interface Member {
  token: string;
  userId: string;
  email: string;
}

async function signup(accountType: 'student' | 'mentor', firstName: string, lastName: string, email: string) {
  return api('POST', '/api/community/signup', { accountType, firstName, lastName, email, password: 'longpassword1' }, null);
}

/** Full happy path: signup -> verify email -> profile -> complete. */
async function createMember(
  accountType: 'student' | 'mentor',
  firstName: string,
  lastName: string,
  email: string,
  profile: Record<string, unknown> = {},
): Promise<Member> {
  const created = await signup(accountType, firstName, lastName, email);
  assert.ok(created.status === 201 || created.status === 200, JSON.stringify(created.body));
  const token = created.body.token as string;
  const verify = await api('POST', '/api/auth/verify-email', { token: lastLinkTo(email.trim().toLowerCase()) }, null);
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  const update = await api('PUT', '/api/community/profile', { firstName, lastName, ...profile }, token);
  assert.equal(update.status, 200, JSON.stringify(update.body));
  const complete = await api('POST', '/api/community/onboarding/complete', undefined, token);
  assert.equal(complete.status, 200);
  assert.equal(complete.body.community.status, 'active');
  return { token, userId: created.body.user.id, email: email.trim().toLowerCase() };
}

function rawDb() {
  return fakeD1._raw as { prepare(sql: string): { all(...a: unknown[]): any[]; get(...a: unknown[]): any } };
}

function contactsWithEmail(email: string): any[] {
  return rawDb().prepare(`SELECT * FROM contacts WHERE lower(trim(email)) = ? AND deleted_at IS NULL`).all(email);
}

function pngFile(name: string): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  return new File([bytes], name, { type: 'image/png' });
}

before(async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  fakeD1._raw.exec(fs.readFileSync(path.join(here, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  await seedDemoData(createD1Db(fakeD1 as never), 'unh-ecenter', 'UNH Entrepreneurship Center');

  ownerToken = (await api('POST', '/api/auth/login', { email: 'lisa@unh.edu', password: 'test123' }, null)).body.token;
  editorToken = (await api('POST', '/api/auth/login', { email: 'bella@unh.edu', password: 'test123' }, null)).body.token;
  const viewer = await api('POST', '/api/settings/users', {
    email: 'viewer@unh.edu',
    name: 'Vera Viewer',
    role: 'viewer',
    password: 'viewerpass1',
  });
  assert.equal(viewer.status, 201);
  viewerToken = (await api('POST', '/api/auth/login', { email: 'viewer@unh.edu', password: 'viewerpass1' }, null)).body.token;
});

after(() => {
  fakeD1._close();
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

describe('permissions: community accounts vs administrative roles', () => {
  it('a Mentor signup gets the non-administrative member role', async () => {
    const mentor = await createMember('mentor', 'Max', 'Mentor', 'max.mentor@example.org');
    const me = await api('GET', '/api/auth/me', undefined, mentor.token);
    assert.equal(me.body.user.role, 'member');
    assert.equal(me.body.user.isStaff, false);
    assert.equal(me.body.community.accountType, 'mentor');
  });

  it('students and mentors are refused by every administrative API', async () => {
    const student = await createMember('student', 'Sam', 'Student', 'sam.student@example.org');
    const routes: [string, string][] = [
      ['GET', '/api/contacts'],
      ['GET', '/api/contacts/facets'],
      ['GET', '/api/contacts/export.csv'],
      ['GET', '/api/notes'],
      ['GET', '/api/tasks'],
      ['GET', '/api/organizations'],
      ['GET', '/api/events'],
      ['GET', '/api/dashboard'],
      ['GET', '/api/search?q=priya'],
      ['GET', '/api/documents'],
      ['GET', '/api/settings/users'],
      ['GET', '/api/settings/audit-logs'],
      ['GET', '/api/settings'],
      ['GET', '/api/calendar/status'],
      ['GET', '/api/admin/posts'],
      ['GET', '/api/admin/community/accounts'],
      ['POST', '/api/contacts'],
      ['POST', '/api/admin/posts'],
      ['POST', '/api/notes'],
    ];
    for (const [method, route] of routes) {
      const response = await api(method, route, method === 'POST' ? {} : undefined, student.token);
      assert.equal(response.status, 403, `${method} ${route} should be 403 for a student, got ${response.status}`);
    }
  });

  it('existing staff permissions still work after the change', async () => {
    assert.equal((await api('GET', '/api/contacts', undefined, ownerToken)).status, 200);
    assert.equal((await api('GET', '/api/dashboard', undefined, editorToken)).status, 200);
    assert.equal((await api('GET', '/api/contacts', undefined, viewerToken)).status, 200);
    // Viewers remain read-only.
    const viewerWrite = await api('POST', '/api/contacts', { firstName: 'A', lastName: 'B', email: 'a@b.co' }, viewerToken);
    assert.equal(viewerWrite.status, 403);
    // Only owners manage the team.
    assert.equal((await api('POST', '/api/settings/users', {}, editorToken)).status, 403);
  });

  it('community members never appear in the staff team roster', async () => {
    const team = await api('GET', '/api/settings/users');
    assert.ok(team.body.users.every((u: any) => ['owner', 'editor', 'viewer'].includes(u.role)));
    assert.ok(!team.body.users.some((u: any) => u.email === 'sam.student@example.org'));
  });

  it('pending (unverified) members cannot read community content', async () => {
    const created = await signup('student', 'Pat', 'Pending', 'pat.pending@example.org');
    assert.equal(created.status, 201);
    assert.equal(created.body.community.status, 'pending');
    assert.equal((await api('GET', '/api/community/feed', undefined, created.body.token)).status, 403);
    assert.equal((await api('GET', '/api/community/members', undefined, created.body.token)).status, 403);
  });
});

describe('signup links accounts to CRM contacts', () => {
  it('links a verified email to the one matching contact without overwriting CRM data', async () => {
    const before = contactsWithEmail('priya.raghavan@example.com');
    assert.equal(before.length, 1);
    const original = before[0];
    const notesBefore = rawDb()
      .prepare(`SELECT COUNT(*) AS n FROM note_contacts WHERE contact_id = ?`)
      .get(original.id).n;

    // Different case and stray whitespace; different first name in the portal.
    const member = await createMember('mentor', 'Pri', 'Raghavan', '  PRIYA.Raghavan@Example.com ', {
      bio: 'Portal bio',
      roleTitle: 'VP Product',
      company: 'Acme',
    });

    const after = contactsWithEmail('priya.raghavan@example.com');
    assert.equal(after.length, 1, 'no duplicate contact is created');
    const contact = after[0];
    assert.equal(contact.id, original.id);
    assert.equal(contact.first_name, original.first_name, 'staff-owned name is untouched');
    assert.equal(contact.how_we_connected, original.how_we_connected);
    assert.equal(contact.phone, original.phone);
    assert.equal(contact.status, original.status);
    assert.equal(contact.organization_id, original.organization_id);
    const tags = JSON.parse(contact.tags) as string[];
    for (const tag of JSON.parse(original.tags) as string[]) assert.ok(tags.includes(tag), `kept tag ${tag}`);
    assert.equal(tags.filter((t) => t === 'Created Account').length, 1);
    assert.equal(
      rawDb().prepare(`SELECT COUNT(*) AS n FROM note_contacts WHERE contact_id = ?`).get(original.id).n,
      notesBefore,
    );

    const crm = await api('GET', `/api/contacts/${original.id}`);
    assert.deepEqual(crm.body.contact.communityAccount, { userId: member.userId, accountType: 'mentor', status: 'active' });
  });

  it('a brand-new email creates exactly one contact and one "Created Account" tag', async () => {
    const member = await createMember('student', 'Nina', 'New', 'nina.new@example.org');
    const contacts = contactsWithEmail('nina.new@example.org');
    assert.equal(contacts.length, 1);
    assert.deepEqual(JSON.parse(contacts[0].tags), ['Created Account']);
    assert.equal(contacts[0].first_name, 'Nina');
    const filtered = await api('GET', `/api/contacts?tag=${encodeURIComponent('Created Account')}&limit=200`);
    assert.ok(filtered.body.contacts.some((c: any) => c.id === contacts[0].id));
    const byStatus = await api('GET', '/api/contacts?accountStatus=active&limit=200');
    assert.ok(byStatus.body.contacts.some((c: any) => c.communityAccount?.userId === member.userId));
  });

  it('retries and concurrent requests do not duplicate contacts, tags or links', async () => {
    const email = 'retry.rita@example.org';
    const first = await signup('student', 'Rita', 'Retry', email);
    const again = await signup('student', 'Rita', 'Retry', email); // e.g. double-click / refresh
    assert.equal(again.status, 200);
    assert.equal(again.body.resumed, true);
    assert.equal(again.body.user.id, first.body.user.id);
    assert.equal(rawDb().prepare(`SELECT COUNT(*) AS n FROM users WHERE email = ?`).get(email).n, 1);

    const token = lastLinkTo(email);
    await api('POST', '/api/auth/verify-email', { token }, null);
    // Single-use: a second open changes nothing, it only reports that the address is already confirmed.
    const reused = await api('POST', '/api/auth/verify-email', { token }, null);
    assert.equal(reused.status, 200);
    assert.equal(reused.body.alreadyVerified, true);

    await Promise.all([
      api('POST', '/api/community/onboarding/complete', undefined, again.body.token),
      api('POST', '/api/community/onboarding/complete', undefined, again.body.token),
      api('GET', '/api/auth/me', undefined, again.body.token),
    ]);
    await api('POST', `/api/admin/community/accounts/${first.body.user.id}/retry-link`, undefined, ownerToken);

    const contacts = contactsWithEmail(email);
    assert.equal(contacts.length, 1);
    assert.equal((JSON.parse(contacts[0].tags) as string[]).filter((t) => t === 'Created Account').length, 1);
    assert.equal(rawDb().prepare(`SELECT COUNT(*) AS n FROM community_accounts WHERE contact_id = ?`).get(contacts[0].id).n, 1);
  });

  it('a different password cannot hijack a pending signup', async () => {
    const response = await api(
      'POST',
      '/api/community/signup',
      { accountType: 'mentor', firstName: 'X', lastName: 'Y', email: 'pat.pending@example.org', password: 'otherpassword' },
      null,
    );
    assert.equal(response.status, 409);
  });

  it('flags ambiguous matches for staff instead of choosing one', async () => {
    for (const email of ['dup.dana@example.org', ' DUP.Dana@example.org']) {
      const created = await api('POST', '/api/contacts', { firstName: 'Dana', lastName: 'Dup', email: email.trim() });
      assert.equal(created.status, 201);
    }
    const member = await createMember('student', 'Dana', 'Dup', 'dup.dana@example.org');
    const contacts = contactsWithEmail('dup.dana@example.org');
    assert.equal(contacts.length, 2, 'no third contact is created');
    for (const contact of contacts) assert.ok(!(JSON.parse(contact.tags) as string[]).includes('Created Account'));

    const detail = await api('GET', `/api/admin/community/accounts/${member.userId}`);
    assert.equal(detail.body.account.linkState, 'conflict');
    assert.equal(detail.body.candidates.length, 2);

    // Viewers cannot resolve; editors can.
    const chosen = contacts[1].id;
    assert.equal((await api('POST', `/api/admin/community/accounts/${member.userId}/link`, { contactId: chosen }, viewerToken)).status, 403);
    const resolved = await api('POST', `/api/admin/community/accounts/${member.userId}/link`, { contactId: chosen }, editorToken);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.account.linkState, 'linked');
    assert.equal(resolved.body.account.contactId, chosen);
    const tagged = contactsWithEmail('dup.dana@example.org').find((c) => c.id === chosen);
    assert.ok((JSON.parse(tagged.tags) as string[]).includes('Created Account'));
  });

  it('staff cannot hand-add or remove the system "Created Account" tag', async () => {
    const linked = contactsWithEmail('nina.new@example.org')[0];
    const contact = (await api('GET', `/api/contacts/${linked.id}`)).body.contact;
    const removed = await api('PUT', `/api/contacts/${linked.id}`, { ...contact, tags: ['Student'] });
    assert.deepEqual(removed.body.contact.tags.sort(), ['Created Account', 'Student']);

    const unlinked = contactsWithEmail('helen.brackett@example.com')[0];
    await api('POST', '/api/contacts/bulk-tags', { ids: [unlinked.id], add: ['Created Account'] });
    const after = (await api('GET', `/api/contacts/${unlinked.id}`)).body.contact;
    assert.ok(!after.tags.includes('Created Account'));
  });

  it('an email change is re-verified and keeps the existing CRM link', async () => {
    const member = await createMember('student', 'Eve', 'Change', 'eve.change@example.org');
    const linkedContact = contactsWithEmail('eve.change@example.org')[0];
    const request = await api('POST', '/api/community/account/email', { email: 'eve.new@example.org', password: 'longpassword1' }, member.token);
    assert.equal(request.status, 200);
    assert.equal((await api('GET', '/api/auth/me', undefined, member.token)).body.user.email, 'eve.change@example.org');

    const message = [...outbox].reverse().find((m) => m.to === 'eve.new@example.org')!;
    const token = /token=([a-f0-9]+)/.exec(message.text)![1]!;
    assert.equal((await api('POST', '/api/auth/confirm-email-change', { token }, null)).status, 200);

    const detail = await api('GET', `/api/admin/community/accounts/${member.userId}`);
    assert.equal(detail.body.account.email, 'eve.new@example.org');
    assert.equal(detail.body.account.contactId, linkedContact.id, 'still linked to the same contact');
    assert.equal(detail.body.account.emailDiffersFromContact, true);
    assert.equal(contactsWithEmail('eve.new@example.org').length, 0, 'no new contact for the new address');
  });
});

describe('public profiles and private data', () => {
  it('directory and profile responses expose only public fields', async () => {
    const viewer = await createMember('student', 'Dee', 'Rectory', 'dee.rectory@example.org');
    const mentor = await createMember('mentor', 'Paula', 'Private', 'paula.private@example.org', {
      bio: 'I help founders.',
      interests: ['marketing'],
    });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], 'cv.pdf', { type: 'application/pdf' }));
    assert.equal((await api('POST', '/api/community/profile/resume', form, mentor.token)).status, 200);

    const list = await api('GET', '/api/community/members?limit=60', undefined, viewer.token);
    const profile = await api('GET', `/api/community/members/${mentor.userId}`, undefined, viewer.token);
    for (const payload of [JSON.stringify(list.body), JSON.stringify(profile.body)]) {
      assert.ok(!payload.includes('@example.'), 'no email addresses');
      // The resume stays private unless the member opts in: no file name, key or link.
      assert.ok(!/cv\.pdf|resume_key|\/files\/resume/i.test(payload), 'no resume file');
      assert.ok(!payload.includes('Created Account'), 'no internal CRM tags');
      assert.ok(!/contactId|how_?we_?connected|"phone"|"email"/i.test(payload), 'no CRM fields');
    }
    assert.equal(profile.body.member.bio, 'I help founders.');
    assert.deepEqual(Object.keys(profile.body.member).sort(), [
      'accountType', 'available', 'bio', 'company', 'firstName', 'fullName', 'graduationYear', 'hasPublicResume',
      'help', 'id', 'interests', 'lastName', 'linkedinUrl', 'major', 'photoUrl', 'roleTitle', 'schedulingUrl',
    ]);
    assert.equal(profile.body.member.hasPublicResume, false, 'resumes are private by default');
  });

  it('CRM contacts without accounts never become public profiles', async () => {
    const viewer = await createMember('student', 'Una', 'Seen', 'una.seen@example.org');
    const list = await api('GET', '/api/community/members?limit=60&q=marchetti', undefined, viewer.token);
    assert.equal(list.body.total, 0);
  });

  it('resumes are downloadable by their owner and staff only', async () => {
    const owner = await createMember('student', 'Ron', 'Resume', 'ron.resume@example.org');
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'ron.pdf', { type: 'application/pdf' }));
    await api('POST', '/api/community/profile/resume', form, owner.token);

    const own = await api('GET', '/api/community/profile/resume', undefined, owner.token);
    assert.equal(own.status, 200);
    assert.equal((await api('GET', own.body.url, undefined, null)).status, 200);

    const staff = await api('GET', `/api/admin/community/accounts/${owner.userId}/resume`, undefined, viewerToken);
    assert.equal(staff.status, 200);

    const other = await createMember('mentor', 'Otto', 'Other', 'otto.other@example.org');
    assert.equal((await api('GET', `/api/admin/community/accounts/${owner.userId}/resume`, undefined, other.token)).status, 403);
    assert.equal((await api('GET', `/api/community/files/resume/${owner.userId}`, undefined, other.token)).status, 401);
    // A token for one person's resume does not open another's.
    const forged = own.body.url.replace(owner.userId, other.userId);
    assert.equal((await api('GET', forged, undefined, null)).status, 401);
  });

  it('rejects uploads whose bytes do not match the declared type', async () => {
    const member = await createMember('student', 'Ute', 'Upload', 'ute.upload@example.org');
    const fake = new FormData();
    fake.set('file', new File(['<script>alert(1)</script>'], 'photo.png', { type: 'image/png' }));
    assert.equal((await api('POST', '/api/community/profile/photo', fake, member.token)).status, 400);
    const exe = new FormData();
    exe.set('file', new File(['MZ'], 'cv.exe', { type: 'application/octet-stream' }));
    assert.equal((await api('POST', '/api/community/profile/resume', exe, member.token)).status, 400);
    const ok = new FormData();
    ok.set('file', pngFile('me.png'));
    const uploaded = await api('POST', '/api/community/profile/photo', ok, member.token);
    assert.equal(uploaded.status, 200);
    assert.ok(uploaded.body.community.profile.photoUrl);
  });

  it('validates LinkedIn and scheduling URLs', async () => {
    const member = await createMember('mentor', 'Lin', 'Ked', 'lin.ked@example.org');
    const bad = await api('PUT', '/api/community/profile', { firstName: 'Lin', lastName: 'Ked', linkedinUrl: 'https://evil.example/in/x' }, member.token);
    assert.equal(bad.status, 400);
    const js = await api('PUT', '/api/community/profile', { firstName: 'Lin', lastName: 'Ked', schedulingUrl: 'javascript:alert(1)' }, member.token);
    assert.equal(js.status, 400);
    const good = await api(
      'PUT',
      '/api/community/profile',
      { firstName: 'Lin', lastName: 'Ked', linkedinUrl: 'linkedin.com/in/linked', schedulingUrl: 'https://calendly.com/lin' },
      member.token,
    );
    assert.equal(good.status, 200);
    assert.equal(good.body.community.profile.linkedinUrl, 'https://linkedin.com/in/linked');
  });
});

describe('admin-authored feed', () => {
  let draftId = '';

  it('only owners and editors can create and publish posts', async () => {
    const student = await createMember('student', 'Fay', 'Feed', 'fay.feed@example.org');
    assert.equal((await api('POST', '/api/admin/posts', { title: 'x', body: 'y' }, student.token)).status, 403);
    assert.equal((await api('POST', '/api/admin/posts', { title: 'x', body: 'y' }, viewerToken)).status, 403);

    const draft = await api('POST', '/api/admin/posts', { title: 'Secret draft', body: 'Not yet' }, editorToken);
    assert.equal(draft.status, 201);
    assert.equal(draft.body.post.status, 'draft');
    draftId = draft.body.post.id;
    assert.equal((await api('POST', `/api/admin/posts/${draftId}/publish`, undefined, viewerToken)).status, 403);
    assert.equal((await api('GET', '/api/admin/posts', undefined, viewerToken)).status, 200, 'viewers can read');

    const published = await api('POST', '/api/admin/posts', { title: 'Hello community', body: 'Welcome!', publish: true }, ownerToken);
    assert.equal(published.body.post.status, 'published');
    assert.ok(published.body.post.publishedAt);
  });

  it('drafts, unpublished and archived posts stay private, including by direct request', async () => {
    const student = await createMember('student', 'Dru', 'Draft', 'dru.draft@example.org');
    const image = new FormData();
    image.set('file', pngFile('cover.png'));
    const withImage = await api('POST', `/api/admin/posts/${draftId}/image`, image, editorToken);
    assert.equal(withImage.status, 200);

    let feed = await api('GET', '/api/community/feed', undefined, student.token);
    assert.ok(!feed.body.posts.some((p: any) => p.id === draftId));
    assert.equal((await api('GET', `/api/community/posts/${draftId}`, undefined, student.token)).status, 404);
    // The staff-scoped preview image link is not a community link.
    const staffImage = withImage.body.post.imageUrl as string;
    assert.equal((await api('GET', staffImage, undefined, null)).status, 200);

    await api('POST', `/api/admin/posts/${draftId}/publish`, undefined, editorToken);
    feed = await api('GET', '/api/community/feed', undefined, student.token);
    const live = feed.body.posts.find((p: any) => p.id === draftId);
    assert.ok(live);
    assert.equal((await api('GET', live.imageUrl, undefined, null)).status, 200);

    await api('POST', `/api/admin/posts/${draftId}/unpublish`, undefined, editorToken);
    assert.equal((await api('GET', `/api/community/posts/${draftId}`, undefined, student.token)).status, 404);
    assert.equal((await api('GET', live.imageUrl, undefined, null)).status, 404, 'old image links stop working');

    await api('POST', `/api/admin/posts/${draftId}/archive`, undefined, editorToken);
    feed = await api('GET', '/api/community/feed', undefined, student.token);
    assert.ok(!feed.body.posts.some((p: any) => p.id === draftId));
  });

  it('paginates the feed newest first', async () => {
    const student = await createMember('student', 'Pag', 'Inate', 'pag.inate@example.org');
    for (let i = 0; i < 4; i += 1) {
      await api('POST', '/api/admin/posts', { title: `Update ${i}`, body: 'Body', publish: true }, ownerToken);
    }
    const first = await api('GET', '/api/community/feed?limit=2', undefined, student.token);
    assert.equal(first.body.posts.length, 2);
    assert.ok(first.body.nextCursor);
    const second = await api('GET', `/api/community/feed?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, undefined, student.token);
    const ids = [...first.body.posts, ...second.body.posts].map((p: any) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    const times = [...first.body.posts, ...second.body.posts].map((p: any) => p.publishedAt);
    assert.deepEqual(times, [...times].sort().reverse());
  });

  it('only community-visible events reach the portal', async () => {
    const student = await createMember('student', 'Evan', 'Events', 'evan.events@example.org');
    const startsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const hidden = await api('POST', '/api/events', { name: 'Staff planning', startsAt });
    const shown = await api('POST', '/api/events', { name: 'Open pitch night', startsAt, communityVisible: true });
    const events = await api('GET', '/api/community/events?limit=20', undefined, student.token);
    const ids = events.body.events.map((e: any) => e.id);
    assert.ok(ids.includes(shown.body.event.id));
    assert.ok(!ids.includes(hidden.body.event.id));
    assert.deepEqual(Object.keys(events.body.events[0]).sort(), ['competitionId', 'endsAt', 'id', 'location', 'name', 'source', 'startsAt']);
    // A post cannot be linked to a hidden event.
    const linked = await api('POST', '/api/admin/posts', { title: 'x', body: 'y', eventId: hidden.body.event.id });
    assert.equal(linked.status, 400);
  });
});

describe('mentorship matching', () => {
  it('ranks deterministically and explains shared tags', () => {
    const tag = (slug: string, label: string) => ({ slug, label });
    const marketing = tag('marketing', 'Marketing');
    const entre = tag('entrepreneurship', 'Entrepreneurship');
    const funding = tag('fundraising', 'Fundraising');
    const results = recommendMentors(
      { id: 'student', interests: [marketing, entre], help: [funding] },
      [
        { id: 'b', firstName: 'Bo', lastName: 'Zed', interests: [marketing, entre], help: [] },
        { id: 'a', firstName: 'Al', lastName: 'Able', interests: [marketing, entre], help: [] },
        { id: 'c', firstName: 'Cy', lastName: 'Cash', interests: [], help: [funding] },
        { id: 'd', firstName: 'Di', lastName: 'None', interests: [tag('design', 'Design')], help: [] },
      ],
    );
    assert.deepEqual(results.map((r) => r.id), ['a', 'b', 'c'], 'ties break by name; no zero-score matches');
    assert.equal(results[0]!.reason, 'Matches your interests in entrepreneurship and marketing.');
    assert.equal(results[2]!.reason, 'Can help with fundraising.');
  });

  it('recommends active mentors with overlapping tags and excludes deactivated ones', async () => {
    const student = await createMember('student', 'Stu', 'Match', 'stu.match@example.org', {
      interests: ['marketing', 'entrepreneurship'],
      help: ['fundraising'],
    });
    const good = await createMember('mentor', 'Mia', 'Match', 'mia.match@example.org', {
      interests: ['marketing'],
      help: ['fundraising'],
    });
    const gone = await createMember('mentor', 'Gus', 'Gone', 'gus.gone@example.org', { interests: ['marketing', 'entrepreneurship'], help: ['fundraising'] });
    await api('POST', `/api/admin/community/accounts/${gone.userId}/deactivate`, { reason: 'test' }, editorToken);

    const recs = await api('GET', '/api/community/mentors/recommended', undefined, student.token);
    assert.equal(recs.status, 200);
    const ids = recs.body.recommendations.map((r: any) => r.mentor.id);
    assert.ok(ids.includes(good.userId));
    assert.ok(!ids.includes(gone.userId));
    const mia = recs.body.recommendations.find((r: any) => r.mentor.id === good.userId);
    assert.equal(mia.reason, 'Can help with fundraising. Also matches your interests in marketing.');

    const noTags = await createMember('student', 'Tia', 'Tagless', 'tia.tagless@example.org');
    const none = await api('GET', '/api/community/mentors/recommended', undefined, noTags.token);
    assert.equal(none.body.needsTags, true);
    assert.equal(none.body.recommendations.length, 0);
    const browse = await api('GET', '/api/community/mentors?limit=60', undefined, noTags.token);
    assert.ok(browse.body.members.length > 0, 'browsing still works without tags');
    assert.ok(browse.body.members.every((m: any) => m.accountType === 'mentor'));
  });
});

describe('private messaging', () => {
  let alice: Member;
  let bob: Member;
  let carol: Member;
  let conversationId = '';

  before(async () => {
    alice = await createMember('student', 'Alice', 'Asker', 'alice.asker@example.org');
    bob = await createMember('mentor', 'Bob', 'Builder', 'bob.builder@example.org');
    carol = await createMember('student', 'Carol', 'Curious', 'carol.curious@example.org');
  });

  it('participants can start a conversation and exchange messages', async () => {
    const started = await api('POST', '/api/community/conversations', { recipientId: bob.userId }, alice.token);
    assert.equal(started.status, 200);
    conversationId = started.body.conversationId;
    const again = await api('POST', '/api/community/conversations', { recipientId: alice.userId }, bob.token);
    assert.equal(again.body.conversationId, conversationId, 'one conversation per pair');

    const sent = await api('POST', `/api/community/conversations/${conversationId}/messages`, {
      body: 'Hi Bob! Could we meet next week?',
      kind: 'meeting_request',
      clientKey: 'client-key-0001',
    }, alice.token);
    assert.equal(sent.status, 201);

    const unread = await api('GET', '/api/community/messages/unread-count', undefined, bob.token);
    assert.equal(unread.body.unread, 1);
    const list = await api('GET', '/api/community/conversations', undefined, bob.token);
    assert.equal(list.body.conversations[0].unreadCount, 1);
    assert.equal(list.body.conversations[0].other.fullName, 'Alice Asker');

    await api('POST', `/api/community/conversations/${conversationId}/read`, undefined, bob.token);
    assert.equal((await api('GET', '/api/community/messages/unread-count', undefined, bob.token)).body.unread, 0);
  });

  it('a retried send does not create a duplicate', async () => {
    const payload = { body: 'Only once', clientKey: 'client-key-0002' };
    const one = await api('POST', `/api/community/conversations/${conversationId}/messages`, payload, alice.token);
    const two = await api('POST', `/api/community/conversations/${conversationId}/messages`, payload, alice.token);
    assert.equal(one.body.message.id, two.body.message.id);
    assert.equal(two.body.duplicate, true);
    const count = rawDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE client_key = 'client-key-0002'`).get().n;
    assert.equal(count, 1);
  });

  it('only participants can read or send', async () => {
    assert.equal((await api('GET', `/api/community/conversations/${conversationId}/messages`, undefined, carol.token)).status, 404);
    assert.equal(
      (await api('POST', `/api/community/conversations/${conversationId}/messages`, { body: 'sneaky' }, carol.token)).status,
      404,
    );
    // Administrative access does not open private conversations (staff are just another non-participant).
    assert.equal((await api('GET', `/api/community/conversations/${conversationId}/messages`, undefined, ownerToken)).status, 404);
    const carolList = await api('GET', '/api/community/conversations', undefined, carol.token);
    assert.ok(!carolList.body.conversations.some((c: any) => c.id === conversationId));
  });

  it('validates message length and paginates history', async () => {
    assert.equal((await api('POST', `/api/community/conversations/${conversationId}/messages`, { body: '   ' }, bob.token)).status, 400);
    assert.equal(
      (await api('POST', `/api/community/conversations/${conversationId}/messages`, { body: 'x'.repeat(4001) }, bob.token)).status,
      400,
    );
    for (let i = 0; i < 5; i += 1) {
      await api('POST', `/api/community/conversations/${conversationId}/messages`, { body: `Reply ${i}`, clientKey: `page-key-${i}xx` }, bob.token);
    }
    const page = await api('GET', `/api/community/conversations/${conversationId}/messages?limit=3`, undefined, alice.token);
    assert.equal(page.body.messages.length, 3);
    assert.equal(page.body.messages[2].body, 'Reply 4');
    assert.ok(page.body.olderCursor);
    const older = await api(
      'GET',
      `/api/community/conversations/${conversationId}/messages?limit=3&before=${encodeURIComponent(page.body.olderCursor)}`,
      undefined,
      alice.token,
    );
    assert.equal(older.body.messages[2].body, 'Reply 1');
  });

  it('staff message members through their ECenter staff community identity', async () => {
    // Every staff user has one (created with the account, or by the v3 migration for existing staff).
    const identity = await api('POST', '/api/community/staff-identity', undefined, editorToken);
    assert.equal(identity.status, 200);
    assert.equal(identity.body.community.accountType, 'staff');
    const started = await api('POST', '/api/community/conversations', { recipientId: alice.userId }, editorToken);
    assert.equal(started.status, 200);
    // The identity grants nothing extra and removes nothing: CRM access is unchanged.
    assert.equal((await api('GET', '/api/contacts', undefined, editorToken)).status, 200);
  });
});

describe('deactivation', () => {
  it('revokes access, hides the member, blocks new messages and keeps history', async () => {
    const dee = await createMember('mentor', 'Dee', 'Activated', 'dee.activated@example.org', { interests: ['finance'] });
    const friend = await createMember('student', 'Fran', 'Friend', 'fran.friend@example.org', { interests: ['finance'] });
    const conversation = await api('POST', '/api/community/conversations', { recipientId: dee.userId }, friend.token);
    await api('POST', `/api/community/conversations/${conversation.body.conversationId}/messages`, { body: 'Hello!' }, friend.token);
    const contact = contactsWithEmail('dee.activated@example.org')[0];

    assert.equal((await api('POST', `/api/admin/community/accounts/${dee.userId}/deactivate`, {}, viewerToken)).status, 403);
    const result = await api('POST', `/api/admin/community/accounts/${dee.userId}/deactivate`, { reason: 'Left program' }, editorToken);
    assert.equal(result.body.account.status, 'deactivated');

    // Existing session and new sign-ins are refused.
    assert.equal((await api('GET', '/api/community/feed', undefined, dee.token)).status, 401);
    const login = await api('POST', '/api/auth/login', { email: dee.email, password: 'longpassword1' }, null);
    assert.equal(login.status, 401);
    assert.match(login.body.error, /deactivated/);

    // Gone from discovery and recommendations.
    const directory = await api('GET', '/api/community/members?limit=60', undefined, friend.token);
    assert.ok(!directory.body.members.some((m: any) => m.id === dee.userId));
    assert.equal((await api('GET', `/api/community/members/${dee.userId}`, undefined, friend.token)).status, 404);
    const recs = await api('GET', '/api/community/mentors/recommended', undefined, friend.token);
    assert.ok(!recs.body.recommendations.some((r: any) => r.mentor.id === dee.userId));

    // No new messages, but history stays readable and labelled.
    const blocked = await api('POST', `/api/community/conversations/${conversation.body.conversationId}/messages`, { body: 'Still there?' }, friend.token);
    assert.equal(blocked.status, 403);
    const history = await api('GET', `/api/community/conversations/${conversation.body.conversationId}/messages`, undefined, friend.token);
    assert.equal(history.body.messages.length, 1);
    assert.equal(history.body.other.available, false);

    // CRM record is preserved and still shows the account (as deactivated).
    const crm = await api('GET', `/api/contacts/${contact.id}`);
    assert.equal(crm.status, 200);
    assert.equal(crm.body.contact.communityAccount.status, 'deactivated');
    assert.ok(crm.body.contact.tags.includes('Created Account'));

    // Reactivation restores access.
    await api('POST', `/api/admin/community/accounts/${dee.userId}/reactivate`, undefined, editorToken);
    const back = await api('POST', '/api/auth/login', { email: dee.email, password: 'longpassword1' }, null);
    assert.equal(back.status, 200);
  });
});

describe('password recovery', () => {
  it('resets a password through the emailed link without revealing accounts', async () => {
    const unknown = await api('POST', '/api/auth/forgot-password', { email: 'nobody@example.org' }, null);
    assert.equal(unknown.status, 200);
    const member = await createMember('student', 'Reese', 'Reset', 'reese.reset@example.org');
    assert.equal((await api('POST', '/api/auth/forgot-password', { email: 'Reese.Reset@example.org' }, null)).status, 200);
    const token = lastLinkTo('reese.reset@example.org', 'reset-password');
    assert.equal((await api('POST', '/api/auth/reset-password', { token, password: 'brandnewpass' }, null)).status, 200);
    assert.equal((await api('GET', '/api/community/feed', undefined, member.token)).status, 401, 'old sessions end');
    const login = await api('POST', '/api/auth/login', { email: member.email, password: 'brandnewpass' }, null);
    assert.equal(login.status, 200);
  });
});
