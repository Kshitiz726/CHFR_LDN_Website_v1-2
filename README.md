# CHFR LDN — website, booking API and lead-management system

The CHFR LDN marketing site, plus a production booking pipeline and a private
operations dashboard behind it.

The public site is unchanged: same hero, fleet section, typography, animations
and brand colours. What changed is that the booking form now actually does
something.

---

## 1. Architecture

```
                    ┌──────────────────────┐
                    │      CHFR SITE       │
                    │  public/index.html   │   static, unchanged
                    │    Booking form      │
                    └──────────┬───────────┘
                               │  POST /api/bookings
                               ▼
                    ┌──────────────────────┐
                    │     CHFR BACKEND     │
                    │  Validation          │
                    │  Honeypot · Turnstile│
                    │  Rate limit          │
                    │  Idempotency         │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │      PostgreSQL      │   ← single source of truth
                    │  bookings            │
                    │  booking_events      │
                    │  notification_logs   │
                    └──────────┬───────────┘
                               │  (after commit — never blocks the customer)
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
    ┌───────────┐      ┌──────────────┐      ┌────────────┐
    │   Email   │      │  Spreadsheet │      │   OpenWA   │
    │   SMTP    │      │Google Sheets │      │  WhatsApp  │
    └─────┬─────┘      └──────┬───────┘      └─────┬──────┘
          ▼                   ▼                    ▼
    CHFR Gmail +         Staff sheet          CHFR WhatsApp
    customer ack

                               │
                               ▼
                    ┌──────────────────────┐
                    │     ADMIN PANEL      │   /admin  (authenticated)
                    │  Leads · Confirmed   │
                    │  Today · Upcoming    │
                    │  Audit · Export      │
                    └──────────────────────┘
```

**Stack.** Node 20+ · TypeScript · Express · PostgreSQL (`pg`) · Zod ·
Nodemailer · ExcelJS · bcrypt. Server-rendered admin pages — no client
framework, no build step for the front end.

**The load-bearing design decision:** PostgreSQL is committed *before* any
notification is attempted. Email, the spreadsheet and WhatsApp run afterwards,
concurrently, each wrapped so a failure is recorded rather than propagated.
A booking is never lost because Gmail was down.

### Who gets emailed, and when

| Moment | Recipient | Email |
| --- | --- | --- |
| Customer submits the form | `ADMIN_EMAIL` | Full internal booking email, with every field and an "Open booking" button |
| Customer submits the form | `ALERT_EMAIL` | Short new-booking ping: who, where, when, and a link |
| Customer submits the form | The customer | Acknowledgement, explicitly *not* a confirmation |
| Staff change a customer-facing detail | The customer | Confirmed / Updated / Cancelled, carrying the current details |
| Staff press **Send booked confirmation** | The customer | Short "your journey is booked" email, and the booking is marked Confirmed |

The customer email on a staff edit is **automatic**. It fires whenever one of
these changes: status, pickup, destination, date, time, vehicle, confirmed
price, driver, vehicle registration or customer notes. Internal notes, priority,
the assignee and the draft quote never trigger it. The booking form has a
*Do not email the customer this time* checkbox as the deliberate opt-out.

**Send booked confirmation** is the one-click version, on its own panel at the
top of the booking page. It sends the short email and moves the status to
`CONFIRMED` with the automatic update email suppressed, so one click is one
email. Lines the operator has not filled in yet (chauffeur, registration,
price) are left out rather than shown blank, and the panel says which those are
before you press it.

When the booking becomes `CONFIRMED`, the customer receives the agreed price,
the chauffeur's name and the vehicle registration as soon as those are filled
in; the chauffeur block is omitted entirely until they are, so a confirmation
sent early never shows blanks.

### Layout

