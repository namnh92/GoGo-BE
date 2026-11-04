import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../shared/app-error';

/**
 * NTF-BE-017 (#747), ADR-0038 — the `device:` namespace and the credential behind
 * it.
 *
 * A user's external id is their uuid, so nothing a user path produces can start
 * with this prefix, and a device path only ever builds one from a uuid this
 * service minted. The provider JWT is for the provider: the credential GoGo's own
 * API accepts is this one, and it reaches device-scoped calls and nothing else.
 */
export const DEVICE_EXTERNAL_ID_PREFIX = 'device:';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function deviceExternalId(deviceId: string): string {
  if (!UUID.test(deviceId)) throw new Error('A device identity is a uuid');
  return `${DEVICE_EXTERNAL_ID_PREFIX}${deviceId}`;
}

export function isDeviceExternalId(externalId: string): boolean {
  return externalId.startsWith(DEVICE_EXTERNAL_ID_PREFIX);
}

export type DeviceCredential = { deviceId: string; secret: string };

/** `Authorization: Device <deviceId>.<deviceSecret>`. The secret is base64url. */
const DEVICE_AUTHORIZATION = /^Device ([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,128})$/i;

export function parseDeviceAuthorization(header: string | undefined): DeviceCredential {
  const match = header ? DEVICE_AUTHORIZATION.exec(header) : null;
  if (!match || !UUID.test(match[1]!)) {
    throw AppError.unauthorized('DEVICE_CREDENTIAL_REQUIRED', 'Device credential required');
  }
  return { deviceId: match[1]!.toLowerCase(), secret: match[2]! };
}

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function deviceSecretMatches(secret: string, storedHash: string): boolean {
  const given = Buffer.from(hashDeviceSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/** Issuance and reporting need the flag on; retiring an identity never does. */
export const DEVICE_IDENTITY_FLAG = 'push.device_identity.enabled';

/** Never confirmed by a report within this long: expired by the worker (D9). */
export const DEVICE_UNCONFIRMED_DAYS = 7;
/** No renewal or report for this long: expired by the worker (D9). */
export const DEVICE_INACTIVE_DAYS = 90;
/** How long a retired identity stays after its provider cleanup (owner 2026-11-04). */
export const DEVICE_RETAINED_AFTER_CLEANUP_DAYS = 30;
/**
 * Provider cleanup waits this long after retirement: the identity's last JWT has
 * expired (≤ 1 h, ADR-0017) and the device has had time to move its subscription.
 * Deleting a provider user sooner could take a subscription still on the way out.
 */
export const DEVICE_CLEANUP_DELAY_SECONDS = 3_600;
