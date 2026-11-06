-- Replacement enum is usable inside the all-pending-migrations transaction,
-- including fresh databases. ADD VALUE followed by seeds is not safe there.
-- Preserve the existing vocabulary (including future extension values).
DO $$
DECLARE labels text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='taxonomy_kind' AND e.enumlabel='amenity') THEN
    SELECT string_agg(quote_literal(e.enumlabel), ',' ORDER BY e.enumsortorder) INTO labels
      FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='taxonomy_kind';
    EXECUTE 'CREATE TYPE taxonomy_kind_discovery AS ENUM (' || labels || ',''amenity'')';
    ALTER TABLE taxonomies ALTER COLUMN kind TYPE taxonomy_kind_discovery USING kind::text::taxonomy_kind_discovery;
    DROP TYPE taxonomy_kind;
    ALTER TYPE taxonomy_kind_discovery RENAME TO taxonomy_kind;
  END IF;
END $$;
--> statement-breakpoint
WITH vocabulary(kind,key,vi,en) AS (VALUES
 ('amenity','car_parking','Đỗ ô tô','Car parking'),
 ('amenity','motorbike_parking','Đỗ xe máy','Motorbike parking'),
 ('amenity','wifi','Wi-Fi','Wi-Fi'),
 ('amenity','power_outlets','Ổ cắm điện','Power outlets'),
 ('amenity','card_payment','Thanh toán thẻ','Card payment'),
 ('amenity','qr_payment','Thanh toán QR','QR payment'),
 ('amenity','pets_allowed','Cho phép thú cưng','Pets allowed'),
 ('suitability','couple','Cặp đôi','Couple'),
 ('suitability','group','Nhóm bạn','Group'),
 ('suitability','family','Gia đình','Family'),
 ('suitability','work_reading','Làm việc / đọc sách','Work / reading'))
INSERT INTO taxonomies(kind,key)
SELECT kind::taxonomy_kind,key FROM vocabulary ON CONFLICT (kind,key) DO NOTHING;
--> statement-breakpoint
WITH vocabulary(kind,key,vi,en) AS (VALUES
 ('amenity','car_parking','Đỗ ô tô','Car parking'),
 ('amenity','motorbike_parking','Đỗ xe máy','Motorbike parking'),
 ('amenity','wifi','Wi-Fi','Wi-Fi'),
 ('amenity','power_outlets','Ổ cắm điện','Power outlets'),
 ('amenity','card_payment','Thanh toán thẻ','Card payment'),
 ('amenity','qr_payment','Thanh toán QR','QR payment'),
 ('amenity','pets_allowed','Cho phép thú cưng','Pets allowed'),
 ('suitability','couple','Cặp đôi','Couple'),
 ('suitability','group','Nhóm bạn','Group'),
 ('suitability','family','Gia đình','Family'),
 ('suitability','work_reading','Làm việc / đọc sách','Work / reading'))
INSERT INTO taxonomy_labels(taxonomy_id,locale,label)
SELECT t.id,l.locale,l.label FROM vocabulary v JOIN taxonomies t ON t.kind::text=v.kind AND t.key=v.key
CROSS JOIN LATERAL (VALUES ('vi',v.vi),('en',v.en)) l(locale,label)
ON CONFLICT (taxonomy_id,locale) DO NOTHING;