```
public/                     the existing website, served as-is
  index.html                booking form now posts to /api/bookings
  styles.css                original stylesheet + an appended additive block
  script.js                 form submission, validation display, success state
  privacy.html              new — GDPR notice
  admin.css / admin.js      operations dashboard styling and enhancements
src/
  config/env.ts             all configuration, validated at boot
  db/                       driver, migrations, migration runner
  domain/                   booking model, reference options, reference numbers
  validation/               Zod schemas for public and admin input
  repositories/             all SQL
  services/
    bookings.ts             create / update / archive + audit
    notifications.ts        the fan-out, and its failure isolation
    health.ts               subsystem checks
    export.ts               CSV and XLSX
    email/                  transport + templates/
    whatsapp/               provider interface, OpenWA adapter, message bodies
    spreadsheet/            provider interface, Google Sheets adapter, columns
  auth/                     password hashing, sessions, guards, CSRF
  http/                     Express app, middleware, routes
  admin/views/              server-rendered dashboard pages
  scripts/create-admin.ts
tests/                      86 tests, run against real Postgres (PGlite)
docker/openwa/              OpenWA deployment guide and compose file
```

---

## 2. Local development

Requires Node 20+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env
```

Edit `.env` and set at minimum:

```bash
DATABASE_URL=postgresql://chfr:chfr@localhost:5432/chfr
ADMIN_SESSION_SECRET=$(openssl rand -base64 48)
IP_HASH_SALT=$(openssl rand -hex 32)
```

Then:

```bash
createdb chfr          # or: docker compose up -d db
npm run migrate
npm run create-admin
npm run dev
```

- Website — <http://localhost:3000>
- Dashboard — <http://localhost:3000/admin>
- Health — <http://localhost:3000/api/health>

Email, the spreadsheet and WhatsApp are all optional. With none configured the
booking flow works end to end; emails are captured in memory and logged rather
than delivered, and the dashboard shows those subsystems as `NOT CONFIGURED`.

Everything with Docker instead:

```bash
docker compose up -d --build
docker compose run --rm web npm run create-admin:prod
```

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run migrate` | Apply pending migrations |
| `npm run create-admin` | Create or reset a staff account |
| `npm test` | Full test suite |
| `npm run typecheck` | Types only |
| `npm run lint` | ESLint |

---

## 3. Database

PostgreSQL. Migrations are plain `.sql` in `src/db/migrations/`, applied in
filename order inside a transaction each, tracked in `schema_migrations`. They
run automatically on server start, so a deploy is a single step.

| Table | Purpose |
| --- | --- |
| `users` | Staff accounts. `ADMIN` or `STAFF`, bcrypt password hashes |
| `sessions` | Server-side sessions. Only a SHA-256 of the token is stored |
| `ref_options` | Statuses, priorities, vehicles, journey types, luggage, payment states |
| `booking_sequences` | Per-day counter behind the booking reference |
| `bookings` | The booking / lead record |
| `booking_events` | Append-only audit trail |
| `notification_logs` | Per-channel delivery state, with attempt counts |
| `whatsapp_messages` | Every outbound WhatsApp message and its result |
| `email_logs` | Every outbound email and its result |
| `idempotency_keys` | Duplicate-submission protection |
| `rate_limits` | Durable rate-limit buckets |

### `bookings`

Identification `id`, `booking_reference`, `created_at`, `updated_at` ·
Customer `full_name`, `mobile`, `email` ·
Journey `pickup_location`, `destination`, `journey_date`, `pickup_time`,
`passengers`, `luggage`, `journey_type`, `preferred_vehicle`, `flight_number`,
`special_requests` ·
CRM `status`, `priority`, `assigned_to`, `quoted_price`, `confirmed_price`,
`currency`, `payment_status`, `driver_name`, `vehicle_registration`,
`internal_notes`, `customer_notes` ·
Communication `customer_email_sent`, `internal_email_sent`, `whatsapp_sent`,
`whatsapp_message_id`, `whatsapp_status`, `sheet_status`, `sheet_row_number`,
`sheet_synced_at`, `last_contacted_at` ·
Tracking `source`, `user_agent`, `ip_hash`, `dedupe_hash` ·
Lifecycle `archived_at`, `archived_by`.

**No card or payment details are stored, anywhere.** IP addresses are not
stored either — only a salted one-way hash, for abuse detection.

### Booking reference

