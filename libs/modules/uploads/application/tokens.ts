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

/**
 * ADR-0022 — whether an avatar can be taken *and published* here: the private
 * bucket for the original, the public bucket with its own credential for the
 * processed object, and a public base URL to serve it from. What `GET /me`
 * reports as `capabilities.avatarUpload`, and what `POST /uploads` enforces
 * for purpose `avatar`.
 */
export const AVATAR_STORAGE_CONFIGURED = 'AVATAR_STORAGE_CONFIGURED';

/**
 * Whether catalogue media can be published in this environment (ADR-0005).
 *
 * The same requirement an avatar has — public bucket, its own credential, a
 * host to serve from — asked separately because they are different features
 * and an environment could gain one before the other. Without it the presigner
 * would fall back to the fake storage adapter and answer 201 with a
 * `fake-storage.local` URL: an upload that looks authorized and cannot work.
 */
export const CATALOGUE_STORAGE_CONFIGURED = 'CATALOGUE_STORAGE_CONFIGURED';
