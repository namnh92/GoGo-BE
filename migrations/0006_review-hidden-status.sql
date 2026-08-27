-- SEC-001: `hidden` is the emergency-takedown state for a review.
-- Deliberately not reusing `rejected`/`removed`: those are moderator verdicts
-- on content quality, while `hidden` records "taken down under time pressure by
-- whoever was on call, pending review". Conflating them would lose that
-- distinction in the audit trail and make the reversal ambiguous.
ALTER TYPE review_status ADD VALUE IF NOT EXISTS 'hidden';