`CHFR-YYYYMMDD-NNNN`, e.g. `CHFR-20260908-0001`. The counter is allocated with
a single atomic upsert, so concurrent submissions cannot collide; a `UNIQUE`
index is the backstop. It appears in the email subjects, both email bodies, the
WhatsApp message, the dashboard, the spreadsheet and the audit trail.

### Statuses

`NEW LEAD → CONTACTED → QUOTED → AWAITING CUSTOMER → CONFIRMED → GOING →
COMPLETED`, plus `CANCELLED` and `NO SHOW`. Default `NEW LEAD`.

Statuses live in `ref_options`, not in code. Adding one is an insert — the
dashboard, filters, exports and validation all pick it up with no deploy:

```sql
INSERT INTO ref_options (category, code, label, sort_order, meta)
VALUES ('status', 'EN_ROUTE', 'En Route', 65, '{"tone":"active"}');
```

The same applies to vehicles, journey types, luggage options, priorities and
payment statuses.

---

## 4. Environment variables

Full annotated list in [`.env.example`](.env.example). Required in production:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_SSL` | `true` on Render's managed Postgres |
| `ADMIN_SESSION_SECRET` | ≥32 chars. `openssl rand -base64 48` |
| `IP_HASH_SALT` | `openssl rand -hex 32` |
| `APP_URL` | Public base URL, no trailing slash |
| `ADMIN_EMAIL` | Where the full internal booking email goes — `CHFRLONDON@GMAIL.COM` |
| `ALERT_EMAIL` | A second address that gets a short new-booking ping. Blank, or equal to `ADMIN_EMAIL`, turns it off |
| `EMAIL_REPLY_TO` | Where a customer's reply lands. Defaults to `ADMIN_EMAIL` |

The process refuses to start in production if `DATABASE_URL` or
`ADMIN_SESSION_SECRET` is missing or too short. Everything else is optional and
degrades to a documented no-op.

---

## 5. Email

Any SMTP provider works. **Gmail:**

1. The Google account needs 2-Step Verification enabled.
2. Create an **App Password**: <https://myaccount.google.com/apppasswords>
   — a normal Gmail password will not work.
3. Set:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=CHFRLONDON@GMAIL.COM
SMTP_PASSWORD=<16-character app password>
SMTP_FROM=CHFR LDN <CHFRLONDON@GMAIL.COM>
```

Gmail caps sending at roughly 500/day. If CHFR outgrows that, or if
acknowledgements start landing in spam, move to a transactional provider
(Resend, Postmark, SES) — they are all plain SMTP, so only these five variables
change.

Verify with `/api/health?deep=1`, which performs a real SMTP handshake.

### Templates

In `src/services/email/templates/`: `newBooking`, `customerAcknowledgement`,
`bookingConfirmed`, `bookingUpdated`, `bookingCancelled`, `staffMessage`. All
share `layout.ts`. Table-based and inline-styled, because Gmail and Outlook
strip `<style>` blocks. Every customer value is HTML-escaped.

Route handlers contain no email markup — editing the wording never touches
business logic.

### Update emails

Staff tick **"Email the customer about this change"** on the booking page. The
email only goes out if a *customer-impacting* field actually changed — pickup,
destination, date, time, vehicle or status. Editing internal notes, the driver
or a draft price never emails anyone. `CUSTOMER_UPDATE_EMAILS_ENABLED=false`
turns the feature off entirely.

---

## 6. Spreadsheet

Three options, in order of effort.

### A. Export only (default, `SPREADSHEET_PROVIDER=none`)

**Export CSV** and **Export Excel** on the bookings page. Exports respect the
active filters, and named scopes exist for today, upcoming, confirmed,
completed and cancelled. Prices export as real numbers, dates as
`15 September 2026`, and no cell contains raw JSON. No setup, no credentials.

### B. Live Google Sheet (`SPREADSHEET_PROVIDER=google`)

One row per booking, keyed on Booking Reference — appended on creation, updated
in place on every edit, never duplicated.

1. <https://console.cloud.google.com> → new project.
2. Enable the **Google Sheets API**.
3. **IAM & Admin → Service Accounts** → create one → **Keys → Add key → JSON**.
4. Create a Google Sheet. Copy its ID from the URL:
   `docs.google.com/spreadsheets/d/`**`<THIS>`**`/edit`
