import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';

/**
 * End-to-end API tests.
 *
 * The suite runs against a throwaway SQLite database, reseeded before the first
 * test, so it is deterministic and repeatable and never touches dev data. The
 * environment has to be configured before src/env.ts is imported, hence the
 * dynamic imports in `before`.
 */

const testDb = path.join(os.tmpdir(), `ecenter-test-${process.pid}.db`);
process.env.ECENTER_TEST_MODE = '1';
process.env.SQLITE_PATH = testDb;
process.env.DATABASE_URL = '';
process.env.DB_DRIVER = 'sqlite';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_UPLOAD_DIR = path.join(os.tmpdir(), `ecenter-test-uploads-${process.pid}`);
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key';

let server: Server;
let base = '';
let token = '';
let closeDatabase: () => Promise<void>;

async function api(
  method: string,
  routePath: string,
  body?: unknown,
  authToken: string | null = token,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${base}${routePath}`, { method, headers, body: payload });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

before(async () => {
  fs.rmSync(testDb, { force: true });
  const { seed } = await import('../src/db/seed.ts');
  const { closeDb } = await import('../src/db/index.ts');
  closeDatabase = closeDb;
  await seed();

  const { app } = await import('../src/index.ts');
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/api`;

  const login = await api('POST', '/auth/login', { email: 'lisa@unh.edu', password: 'test123' }, null);
  assert.equal(login.status, 200);
  token = login.body.token;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDatabase?.();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(process.env.LOCAL_UPLOAD_DIR!, { recursive: true, force: true });
});

describe('authentication', () => {
  it('rejects a wrong password without revealing the account exists', async () => {
    const response = await api('POST', '/auth/login', { email: 'lisa@unh.edu', password: 'nope' }, null);
    assert.equal(response.status, 401);
    assert.match(response.body.error, /do not match/);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await api('GET', '/contacts', undefined, null);
    assert.equal(response.status, 401);
  });

  it('returns the signed-in user and tenant', async () => {
    const response = await api('GET', '/auth/me');
    assert.equal(response.body.user.email, 'lisa@unh.edu');
    assert.equal(response.body.user.role, 'owner');
    assert.equal(response.body.customer.slug, 'unh-ecenter');
  });
});

describe('contacts', () => {
  it('lists seeded contacts with relationship aggregates', async () => {
    const { body } = await api('GET', '/contacts?limit=50');
    assert.equal(body.total, 10);
    assert.ok(body.contacts.some((c: any) => c.lastInteractionAt));
    assert.ok(body.contacts.some((c: any) => c.noteCount > 0));
    assert.ok(body.contacts.some((c: any) => c.latestNoteSnippet));
    assert.ok(body.contacts.some((c: any) => c.organizationName === 'Wildcat Ventures'));
  });

  it('searches names, emails, tags and the relationship story', async () => {
    const byName = await api('GET', '/contacts?q=raghavan');
    assert.equal(byName.body.total, 1);

    // The origin story is searchable on purpose, so "who introduced them" is findable.
    const byStory = await api('GET', '/contacts?q=ideathon');
    assert.ok(byStory.body.total >= 2);
  });

  it('filters by status, tag and student-founder flag', async () => {
    assert.equal((await api('GET', '/contacts?status=on_hold')).body.total, 1);
    assert.equal((await api('GET', '/contacts?tag=Mentor')).body.total, 3);
    assert.equal((await api('GET', '/contacts?studentFoundersOnly=true')).body.total, 2);
  });

  it('paginates and sorts', async () => {
    const first = await api('GET', '/contacts?sort=name&limit=4&page=1');
    const second = await api('GET', '/contacts?sort=name&limit=4&page=2');
    assert.equal(first.body.contacts.length, 4);
    assert.equal(first.body.hasMore, true);
    assert.notEqual(first.body.contacts[0].id, second.body.contacts[0].id);
  });

  it('validates required fields and names the offending one', async () => {
    const response = await api('POST', '/contacts', { firstName: 'No', lastName: 'Email' });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, 'Email');
  });

  it('derives the student-founder flag from the tag', async () => {
    const created = await api('POST', '/contacts', {
      firstName: 'Case',
      lastName: 'Study',
      email: 'case.study@example.com',
      tags: ['Student Founder'],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.contact.isStudentFounder, true);
    await api('DELETE', `/contacts/${created.body.contact.id}`);
  });

  it('applies bulk tag changes', async () => {
    const list = await api('GET', '/contacts?tag=Mentor&limit=50');
    const ids = list.body.contacts.map((c: any) => c.id);
    const response = await api('POST', '/contacts/bulk-tags', { ids, add: ['Advisory Board'] });
    assert.equal(response.body.updated, ids.length);
    assert.equal((await api('GET', '/contacts?tag=Advisory Board')).body.total, ids.length);
    await api('POST', '/contacts/bulk-tags', { ids, remove: ['Advisory Board'] });
  });

  it('soft-deletes a contact and hides its notes and tasks', async () => {
    const created = await api('POST', '/contacts', {
      firstName: 'Temp',
      lastName: 'Record',
      email: 'temp.record@example.com',
    });
    const id = created.body.contact.id;
    await api('POST', '/notes', { contactId: id, content: 'Note on a doomed record.', noteType: 'call' });

    assert.equal((await api('DELETE', `/contacts/${id}`)).status, 200);
    assert.equal((await api('GET', `/contacts/${id}`)).status, 404);
    assert.equal((await api('GET', `/notes?contactId=${id}`)).body.total, 0);
  });
});

