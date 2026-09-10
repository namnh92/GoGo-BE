/**
 * Whether this environment can take an upload at all: R2 credentials and a
 * bucket, or the test fake. Bound by `UploadsModule`; exported from its own
 * file because both the module and the service import it, and a constant
 * read at decorator time must not sit behind a circular import.
 *
 * Also what a profile reports as `capabilities.avatarUpload` (ADR-0022): the
 * same condition the endpoint enforces, read from the same place, so a client
 * can disable the control before a picker opens.
 */
export const MEDIA_UPLOADS_CONFIGURED = 'MEDIA_UPLOADS_CONFIGURED';
