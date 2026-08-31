-- BE-CMS-G4e (#226) — notification campaigns, dispatched through the outbox.
--
-- A campaign never sends from the request path. The API validates and stores;
-- a worker claims what is due, resolves the audience at send time, and hands
-- each message to the provider adapter. A campaign sent by mistake cannot be
-- recalled, so the only way it can start is a row transition something else
-- picks up.
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'campaign';--> statement-breakpoint

-- At-least-once delivery means a retry must be a no-op rather than a second
-- push. `dedupe_key` existed and was never unique, so nothing stopped one.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_unique
  ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;--> statement-breakpoint

CREATE TYPE campaign_status AS ENUM (
  'draft',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
  'failed'
);--> statement-breakpoint

-- Only the audiences the backend can actually resolve from data it holds.
-- `city`, `app_version` and `custom_segment` from the mockup are absent on
-- purpose: nothing stores a user's city or their app version, and a campaign
-- aimed at a segment the server cannot compute would be sent to the wrong
-- people, which is not recoverable.
CREATE TYPE campaign_audience AS ENUM ('all', 'couple', 'group', 'platform');--> statement-breakpoint

CREATE TYPE campaign_destination AS ENUM (
  'home',
  'place',
  'recommendation',
  'plan_template',
  'saved',
  'external_url'
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS notification_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The editorial name; `title` is what lands on a lock screen.
  name text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  -- Key from POST /cms/uploads, purpose `campaign_image`.
  image_key text,
  cta_label text,
  audience_type campaign_audience NOT NULL,
  -- Closed shape per audience type, validated at the API boundary.
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  destination_type campaign_destination NOT NULL DEFAULT 'home',
  destination_value text,
  status campaign_status NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  -- Stamped when a send is scheduled and used to build each message's dedupe
  -- key, so a worker retry cannot deliver twice while a genuine re-send after
  -- a cancel still can.
  dispatch_key uuid,
  recipient_count integer,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  last_error text,
  -- A test send is a request the worker picks up, never a provider call in the
  -- request path, and it never touches `status`.
  test_send_requested_at timestamptz,
  test_send_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  test_send_completed_at timestamptz,
  created_by_admin_id uuid NOT NULL,
  cancelled_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_campaigns_name_unique UNIQUE (name),
  CONSTRAINT notification_campaigns_schedule_present CHECK (
    status <> 'scheduled' OR scheduled_at IS NOT NULL
  ),
  -- Every destination that points somewhere carries where; the ones that do
  -- not, do not. A dangling half of either is a deep link that goes nowhere.
  CONSTRAINT notification_campaigns_destination_value CHECK (
    (destination_type IN ('home', 'saved') AND destination_value IS NULL)
    OR (destination_type NOT IN ('home', 'saved') AND destination_value IS NOT NULL)
  )
);--> statement-breakpoint

-- The worker's claim query: what is due, oldest first.
CREATE INDEX IF NOT EXISTS notification_campaigns_due_idx
  ON notification_campaigns (scheduled_at)
  WHERE status = 'scheduled';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notification_campaigns_test_send_idx
  ON notification_campaigns (test_send_requested_at)
  WHERE test_send_requested_at IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notification_campaigns_list_idx
  ON notification_campaigns (created_at DESC, id DESC);

-- Rollback:
--   DROP TABLE IF EXISTS notification_campaigns;
--   DROP TYPE campaign_destination;
--   DROP TYPE campaign_audience;
--   DROP TYPE campaign_status;
--   DROP INDEX IF EXISTS notifications_dedupe_unique;
--   'campaign' cannot be removed from notification_kind in place; recreate the
--   type without it the way 0014 recreated taxonomy_kind, after deleting any
--   notification rows that use it.
