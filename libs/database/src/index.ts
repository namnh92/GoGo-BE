export { createDb, closeDb } from './client';
export type { Db } from './client';
export * as schema from './schema';
export type { IngestMessage, MatchCandidate, SubmissionReviewDraft } from './schema/ingestion';
export { WorkerLease } from './worker-lease';
export type { HeldLease, LeaseQuery, WorkerLeaseOptions } from './worker-lease';
export {
  eraseSuperAdminPasswordIfConfirmed,
  formatSyncFailure,
  syncSuperAdmin,
  SuperAdminSyncConflict,
  SuperAdminSyncError,
} from './super-admin-sync';
export type { SyncSuperAdminInput, SyncSuperAdminResult } from './super-admin-sync';
export { errorFacts, summarizeError } from './error-summary';
export type { ErrorFacts } from './error-summary';
