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

Open <http://localhost:5173> and sign in:

| Email           | Password  | Role   |
| --------------- | --------- | ------ |
| `lisa@unh.edu`  | `test123` | Owner  |
| `bella@unh.edu` | `test123` | Editor |

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
| `npm test`           | End-to-end API test suite (38 tests), no server needed                  |
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
`notes`, `tasks`, `events`, `event_attendees`, `documents`, `audit_logs`,
`microsoft_oauth_credentials`, `calendar_sync_metadata`, `event_external_mapping`.

Every business table has `created_at`, `updated_at`, `deleted_at`, `created_by` and `last_edited_by`.
**Nothing is ever hard-deleted**: deletes set `deleted_at`, and every read filters it out. Deleting a
contact cascades the soft delete to their notes and tasks (one atomic `db.batch()`); deleting an
organization keeps its people and just clears the link.

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

38 end-to-end tests call the real Worker's `fetch()` handler directly (no HTTP server) against a
throwaway `node:sqlite`-backed D1 shim and a temp-directory R2 shim, reseeded first, so the suite is
deterministic and repeatable. They cover authentication and account enumeration, **session
revocation on logout and on team-member removal**, contact search/filter/sort/pagination, bulk
tagging, the soft-delete cascade, server-side note timestamping (including that editing preserves
it), derived overdue status, recurrence scheduling and its duplicate guard, organization linking,
event-driven note creation, upload type rejection via the R2 binding, HMAC-signed download URLs,
dashboard aggregates, global search, role enforcement, the last-owner guard, and CSV
formula-injection escaping.

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

**Changing `ENCRYPTION_KEY` breaks the Outlook connection**
Stored tokens cannot be decrypted with a new key. Reconnect Outlook in Settings; no other data is
affected.

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
