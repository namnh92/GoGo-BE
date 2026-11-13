-- Fence new producers first. Retain schema, creator, roles, versions, receipts,
-- audit and queued notifications. Deploy only ownership-aware compatibility code.
UPDATE room_host_transfer_rollout SET enabled=false WHERE singleton;
