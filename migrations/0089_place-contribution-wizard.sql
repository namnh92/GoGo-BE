ALTER TABLE place_submissions ADD COLUMN enrichment jsonb;
--> statement-breakpoint
CREATE TABLE place_contribution_drafts (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 google_place_id text NOT NULL,
 enrichment jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX place_contribution_drafts_owner_idx ON place_contribution_drafts(user_id);
--> statement-breakpoint
CREATE INDEX place_contribution_drafts_expiry_idx ON place_contribution_drafts(expires_at);
--> statement-breakpoint
ALTER TABLE assistant_credit_ledger DROP CONSTRAINT assistant_credit_ledger_check;
--> statement-breakpoint
ALTER TABLE assistant_credit_ledger ADD CONSTRAINT assistant_credit_ledger_check CHECK
 ((reason='submission_approved' AND delta IN (20,50,70) AND submission_id IS NOT NULL AND venue_identity IS NOT NULL AND usage_ledger_id IS NULL)
 OR (reason='message_spent' AND delta=-1 AND usage_ledger_id IS NOT NULL AND submission_id IS NULL AND venue_identity IS NULL)) NOT VALID;
--> statement-breakpoint
WITH vocabulary(kind,key,vi,en) AS (VALUES
 ('amenity','power_at_each_table','Ổ cắm từng bàn','Power at each table'),
 ('amenity','separate_smoking_area','Khu hút thuốc riêng','Separate smoking area'),
 ('amenity','open_after_23','Mở sau 23h','Open after 23:00'),
 ('amenity','tables_over_six','Bàn cho nhóm trên 6 người','Tables for more than six'),
 ('checkin_tag','service_friendly','Phục vụ thân thiện','Friendly service'),
 ('checkin_tag','service_attentive','Phục vụ chu đáo','Attentive service'),
 ('checkin_tag','space_quiet','Không gian yên tĩnh','Quiet space'),
 ('checkin_tag','space_spacious','Không gian rộng rãi','Spacious space'))
INSERT INTO taxonomies(kind,key) SELECT kind::taxonomy_kind,key FROM vocabulary ON CONFLICT (kind,key) DO NOTHING;
--> statement-breakpoint
WITH vocabulary(kind,key,vi,en) AS (VALUES
 ('amenity','power_at_each_table','Ổ cắm từng bàn','Power at each table'),
 ('amenity','separate_smoking_area','Khu hút thuốc riêng','Separate smoking area'),
 ('amenity','open_after_23','Mở sau 23h','Open after 23:00'),
 ('amenity','tables_over_six','Bàn cho nhóm trên 6 người','Tables for more than six'),
 ('checkin_tag','service_friendly','Phục vụ thân thiện','Friendly service'),
 ('checkin_tag','service_attentive','Phục vụ chu đáo','Attentive service'),
 ('checkin_tag','space_quiet','Không gian yên tĩnh','Quiet space'),
 ('checkin_tag','space_spacious','Không gian rộng rãi','Spacious space'))
INSERT INTO taxonomy_labels(taxonomy_id,locale,label)
SELECT t.id,l.locale,l.label FROM vocabulary v JOIN taxonomies t ON t.kind::text=v.kind AND t.key=v.key
CROSS JOIN LATERAL (VALUES ('vi',v.vi),('en',v.en)) l(locale,label)
ON CONFLICT (taxonomy_id,locale) DO NOTHING;

--> statement-breakpoint
-- Approval attaches user contributions to a separate set, never place_media.
ALTER TABLE place_submission_photos ADD COLUMN place_id uuid REFERENCES places(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX place_submission_photos_place_idx ON place_submission_photos(place_id, status);
