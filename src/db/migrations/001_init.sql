-- CHFR LDN — initial schema.
-- PostgreSQL is the single source of truth. Spreadsheets, email and WhatsApp
-- are downstream projections of this data and never write back into it.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'STAFF',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'STAFF'))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  user_agent TEXT,
  ip_hash    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- Reference data. Statuses, vehicles, journey types etc. live in the database
-- rather than in the code so new options can be added without a deploy, and so
-- the admin UI never hard-codes a closed list.
CREATE TABLE IF NOT EXISTS ref_options (
  category   TEXT NOT NULL,
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (category, code)
);

-- Per-day counter behind the human-readable booking reference.
CREATE TABLE IF NOT EXISTS booking_sequences (
  day      DATE PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id                  BIGSERIAL PRIMARY KEY,
  booking_reference   TEXT NOT NULL UNIQUE,

  -- Customer
  full_name           TEXT NOT NULL,
  mobile              TEXT NOT NULL,
  email               TEXT NOT NULL,

  -- Journey
  pickup_location     TEXT NOT NULL,
  destination         TEXT NOT NULL,
  journey_date        DATE NOT NULL,
  pickup_time         TIME NOT NULL,
  passengers          INTEGER NOT NULL DEFAULT 1,
  luggage             TEXT NOT NULL DEFAULT 'NONE',
  journey_type        TEXT NOT NULL DEFAULT 'OTHER',
  preferred_vehicle   TEXT NOT NULL DEFAULT 'RECOMMEND',
  flight_number       TEXT,
  special_requests    TEXT,

  -- Business / CRM
  status              TEXT NOT NULL DEFAULT 'NEW_LEAD',
  priority            TEXT NOT NULL DEFAULT 'NORMAL',
  assigned_to         BIGINT REFERENCES users (id) ON DELETE SET NULL,
  quoted_price        NUMERIC(10, 2),
  confirmed_price     NUMERIC(10, 2),
  currency            TEXT NOT NULL DEFAULT 'GBP',
  payment_status      TEXT NOT NULL DEFAULT 'UNPAID',
  driver_name         TEXT,
  vehicle_registration TEXT,
  internal_notes      TEXT,
  customer_notes      TEXT,

  -- Communication
  customer_email_sent BOOLEAN NOT NULL DEFAULT FALSE,
  internal_email_sent BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_sent       BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_message_id TEXT,
  whatsapp_status     TEXT NOT NULL DEFAULT 'PENDING',
  last_contacted_at   TIMESTAMPTZ,

  -- Spreadsheet projection
  sheet_row_number    INTEGER,
  sheet_synced_at     TIMESTAMPTZ,
  sheet_status        TEXT NOT NULL DEFAULT 'PENDING',

  -- Tracking
  source              TEXT NOT NULL DEFAULT 'WEBSITE',
  user_agent          TEXT,
  ip_hash             TEXT,
  dedupe_hash         TEXT,

  -- Lifecycle (soft delete: bookings are archived, never dropped, by default)
  archived_at         TIMESTAMPTZ,
  archived_by         BIGINT REFERENCES users (id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT bookings_passengers_check CHECK (passengers >= 1 AND passengers <= 16)
);

CREATE INDEX IF NOT EXISTS bookings_created_idx ON bookings (created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_journey_idx ON bookings (journey_date, pickup_time);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_email_idx ON bookings (lower(email));
CREATE INDEX IF NOT EXISTS bookings_mobile_idx ON bookings (mobile);
CREATE INDEX IF NOT EXISTS bookings_archived_idx ON bookings (archived_at);
CREATE INDEX IF NOT EXISTS bookings_dedupe_idx ON bookings (dedupe_hash, created_at DESC);

-- Append-only audit trail. Nothing in the admin interface updates or deletes
-- rows in this table; it is written by the booking service only.
CREATE TABLE IF NOT EXISTS booking_events (
  id            BIGSERIAL PRIMARY KEY,
  booking_id    BIGINT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  field         TEXT,
  old_value     TEXT,
  new_value     TEXT,
  message       TEXT,
  changed_by    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  changed_by_label TEXT NOT NULL DEFAULT 'System',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_events_booking_idx ON booking_events (booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_logs (
  id                  BIGSERIAL PRIMARY KEY,
  booking_id          BIGINT REFERENCES bookings (id) ON DELETE CASCADE,
  channel             TEXT NOT NULL,           -- EMAIL | WHATSAPP | SPREADSHEET
  kind                TEXT NOT NULL,           -- e.g. INTERNAL_NEW_BOOKING, CUSTOMER_ACK
  status              TEXT NOT NULL,           -- PENDING | SENT | FAILED | SKIPPED
  recipient           TEXT,
  provider_message_id TEXT,
  error_message       TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notification_logs_booking_idx ON notification_logs (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_logs_status_idx ON notification_logs (status);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                  BIGSERIAL PRIMARY KEY,
  booking_id          BIGINT REFERENCES bookings (id) ON DELETE CASCADE,
  direction           TEXT NOT NULL DEFAULT 'OUTBOUND',
  recipient           TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL,
  provider            TEXT NOT NULL DEFAULT 'openwa',
  provider_message_id TEXT,
  error_message       TEXT,
  sent_by             BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_booking_idx ON whatsapp_messages (booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_logs (
  id                  BIGSERIAL PRIMARY KEY,
  booking_id          BIGINT REFERENCES bookings (id) ON DELETE CASCADE,
  template            TEXT NOT NULL,
  recipient           TEXT NOT NULL,
  subject             TEXT NOT NULL,
  status              TEXT NOT NULL,
  provider_message_id TEXT,
  error_message       TEXT,
  sent_by             BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_logs_booking_idx ON email_logs (booking_id, created_at DESC);

-- Idempotency: a repeated submission with the same key returns the original
-- booking instead of creating a second one.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  booking_id  BIGINT REFERENCES bookings (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idempotency_created_idx ON idempotency_keys (created_at);

-- Simple durable rate-limit buckets (survives restarts, works across instances).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT PRIMARY KEY,
  hits        INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);
