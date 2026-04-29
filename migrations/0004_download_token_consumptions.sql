-- Single-use enforcement for signed download tokens (spec §2.7).
--
-- A signed download token is base64url(payload || HMAC). The token's HMAC
-- alone proves authenticity + freshness (60s TTL); single-use is enforced
-- by INSERTing the token-hash on first valid GET — a duplicate key on a
-- replayed token bounces with 410 Gone.
--
-- The 60s TTL keeps this table small. M10 will add a periodic prune of
-- rows where expires_at < now() - interval '1 hour' (cushion past clock
-- skew + ad-hoc 5-minute admin step-up windows).

CREATE TABLE download_token_consumptions (
  token_hash   CHAR(64) PRIMARY KEY,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  consumed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_dtc_expires ON download_token_consumptions (expires_at);