describe('notes', () => {
  let contactId = '';

  before(async () => {
    const { body } = await api('GET', '/contacts?q=raghavan');
    contactId = body.contacts[0].id;
  });

  it('stamps the timestamp server-side and ignores any client value', async () => {
    const created = await api('POST', '/notes', {
      contactId,
      noteType: 'call',
      content: 'Server stamps this.',
      createdAt: '1999-01-01T00:00:00.000Z',
      updatedAt: '1999-01-01T00:00:00.000Z',
    });
    assert.equal(created.status, 201);
    assert.equal(new Date(created.body.note.createdAt).getFullYear(), new Date().getFullYear());
    assert.equal(created.body.note.wordCount, 3);

    // Editing the body must not move the original timestamp.
    const edited = await api('PUT', `/notes/${created.body.note.id}`, {
      content: 'Edited body, same timestamp.',
      noteType: 'call',
    });
    assert.equal(edited.body.note.createdAt, created.body.note.createdAt);

    await api('DELETE', `/notes/${created.body.note.id}`);
  });

  it('returns a newest-first timeline that can be reversed', async () => {
    const newest = await api('GET', '/notes?limit=100');
    const oldest = await api('GET', '/notes?order=oldest&limit=100');
    assert.ok(newest.body.notes[0].createdAt > newest.body.notes.at(-1).createdAt);
    assert.ok(oldest.body.notes[0].createdAt < oldest.body.notes.at(-1).createdAt);
  });

  it('searches content and filters by type, tag and author', async () => {
    assert.equal((await api('GET', '/notes?q=thermal')).body.total, 1);
    assert.ok((await api('GET', '/notes?noteType=meeting')).body.total >= 4);
    assert.ok((await api('GET', '/notes?tag=%23FollowUp')).body.total >= 3);

    const users = await api('GET', '/settings/users');
    const bella = users.body.users.find((u: any) => u.email === 'bella@unh.edu');
    assert.ok((await api(`GET`, `/notes?createdBy=${bella.id}`)).body.total >= 4);
  });
});

