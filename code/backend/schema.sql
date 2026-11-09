-- Start-First OPTIONAL telemetry production storage blueprint, NOT applied or deployed.
-- Review data-processing policy, database roles, migrations, backups and security first.
-- No Task.title, Task.note, Step.text, email, IP or user-agent columns permitted.
BEGIN;

CREATE TABLE IF NOT EXISTS telemetry_installations (
  installation_id UUID PRIMARY KEY,
  policy_version TEXT NOT NULL,
  write_token_hash CHAR(64) NOT NULL UNIQUE,
  deletion_token_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  installation_id UUID NOT NULL REFERENCES telemetry_installations(installation_id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  event_name TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version SMALLINT NOT NULL CHECK (schema_version = 1),
  attributes JSONB NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
  PRIMARY KEY (installation_id, event_id)
);
CREATE INDEX IF NOT EXISTS telemetry_received_name_idx
  ON telemetry_events(received_at, event_name);

COMMIT;

-- Operational requirements (not automated in this blueprint):
-- 1. Validate exact per-event attribute allowlists in API before any insert.
-- 2. Use INSERT ... ON CONFLICT DO NOTHING with canonical-content mismatch detection.
-- 3. Use a single transaction for each validated batch, token revocation and deletion.
-- 4. Schedule DELETE FROM telemetry_events WHERE received_at < now() - interval '90 days';
--    then delete inactive installations under an approved data-retention policy.
-- 5. Do not allow application role to create schema or read raw events through admin API.
-- 6. Disclose backup expiration and enforce independently managed backups / restore tests.
