/**
 * Loads a realistic demo tenant into the local dev database: the ECenter team,
 * a handful of organizations, contacts across every relationship type, a dated
 * note history, live and overdue follow-ups, and a few events with attendance
 * already recorded.
 *
 * For production, seed real D1 the same way the schema is migrated -- generate
 * a SQL file and run `wrangler d1 execute ecenter-crm --remote --file=...` --
 * or just use the app's own Settings -> team + the Contacts/Organizations UI.
 * This script only ever touches the local dev database.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1Db } from '../src/db/d1.ts';
import type { Db } from '../src/db/driver.ts';
import { newId } from '../src/lib/ids.ts';
import { hashPassword } from '../src/lib/password.ts';
import { addDaysToDate, nowIso, todayDate } from '../src/lib/time.ts';
// @ts-expect-error -- plain JS dev shim, no type declarations.
import { createFakeD1 } from '../dev/fakeD1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, '..');
const dbPath = process.env.DEV_SQLITE_PATH || path.join(workerRoot, 'data', 'dev.db');

const CUSTOMER_SLUG = process.env.DEFAULT_CUSTOMER_SLUG || 'unh-ecenter';
const CUSTOMER_NAME = process.env.DEFAULT_CUSTOMER_NAME || 'UNH Entrepreneurship Center';
const DEMO_PASSWORD = 'test123';

/** Days before/after today, so seeded data stays plausible whenever it is run. */
function isoDaysAgo(days: number, hour = 14, minute = 30): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}
function isoDaysAhead(days: number, hour = 17, minute = 0): string {
  return isoDaysAgo(-days, hour, minute);
}

const CUSTOMER_SCOPED_TABLES = [
  'event_external_mapping',
  'calendar_sync_metadata',
  'microsoft_oauth_credentials',
  'audit_logs',
  'documents',
  'event_attendees',
  'events',
  'sessions',
  'tasks',
  'note_contacts',
  'notes',
  'contact_organizations',
  'contacts',
  'organizations',
  'user_preferences',
  'users',
];

/**
 * Loads the demo tenant into `db`. Used both by the CLI wrapper below
 * (local dev database) and directly by the test suite (an isolated,
 * throwaway database per test run).
 */