describe('tasks', () => {
  it('derives overdue status rather than storing it', async () => {
    const { body } = await api('GET', '/tasks?limit=100');
    assert.equal(body.summary.overdue, 2);
    const overdue = body.tasks.filter((t: any) => t.displayStatus === 'overdue');
    assert.equal(overdue.length, 2);
    assert.ok(overdue.every((t: any) => t.isOverdue && t.status !== 'complete'));
  });

  it('filters by status, assignee and priority', async () => {
    assert.equal((await api('GET', '/tasks?status=overdue')).body.total, 2);
    assert.equal((await api('GET', '/tasks?status=complete')).body.total, 2);
    assert.ok((await api('GET', '/tasks?priority=high')).body.total >= 2);

    const users = await api('GET', '/settings/users');
    const lisa = users.body.users.find((u: any) => u.email === 'lisa@unh.edu');
    assert.ok((await api('GET', `/tasks?assignedTo=${lisa.id}`)).body.total >= 4);
  });

  it('rejects a date that does not exist', async () => {
    const response = await api('POST', '/tasks', { title: 'Impossible', dueDate: '2025-02-31' });
    assert.equal(response.status, 400);
  });

  it('schedules the next occurrence when a recurring task is completed', async () => {
    const list = await api('GET', '/tasks?limit=100');
    const weekly = list.body.tasks.find((t: any) => t.recurrence === 'weekly');
    assert.ok(weekly, 'seed should include a weekly task');

    const toggled = await api('POST', `/tasks/${weekly.id}/toggle`);
    assert.equal(toggled.body.task.status, 'complete');
    assert.ok(toggled.body.nextOccurrence, 'completing a recurring task creates the next one');

    const expected = new Date(`${weekly.dueDate}T12:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 7);
    assert.equal(toggled.body.nextOccurrence.dueDate, expected.toISOString().slice(0, 10));
    assert.equal(toggled.body.nextOccurrence.recurrence, 'weekly');

    // Completing again must not duplicate the occurrence.
    await api('POST', `/tasks/${weekly.id}/toggle`);
    const second = await api('POST', `/tasks/${weekly.id}/toggle`);
    assert.equal(second.body.nextOccurrence, null);

    await api('DELETE', `/tasks/${toggled.body.nextOccurrence.id}`);
    await api('POST', `/tasks/${weekly.id}/toggle`);
  });
});

describe('organizations', () => {
  it('groups multiple contacts under one organization', async () => {
    const list = await api('GET', '/organizations');
    assert.equal(list.body.total, 5);
    const wildcat = list.body.organizations.find((o: any) => o.name === 'Wildcat Ventures');
    assert.equal(wildcat.contactCount, 2);

    const detail = await api('GET', `/organizations/${wildcat.id}`);
    assert.equal(detail.body.contacts.length, 2);
    assert.ok(detail.body.contacts.every((c: any) => c.orgRole));
  });

  it('links and unlinks contacts inline', async () => {
    const orgs = await api('GET', '/organizations');
    const club = orgs.body.organizations.find((o: any) => o.name === 'UNH Entrepreneurs Club');
    const contacts = await api('GET', '/contacts?q=fontaine');
    const angela = contacts.body.contacts[0];

    assert.equal((await api('POST', `/organizations/${club.id}/contacts`, {
      contactId: angela.id,
      orgRole: 'Faculty Liaison',
    })).status, 200);
    assert.equal((await api('GET', `/organizations/${club.id}`)).body.contacts.length, 2);

    await api('DELETE', `/organizations/${club.id}/contacts/${angela.id}`);
    assert.equal((await api('GET', `/organizations/${club.id}`)).body.contacts.length, 1);
  });

  it('keeps contacts when an organization is deleted', async () => {
    const created = await api('POST', '/organizations', { name: 'Disposable Co', orgType: 'startup' });
    const orgId = created.body.organization.id;
    const contact = await api('POST', '/contacts', {
      firstName: 'Linked',
      lastName: 'Person',
      email: 'linked.person@example.com',
      organizationId: orgId,
    });

    await api('DELETE', `/organizations/${orgId}`);
    const after = await api('GET', `/contacts/${contact.body.contact.id}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.contact.organizationId, null);

    await api('DELETE', `/contacts/${contact.body.contact.id}`);
  });
});

