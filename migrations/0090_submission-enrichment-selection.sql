SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE places ADD COLUMN contribution_facts jsonb;
