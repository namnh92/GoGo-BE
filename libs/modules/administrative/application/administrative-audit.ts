/**
 * ADM-005 (#458) — the audit vocabulary for administrative datasets.
 *
 * One resource type and a closed set of actions, named here rather than spelled
 * out at each call site: an audit trail whose action strings drift is a trail
 * nobody can query, and the rejected variants exist because a refused
 * publication is exactly the event a reviewer needs to find later.
 */
export const AUDIT_RESOURCE = 'administrative_dataset';

/**
 * ADM-011 (#484) — reviewer adjudication of the advisory mapping source.
 *
 * A separate resource type from the dataset: a decision is about one quarantined
 * row, and a reviewer asking "who decided 00160, and why" should not have to
 * read past every publication of the dataset it belonged to.
 */
export const AUDIT_OVERRIDE_RESOURCE = 'administrative_mapping_override';

export const AUDIT_ACTION = {
  import: 'administrative_dataset.import',
  validate: 'administrative_dataset.validate',
  validateRejected: 'administrative_dataset.validate_rejected',
  publish: 'administrative_dataset.publish',
  publishRejected: 'administrative_dataset.publish_rejected',
  rollback: 'administrative_dataset.rollback',
  rollbackRejected: 'administrative_dataset.rollback_rejected',
} as const;

/**
 * The override vocabulary. `superseded` is written on the decision being
 * replaced, by the one replacing it — so the trail reads as a sequence of
 * opinions rather than as a value that changed.
 */
export const OVERRIDE_ACTION = {
  accepted: 'administrative_mapping_override.accepted',
  rejected: 'administrative_mapping_override.rejected',
  superseded: 'administrative_mapping_override.superseded',
  decisionRefused: 'administrative_mapping_override.decision_rejected',
  materialized: 'administrative_mapping_override_set.materialized',
  materializeRefused: 'administrative_mapping_override_set.materialize_rejected',
  abandoned: 'administrative_mapping_override_set.abandoned',
} as const;