describe('events', () => {
  it('writes attendance into the contact timeline automatically', async () => {
    const events = await api('GET', '/events');
    const kickoff = events.body.events.find((e: any) => e.name === 'Ideathon Kickoff');
    const contacts = await api('GET', '/contacts?q=brackett');
    const helen = contacts.body.contacts[0];

    const before = (await api('GET', `/notes?contactId=${helen.id}`)).body.total;
    assert.equal((await api('POST', `/events/${kickoff.id}/attendees`, { contactId: helen.id })).status, 201);

    const notes = await api('GET', `/notes?contactId=${helen.id}`);
    assert.equal(notes.body.total, before + 1);
    const generated = notes.body.notes.find((n: any) => n.source === 'event');
    assert.match(generated.content, /^Attended Ideathon Kickoff on \w{3} \d{1,2}, \d{4}$/);

    // The generated note is a record of what happened, so unlinking keeps it.
    await api('DELETE', `/events/${kickoff.id}/attendees/${helen.id}`);
    assert.equal((await api('GET', `/notes?contactId=${helen.id}`)).body.total, before + 1);
    await api('DELETE', `/notes/${generated.id}`);
  });

  it('rejects a duplicate attendee and an end before the start', async () => {
    const events = await api('GET', '/events');
    const kickoff = events.body.events.find((e: any) => e.name === 'Ideathon Kickoff');
    const attendees = await api('GET', `/events/${kickoff.id}`);
    const existing = attendees.body.attendees[0];

    const duplicate = await api('POST', `/events/${kickoff.id}/attendees`, { contactId: existing.id });
    assert.equal(duplicate.status, 400);

    const backwards = await api('POST', '/events', {
      name: 'Backwards',
      startsAt: '2026-03-01T18:00:00.000Z',
      endsAt: '2026-03-01T16:00:00.000Z',
    });
    assert.equal(backwards.status, 400);
  });
});

describe('documents', () => {
  let contactId = '';
  let documentId = '';

  before(async () => {
    const { body } = await api('GET', '/contacts?q=whitfield');
    contactId = body.contacts[0].id;
  });

  it('uploads, sanitises the name and records an audit entry', async () => {
    const form = new FormData();
    form.append('file', new Blob(['engagement letter'], { type: 'text/plain' }), '../../my notes.txt');
    form.append('contactId', contactId);

    const response = await api('POST', '/documents', form);
    assert.equal(response.status, 201);
    assert.equal(response.body.document.fileName, 'my_notes.txt');
    documentId = response.body.document.id;

    const logs = await api('GET', '/settings/audit-logs');
    assert.ok(logs.body.logs.some((l: any) => l.action === 'document.upload'));
  });

  it('refuses a disallowed file type', async () => {
    const form = new FormData();
    form.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'payload.exe');
    form.append('contactId', contactId);
    assert.equal((await api('POST', '/documents', form)).status, 400);
  });

  it('serves the file only with a valid time-limited token', async () => {
    const link = await api('GET', `/documents/${documentId}/download`);
    assert.equal(link.status, 200);
    assert.ok(link.body.url);

    const origin = base.replace(/\/api$/, '');
    const good = await fetch(`${origin}${link.body.url}`);
    assert.equal(good.status, 200);
    assert.equal(await good.text(), 'engagement letter');

    const bad = await fetch(`${origin}/api/documents/${documentId}/raw?token=forged`);
    assert.equal(bad.status, 401);

    const logs = await api('GET', '/settings/audit-logs');
    assert.ok(logs.body.logs.some((l: any) => l.action === 'document.download'));
  });

  it('soft-deletes and stops serving the document', async () => {
    assert.equal((await api('DELETE', `/documents/${documentId}`)).status, 200);
    assert.equal((await api('GET', `/documents/${documentId}/download`)).status, 404);
    assert.equal((await api('GET', `/documents?contactId=${contactId}`)).body.documents.length, 0);
  });
});

