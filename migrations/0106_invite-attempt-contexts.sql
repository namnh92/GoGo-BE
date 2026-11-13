-- I05 additive expand after 0105 room host transfer.
CREATE TABLE invite_attempt_contexts (
  id uuid PRIMARY KEY,
  proof_hash text NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'invite_attempts',
  transport text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT invite_attempt_purpose CHECK (purpose = 'invite_attempts'),
  CONSTRAINT invite_attempt_transport CHECK (transport IN ('MOBILE_HEADER', 'BROWSER_COOKIE')),
  CONSTRAINT invite_attempt_ttl CHECK (expires_at = created_at + interval '48 hours')
);
CREATE INDEX invite_attempt_contexts_expiry_idx ON invite_attempt_contexts (expires_at);
CREATE TABLE invite_attempt_replays (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  context_id uuid NOT NULL REFERENCES invite_attempt_contexts(id),
  ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX invite_attempt_replays_expiry_idx ON invite_attempt_replays (expires_at);
CREATE TABLE invite_bootstrap_buckets (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX invite_bootstrap_buckets_expiry_idx ON invite_bootstrap_buckets (expires_at);
