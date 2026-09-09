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

---

## Contents

- [Quick start](#quick-start)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Environment variables](#environment-variables)
- [Database](#database)
- [What is in each tab](#what-is-in-each-tab)
- [Security and compliance](#security-and-compliance)
- [Multi-tenancy](#multi-tenancy)
- [Cloudflare R2 document storage](#cloudflare-r2-document-storage)
- [Outlook calendar sync](#outlook-calendar-sync)
- [Testing](#testing)
- [Deployment](#deployment)
- [Design decisions](#design-decisions)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Requires **Node.js 22.18 or newer** (24 recommended). Nothing else -- no database server, no cloud
account, no native build tools.

```bash
npm install
cp .env.example .env      # then set JWT_SECRET and ENCRYPTION_KEY
npm run migrate           # create the schema
npm run seed              # load the demo tenant and sample data
npm run dev               # API on :4000, web app on :5173
```

Open <http://localhost:5173> and sign in:

| Email           | Password  | Role   |
| --------------- | --------- | ------ |
| `lisa@unh.edu`  | `test123` | Owner  |
| `bella@unh.edu` | `test123` | Editor |

Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Scripts

| Command             | What it does                                                  |
| ------------------- | ------------------------------------------------------------- |
| `npm run dev`       | API and web dev server together, with hot reload               |
| `npm run dev:api`   | API only (`http://localhost:4000`)                             |
| `npm run dev:web`   | Web only (`http://localhost:5173`, proxies `/api` to the API)   |
| `npm run build`     | Production build of the web app into `client/dist`              |
| `npm start`         | Production server -- serves the API *and* `client/dist`         |
| `npm run migrate`   | Apply `server/src/db/schema.sql` (idempotent)                   |
| `npm run seed`      | Reload the demo tenant (clears only that customer's rows)       |
| `npm run reset`     | Empty every table                                              |
| `npm test`          | End-to-end API test suite (36 tests)                            |
| `npm run typecheck` | TypeScript check for both workspaces                            |

---

## Tech stack

| Layer      | Choice                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| Frontend   | React 18 + TypeScript, Vite, Tailwind CSS, React Router                    |
| Backend    | Node.js + Express, TypeScript run natively (no build step)                 |
| Database   | PostgreSQL in production, `node:sqlite` for local development              |
| Auth       | JWT (HS256) with bcrypt password hashing                                   |
| Documents  | Cloudflare R2 (S3-compatible), or local disk for development               |
| Calendar   | Microsoft Graph REST API (Outlook), two-way sync                           |

The server is written in TypeScript and executed **directly by Node's built-in type stripping**, so
there is no transpile step for the backend in either development or production. `npm run typecheck`
runs `tsc --noEmit` for real type checking.

---

## Project layout

```
unh-ecenter-crm/
├── server/
│   ├── src/
│   │   ├── index.ts              Express app, route mounting, static client
│   │   ├── env.ts                All configuration, one place
│   │   ├── records.ts            Row -> API shape mappers, enum definitions
│   │   ├── db/
│   │   │   ├── schema.sql        The canonical schema (both dialects)
│   │   │   ├── driver.ts         Db interface, `?` -> `$n` rewriting
│   │   │   ├── sqlite.ts         node:sqlite driver
│   │   │   ├── postgres.ts       node-postgres driver
│   │   │   ├── migrate.ts        Applies the schema (idempotent)
│   │   │   └── seed.ts           Demo tenant and sample data
│   │   ├── lib/                  jwt, crypto, validation, csv, audit, time
│   │   ├── middleware/           auth + tenant scoping, error handling
│   │   ├── routes/               One router per resource
│   │   └── services/             R2 storage, Microsoft Graph, calendar sync
│   └── test/api.test.ts          End-to-end API tests
└── client/
    └── src/
        ├── components/           AppShell, ui primitives, overlays, forms
        ├── pages/                One page per tab
        ├── state/                Auth and toast contexts
        └── lib/                  API client, types, formatting, hooks
```

---

## Environment variables

Everything lives in one `.env` at the repository root. See `.env.example` for the annotated
template. The only values that are **required in production** are `JWT_SECRET` and `ENCRYPTION_KEY`;
the server refuses to start without them when `NODE_ENV=production`.

| Variable                              | Default                  | Notes                                                    |
| ------------------------------------- | ------------------------ | -------------------------------------------------------- |
| `PORT`                                | `4000`                   | API port                                                  |
| `APP_URL`                             | `http://localhost:5173`  | Public URL of the web app                                 |
| `CORS_ORIGINS`                        | `http://localhost:5173`  | Comma-separated allowed browser origins                   |
| `JWT_SECRET`                          | *(required in prod)*     | Signs session tokens                                      |
| `ENCRYPTION_KEY`                      | *(required in prod)*     | AES-256-GCM key for OAuth secrets and calendar tokens     |
| `JWT_TTL_SECONDS`                     | `43200` (12h)            | Normal session length                                     |
| `JWT_TTL_REMEMBER_SECONDS`            | `2592000` (30d)          | "Keep me signed in"                                       |
| `DATABASE_URL`                        | *(empty)*                | Set it to use PostgreSQL; empty means local SQLite         |
| `DB_DRIVER`                           | auto                     | `postgres` or `sqlite`; inferred from `DATABASE_URL`       |
| `SQLITE_PATH`                         | `server/data/ecenter.db` | Local database file                                       |
| `STORAGE_DRIVER`                      | auto                     | `r2` or `local`; inferred from `R2_BUCKET`                 |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | -- | Cloudflare R2 credentials      |
| `UPLOAD_MAX_BYTES`                    | `52428800` (50 MB)       | Per-file upload limit                                     |
| `DOWNLOAD_URL_TTL_SECONDS`            | `900` (15 min)           | Pre-signed download link lifetime                         |
| `MICROSOFT_REDIRECT_URI`              | `.../api/calendar/microsoft/callback` | Must match the Azure app registration        |
| `DEFAULT_CUSTOMER_SLUG` / `DEFAULT_CUSTOMER_NAME` | `unh-ecenter` | Tenant created by `npm run seed`                |

---

## Database

`server/src/db/schema.sql` is the single source of truth and runs unmodified on **both**
PostgreSQL and SQLite. That is possible because the schema stays inside a portable SQL subset:

- Primary keys are application-generated UUID `TEXT` -- no `SERIAL`, no `AUTOINCREMENT`.
- Timestamps are ISO-8601 UTC strings and dates are `YYYY-MM-DD`, both in `TEXT`. They sort and
  compare correctly with ordinary SQL operators in either engine.
- Booleans are `INTEGER` 0/1, since SQLite has no boolean type.
- Tag lists are JSON in a `TEXT` column, parsed in the mappers.

Queries are written once with `?` placeholders; the PostgreSQL driver rewrites them to `$1..$n`.
Case-insensitive search uses `LOWER(column) LIKE ?` so it behaves identically in both engines.

**Tables:** `customers`, `users`, `user_preferences`, `organizations`, `contacts`, `notes`, `tasks`,
`events`, `event_attendees`, `documents`, `audit_logs`, `microsoft_oauth_credentials`,
`calendar_sync_metadata`, `event_external_mapping` -- 14 tables, 40 indexes.

Every business table has `created_at`, `updated_at`, `deleted_at`, `created_by` and `last_edited_by`.
**Nothing is ever hard-deleted**: deletes set `deleted_at`, and every read filters it out. Deleting a
contact cascades the soft delete to their notes and tasks; deleting an organization keeps its people
and just clears the link.

To switch to PostgreSQL, set `DATABASE_URL` and run `npm run migrate`. No code changes.

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

- **Passwords** are bcrypt hashed (cost 12). Login returns the same generic message whether the
  email exists or not, so the endpoint cannot be used to enumerate accounts.
- **Sessions** are stateless HS256 JWTs, verified with a timing-safe comparison.
- **Secrets at rest** -- Microsoft client secrets, access tokens and refresh tokens -- are
  AES-256-GCM encrypted before they touch the database.
- **Roles**: `owner` (full access plus team management), `editor` (everyday work), `viewer`
  (read-only). Enforced server-side on every mutating route.
- **Uploads** are restricted to an allow-list of MIME types *and* matching extensions, so an
  executable renamed `.pdf` is rejected. Filenames are reduced to a safe character allow-list.
- **Downloads** go through short-lived pre-signed URLs (15 minutes by default) and are audited.
- **CSV exports** neutralise spreadsheet formula injection by prefixing cells that begin with
  `=`, `+`, `-` or `@`.
- **Audit log** records sign-ins, failed sign-ins, document uploads/downloads/deletions, calendar
  connections and syncs, exports, user administration, and every record deletion, with IP address
  and user agent.
- **GDPR posture**: soft deletes throughout, full CSV data export, and an audit trail.

---

## Multi-tenancy

Although v1 serves one customer, the data model is multi-tenant from the start so the same codebase
can be deployed for the next one:

- Every business table carries `customer_id`.
- The JWT carries the tenant id (`cid`), and `auth(req).customerId` is applied to **every** query.
- Documents are namespaced per tenant: `customers/{customerId}/documents/...`.
- Microsoft OAuth credentials are stored and encrypted per tenant.

`npm run seed` re-seeds by deleting only that customer's rows, which exercises the scoping.

---

## Cloudflare R2 document storage

```
Bucket:      crm-documents
Path:        customers/{customerId}/documents/{timestamp}-{filename}
Encryption:  AES-256 at rest (R2 default)
Public:      disabled
Downloads:   pre-signed URLs, 15-minute expiry
```

Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`, and the storage
driver switches automatically. Enable bucket versioning in the Cloudflare dashboard for recovery.

With no R2 credentials the app uses `STORAGE_DRIVER=local`, writing to `server/data/uploads` and
serving downloads through a short-lived signed token instead of a pre-signed URL. The client code
is identical either way -- it just follows the `url` the API returns.

Allowed types: PDF, JPEG, PNG, DOCX, DOC, XLSX, CSV, TXT. Limit 50 MB per file.

---

## Outlook calendar sync

1. In the Azure portal, register an application.
2. Add the **delegated** permission `Calendars.ReadWrite` (plus `offline_access`).
3. Add a **Web** platform redirect URI matching `MICROSOFT_REDIRECT_URI`, by default
   `http://localhost:4000/api/calendar/microsoft/callback`.
4. In the app: **Settings -> Outlook calendar -> Add app registration**, paste the client ID, client
   secret and tenant ID (`common` for multi-tenant apps).
5. Click **Connect Outlook**, approve in the Microsoft window, then **Sync now**.

The sync is two-way over a rolling 30-day window. Events created in the CRM are pushed to Outlook;
Outlook events are pulled in. Local records are matched to remote ones through
`event_external_mapping`, so nothing is duplicated. Conflicts resolve last-write-wins, comparing
each side's modification time against the previous successful sync stamp.

Sync is **manual** in v1 -- a "Sync now" button -- per the recommendation in the brief. Every sync
writes its outcome to `calendar_sync_metadata` and the audit log. Disconnecting deletes the stored
tokens but keeps the app registration, so reconnecting is one click.

Calls go to the Microsoft Graph REST API directly using Node's built-in `fetch`, rather than through
`@microsoft/microsoft-graph-client`. The integration uses four endpoints, and doing it directly keeps
the token-refresh path explicit and the dependency surface small for a customer-hosted deployment.

---

## Testing

```bash
npm test
```

36 end-to-end tests run the real Express app against a throwaway SQLite database that is reseeded
first, so the suite is deterministic and repeatable and never touches development data. They cover
authentication and account enumeration, contact search/filter/sort/pagination, bulk tagging, the
soft-delete cascade, server-side note timestamping (including that editing preserves it), derived
overdue status, recurrence scheduling and its duplicate guard, organization linking, event-driven
note creation, upload type rejection, signed download URLs, dashboard aggregates, global search,
role enforcement, the last-owner guard, and CSV formula-injection escaping.

---

## Deployment

The production server serves the API **and** the built client from one process, so a single service
is enough.

```bash
npm install
npm run build          # builds client/dist
npm run migrate        # apply the schema
NODE_ENV=production npm start
```

Set at minimum: `NODE_ENV=production`, `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `APP_URL`,
`CORS_ORIGINS`, and the R2 and Microsoft values you intend to use.

**Railway / Render / Fly.io** -- point the service at this repository, set the build command to
`npm install && npm run build`, the start command to `npm start`, and attach a PostgreSQL instance
so `DATABASE_URL` is provided.

**Cloudflare** -- deploy `client/dist` to Pages, and host the API separately (a container or VM);
the Express server needs a Node runtime, and R2 works from anywhere over the S3 API. If you deploy
the frontend and API to different hostnames, add the Pages origin to `CORS_ORIGINS`.

**Traditional server** -- run `npm start` behind nginx or Caddy with TLS, using systemd or pm2 to
keep it alive.

Note for local work on Windows ARM64: `wrangler` has no `workerd` build for that platform, so deploy
Cloudflare targets from CI (GitHub Actions) rather than from the machine.

---

## Design decisions

A few choices worth flagging, and why they were made:

- **One schema for two databases.** Writing to a portable SQL subset means development, tests and
  production all run the same statements. The cost is ISO-8601 text timestamps in PostgreSQL rather
  than `TIMESTAMPTZ`; the benefit is that a query cannot work in one engine and break in the other.
- **`node:sqlite` for local development.** It ships with Node, so `npm install` needs no native
  compilation, no Python and no Postgres server -- the project clones and runs.
- **Overdue is derived, never stored.** A stored status would need a nightly job and would be wrong
  between runs.
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

**`JWT_SECRET not set -- using an insecure development fallback`**
Expected in development; copy `.env.example` to `.env` and set the two secrets. In production the
server refuses to start instead.

**Login fails right after setup**
Run `npm run seed`. Without it the database has no users.

**"Cannot reach the server"**
The API is not running. `npm run dev` starts both; `npm run dev:api` starts the API alone on
port 4000. Check `curl http://localhost:4000/api/health`.

**Port already in use**
Change `PORT` for the API, or run `npm run dev:web -- --port 5174` for the web app.

**Changing `ENCRYPTION_KEY` breaks the Outlook connection**
Stored tokens cannot be decrypted with a new key. Reconnect Outlook in Settings; no other data is
affected.

**Sync says "Connect your Outlook calendar first"**
The app registration is saved but consent has not been granted. Click **Connect Outlook** and
approve in the Microsoft window.

**Uploads rejected**
The type must be on the allow-list *and* the extension must match the content type. Settings ->
Documents lists the accepted extensions.

---

© University of New Hampshire | ECenter | 21 Madbury Road, Durham, NH
