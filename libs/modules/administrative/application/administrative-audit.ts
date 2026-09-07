/**
 * ADM-005 (#458) — the audit vocabulary for administrative datasets.
 *
 * One resource type and a closed set of actions, named here rather than spelled
 * out at each call site: an audit trail whose action strings drift is a trail
 * nobody can query, and the rejected variants exist because a refused
 * publication is exactly the event a reviewer needs to find later.
 */
export const AUDIT_RESOURCE = 'administrative_dataset';

export const AUDIT_ACTION = {
  import: 'administrative_dataset.import',
  validate: 'administrative_dataset.validate',
  validateRejected: 'administrative_dataset.validate_rejected',
  publish: 'administrative_dataset.publish',
  publishRejected: 'administrative_dataset.publish_rejected',
  rollback: 'administrative_dataset.rollback',
  rollbackRejected: 'administrative_dataset.rollback_rejected',
} as const;