export async function seedDemoData(
  db: Db,
  customerSlug: string,
  customerName: string,
): Promise<{ customerId: string }> {
  const timestamp = nowIso();

  const existing = await db.get<{ id: string }>(`SELECT id FROM customers WHERE slug = ?`, [customerSlug]);
  const customerId = existing?.id ?? newId();

  if (existing) {
    for (const table of CUSTOMER_SCOPED_TABLES) {
      await db.run(`DELETE FROM ${table} WHERE customer_id = ?`, [customerId]);
    }
  } else {
    await db.run(`INSERT INTO customers (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
      customerId,
      customerName,
      customerSlug,
      timestamp,
      timestamp,
    ]);
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const team = [
    { id: newId(), email: 'lisa@unh.edu', name: 'Lisa Keslar', role: 'owner' },
    { id: newId(), email: 'bella@unh.edu', name: 'Bella Kenoyer', role: 'editor' },
  ];

  for (const member of team) {
    await db.run(
      `INSERT INTO users (id, customer_id, email, password_hash, name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [member.id, customerId, member.email, passwordHash, member.name, member.role, timestamp, timestamp],
    );
    await db.run(
      `INSERT INTO user_preferences (user_id, customer_id, email_digest, reminder_lead_days, timezone, updated_at)
       VALUES (?, ?, 'weekly', 1, 'America/New_York', ?)`,
      [member.id, customerId, timestamp],
    );
  }

  const lisa = team[0]!.id;
  const bella = team[1]!.id;

  const orgs = [
    {
      id: newId(),
      name: 'Wildcat Ventures',
      orgType: 'startup',
      location: 'Durham, NH',
      website: 'https://example.com/wildcat-ventures',
      relationship:
        'Student-founded hardware startup that came through the Ideathon. We provide mentorship and prototyping space.',
      status: 'active',
    },
    {
      id: newId(),
      name: 'Seacoast Angel Network',
      orgType: 'established',
      location: 'Portsmouth, NH',
      website: 'https://example.com/seacoast-angels',
      relationship:
        'Regional angel group. They send two members to judge our pitch nights and take warm intros from us.',
      status: 'active',
    },
    {
      id: newId(),
      name: 'UNH Entrepreneurs Club',
      orgType: 'club',
      location: 'Madbury Commons, Durham',
      website: null,
      relationship: 'Student club we co-program with. They run weekly meetups; we supply speakers and space.',
      status: 'active',
    },
    {
      id: newId(),
      name: 'Granite State Manufacturing',
      orgType: 'established',
      location: 'Rochester, NH',
      website: 'https://example.com/granite-state-mfg',
      relationship:
        'Industry partner for capstone projects. Interested in sponsoring an internship track next year.',
      status: 'prospect',
    },
    {
      id: newId(),
      name: 'NH Tech Alliance',
      orgType: 'nonprofit',
      location: 'Manchester, NH',
      website: 'https://example.com/nh-tech-alliance',
      relationship: 'Statewide nonprofit. Co-hosts our fall speaker series and shares their mentor bench.',
      status: 'active',
    },
  ];

  for (const org of orgs) {
    await db.run(
      `INSERT INTO organizations
         (id, customer_id, name, org_type, location, website, relationship, status,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        org.id,
        customerId,
        org.name,
        org.orgType,
        org.location,
        org.website,
        org.relationship,
        org.status,
        timestamp,
        timestamp,
        lisa,
        lisa,
      ],
    );
  }

  const [wildcat, angels, club, manufacturing, alliance] = orgs;

  const contacts = [
    {
      id: newId(),
      firstName: 'Marcus',
      lastName: 'Whitfield',
      email: 'marcus.whitfield@example.com',
      phone: '603-555-0142',
      howWeConnected:
        'Introduced by Dean Alvarez at the 2023 innovation breakfast. He mentored two of our teams that year and keeps asking for more.',
      tags: ['Mentor', 'Alumni'],
      organizationId: angels!.id,
      orgRole: 'Managing Partner',
      status: 'active',
      isStudentFounder: 0,
      createdDaysAgo: 420,
    },
    {
      id: newId(),
      firstName: 'Priya',
      lastName: 'Raghavan',
      email: 'priya.raghavan@example.com',
      phone: '603-555-0188',
      howWeConnected:
        'Won the 2024 Ideathon with a battery-diagnostics prototype. Tracked here as a business owner, not a student record.',
      tags: ['Founder', 'Student Founder'],
      organizationId: wildcat!.id,
      orgRole: 'Founder & CEO',
      status: 'active',
      isStudentFounder: 1,
      createdDaysAgo: 190,
    },
    {
      id: newId(),
      firstName: 'Daniel',
      lastName: 'Okafor',
      email: 'daniel.okafor@example.com',
      phone: '603-555-0119',
      howWeConnected: 'Co-founder alongside Priya. Handles the firmware side. Met him at the same Ideathon.',
      tags: ['Founder', 'Student Founder'],
      organizationId: wildcat!.id,
      orgRole: 'Co-founder, Engineering',
      status: 'active',
      isStudentFounder: 1,
      createdDaysAgo: 190,
    },
    {
      id: newId(),
      firstName: 'Helen',
      lastName: 'Brackett',
      email: 'helen.brackett@example.com',
      phone: '603-555-0203',
      howWeConnected:
        'Cold outreach from her side after reading about the speaker series. Runs corporate giving at her firm and offered sponsorship.',
      tags: ['Sponsor', 'Partner'],
      organizationId: alliance!.id,
      orgRole: 'Director of Programs',
      status: 'active',
      isStudentFounder: 0,
      createdDaysAgo: 95,
    },
    {
      id: newId(),
      firstName: 'Tomas',
      lastName: 'Reyes',
      email: 'tomas.reyes@example.com',
      phone: null,
      howWeConnected: 'President of the Entrepreneurs Club. Bella met him at the fall involvement fair.',
      tags: ['Student', 'Partner'],
      organizationId: club!.id,
      orgRole: 'Club President',
      status: 'active',
      isStudentFounder: 0,
      createdDaysAgo: 60,
    },
    {
      id: newId(),
      firstName: 'Angela',
      lastName: 'Fontaine',
      email: 'angela.fontaine@example.com',
      phone: '603-555-0177',
      howWeConnected: 'Alumna, class of 2011. Reached out when she moved back to the Seacoast and wants to mentor.',
      tags: ['Alumni', 'Mentor'],
      organizationId: null,
      orgRole: null,
      status: 'active',
      isStudentFounder: 0,
      createdDaysAgo: 47,
    },
    {
      id: newId(),
      firstName: 'Robert',
      lastName: 'Kinsley',
      email: 'robert.kinsley@example.com',
      phone: '603-555-0164',
      howWeConnected:
        'Warm intro from Marcus Whitfield. Runs operations at a Rochester manufacturer that wants capstone teams.',
      tags: ['Partner'],
      organizationId: manufacturing!.id,
      orgRole: 'VP Operations',
      status: 'active',
      isStudentFounder: 0,
      createdDaysAgo: 33,
    },
    {
      id: newId(),
      firstName: 'Sofia',
      lastName: 'Marchetti',
      email: 'sofia.marchetti@example.com',
      phone: '603-555-0150',
      howWeConnected: 'Met at the NH Tech Alliance mixer. Early-stage investor looking at pre-seed hardware.',
      tags: ['Investor'],
      organizationId: angels!.id,
      orgRole: 'Angel Investor',
      status: 'active',
      isStudentFounder: 0,
      createdDaysAgo: 21,
    },
    {
      id: newId(),
      firstName: 'Grace',
      lastName: 'Lindqvist',
      email: 'grace.lindqvist@example.com',
      phone: null,
      howWeConnected:
        'Former workshop attendee who has since graduated. Keeping the record for the alumni mentor bench.',
      tags: ['Alumni'],
      organizationId: null,
      orgRole: null,
      status: 'past',
      isStudentFounder: 0,
      createdDaysAgo: 300,
    },
    {
      id: newId(),
      firstName: 'Owen',
      lastName: 'Duplessis',
      email: 'owen.duplessis@example.com',
      phone: '603-555-0198',
      howWeConnected:
        'Referred by Angela Fontaine. Wants to run a finance-for-founders workshop but is on sabbatical until spring.',
      tags: ['Mentor'],
      organizationId: null,
      orgRole: null,
      status: 'on_hold',
      isStudentFounder: 0,
      createdDaysAgo: 12,
    },
  ];

  for (const contact of contacts) {
    const createdAt = isoDaysAgo(contact.createdDaysAgo, 9, 15);
    await db.run(
      `INSERT INTO contacts
         (id, customer_id, first_name, last_name, email, phone, how_we_connected, tags,
          organization_id, org_role, status, is_student_founder,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contact.id,
        customerId,
        contact.firstName,
        contact.lastName,
        contact.email,
        contact.phone,
        contact.howWeConnected,
        JSON.stringify(contact.tags),
        contact.organizationId,
        contact.orgRole,
        contact.status,
        contact.isStudentFounder,
        createdAt,
        createdAt,
        lisa,
        lisa,
      ],
    );
    if (contact.organizationId) {
      await db.run(
        `INSERT INTO contact_organizations (id, customer_id, contact_id, organization_id, org_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), customerId, contact.id, contact.organizationId, contact.orgRole, createdAt],
      );
    }
  }

  const byName = (first: string) => contacts.find((c) => c.firstName === first)!.id;

  // Marcus advises a second organization too -- demonstrates multi-org membership.
  await db.run(
    `INSERT INTO contact_organizations (id, customer_id, contact_id, organization_id, org_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), customerId, byName('Marcus'), alliance!.id, 'Advisory Board', nowIso()],
  );

  const notes = [
    {
      contactId: byName('Marcus'),
      noteType: 'meeting',
      daysAgo: 4,
      author: lisa,
      tags: ['Follow up', 'Interested'],
      content:
        'Coffee at Madbury Commons. He will judge the spring pitch night and can bring one more angel. Asked whether we can send a one-pager on the Wildcat Ventures team before he commits capital.',
    },
    {
      contactId: byName('Marcus'),
      noteType: 'email',
      daysAgo: 38,
      author: lisa,
      tags: [],
      content: 'Sent the fall program recap. He replied same day offering to introduce us to two portfolio founders.',
    },
    {
      contactId: byName('Priya'),
      noteType: 'meeting',
      daysAgo: 2,
      author: bella,
      tags: ['Needs'],
      content:
        'Prototype review. Battery pack is failing thermal testing at 40C. She needs an intro to a materials engineer and shop time before the March demo.',
    },
    {
      contactId: byName('Priya'),
      noteType: 'workshop',
      daysAgo: 26,
      author: bella,
      tags: [],
      content: 'Attended the pricing workshop. Stayed after to ask about licensing versus direct sales.',
    },
    {
      contactId: byName('Daniel'),
      noteType: 'call',
      daysAgo: 9,
      author: bella,
      tags: ['Follow up'],
      content:
        'Firmware milestone slipped two weeks. He is carrying a heavy course load; suggested we scope the demo down rather than miss it entirely.',
    },
    {
      contactId: byName('Helen'),
      noteType: 'call',
      daysAgo: 6,
      author: lisa,
      tags: ['Interested', 'Follow up'],
      content:
        'Sponsorship conversation. Their giving committee meets at the end of the month. She needs a budget breakdown at three levels to bring forward.',
    },
    {
      contactId: byName('Helen'),
      noteType: 'email',
      daysAgo: 60,
      author: lisa,
      tags: [],
      content: 'First reply to her outreach. Set up the intro call and sent the speaker series overview.',
    },
    {
      contactId: byName('Tomas'),
      noteType: 'meeting',
      daysAgo: 11,
      author: bella,
      tags: ['Ideas'],
      content:
        'Planned the joint spring calendar. Club wants a founder panel in February; we supply two alumni speakers and the room.',
    },
    {
      contactId: byName('Angela'),
      noteType: 'referral',
      daysAgo: 14,
      author: lisa,
      tags: ['Follow up'],
      content: 'She referred Owen Duplessis for a finance workshop. Also volunteered for the mentor bench starting next term.',
    },
    {
      contactId: byName('Robert'),
      noteType: 'meeting',
      daysAgo: 19,
      author: lisa,
      tags: ['Needs', 'Interested'],
      content:
        'Site visit in Rochester. Wants two capstone teams in the fall and floated funding an internship track. Waiting on their budget cycle in April.',
    },
    {
      contactId: byName('Sofia'),
      noteType: 'meeting',
      daysAgo: 16,
      author: lisa,
      tags: ['Interested'],
      content:
        'Coffee after the Alliance mixer. Actively looking at pre-seed hardware in the Seacoast. Asked to be told about Wildcat Ventures when they raise.',
    },
    {
      contactId: byName('Owen'),
      noteType: 'email',
      daysAgo: 10,
      author: bella,
      tags: [],
      content: 'Intro email after the referral. On sabbatical until spring; asked us to circle back in March.',
    },
    {
      contactId: byName('Grace'),
      noteType: 'other',
      daysAgo: 210,
      author: lisa,
      tags: [],
      content: 'Graduated and moved to Boston. Happy to be contacted for alumni panels.',
    },
    {
      contactId: byName('Tomas'),
      noteType: 'email',
      daysAgo: 30,
      author: bella,
      tags: [],
      content: 'Sent the room booking process and the AV checklist for club events.',
    },
  ];

  for (const note of notes) {
    const createdAt = isoDaysAgo(note.daysAgo);
    const noteId = newId();
    await db.run(
      `INSERT INTO notes
         (id, customer_id, contact_id, note_type, content, tags, source,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      [
        noteId,
        customerId,
        note.contactId,
        note.noteType,
        note.content,
        JSON.stringify(note.tags),
        createdAt,
        createdAt,
        note.author,
        note.author,
      ],
    );
    await db.run(
      `INSERT INTO note_contacts (id, customer_id, note_id, contact_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      [newId(), customerId, noteId, note.contactId, createdAt],
    );
  }

  // A single debrief filed under both Wildcat co-founders -- demonstrates a
  // multi-contact note.
  {
    const createdAt = isoDaysAgo(3);
    const noteId = newId();
    await db.run(
      `INSERT INTO notes
         (id, customer_id, contact_id, note_type, content, tags, source,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      [
        noteId,
        customerId,
        byName('Priya'),
        'meeting',
        'Joint check-in with both Wildcat Ventures founders on the March demo plan and next steps. Filed under both of them.',
        JSON.stringify(['Follow up', 'Needs']),
        createdAt,
        createdAt,
        bella,
        bella,
      ],
    );
    for (const contactId of [byName('Priya'), byName('Daniel')]) {
      await db.run(
        `INSERT INTO note_contacts (id, customer_id, note_id, contact_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        [newId(), customerId, noteId, contactId, createdAt],
      );
    }
  }

  const today = todayDate();
  const tasks = [
    {
      title: 'Send Marcus the Wildcat Ventures one-pager',
      dueDate: addDaysToDate(today, -3),
      contactId: byName('Marcus'),
      assignedTo: lisa,
      status: 'open',
      priority: 'high',
      recurrence: 'none',
      contextNotes: 'He asked for this at coffee. Blocking his decision on judging and a possible check.',
    },
    {
      title: 'Intro Priya to a materials engineer',
      dueDate: addDaysToDate(today, -1),
      contactId: byName('Priya'),
      assignedTo: bella,
      status: 'in_progress',
      priority: 'high',
      recurrence: 'none',
      contextNotes: 'Thermal failure at 40C. Ask Marcus or the Alliance mentor bench.',
    },
    {
      title: 'Send Helen the three-tier sponsorship budget',
      dueDate: addDaysToDate(today, 2),
      contactId: byName('Helen'),
      assignedTo: lisa,
      status: 'open',
      priority: 'high',
      recurrence: 'none',
      contextNotes: 'Their giving committee meets end of month. Must land before then.',
    },
    {
      title: 'Confirm February founder panel speakers with Tomas',
      dueDate: addDaysToDate(today, 5),
      contactId: byName('Tomas'),
      assignedTo: bella,
      status: 'open',
      priority: 'medium',
      recurrence: 'none',
      contextNotes: 'Two alumni speakers plus the room booking.',
    },
    {
      title: 'Follow up with Robert on the capstone budget cycle',
      dueDate: addDaysToDate(today, 6),
      contactId: byName('Robert'),
      assignedTo: lisa,
      status: 'open',
      priority: 'medium',
      recurrence: 'none',
      contextNotes: 'Their budget opens in April; check in before it closes.',
    },
    {
      title: 'Weekly follow-up review',
      dueDate: addDaysToDate(today, 1),
      contactId: null,
      assignedTo: lisa,
      status: 'open',
      priority: 'low',
      recurrence: 'weekly',
      contextNotes: 'Standing pass over every open follow-up and anything gone quiet for 30 days.',
    },
    {
      title: 'Circle back with Owen in March',
      dueDate: addDaysToDate(today, 24),
      contactId: byName('Owen'),
      assignedTo: bella,
      status: 'open',
      priority: 'low',
      recurrence: 'none',
      contextNotes: 'On sabbatical until spring.',
    },
    {
      title: 'Thank Angela for the Owen referral',
      dueDate: addDaysToDate(today, -8),
      contactId: byName('Angela'),
      assignedTo: lisa,
      status: 'complete',
      priority: 'low',
      recurrence: 'none',
      contextNotes: null,
    },
    {
      title: 'Add Sofia to the pitch night invite list',
      dueDate: addDaysToDate(today, -5),
      contactId: byName('Sofia'),
      assignedTo: bella,
      status: 'complete',
      priority: 'medium',
      recurrence: 'none',
      contextNotes: null,
    },
  ];

  for (const task of tasks) {
    const createdAt = isoDaysAgo(20, 11, 0);
    await db.run(
      `INSERT INTO tasks
         (id, customer_id, title, due_date, contact_id, assigned_to, status, priority,
          reminder_enabled, reminder_offset, context_notes, recurrence, completed_at,
          created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'one_day', ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        customerId,
        task.title,
        task.dueDate,
        task.contactId,
        task.assignedTo,
        task.status,
        task.priority,
        task.priority === 'high' ? 1 : 0,
        task.contextNotes,
        task.recurrence,
        task.status === 'complete' ? isoDaysAgo(4, 16, 0) : null,
        createdAt,
        createdAt,
        lisa,
        lisa,
      ],
    );
  }

  const events = [
    {
      id: newId(),
      name: 'Founder Office Hours',
      startsAt: isoDaysAhead(3, 15, 0),
      endsAt: isoDaysAhead(3, 17, 0),
      eventType: 'one_on_one',
      location: 'Madbury Commons',
      description: 'Drop-in slots for active founders.',
      followupNotes: null as string | null,
      attendees: [byName('Priya'), byName('Daniel')],
    },
    {
      id: newId(),
      name: 'Spring Speaker Series: Building in New Hampshire',
      startsAt: isoDaysAhead(12, 18, 0),
      endsAt: isoDaysAhead(12, 20, 0),
      eventType: 'speaker_series',
      location: 'Paul College, Room 165',
      description: 'Co-hosted with the NH Tech Alliance.',
      followupNotes: null,
      attendees: [byName('Helen'), byName('Marcus'), byName('Tomas')],
    },
    {
      id: newId(),
      name: 'Ideathon Kickoff',
      startsAt: isoDaysAhead(21, 9, 0),
      endsAt: isoDaysAhead(21, 16, 0),
      eventType: 'ideathon',
      location: 'Madbury Commons',
      description: 'Team formation and problem framing.',
      followupNotes: null,
      attendees: [byName('Tomas')],
    },
    {
      id: newId(),
      name: 'Pricing for Early-Stage Products',
      startsAt: isoDaysAgo(26, 17, 0),
      endsAt: isoDaysAgo(26, 19, 0),
      eventType: 'workshop',
      location: 'Madbury Commons',
      description: 'Hands-on pricing workshop.',
      followupNotes:
        'Fourteen attendees. Strong interest in a follow-on session on licensing. Priya stayed after with questions.',
      attendees: [byName('Priya'), byName('Sofia')],
    },
  ];

  for (const event of events) {
    await db.run(
      `INSERT INTO events
         (id, customer_id, name, starts_at, ends_at, event_type, location, description,
          followup_notes, created_at, updated_at, created_by, last_edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        customerId,
        event.name,
        event.startsAt,
        event.endsAt,
        event.eventType,
        event.location,
        event.description,
        event.followupNotes,
        timestamp,
        timestamp,
        lisa,
        lisa,
      ],
    );

    for (const contactId of event.attendees) {
      await db.run(
        `INSERT INTO event_attendees (id, customer_id, event_id, contact_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [newId(), customerId, event.id, contactId, timestamp],
      );
    }
  }

  await db.run(
    `INSERT INTO calendar_sync_metadata (customer_id, sync_status, events_pulled, events_pushed)
     VALUES (?, 'never', 0, 0)`,
    [customerId],
  );

  return { customerId };
}

async function main(): Promise<void> {
  const fakeD1 = createFakeD1(dbPath);
  const db = createD1Db(fakeD1 as never);
  const { customerId } = await seedDemoData(db, CUSTOMER_SLUG, CUSTOMER_NAME);
  fakeD1._close();

  console.log('Sample data loaded.');
  console.log(`  customer: ${CUSTOMER_NAME} (${customerId})`);
  console.log(`  sign in:  lisa@unh.edu / ${DEMO_PASSWORD}   (owner)`);
  console.log(`            bella@unh.edu / ${DEMO_PASSWORD}  (editor)`);
}

const isEntrypoint =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
}
