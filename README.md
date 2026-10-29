# UNH ECenter CRM

A lightweight, multi-tenant CRM built for the UNH Entrepreneurship Center, replacing a
Salesforce-based option that costs more than the ECenter needs.

It is built around the problem Lisa Keslar described in the requirements questionnaire:

> "I'm missing follow-ups. I can't track relationships."

So the two things the app refuses to let you lose are **relationship history** and **follow-ups**:

- Every contact carries a **How we connected** story -- who introduced them, what they need, what
  they can offer -- and it is fully searchable.
- Every interaction is a **note that the server timestamps on save**. There is no date field to type
  into, anywhere, by design.
- Every follow-up has an owner and a due date, and **overdue is derived**, never stored, so it can
  never drift out of date.

Runs as a **single Cloudflare Worker** -- API and the built React client served from one place, no
separate backend host, no database server to run.

---

## Contents

- [Quick start](#quick-start)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [How the Worker is put together](#how-the-worker-is-put-together)
- [Environment and secrets](#environment-and-secrets)
- [Database](#database)
- [What is in each tab](#what-is-in-each-tab)
- [Community portal](#community-portal)
- [Security and compliance](#security-and-compliance)
- [Multi-tenancy](#multi-tenancy)
- [Document storage (R2)](#document-storage-r2)
- [Outlook calendar sync](#outlook-calendar-sync)
- [Testing](#testing)
- [Deployment](#deployment)
- [Design decisions](#design-decisions)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Requires **Node.js 22.18 or newer** (24 recommended) and a **Cloudflare account** for deployment
(local development needs neither Postgres, Python, nor any Cloudflare credentials).

```bash
npm install
cp .env.example .env      # then set JWT_SECRET and ENCRYPTION_KEY (or leave blank for dev fallbacks)
npm run build              # builds the client once, so the dev server has something to serve
npm run migrate            # create the local dev database
npm run seed                # load the demo tenant and sample data
npm run dev                  # Worker dev server on :8788, Vite on :5173
```

Open <http://localhost:5173> and sign in. Staff land on the CRM at `/admin`; community members land on
the community feed at `/`.

| Email                        | Password  | Role                                  |
| ---------------------------- | --------- | ------------------------------------- |
| `lisa@unh.edu`               | `test123` | Owner (staff)                         |
| `bella@unh.edu`              | `test123` | Editor (staff)                        |
| `maya.chen@example.org`      | `test123` | Community student (local demo only)   |
| `priya.raghavan@example.com` | `test123` | Community mentor, linked to a contact |
| `jordan.lee@example.org`     | `test123` | Community mentor (local demo only)    |

There is no email service locally: verification and password-reset links are printed to the
`npm run dev:api` console (see [Email verification and password reset](#email-verification-and-password-reset)).

(You can also open <http://localhost:8788> directly -- the Worker dev server serves the built
client itself, the same way production does.)

Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Scripts

| Command             | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `npm run dev`        | Worker dev server (`:8788`) + Vite (`:5173`), together, hot reload  |
| `npm run dev:api`    | Worker dev server only                                              |
| `npm run dev:web`    | Vite only (proxies `/api` to `:8788`)                                |
| `npm run build`      | Production build of the client into `client/dist`                    |
| `npm run migrate`    | Apply `worker/src/db/schema.sql` to the **local** dev database        |
| `npm run seed`       | Reload the demo tenant into the **local** dev database                 |
| `npm run reset`      | Empty every table in the **local** dev database                       |
| `npm test`           | End-to-end API test suites (CRM + community portal), no server needed   |
| `npm run typecheck`  | TypeScript check for the Worker (both its runtime and Node tsconfigs) and the client |
| `npm run deploy`     | `wrangler deploy` -- ships the Worker + client to Cloudflare             |

`migrate`/`seed`/`reset` only ever touch the **local** SQLite-backed dev database
(`worker/data/dev.db`) -- see [Deployment](#deployment) for seeding/migrating real D1.

---

## Tech stack

| Layer         | Choice                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| Frontend      | React 18 + TypeScript, Vite, Tailwind CSS, React Router                            |
| Backend       | A single Cloudflare Worker, TypeScript, hand-rolled router (no framework)          |
| Database      | Cloudflare D1 (SQLite-compatible), locally shimmed with `node:sqlite`               |
| Document storage | Cloudflare R2, via the native binding (no S3 SDK, no access keys)                |
| Auth          | DB-backed sessions (revocable) + PBKDF2 password hashing, both via Web Crypto        |
| Calendar      | Microsoft Graph REST API (Outlook), two-way sync, plain `fetch`                       |

Everything runs in the Workers runtime -- no Node-only APIs in `worker/src/`, no native modules, no
long-running server process. Local development runs the exact same code against
Node-backed shims for the D1/R2 bindings (see
[How the Worker is put together](#how-the-worker-is-put-together)) because `wrangler dev`'s bundled
`workerd` has no Windows-ARM64 build; Cloudflare's own build servers run `wrangler deploy` for real.

---

## Project layout

```
unh-ecenter-crm/
├── wrangler.toml              Worker config: D1/R2 bindings, static assets, vars
├── worker/
│   ├── src/
│   │   ├── index.ts            The Worker: router mount, CORS, auth, static-asset fallthrough
│   │   ├── env.ts              Typed bindings + config, loaded fresh per request
│   │   ├── router.ts            Minimal method+path router with :param segments
│   │   ├── records.ts           Row -> API shape mappers, enum definitions
│   │   ├── db/
│   │   │   ├── schema.sql        The canonical schema (SQLite-dialect; D1-compatible as-is)
│   │   │   ├── driver.ts          The `Db` interface (all/get/run/batch -- no generic tx(), see below)
│   │   │   └── d1.ts               D1Database-backed implementation
│   │   ├── lib/                    encoding, password (PBKDF2), crypto (AES-GCM secrets-at-rest),
│   │   │                            session (DB-backed, revocable), signedToken (short-lived HMAC
│   │   │                            proofs for downloads/OAuth state), validate, csv, audit, time
│   │   ├── middleware/auth.ts        requireAuth/requireEditor/requireOwner
│   │   ├── routes/                    One module per resource, each exports `register(router)`
│   │   └── services/                   storage.ts (R2), graph.ts + calendarSync.ts (Outlook)
│   ├── scripts/                         migrate/seed/reset -- target the LOCAL dev database only
│   ├── dev/
│   │   ├── dev-server.mjs                Runs the REAL worker/src/index.ts against Node shims
│   │   ├── fakeD1.mjs                     D1Database surface, backed by node:sqlite
│   │   ├── fakeR2.mjs                      R2Bucket surface, backed by the filesystem
│   │   └── fakeAssets.mjs                   Serves client/dist, with SPA fallback
│   └── test/api.test.ts                      End-to-end tests, call the Worker's fetch() directly
└── client/
    └── src/
        ├── components/           AppShell, ui primitives, overlays, forms
        ├── pages/                 One page per tab
        ├── state/                  Auth and toast contexts
        └── lib/                     API client, types, formatting, hooks
```

---

## How the Worker is put together

Cloudflare Workers are not Node: no `app.listen()`, no persistent TCP connections, no filesystem,
one V8 isolate per request rather than a long-running process. Three things follow from that:

**One `Db` interface, two implementations.** `worker/src/db/driver.ts` defines `all/get/run/batch`;
`db/d1.ts` implements it against a real D1 binding, and `dev/fakeD1.mjs` implements the *same*
`D1Database` surface (`prepare().bind().all()/.first()/.run()`, `.batch()`) with `node:sqlite`. Route
code only ever imports the `Db` type, so it is identical in dev and production -- only what gets
passed in as `env.DB` differs. D1 has no interactive `BEGIN...COMMIT` the way a persistent
connection would; where a handler needs true atomicity (a soft-delete cascade, scheduling a
recurring task's next occurrence), it does all its reads and branching in plain JS first, then hands
the resulting writes to `db.batch()` in one shot.

**Sessions live in the database, not in a signed token.** A bearer token is an opaque random string;
only its SHA-256 hash is stored (`sessions` table), and verifying one joins straight through to
`users`. That means removing a team member or signing out ends access on their very next request --
a stateless JWT cannot do that without a separate deny-list. Two genuinely stateless, short-lived
proofs still use small HMAC-signed tokens (`lib/signedToken.ts`): a document download link, and the
`state` parameter carried through the Microsoft OAuth redirect.

**No Node crypto, no bcrypt.** Password hashing is PBKDF2-SHA256 and secrets-at-rest are AES-256-GCM,
both via the Web Crypto API (`crypto.subtle`), which is standard across the Workers runtime with no
native module or Node compatibility flag needed for it specifically.

**Local dev runs the real Worker.** `worker/dev/dev-server.mjs` imports `worker/src/index.ts`
directly and serves it over a plain Node HTTP server, with `env.DB` / `env.DOCS` / `env.ASSETS`
pointed at the `fakeD1`/`fakeR2`/`fakeAssets` shims instead of real bindings. Because Node 24 strips
TypeScript types natively, this needs no build step and no `tsx`/`ts-node`. The test suite
(`worker/test/api.test.ts`) goes one step further and calls `worker.fetch(request, env)` in-process,
with no HTTP server at all.

---

## Environment and secrets

Local development reads `.env` (see `.env.example`) -- but **only for the local dev server**. It
configures nothing about the deployed Worker.

Production configuration is split two ways:

- **Non-secret config** lives in `wrangler.toml`'s `[vars]` block, committed to the repo (customer
  defaults, TTLs, upload limits).
- **Secrets** (`JWT_SECRET`, `ENCRYPTION_KEY`) are set with `wrangler secret put NAME` and never
  appear in the repo or in `wrangler.toml`.

The Microsoft app-registration client ID/secret are **not** a Worker secret at all -- they are
entered per-tenant in the app's own Settings screen and stored encrypted in D1, so a multi-customer
deployment of this codebase can hold a different Microsoft app registration per customer.

---

## Database

`worker/src/db/schema.sql` is the single source of truth. It targets a SQLite dialect that D1 (and
the local `node:sqlite` shim) both speak natively -- no translation layer needed:

- Primary keys are application-generated UUID `TEXT`.
- Timestamps are ISO-8601 UTC strings and dates are `YYYY-MM-DD`, both in `TEXT`; they sort and
  compare correctly with ordinary SQL operators.
- Booleans are `INTEGER` 0/1.
- Tag lists are JSON in a `TEXT` column, parsed in the mappers.

**Tables:** `customers`, `users`, `sessions`, `user_preferences`, `organizations`, `contacts`,
`contact_organizations`, `notes`, `note_contacts`, `tasks`, `events`, `event_attendees`, `documents`,
`audit_logs`, `microsoft_oauth_credentials`, `calendar_sync_metadata`, `event_external_mapping`, and
for the community portal `community_accounts`, `community_profiles`, `interest_tags`,
`community_profile_tags`, `auth_tokens`, `posts`, `conversations`, `conversation_members`, `messages`,
`rate_limit_events`.

A contact can belong to several organizations (`contact_organizations`) and a note can be filed under
several contacts or none at all (`note_contacts`); in both cases the junction table is the source of
truth and the `contacts.organization_id` / `notes.contact_id` columns mirror the **primary** link for
headline display, sorting and search. Documents can be attached to a contact, an organization **or a
note** (`documents.note_id`).

Every business table has `created_at`, `updated_at`, `deleted_at`, `created_by` and `last_edited_by`.
**Nothing is ever hard-deleted**: deletes set `deleted_at`, and every read filters it out. Deleting a
contact cascades the soft delete to their notes (only notes left with no other contact) and tasks (one
atomic `db.batch()`); deleting an organization keeps its people and just removes the membership.

### Migrations

`schema.sql` is the whole schema for a **fresh** database. Changes to an **existing** production D1
database ship as dated files in `worker/src/db/migrations/`, applied once, before deploying the
matching Worker build, e.g.:

```bash
npx wrangler d1 execute ecenter-crm --remote \
  --file=./worker/src/db/migrations/2026-09-28-multi-links-and-attachments.sql
```

That migration adds the `contact_organizations` and `note_contacts` junctions, the `documents.note_id`
column, backfills both junctions from the existing primary links, and rebuilds `notes` so `contact_id`
becomes nullable (notes with no contact). It is not needed for a database created from `schema.sql`.

`2026-10-12-community-portal.sql` adds the community portal. It is **purely additive**: two
defaulted columns (`users.email_verified_at`, and `events.community_visible`, which defaults to
hidden) plus new tables and indexes. No existing row is rewritten. Apply it once, before deploying
the matching build (try it on a copy or preview database first):

```bash
npx wrangler d1 execute ecenter-crm --remote \
  --file=./worker/src/db/migrations/2026-10-12-community-portal.sql
```

`2026-10-20-community-v2.sql` adds member posting with approval, comments, likes, @mentions, RSVPs,
public resumes and notification emails. It is also purely additive: new columns with safe defaults
(existing posts stay staff posts, nobody's resume becomes public) plus new tables. Apply it after the
first one and **before** deploying the matching build:

```bash
npx wrangler d1 execute ecenter-crm --remote \
  --file=./worker/src/db/migrations/2026-10-20-community-v2.sql
```

`2026-10-28-community-v3.sql` adds event options (21+, public attendee lists, hiding from guests),
group-only posts, blocked emails, groups, businesses and competitions. It is additive too: new
columns with safe defaults (every existing post stays visible to everyone, including guests) and new
tables. It also inserts rows only: a blocked-email entry for every member who was already removed. Apply it **before**
deploying the matching build:

```bash
npx wrangler d1 execute ecenter-crm --remote \
  --file=./worker/src/db/migrations/2026-10-28-community-v3.sql
```

Locally, `npm run migrate` adds any missing columns to an older dev database before applying
`schema.sql`, so an existing `worker/data/dev.db` upgrades in place.

---

## What is in each tab

Ordered by the priority ranking in the requirements questionnaire.

### 1. Contacts

Card view with search across name, email, tags, organization **and the relationship story**;
filters for status, tag, organization and last-interaction date range; six sort orders including
*Gone quiet longest*, which surfaces relationships that have gone cold. Each card shows the latest
note snippet and badge counts for notes, open follow-ups and documents. Bulk tagging, CSV export,
and a right slide-in detail panel that never loses your place in the list.

**Student founders** are flagged with a badge and tracked as business owners. The schema has no
student fields at all -- no student ID, major, class year or advisor -- so business-only tracking is
enforced by the data model rather than by policy.

### 2. Notes -- interaction history

A vertical timeline grouped by day, newest first (reversible). Search by keyword, contact, type,
tag, author and date range.

**The timestamp is generated on the server at insert time and is never accepted from the client.**
Editing a note's text leaves its original timestamp untouched. This is covered by a test.

### 3. Follow-ups

List view sorted by due date, priority, contact or status, with colour-coded badges (red overdue,
amber due within 7 days, green complete). Assignees, priorities, reminders and context notes.

Recurring follow-ups (weekly / bi-weekly / monthly) **schedule their next occurrence automatically
when you complete one**, and the app will not create a duplicate occurrence if you toggle twice.

### 4. Organizations

Groups multiple people under one business, club or group, each with their role. Type-coloured cards,
contact-count badges, inline linking and unlinking, and an *Our relationship* narrative.

### 5. Events

Month grid and upcoming-list views. **Linking a contact to an event writes a dated note to that
contact's timeline** -- "Attended Ideathon Kickoff on Sep 29, 2026" -- so event participation shows
up in relationship history without anyone remembering to log it. Unlinking keeps the note, because
it is a record of something that happened.

### 6. Dashboard

Quick stats, a red overdue banner, this week's follow-ups, upcoming events, a per-person team
snapshot with open counts, and a merged recent-activity feed. All of it in one API request.

### Settings

Team management with roles, preferences, CSV exports, Outlook connection, document configuration,
and a readable audit log.

---

## Community portal

The community portal is a second interface on the same Worker, database, sessions and R2 bucket.
Students and mentors sign up, read ECenter news, find mentors and message each other. The CRM moved
under `/admin`.

### Routes

| Path | Who | What |
| --- | --- | --- |
| `/` | Members, staff, guests | Community feed (signed-out visitors see the join / sign-in page, with "Continue as a guest") |
| `/posts/:id`, `/events/:id` | Members, staff, guests | A post or event (guests get a read-only view) |
| `/competitions`, `/competitions/:id` | Members, staff, guests | ECenter competitions and their deadlines |
| `/groups`, `/groups/:slug` | Members, staff | Topic groups, group feeds, join requests and moderation |
| `/businesses`, `/businesses/:id` | Members, staff | Member business profiles: logo, about, hiring/networking, photos |
| `/signup` | Anyone | Two-step onboarding: account and role, then an optional "about you" step |
| `/mentorship` | Members, staff | Recommended mentors; browse, search and filter all mentors |
| `/network` | Members, staff | Member directory with type and topic filters |
| `/messages` | Active community identity | One-to-one messaging |
| `/profile` | Signed in | Your own profile, photo, private resume, email and password |
| `/members/:id` | Members, staff | A member's public profile |
| `/login`, `/verify-email`, `/forgot-password`, `/reset-password` | Anyone | Sign-in and account flows |
| `/admin/*` | Staff only | The CRM: Dashboard, Contacts, Notes, Follow-ups, Organizations, Events, **Posts**, **Members**, **Groups**, **Competitions**, Settings |

The old CRM paths (`/contacts`, `/notes`, `/tasks`, `/organizations`, `/events`, `/settings`)
redirect to their `/admin/...` equivalents and keep any query string. The CRM's API paths are
unchanged. New staff APIs live under `/api/admin/*` and community APIs under `/api/community/*`.

### Permissions

- **Administrative roles** are unchanged: `owner`, `editor` and `viewer` on `users.role`.
- **Community-only logins** have `users.role = 'member'`, which is **not** an administrative role.
  Student or Mentor is an *account type* on `community_accounts`, so choosing Mentor at signup grants
  nothing in the CRM.
- Every CRM route calls `requireStaff` (formerly `requireAuth`), so a member session gets **403**
  everywhere in the CRM by default. That includes CRM routes added later. Team rosters, assignee
  checks and the dashboard team count only include staff.
- Community routes use two guards. `requireCommunityViewer` (an active member, or any staff user)
  covers reading. `requireActiveCommunityMember` covers acting as a community identity, such as
  messaging.
- Staff join the community through an explicit **staff identity** (Profile, then "Create my
  community profile"), which lists them under ECenter staff in the Network. It is never linked to a
  contact and leaves CRM access exactly as it was. **No administrative route can read private
  conversations.**
- **Guests** (no account) use the read-only `/api/public/*` routes: the main feed, upcoming events
  and competitions. They see only posts for everyone that the author has not hidden from guests, and
  only CRM events marked visible to guests. Comments, attendee lists, member profiles and photos are
  never shown to guests, and member authors appear as first name and last initial.
- **Posting** is off by default for students and mentors. Staff grant "post with approval" or "post
  without approval" per person in Admin > Members, where they can also grant **"Can create groups"**.
- **Blocked emails**: removing (deactivating) a member blocks their email from signing up or being
  used in an email change. Settings > Blocked users lists them; unblocking (or reactivating the
  member) lifts the block and restores the account.
- Staff switch between the interfaces from the avatar menu ("Switch to community portal" /
  "Switch to admin CRM").

### Data separation

| Data | Tables | Visible to |
| --- | --- | --- |
| Public profile: name, bio, LinkedIn, photo, major/year, role/company, scheduling link, topics | `community_profiles`, `community_profile_tags` | Signed-in members (allow-listed in `publicMemberOut`) |
| Private member data: sign-in email, account state, resume | `users`, `community_accounts` | The member and staff |
| Staff-only CRM data: contacts, notes, follow-ups, internal tags, organizations | Existing CRM tables | Staff only |

Community matching topics (`interest_tags`) are a separate shared public taxonomy, created per
tenant on first use. Entrepreneurship, Marketing, Technology, Product development, Finance,
Fundraising, Design, Career development and a few others. They are never mixed with the CRM's
internal contact tags.

### Onboarding and CRM linking

1. **Step 1:** Student or Mentor, name, email and password. This creates a *pending* account, signs
   the person in and emails a verification link. Re-submitting the same email and password while the
   account is still pending **resumes** that signup instead of failing or duplicating it.
2. **Step 2:** everything is optional: bio, LinkedIn, photo, resume, topics, major and year or role
   and company, and a mentor's scheduling link. "Skip for now" is always available.
3. The account becomes **active** once the email is verified *and* onboarding is finished, in
   either order.

Linking only uses a **verified** email, normalised by trimming and lowercasing (no provider-specific
rewriting):

- exactly one matching contact: link it;
- no match: create one contact (first name, last name, email and a one-line "how we connected");
- several matches: flag it **Needs review** in Admin > Members. Nothing is chosen or merged
  automatically.

The system tag **"Created Account"** is added when the link is made. Every step is idempotent:

- A new contact's id is derived from the user id and inserted with `INSERT OR IGNORE`.
- The link only applies from the expected state.
- A partial unique index stops one contact from being linked to two accounts.
- The tag is added by a single conditional `json_insert`.

If linking fails part-way, it stays `pending`. It is retried on the next `/api/auth/me`, or when
staff click "Run matching now".

**Field ownership.** Signup and profile edits never write an existing contact's fields.

- **Staff-managed:** the contact's name, email, phone, status, relationship story, organizations,
  notes, follow-ups, documents and internal tags (Student, Alumni, Mentor...).
- **Member-managed:** the public profile, which staff see read-only in Admin > Members.
- **System-managed:** "Created Account". Staff cannot add or remove it through the contact form or
  bulk tagging; it is present exactly while a contact is linked.

Contacts show the account status (active, pending or deactivated) as a badge, and the contact
filters include "Community account".

**Email changes** require the current password and a click on a link sent to the *new* address. The
existing contact link is kept as it is. If the sign-in email then differs from the contact's email,
Admin > Members says so rather than changing either one.

### Feed, mentorship and messaging

- **Posts** (Admin > Posts): owners and editors create, edit, publish, unpublish and archive posts;
  viewers can read them. A post has a title, a plain-text body, an optional image (private R2,
  signed URLs), an optional link, and optionally a community-visible event. The feed and
  `GET /api/community/posts/:id` only return `published` posts, and an image link stops working when
  its post is unpublished. The feed is keyset-paginated, newest first.
- **Events** reach the portal only when staff tick "Show in the community portal"
  (`community_visible`). Only the name, time and location are exposed.
- **Recommendations** are deterministic (`services/matching.ts`):
  - A student's "help with" topics count double and their interests count once. Both are matched
    against everything a mentor lists.
  - Ties break on name, then id.
  - Every result carries a reason, e.g. "Can help with fundraising. Also matches your interests in
    marketing."
  - With no topics nothing is claimed as a match, though browsing still works.
  - Deactivated mentors are excluded.
- **Meetings:** a mentor with a valid https scheduling link shows **Book a meeting**, which opens
  their page in a new tab. Otherwise **Request a meeting** opens Messages with an editable request
  labelled "Meeting request". Nothing ever says a meeting is booked.
- **Messages** are stored in D1.
  - Only participants can open a conversation; anyone else gets a 404.
  - Bodies are capped at 4,000 characters and rendered as plain text.
  - Sends are idempotent through a client key.
  - Rate limits: 20 sends per minute and 20 new conversations per hour.
  - History is paginated, and read/unread is tracked per participant.
  - The Worker has no realtime channel, so the page polls lightly while it is visible: every 8s for
    the open thread, 20s for the list and 30s for the nav badge.

### Deactivation ("Remove from community")

Owners and editors use Admin > Members > *Remove from community*. Deactivation:

- revokes every session of a community-only login (the session lookup also refuses deactivated
  members);
- removes the member from the directory and from recommendations;
- blocks new messages to or from them.

CRM records, notes, relationships and conversation history are all preserved. The other person in a
conversation sees it labelled "No longer active". *Reactivate* restores access, and nothing is
permanently deleted. Deleting the linked **contact** (the existing soft delete) releases the link
and leaves the account alone.

### Uploads

Photos and post images (JPEG, PNG or WebP) and resumes (PDF, DOC or DOCX) are capped at 5 MB
(`COMMUNITY_UPLOAD_MAX_BYTES`).

- A file's leading bytes must match its declared type.
- Files are stored in the private bucket under `customers/{id}/community/...`.
- The Worker serves them only through short-lived HMAC-signed links, with `nosniff` and a sandbox
  CSP.
- Resume links are issued only to the owner and to staff, and staff downloads are audited.

### Email verification and password reset

Transactional email goes through **Cloudflare Email Service's `send_email` binding**, with no API
keys. This needs external setup (see [Deployment](#deployment)). Until it is configured, signup
still works but reports that the verification email could not be sent, and members cannot activate.

Password reset (`/forgot-password`) works for staff and members. It always gives the same answer,
so it cannot reveal which addresses have accounts. The link expires in an hour, and using it signs
the person out everywhere.

### Audit

New audit actions:

- `community.signup`, `community.email_verified`, `community.activated`
- `community.linked`, `community.link_conflict`, `community.link_failed`, `community.unlinked`
- `community.deactivated`, `community.reactivated`
- `community.email_change_requested`, `community.email_changed`
- `community.staff_identity_created`, `community.resume_download`
- `post.create`, `post.update`, `post.publish`, `post.unpublish`, `post.archive`
- `post.approve`, `post.reject`, `post.delete`, `post.restore`, `post.notify`, `event.notify`
- `community.permissions_changed`
- `auth.password_reset_requested`, `auth.password_reset`

### Member posts, comments and likes

- **Posting permission** is set per person in Admin > Members > *Posting*:
  - **Cannot post**: the default for students and mentors.
  - **Post with approval**: posts wait in Admin > Posts > *Awaiting approval* until an owner or
    editor approves or rejects them. A rejection can include a note, which the author sees.
  - **Post without approval**: posts publish immediately.
  - **Default** follows the account type.
- Anyone who can post gets a **Posts** item in the portal navigation (`/my-posts`), where they create,
  edit and take down their own posts. Posts can include a link, an image, and event details with an
  optional "I'll be there!" RSVP.
- With approval-required posting, **editing a published post sends it back for review**, so approved
  content cannot be swapped out quietly.
- **Comments** have one level of replies. A comment can be removed by its author, by the post's
  author, or by any staff owner/editor; staff can do this even without a community identity.
- **Likes** count once per member.
- **@mentions** work in posts and comments: type `@` to search members. The server re-checks every
  mention and turns a forged one into plain text. Mentioned members get an email once the post is
  published.
- **History.** Every edit, takedown, restore, approval and rejection keeps the previous version.
  Removed comments are kept too. Staff can review all of this in Admin > Settings > *Community
  content history* and restore taken-down posts from there.

### Events in the portal

- *Upcoming events* (the right column on desktop, a swipeable strip on phones) lists two things:
  CRM events marked "Show in the community portal", and published event posts.
- Each CRM event can have a **community description** (shown instead of the staff description) and
  **"I'll be there!" RSVPs**.
- Staff see who RSVP'd in the event panel, and in Admin > Posts for event posts.
- Event posts and CRM events have three more options: **21+** (an RSVP must confirm "I'm over 21",
  stored on the RSVP), **show the attendee list to members** (otherwise only the organiser and staff
  see it), and **hide from guests**.
- Published competitions' deadlines also appear in Upcoming events, linking to the competition.

### Groups

- Eight default groups (Entrepreneurship, Finance, Accounting, Marketing, Sales, Technology,
  Fundraising, Social Impact) are created on first use. Staff create more in Admin > Groups, and
  members with "Can create groups" create their own and become its moderator.
- Moderators edit the group, switch it between **public** (anyone joins instantly) and **private**
  (people request to join and a moderator approves; posts and members are visible to members
  only), approve or decline requests, remove members and appoint other moderators. Staff owners and
  editors moderate every group.
- A post can go to **everyone** (main feed) or **only specific groups**: then it appears only in
  those groups' feeds, never in the main feed or to guests, and "Email members" only emails those
  groups' members. Members can post only to groups they have joined.

### Businesses and competitions

- Students and mentors create up to five business profiles each: logo, tagline, about, industry,
  website, location, hiring (with details), looking to network (with what for), and up to 12
  photos. The owner and staff owners/editors can edit or remove one; it is hidden while the owner's
  account is not active.
- Staff post competitions in Admin > Competitions with any number of dated deadlines, publish,
  unpublish, archive or delete them. Members and guests see published ones.

### Notification emails

Member notification emails go through the same email binding as verification:

| Email | When | Preference |
| --- | --- | --- |
| New direct message | The message is still unread 2 minutes later. One email per unread streak. | Messages |
| @mention | The post or comment that mentions you is published | Mentions |
| Announcement | Staff click **Email members** on a published post or community event | Announcements |

Every email has a one-click unsubscribe link (with `List-Unsubscribe` headers). Members can also
change these preferences on their profile. Signup step 2 asks about announcement emails, ticked by
default.

**How emails are sent.** Requests only add emails to a queue (the `email_outbox` table). A **cron
trigger** (`[triggers] crons = ["* * * * *"]` in `wrangler.toml`) sends up to 25 a minute.

- Before sending, the cron job re-checks each email: the message is still unread, the post is still
  published, and the member is still active and opted in.
- Retries and double clicks never send twice, and failures are retried with backoff.
- Emails need absolute links, so **`APP_URL` must be set** in `wrangler.toml`.
- Locally, the dev server runs the same job every 30 seconds and prints emails to its console.

### Resumes

Resumes stay private by default. A member can tick *Show my resume on my profile*; their profile then
shows a **View resume** button to other signed-in members, behind the same short-lived signed links.

---

## Security and compliance

- **Passwords** are PBKDF2-SHA256 hashed (100,000 iterations) via Web Crypto. Login returns the same
  generic message whether the email exists or not, so the endpoint cannot be used to enumerate
  accounts.
- **Sessions** are DB-backed and revocable (see [How the Worker is put together](#how-the-worker-is-put-together)),
  verified via a SHA-256 hash lookup rather than storing the raw token.
- **Secrets at rest** -- Microsoft client secrets, access tokens and refresh tokens -- are
  AES-256-GCM encrypted before they touch the database.
- **Roles**: `owner` (full access plus team management), `editor` (everyday work), `viewer`
  (read-only). Enforced server-side on every mutating route.
- **Uploads** are restricted to an allow-list of MIME types *and* matching extensions, so an
  executable renamed `.pdf` is rejected. Filenames are reduced to a safe character allow-list.
- **Downloads** go through short-lived HMAC-signed URLs (15 minutes by default) and are audited.
- **CSV exports** neutralise spreadsheet formula injection by prefixing cells that begin with
  `=`, `+`, `-` or `@`.
- **Audit log** records sign-ins, failed sign-ins, document uploads/downloads/deletions, calendar
  connections and syncs, exports, user administration, and every record deletion, with IP address
  and user agent.
- **GDPR posture**: soft deletes throughout, full CSV data export, and an audit trail.

---

## Multi-tenancy

Although v1 serves one customer, the data model is multi-tenant from the start so the same Worker
can be deployed for the next one:

- Every business table carries `customer_id`.
- Every session carries the tenant id, and `auth(ctx).customerId` is applied to **every** query.
- Documents are namespaced per tenant in R2: `customers/{customerId}/documents/...`.
- Microsoft OAuth credentials are stored and encrypted per tenant, so different customers can each
  register their own Azure app.

`npm run seed` re-seeds by deleting only that customer's rows, which exercises the scoping.

---

## Document storage (R2)

```
Bucket:      ecenter-crm-documents
Path:        customers/{customerId}/documents/{timestamp}-{filename}
Binding:     DOCS (native R2 binding, no S3 SDK, no access keys)
Encryption:  AES-256 at rest (R2 default)
Public:      disabled
Downloads:   short-lived HMAC-signed URLs, served by the Worker itself
```

Create the bucket with `wrangler r2 bucket create ecenter-crm-documents` (see
[Deployment](#deployment)). Locally, `worker/dev/fakeR2.mjs` stands in for the binding using the
filesystem (`worker/data/uploads`), so no Cloudflare account is needed for development.

Allowed types: PDF, JPEG, PNG, DOCX, DOC, XLSX, CSV, TXT. Limit 50 MB per file.

---

## Outlook calendar sync

1. In the Azure portal, register an application.
2. Add the **delegated** permission `Calendars.ReadWrite` (plus `offline_access`).
3. Add a **Web** platform redirect URI matching your deployed Worker's
   `.../api/calendar/microsoft/callback`.
4. In the app: **Settings -> Outlook calendar -> Add app registration**, paste the client ID, client
   secret and tenant ID (`common` for multi-tenant apps).
5. Click **Connect Outlook**, approve in the Microsoft window, then **Sync now**.

The sync is two-way over a rolling 30-day window. Events created in the CRM are pushed to Outlook;
Outlook events are pulled in. Local records are matched to remote ones through
`event_external_mapping`, so nothing is duplicated. Conflicts resolve last-write-wins, comparing
each side's modification time against the previous successful sync stamp.

Sync is **manual** in v1 -- a "Sync now" button. Every sync writes its outcome to
`calendar_sync_metadata` and the audit log. Disconnecting deletes the stored tokens but keeps the
app registration, so reconnecting is one click.

Calls go to the Microsoft Graph REST API directly using the platform's built-in `fetch`, rather than
through `@microsoft/microsoft-graph-client` (which expects a Node runtime). The integration is four
endpoints, and doing it directly keeps the token-refresh path explicit.

---

## Testing

```bash
npm test
```

Two end-to-end suites, `worker/test/api.test.ts` (CRM) and `worker/test/community.test.ts`
(community portal), call the real Worker's `fetch()` handler directly (no HTTP server) against a
throwaway `node:sqlite`-backed D1 shim and a temp-directory R2 shim, reseeded first, so the suite is
deterministic and repeatable. They cover authentication and account enumeration, **session
revocation on logout and on team-member removal**, contact search/filter/sort/pagination, bulk
tagging, the soft-delete cascade, server-side note timestamping (including that editing preserves
it), derived overdue status, recurrence scheduling and its duplicate guard, organization linking,
event-driven note creation, upload type rejection via the R2 binding, HMAC-signed download URLs,
dashboard aggregates, global search, role enforcement, the last-owner guard, and CSV
formula-injection escaping.

The community suite uses a fake `EMAIL` binding to follow the emailed links. It covers:

- **Permissions:** members are refused by every administrative API, and staff permissions are
  unchanged.
- **Linking:** a verified email links to the right existing contact without overwriting CRM data;
  a new email gets exactly one contact and one "Created Account" tag; retried and concurrent signups
  create no duplicates; ambiguous matches are flagged and resolved by editors only; the system tag
  resists manual edits; and email changes keep the link.
- **Privacy:** public profiles expose only allow-listed fields; resumes are available to the owner
  and staff only; uploads are content-sniffed; URLs are validated.
- **Feed:** only owners and editors can publish; drafts and unpublished posts stay private,
  including their image links; the feed paginates; only community-visible events appear.
- **Mentorship and messaging:** matching is deterministic and explained; messaging is
  participant-only, with idempotent sends and pagination.
- **Accounts:** deactivation revokes access and hides the member while keeping history; password
  reset works.

---

## Deployment

### First-time setup

```bash
npm install

# Create the D1 database, then paste the printed database_id into wrangler.toml.
npx wrangler d1 create ecenter-crm

# Create the R2 bucket for documents.
npx wrangler r2 bucket create ecenter-crm-documents

# Apply the schema to the REAL database (note --remote).
npx wrangler d1 execute ecenter-crm --remote --file=./worker/src/db/schema.sql

# Set the two required secrets.
npx wrangler secret put JWT_SECRET
npx wrangler secret put ENCRYPTION_KEY

# Community portal email (verification + password reset):
#   1. Onboard a sending domain to Cloudflare Email Service:
#        npx wrangler email sending enable <your-domain>
#   2. In wrangler.toml, uncomment the [[send_email]] binding (name = "EMAIL")
#      and set MAIL_FROM to an address on that domain.
#   3. Optionally set APP_URL so emailed links use your custom domain
#      (they otherwise use the request's own origin).

npm run build
npx wrangler deploy
```

### Ongoing deploys

If **Cloudflare Workers Builds** is connected to this repo's GitHub, every push to `main` builds the
client and runs `wrangler deploy` automatically -- `wrangler.toml` lives at the repository root
specifically so that works with no "Root directory" change in the dashboard project settings. Set
the two secrets once in the dashboard (or via `wrangler secret put`, which applies regardless of how
deploys are triggered) and every subsequent push just works.

To deploy by hand instead: `npm run build && npx wrangler deploy`.

### Seeding or changing the schema in production

`npm run seed`/`migrate`/`reset` only ever touch the local dev database (see
[How the Worker is put together](#how-the-worker-is-put-together)) -- there is no direct binding
access from outside a Worker. For real D1:

```bash
# Schema changes:
npx wrangler d1 execute ecenter-crm --remote --file=./worker/src/db/schema.sql

# Ad-hoc data (or write your own .sql file and pass it the same way):
npx wrangler d1 execute ecenter-crm --remote --command="SELECT COUNT(*) FROM contacts"
```

Day-to-day, the app's own UI (Settings -> team, Contacts, Organizations) is the normal way to put
data into a production tenant.

### Custom domain

Add a route in `wrangler.toml` (`routes = [{ pattern = "crm.yourdomain.org/*", custom_domain = true }]`)
or attach one in the Cloudflare dashboard under Workers & Pages -> ecenter-crm -> Settings ->
Domains & Routes.

---

## Design decisions

A few choices worth flagging, and why they were made:

- **A single Cloudflare Worker, not Express.** The first version of this app was a Node/Express
  server with `node:sqlite`/PostgreSQL, meant to be deployed to a separate Node host. It could not
  run on Cloudflare Workers at all -- no `app.listen()`, no TCP Postgres connections in that runtime.
  This version replaces the entire backend with a hand-rolled Worker (router, DB driver, auth,
  storage) so the whole app -- API and client -- deploys as one Cloudflare project with no second
  host to run or pay for.
- **One schema, two SQLite-family databases.** D1 and the local `node:sqlite` shim already speak the
  same dialect, so `schema.sql` needs no dialect-specific branching at all.
- **DB-backed sessions over JWT.** A stateless JWT cannot be revoked before it expires. Given the app
  already has team management (remove a member), a session that a DB lookup can kill immediately was
  worth the one extra query per request.
- **Overdue is derived, never stored.** A stored status would need a scheduled job and would be
  wrong between runs.
- **Note timestamps are server-generated.** The questionnaire called out hand-typed dates as the
  weak point, so the API ignores any client-supplied `createdAt` outright.
- **Detail panels, not pages.** Opening a contact slides a panel in from the right, keeping the
  filtered list and its scroll position behind it.
- **The dashboard is the landing page.** It ranks last for build priority, but overdue follow-ups
  are the first thing worth seeing, and Contacts is one click away.

### Not built in v1

Called out so nothing looks accidental: email digest delivery (the preference is stored and
reminders show in-app), scheduled background calendar sync (manual sync only), CSV import, and
dark mode. Each was listed in the brief as optional or Phase 2.

---

## Troubleshooting

**Cloudflare build fails with "wrangler deploy" errors about workspace detection**
This was the original failure that led to this rewrite -- it meant there was no `wrangler.toml` /
Worker entrypoint for Cloudflare to deploy. If you see it again, check that `wrangler.toml` is still
at the repository root and that the Cloudflare project's Build command still produces
`client/dist` (check the build log for the Vite output step).

**`JWT_SECRET / ENCRYPTION_KEY not set` warning from the dev server**
Expected in local development if you left `.env` blank; the dev server falls back to fixed insecure
values. Set both in `.env` for anything beyond quick local testing. In production, the Worker
refuses to start a request without them (`wrangler secret put`).

**Login fails right after setup**
Run `npm run build` (so the dev server has a client to serve) then `npm run migrate && npm run seed`.
Without seeding, the local database has no users.

**Port already in use**
Set `PORT` in `.env` for the Worker dev server, or run `npm run dev:web -- --port 5174` for Vite.

**Never change or lose `ENCRYPTION_KEY`**
It encrypts the Outlook tokens *and every uploaded document* (AES-256-GCM, with a separate key derived
for documents). A new key makes Outlook need reconnecting and makes **existing documents permanently
unreadable**. Keep a copy of the key in a password manager. Documents uploaded before encryption was
added are encrypted automatically the first time they are opened.

**Sync says "Connect your Outlook calendar first"**
The app registration is saved but consent has not been granted. Click **Connect Outlook** and
approve in the Microsoft window.

**Uploads rejected**
The type must be on the allow-list *and* the extension must match the content type. Settings ->
Documents lists the accepted extensions.

**`wrangler dev` does not work on this machine**
Expected on Windows ARM64 -- its bundled `workerd` has no build for that platform. Use `npm run dev`
(the Node-backed dev server) for local iteration; `wrangler deploy` itself works fine, since it only
bundles and uploads, and Cloudflare's own build servers run it for real deploys.

---

© University of New Hampshire | ECenter | 21 Madbury Road, Durham, NH
