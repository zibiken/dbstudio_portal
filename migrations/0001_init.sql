-- 0001_init.sql — initial schema for the DB Studio Customer Portal v1.
--
-- Extensions pgcrypto + citext are installed by the M0-A bootstrap as
-- superuser and are not re-created here.
--
-- All UUID primary keys are generated app-side (UUIDv7).

-- ---------------------------------------------------------------------------
-- Audit log (append-only at DB level via trigger; see plan delta in M2).
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id                  UUID PRIMARY KEY,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('admin','customer','system')),
  actor_id            UUID,
  action              TEXT NOT NULL,
  target_type         TEXT,
  target_id           UUID,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  visible_to_customer BOOLEAN NOT NULL DEFAULT FALSE,
  ip                  INET,
  user_agent_hash     TEXT
);
CREATE INDEX idx_audit_actor            ON audit_log (actor_type, actor_id, ts DESC);
CREATE INDEX idx_audit_target           ON audit_log (target_type, target_id, ts DESC);
CREATE INDEX idx_audit_customer_visible ON audit_log (target_id, ts DESC) WHERE visible_to_customer;

-- The owner of audit_log (portal_user) holds implicit UPDATE/DELETE privileges
-- that REVOKE cannot strip. A trigger enforces append-only at row level — even
-- a superuser must explicitly DISABLE TRIGGER ALL to mutate or drop a row.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only; UPDATE and DELETE are forbidden';
END;
$$;

CREATE TRIGGER audit_log_block_modify
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- ---------------------------------------------------------------------------
-- Customers (with envelope-encrypted DEK).
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id              UUID PRIMARY KEY,
  razon_social    TEXT NOT NULL,
  nif             TEXT,
  domicilio       TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  dek_ciphertext  BYTEA NOT NULL,
  dek_iv          BYTEA NOT NULL,
  dek_tag         BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Admins (separate table; portal-managed).
-- ---------------------------------------------------------------------------

CREATE TABLE admins (
  id                UUID PRIMARY KEY,
  email             CITEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  totp_secret_enc   BYTEA,
  totp_iv           BYTEA,
  totp_tag          BYTEA,
  webauthn_creds    JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  backup_codes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  language          CHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en','es')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Customer users.
-- ---------------------------------------------------------------------------

CREATE TABLE customer_users (
  id                 UUID PRIMARY KEY,
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email              CITEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  password_hash      TEXT,
  totp_secret_enc    BYTEA,
  totp_iv            BYTEA,
  totp_tag           BYTEA,
  webauthn_creds     JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_otp_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  backup_codes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  language           CHAR(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en','es')),
  invite_token_hash  TEXT,
  invite_expires_at  TIMESTAMPTZ,
  invite_consumed_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Sessions (server-side; cookie carries only the random ID).
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  user_type           TEXT NOT NULL CHECK (user_type IN ('admin','customer')),
  user_id             UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  step_up_at          TIMESTAMPTZ,
  device_fingerprint  TEXT,
  ip                  INET,
  revoked_at          TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions (user_type, user_id, revoked_at);

-- ---------------------------------------------------------------------------
-- Rate-limit buckets (IP+identifier keyed).
-- ---------------------------------------------------------------------------

CREATE TABLE rate_limit_buckets (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  reset_at     TIMESTAMPTZ NOT NULL,
  locked_until TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Email outbox (queue + retry + idempotency).
-- ---------------------------------------------------------------------------

CREATE TABLE email_outbox (
  id              UUID PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  to_address      CITEXT NOT NULL,
  template        TEXT NOT NULL,
  locale          CHAR(2) NOT NULL DEFAULT 'en',
  locals          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  send_after      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON email_outbox (status, send_after) WHERE status IN ('queued','failed');

-- ---------------------------------------------------------------------------
-- Projects (required for NDA generation).
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  objeto_proyecto TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived','done')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Documents (versioned via parent_id chain; sha256 verified on every download).
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id                   UUID PRIMARY KEY,
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  project_id           UUID REFERENCES projects(id) ON DELETE SET NULL,
  parent_id            UUID REFERENCES documents(id) ON DELETE SET NULL,
  category             TEXT NOT NULL CHECK (category IN ('nda-draft','nda-signed','nda-audit','invoice','generic')),
  storage_path         TEXT NOT NULL,
  original_filename    TEXT NOT NULL,
  mime_type            TEXT NOT NULL,
  size_bytes           BIGINT NOT NULL,
  sha256               CHAR(64) NOT NULL,
  uploaded_by_admin_id UUID REFERENCES admins(id),
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_docs_customer ON documents (customer_id, category, uploaded_at DESC);

-- ---------------------------------------------------------------------------
-- Invoices (overdue computed app-side from due_on + status).
-- ---------------------------------------------------------------------------

CREATE TABLE invoices (
  id             UUID PRIMARY KEY,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,
  amount_cents   BIGINT NOT NULL,
  currency       CHAR(3) NOT NULL DEFAULT 'EUR',
  issued_on      DATE NOT NULL,
  due_on         DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Credentials (payload encrypted with the customer's DEK).
-- ---------------------------------------------------------------------------

CREATE TABLE credentials (
  id                 UUID PRIMARY KEY,
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  label              TEXT NOT NULL,
  payload_ciphertext BYTEA NOT NULL,
  payload_iv         BYTEA NOT NULL,
  payload_tag        BYTEA NOT NULL,
  needs_update       BOOLEAN NOT NULL DEFAULT FALSE,
  created_by         TEXT NOT NULL CHECK (created_by IN ('admin','customer')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Credential requests (admin-initiated; field schema only, no values).
-- ---------------------------------------------------------------------------

CREATE TABLE credential_requests (
  id                      UUID PRIMARY KEY,
  customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  requested_by_admin_id   UUID NOT NULL REFERENCES admins(id),
  provider                TEXT NOT NULL,
  fields                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','not_applicable','cancelled')),
  not_applicable_reason   TEXT,
  fulfilled_credential_id UUID REFERENCES credentials(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- NDAs (template_version_sha = sha256 of rendered template at generation time).
-- ---------------------------------------------------------------------------

CREATE TABLE ndas (
  id                    UUID PRIMARY KEY,
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  project_id            UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  draft_document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  signed_document_id    UUID REFERENCES documents(id),
  audit_document_id     UUID REFERENCES documents(id),
  template_version_sha  CHAR(64) NOT NULL,
  generated_by_admin_id UUID NOT NULL REFERENCES admins(id),
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Provider catalogue (seed in M7).
-- ---------------------------------------------------------------------------

CREATE TABLE provider_catalogue (
  slug           TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  default_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  active         BOOLEAN NOT NULL DEFAULT TRUE
);
