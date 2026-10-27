-- GoGo-BE#713, ADR-0036 — GoGo AI assistant: conversations, messages, cited
-- sources, proposals, feedback, the usage ledger and the CMS "GoGo guide".
--
-- Additive only: eight new tables, no change to an existing table, so no lock
-- is taken on anything a running API reads. Every table is new and empty, so
-- the indexes are built on empty relations (no CONCURRENTLY needed).
--
-- Personal data (conversations, messages, sources, proposals, feedback) is
-- keyed by user_id and cascades from the conversation. Cards keep ids only:
-- no place fact is copied (CLAUDE.md, no new persistent Google content).
--
-- Rollback: turn `assistant.enabled` off (the default) — nothing reads or
-- writes these tables while it is off except history reads/deletes, export and
-- erasure. Rehearsal-only down, in this order:
--   DROP TABLE assistant_buffer_purges;
--   DROP TABLE assistant_document_versions;
--   DROP TABLE assistant_documents;
--   DROP TABLE assistant_usage_ledger;
--   DROP TABLE assistant_feedback;
--   DROP TABLE assistant_proposals;
--   DROP TABLE assistant_message_sources;
--   DROP TABLE assistant_messages;
--   DROP TABLE assistant_conversations;
CREATE TABLE assistant_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text,
  context_kind text,
  context_id uuid,
  message_count integer NOT NULL DEFAULT 0,
  preview text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_conversations_context_ck CHECK (
    (context_kind IS NULL AND context_id IS NULL)
    OR (context_kind IN ('place', 'plan') AND context_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX assistant_conversations_user_recent_idx
  ON assistant_conversations (user_id, last_message_at, id);
--> statement-breakpoint
CREATE INDEX assistant_conversations_retention_idx ON assistant_conversations (last_message_at);
--> statement-breakpoint
CREATE TABLE assistant_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  status text NOT NULL,
  text text NOT NULL DEFAULT '',
  locale text,
  context_kind text,
  context_id uuid,
  cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  follow_ups jsonb NOT NULL DEFAULT '[]'::jsonb,
  notice jsonb,
  error jsonb,
  frames jsonb,
  trace jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT assistant_messages_role_ck CHECK (role IN ('user', 'assistant')),
  CONSTRAINT assistant_messages_status_ck CHECK (
    status IN ('streaming', 'complete', 'stopped', 'fallback', 'failed', 'truncated')
  )
);
--> statement-breakpoint
CREATE INDEX assistant_messages_conversation_recent_idx
  ON assistant_messages (conversation_id, created_at, id);
--> statement-breakpoint
-- One reply at a time per conversation, held by the database rather than by a
-- check-then-insert in the API.
CREATE UNIQUE INDEX assistant_messages_one_streaming_uq
  ON assistant_messages (conversation_id) WHERE status = 'streaming';
--> statement-breakpoint
CREATE INDEX assistant_messages_streaming_lease_idx
  ON assistant_messages (lease_expires_at) WHERE status = 'streaming';
--> statement-breakpoint
CREATE TABLE assistant_message_sources (
  message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  idx integer NOT NULL,
  kind text NOT NULL,
  document_id uuid,
  version_id uuid,
  slug text,
  title text NOT NULL,
  description text,
  checked_at timestamptz,
  PRIMARY KEY (message_id, idx)
);
--> statement-breakpoint
CREATE TABLE assistant_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  values jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  dismissed_at timestamptz,
  CONSTRAINT assistant_proposals_status_ck CHECK (
    status IN ('pending', 'confirming', 'confirmed', 'dismissed', 'expired')
  )
);
--> statement-breakpoint
CREATE INDEX assistant_proposals_message_idx ON assistant_proposals (message_id);
--> statement-breakpoint
CREATE TABLE assistant_feedback (
  message_id uuid PRIMARY KEY REFERENCES assistant_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_feedback_rating_ck CHECK (rating IN ('up', 'down'))
);
--> statement-breakpoint
CREATE INDEX assistant_feedback_queue_idx ON assistant_feedback (created_at, message_id);
--> statement-breakpoint
-- The allowance and the spend ceiling read this ledger, not the messages, so
-- deleting a conversation neither refunds the day's allowance nor hides spend.
-- Unknown cost is NULL, never 0. Erasure nulls user_id.
CREATE TABLE assistant_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  message_id uuid,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'accepted',
  jev_calls integer NOT NULL DEFAULT 0,
  jev_model text,
  jev_input_tokens integer,
  jev_output_tokens integer,
  jev_cost_usd numeric(14, 8),
  haiku_calls integer NOT NULL DEFAULT 0,
  haiku_model text,
  haiku_input_tokens integer,
  haiku_output_tokens integer,
  haiku_upstream_cost_usd numeric(14, 8),
  haiku_openrouter_cost_usd numeric(14, 8),
  haiku_is_byok boolean
);
--> statement-breakpoint
CREATE INDEX assistant_usage_ledger_user_idx ON assistant_usage_ledger (user_id, accepted_at);
--> statement-breakpoint
CREATE INDEX assistant_usage_ledger_accepted_idx ON assistant_usage_ledger (accepted_at);
--> statement-breakpoint
CREATE TABLE assistant_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  locale text NOT NULL,
  status text NOT NULL,
  published_version_id uuid,
  draft_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_documents_locale_ck CHECK (locale IN ('vi', 'en')),
  CONSTRAINT assistant_documents_status_ck CHECK (status IN ('draft', 'published', 'unpublished'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_documents_slug_locale_uq ON assistant_documents (slug, locale);
--> statement-breakpoint
CREATE INDEX assistant_documents_updated_idx ON assistant_documents (updated_at, id);
--> statement-breakpoint
CREATE TABLE assistant_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES assistant_documents(id) ON DELETE CASCADE,
  number integer NOT NULL,
  state text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  body text NOT NULL,
  body_sha256 text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  search_text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  published_at timestamptz,
  published_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  publish_reason text,
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  withdraw_reason text,
  CONSTRAINT assistant_document_versions_state_ck CHECK (
    state IN ('draft', 'published', 'superseded', 'withdrawn', 'discarded')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_document_versions_number_uq
  ON assistant_document_versions (document_id, number);
--> statement-breakpoint
CREATE INDEX assistant_document_versions_doc_idx
  ON assistant_document_versions (document_id, number);
--> statement-breakpoint
-- Retrieval reads published versions only.
CREATE INDEX assistant_document_versions_search_idx
  ON assistant_document_versions USING gin (search_vector) WHERE state = 'published';
--> statement-breakpoint
-- At most one published version per document.
CREATE UNIQUE INDEX assistant_document_versions_one_published_uq
  ON assistant_document_versions (document_id) WHERE state = 'published';
--> statement-breakpoint
-- GoGo-BE#717 A-R-08: live frame buffers (Redis, 1 h) of messages an erasure
-- deleted; every API instance's reaper drops them and removes the row. Ids
-- only, never text.
CREATE TABLE assistant_buffer_purges (
  message_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
