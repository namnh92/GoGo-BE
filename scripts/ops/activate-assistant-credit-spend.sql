-- Audited policy cutover ONLY, never executed by deployment or an HTTP route.
-- Before running: validate migration/indexes/seeds, fence and drain all legacy
-- writers/in-flight executions, record compatible consumer/fleet release evidence.
-- D1 does NOT bind a billing artifact or activate paid admission. D2 must supply
-- provider bound/finality/recovery evidence before a separate reviewed binding.
-- psql -X -v ON_ERROR_STOP=1 -v operator_id=<admin-uuid> -v evidence=<audit-reference> "$DATABASE_URL" -f scripts/ops/activate-assistant-credit-spend.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT singleton FROM assistant_credit_spend_control WHERE singleton=true FOR UPDATE;
-- Refuse an unidentifiable operator or empty audit reference.
SELECT 1/count(*)::int FROM admin_users WHERE id=:'operator_id'::uuid AND role='super_admin' AND status='active' AND length(trim(:'evidence'))>0;
WITH switched AS (
 UPDATE assistant_credit_spend_control SET policy_key='free_then_actual_cost_v1',epoch=epoch+1,
  activated_at=clock_timestamp(),bound_version=NULL WHERE singleton=true AND policy_key='legacy_allowance_v1' AND epoch=0
 RETURNING policy_key,epoch
)
INSERT INTO audit_logs(actor_type,actor_id,action,resource_type,resource_id,diff)
 SELECT 'admin', :'operator_id'::uuid,'assistant.credit_policy_activated','assistant_credit_spend_control','singleton',
 jsonb_build_object('policyKey',policy_key,'epoch',epoch,'evidence',:'evidence') FROM switched;
COMMIT;