5. **Share the sheet with the service account's `client_email`, as Editor.**
   This is the step people miss.
6. Set:

```bash
SPREADSHEET_PROVIDER=google
GOOGLE_SHEETS_ID=<the id>
GOOGLE_SHEETS_TAB=Bookings
GOOGLE_SERVICE_ACCOUNT_JSON=<the JSON, or base64 of it>
```

For Render, base64 the key so newlines survive:
`base64 -i service-account.json | tr -d '\n'`

Headers are created and repaired automatically. Sync failures are logged and
shown on the booking page with a **Resync spreadsheet** button — they never
affect the booking.

### C. Microsoft Excel / OneDrive

Not implemented: this project has no Microsoft 365 infrastructure to build on,
and adding Graph API + app registration + tenant consent for a small operation
is not worth it against option A or B. `SpreadsheetProvider` in
`src/services/spreadsheet/provider.ts` is a two-method interface if that
changes.

**The spreadsheet is never a source of truth.** It is a projection of the
database. Edits made in the sheet are not read back.

---

## 7. WhatsApp (OpenWA)

Entirely optional, and off by default. See
[`docker/openwa/README.md`](docker/openwa/README.md) for deployment and QR
pairing.

The integration sits behind a `WhatsAppProvider` interface. `OpenWAProvider`
implements it against OpenWA's REST API (`POST /api/sessions`,
`POST /api/sessions/{id}/start`, `GET /api/sessions/{id}/qr`,
`POST /api/sessions/{id}/messages/send-text`, authenticated with `X-API-Key`).
Swapping to the WhatsApp Business Cloud API later means one new file.

```bash
WHATSAPP_ENABLED=true
OPENWA_BASE_URL=http://openwa:2785     # private network only
OPENWA_API_KEY=<long random string>
OPENWA_SESSION_ID=CHFR
CHFR_WHATSAPP_NUMBER=+44…              # E.164, validated before sending
```

`OPENWA_API_KEY` is read only on the server. The browser talks to
`/admin/whatsapp`; the CHFR backend talks to OpenWA. **Never expose OpenWA
to the public internet.**

WhatsApp never blocks a booking. Offline, unpaired, rate-limited or erroring,
the booking is still created, emailed and exported; `whatsapp_status` becomes
`FAILED` and **Send WhatsApp again** retries it.

---

## 8. Admin dashboard

`/admin` — authentication required, `noindex`, `no-store`.

| Route | |
| --- | --- |
| `/admin` | Overview: status cards, today, next journeys, uncontacted leads, failed notifications, health |
| `/admin/bookings` | Table with search, filters, sorting, pagination, export |
| `/admin/bookings/:id` | Full record, edit form, actions, communication log, audit history |
| `/admin/today` | Chronological run-sheet |
| `/admin/upcoming` | Today / tomorrow / next 7 / next 30 / custom |
| `/admin/whatsapp` | Session status, connect, QR, test message |
| `/admin/users` | Staff accounts (ADMIN only) |

Search covers booking reference, name, email, pickup, destination, flight
number, and phone number ignoring formatting — `07700 900000` finds
`+447700900000`.

### Roles

**ADMIN** — everything, plus managing staff accounts, disconnecting WhatsApp
and permanent deletion. **STAFF** — view and update bookings, change status,
add notes, contact customers, export.

### Delete vs archive

Archive is the normal action: a soft delete that keeps the record and its full
history, hidden from the default view. Permanent deletion is ADMIN-only and
exists for a verified GDPR erasure request.

### Audit log

Every meaningful change writes a `booking_events` row: what changed, from what,
to what, by whom, when. Values are rendered as staff see them —
`Quoted price changed · £180.00 → £200.00`, not raw codes. Submitting a form
without changing anything writes nothing.

The table is append-only. No route in the application updates or deletes a
`booking_events` row.

---

## 9. API

Public:

| | |
| --- | --- |
| `POST /api/bookings` | Create a booking. Rate-limited, honeypot, idempotent |
| `GET /api/booking-options` | Vehicle / journey type / luggage options for the form |
| `GET /api/health` | Subsystem health. `?deep=1` for live SMTP + Sheets checks |

