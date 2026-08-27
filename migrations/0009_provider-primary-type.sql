-- BE-IMP-004 (b): the provider's primary category, kept on the snapshot.
-- A name can be rewritten by the same owner; a restaurant becoming a karaoke
-- bar cannot. Storing it is what lets an update tell the two apart.
ALTER TABLE place_provider_sources ADD COLUMN IF NOT EXISTS primary_type text;
