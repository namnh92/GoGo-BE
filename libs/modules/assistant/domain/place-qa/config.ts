/** Code-reviewed grammar/state limits. Not CMS-editable. */
export const PLACE_QA_CONFIG_VERSION = 's3-v1';
export const PLACE_QA_PENDING_TTL_MS = 30 * 60 * 1000;
export const PLACE_QA_SEMANTIC_VERSION = 1;

// S2 remains the owner of these calibrated values; S3 reuses them unchanged.
export {
  PLACE_QA_WEAK_THRESHOLD,
  PLACE_QA_RETRIEVAL_THRESHOLD,
  PLACE_QA_CANDIDATE_LIMIT,
} from './resolution';
export { PLACE_NAME_READING_LIMIT } from './span';