Admin — all require a session; all state changes require CSRF:

```
GET    /api/admin/bookings
GET    /api/admin/bookings/:id
PATCH  /api/admin/bookings/:id
DELETE /api/admin/bookings/:id            (archive; ?permanent=true → ADMIN only)
POST   /api/admin/bookings/:id/restore
GET    /api/admin/bookings/:id/history
POST   /api/admin/bookings/:id/notes
POST   /api/admin/bookings/:id/contacted
POST   /api/admin/bookings/:id/email
POST   /api/admin/bookings/:id/whatsapp
POST   /api/admin/bookings/:id/whatsapp/retry
POST   /api/admin/bookings/:id/retry/:channel
GET    /api/admin/export/bookings         ?format=csv|xlsx &scope=…
GET    /api/admin/health
GET    /api/admin/whatsapp/status
POST   /api/admin/whatsapp/connect|disconnect|qr
```

---

## 10. Security

- HTTPS enforced in production (308 redirect); HSTS.
- CSP, `nosniff`, `frame-ancestors 'none'`, strict referrer policy, no
  `X-Powered-By`.
- bcrypt (cost 12). Unknown emails still run a comparison, so login timing does
  not reveal whether an account exists.
- Server-side sessions; only a SHA-256 of the token is stored. `HttpOnly`,
  `SameSite=Lax`, `Secure` in production. Disabling an account kills its live
  sessions immediately.
- CSRF tokens bound to the session, compared in constant time, on every
  cookie-authenticated state change.
- Rate limiting on bookings and logins, stored in Postgres so it survives
  restarts. Fails open — a limiter outage must not stop customers booking.
- All SQL parameterised. Column names in dynamic updates come from a fixed
  allow-list.
- Every customer value HTML-escaped in emails and admin pages.
- Zod validation server-side, `.strict()` — unexpected fields are rejected, not
  ignored.
- 64 KB request body cap.
- Structured logging with redaction of passwords, API keys, cookies and tokens.
  Customers see one generic message; detail stays in the logs.

### Production checklist

- [ ] `ADMIN_SESSION_SECRET` and `IP_HASH_SALT` set to generated values
- [ ] `APP_URL` is the real HTTPS domain
- [ ] `NODE_ENV=production`, `DATABASE_SSL=true`
- [ ] `.env` is not committed (`.gitignore` covers it)
- [ ] First admin created, and the bootstrap password changed after first sign-in
- [ ] `ADMIN_BOOTSTRAP_PASSWORD` removed from the environment after use
- [ ] `/admin` returns a redirect to login when signed out
- [ ] SMTP verified via `/api/health?deep=1`
- [ ] OpenWA is a private service with no public URL
- [ ] Database backups confirmed running

---

## 11. Privacy / GDPR

Only what the journey needs. No card details, ever — stated on the booking form
and in both customer emails. No raw IP addresses. Bookings are never public.
`/privacy.html` covers what is collected, why, who sees it, retention and the
customer's rights.

For an erasure request: find the booking, verify the requester, then
**Delete permanently** as an ADMIN. This removes the booking and, by cascade,
its events, notification logs and messages.

---

## 12. Deployment (Render)

1. Push this repository to GitHub.
2. Render → **New → Blueprint** → select the repo. [`render.yaml`](render.yaml)
   creates the web service and a managed PostgreSQL database, and generates
   `ADMIN_SESSION_SECRET` and `IP_HASH_SALT`.
3. Fill in the `sync: false` variables in the dashboard (SMTP, and Sheets or
   WhatsApp if used).
4. Set `APP_URL` to your domain.
5. Deploy. Migrations run automatically at boot.
6. Create the first admin — Render **Shell** on the service:
   ```bash
   npm run create-admin:prod
   ```
   Or set `ADMIN_BOOTSTRAP_EMAIL` / `_NAME` / `_PASSWORD`, run the command once,
   then delete those variables.
7. Point DNS at Render and add `www.chfrldn.com` under **Custom Domains**.
   Render issues the TLS certificate.
