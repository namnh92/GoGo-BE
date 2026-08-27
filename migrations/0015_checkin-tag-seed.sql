-- #171 — the starting check-in vocabulary.
--
-- Separate file because Postgres will not let a new enum value be *used* in
-- the transaction that added it, and 0014 adds `checkin_tag`.
--
-- These are the keys GoGo-MobileApp had defined locally because no taxonomy
-- existed. Seeding them keeps every check-in already collected meaningful and
-- moves ownership of the vocabulary to the CMS, where the labels live.
insert into taxonomies (kind, key, sort_order, is_active)
values
  ('checkin_tag', 'would_return', 1, true),
  ('checkin_tag', 'photogenic', 2, true),
  ('checkin_tag', 'good_value', 3, true),
  ('checkin_tag', 'quiet', 4, true),
  ('checkin_tag', 'crowded', 5, true),
  ('checkin_tag', 'slow_service', 6, true)
on conflict do nothing;

insert into taxonomy_labels (taxonomy_id, locale, label)
select t.id, v.locale, v.label
from taxonomies t
join (values
  ('would_return', 'vi', 'Muốn quay lại'),
  ('would_return', 'en', 'Would return'),
  ('photogenic', 'vi', 'Lên hình đẹp'),
  ('photogenic', 'en', 'Photogenic'),
  ('good_value', 'vi', 'Đáng tiền'),
  ('good_value', 'en', 'Good value'),
  ('quiet', 'vi', 'Yên tĩnh'),
  ('quiet', 'en', 'Quiet'),
  ('crowded', 'vi', 'Đông khách'),
  ('crowded', 'en', 'Crowded'),
  ('slow_service', 'vi', 'Phục vụ chậm'),
  ('slow_service', 'en', 'Slow service')
) as v(key, locale, label) on v.key = t.key
where t.kind = 'checkin_tag'
on conflict do nothing;

-- Rollback: delete from taxonomies where kind = 'checkin_tag';