describe('dashboard and search', () => {
  it('returns every dashboard section in one request', async () => {
    const { body } = await api('GET', '/dashboard');
    assert.ok(body.stats.activeContacts >= 8);
    assert.equal(body.stats.overdueTasks, 2);
    assert.equal(body.stats.teamMembers, 2);
    assert.ok(body.stats.nextEventAt);
    assert.equal(body.overdueTasks.length, 2);
    assert.ok(body.thisWeek.length >= 1);
    assert.equal(body.upcomingEvents.length, 3);
    assert.ok(body.activity.length > 3);
    assert.equal(body.team.length, 2);
    assert.ok(body.team.every((t: any) => typeof t.openTaskCount === 'number'));
  });

  it('searches across every record type', async () => {
    const orgs = await api('GET', '/search?q=wildcat');
    assert.ok(orgs.body.organizations.length >= 1);

    const notes = await api('GET', '/search?q=thermal');
    assert.equal(notes.body.notes.length, 1);

    const people = await api('GET', '/search?q=okafor');
    assert.equal(people.body.contacts.length, 1);

    // A single character is not enough to search on.
    const tooShort = await api('GET', '/search?q=a');
    assert.deepEqual(tooShort.body.contacts, []);
  });
});

describe('settings and permissions', () => {
  it('exposes configuration and calendar state', async () => {
    const { body } = await api('GET', '/settings');
    assert.equal(body.documents.maxFileSizeMb, 50);
    assert.equal(body.calendar.connected, false);
    assert.equal(body.about.databaseDriver, 'sqlite');
    assert.ok(body.documents.allowedExtensions.includes('.pdf'));
  });

  it('saves preferences', async () => {
    const response = await api('PUT', '/settings/preferences', {
      emailDigest: 'weekly',
      reminderLeadDays: 3,
      timezone: 'America/New_York',
    });
    assert.equal(response.body.preferences.reminderLeadDays, 3);
  });

  it('stops a non-owner from managing team members', async () => {
    const login = await api('POST', '/auth/login', { email: 'bella@unh.edu', password: 'test123' }, null);
    const editorToken = login.body.token;

    const create = await api(
      'POST',
      '/settings/users',
      { email: 'new@unh.edu', name: 'New', role: 'editor', password: 'password123' },
      editorToken,
    );
    assert.equal(create.status, 403);

    // An editor can still do the everyday work.
    const note = await api('GET', '/contacts', undefined, editorToken);
    assert.equal(note.status, 200);
  });

  it('refuses to remove the last owner', async () => {
    const users = await api('GET', '/settings/users');
    const lisa = users.body.users.find((u: any) => u.email === 'lisa@unh.edu');
    const response = await api('PUT', `/settings/users/${lisa.id}`, { name: 'Lisa Keslar', role: 'editor' });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /at least one owner/);
  });

  it('rejects a calendar sync before Outlook is connected', async () => {
    const response = await api('POST', '/calendar/sync');
    assert.equal(response.status, 400);
  });
});

describe('CSV export', () => {
  it('exports contacts, notes and tasks', async () => {
    for (const route of ['/contacts/export.csv', '/notes/export.csv', '/tasks/export.csv']) {
      const response = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.split('\r\n').length > 2, `${route} should have a header and rows`);
    }
  });

  it('neutralises spreadsheet formula injection', async () => {
    const created = await api('POST', '/contacts', {
      firstName: '=cmd()',
      lastName: 'Injection',
      email: 'injection@example.com',
    });
    const response = await fetch(`${base}/contacts/export.csv?q=injection`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.text();
    assert.ok(body.includes("'=cmd()"), 'a leading = must be escaped');
    await api('DELETE', `/contacts/${created.body.contact.id}`);
  });
});