8. OpenWA, if wanted, as a separate private service with a disk — see
   [`docker/openwa/README.md`](docker/openwa/README.md).

Health check path is `/api/health`, which returns 503 only if the database is
unreachable. A missing email or WhatsApp integration does not fail the check —
that is deliberate, so a Gmail outage cannot take the website down.

---

## 13. Backup

**Back up PostgreSQL. Never treat the spreadsheet as a backup** — it is a
projection and can be rebuilt from the database, not the other way round.

Render's managed Postgres takes daily automated backups with point-in-time
recovery on paid plans; confirm it is enabled under the database's **Backups**
tab.

Manual dump:

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom --file=chfr-$(date +%F).dump
```

Restore:

```bash
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" chfr-2026-09-08.dump
```

Test a restore into a scratch database at least once — an untested backup is a
hypothesis.

The OpenWA session is not worth backing up; re-pairing takes under a minute.

---

## 14. Testing

```bash
npm test
```

86 tests, run against **real PostgreSQL** — an embedded WASM build (PGlite), so
the SQL under test is the SQL that ships, with no server to install.

| File | Covers |
| --- | --- |
| `validation.test.ts` | Every field rule, phone normalisation, enum and unknown-field rejection |
| `booking-api.test.ts` | Creation, references, persistence, audit, honeypot, body limits, idempotency, concurrency |
| `notifications.test.ts` | Fan-out; email / spreadsheet / WhatsApp / all-channels / database failure; XSS escaping; health |
| `auth.test.ts` | Auth, session hygiene, CSRF, roles, security headers |
| `admin.test.ts` | Status workflow, audit log, partial updates, search, filters, ops views, CSV/XLSX export |
| `e2e.test.ts` | The full John Smith journey, end to end |

The end-to-end test walks the whole path: the form on the live page posts to the
API, the booking is persisted with every field intact, both emails are generated
and checked fragment by fragment, the spreadsheet row is verified, the WhatsApp
payload is checked against the documented format, staff sign in and move the
booking `NEW LEAD → CONTACTED → QUOTED → CONFIRMED → GOING → COMPLETED`, every
change appears in the audit trail, and the result appears in an export.

---

## 15. Troubleshooting

**Emails are not arriving.** `/api/health?deep=1`. Gmail needs an *App
Password*, not the account password. Check the booking page's Communication
panel for the recorded error, and use **Resend**.

**"Database has not been initialised".** `initDatabase()` did not run — check
`DATABASE_URL` and that Postgres is reachable.

**Migrations fail on start.** Check the ledger:
`SELECT * FROM schema_migrations;`. Each migration is transactional, so a
failure leaves no partial state; fix the cause and restart.

**WhatsApp shows DISCONNECTED.** Normal after a restart if the session storage
is not persistent — that is the whole reason OpenWA needs a disk. Reconnect and
re-scan at `/admin/whatsapp`. Bookings are unaffected.

**Google Sheets sync fails.** Almost always the sheet not being shared with the
service account's `client_email` as Editor. Confirm the Sheets API is enabled
and `GOOGLE_SHEETS_ID` is the ID, not the whole URL.

**Locked out of the dashboard.** `npm run create-admin` with an existing email
resets that account's password and re-enables it.

**Duplicate bookings.** They should not occur — there are two independent
guards. If one appears, compare `dedupe_hash` and `created_at`; identical
journeys more than 15 minutes apart are treated as genuinely separate.

---

## 16. Original release notes (v1)

Preserved from `README.txt`:

- Instagram: [@chfrldn](https://instagram.com/chfrldn) · TikTok:
  [@chfrldn](https://tiktok.com/@chfrldn) — both still linked in the footer.
- Item 1 of the original "before going live" list — *connect the booking form to
  your actual WhatsApp, email, CRM or booking platform* — is what this release
  does.
- Item 2 — legal and privacy pages — is partly done: `/privacy.html` exists and
  is linked, but **CHFR's registered business details still need adding to it**,
  and a terms page has not been written.
- Items 3, 4 and 5 (fleet imagery, confirming every vehicle is bookable,
  analytics) remain open and are business decisions, not code.
