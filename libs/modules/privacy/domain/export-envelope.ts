import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * GoGo-BE#256, ADR-0031 §1 — envelope encryption for one privacy export.
 *
 * A fresh 256-bit data key per artifact encrypts the JSON with AES-256-GCM
 * (96-bit random nonce, 128-bit tag). The data key is wrapped by a versioned,
 * environment-specific wrapping key that lives only in the secret manager
 * (`EXPORT_WRAPPING_KEY_V<n>`). Storage holds the ciphertext; the database
 * holds the wrapped key, its nonce/tag and the key version — never both
 * halves in one place, and never a plaintext key anywhere.
 *
 * Format version, export id and subject id are authenticated as AAD on both
 * layers, so an object cannot be replayed under another artifact or account.
 *
 * Nothing here touches the filesystem: plaintext exists only in process memory
 * for the length of one call.
 */

export const EXPORT_FORMAT_VERSION = 1;
const MAGIC = Buffer.from('GGX1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Bytes the object adds around the ciphertext: magic, nonce, tag. */
export const EXPORT_ENVELOPE_OVERHEAD = MAGIC.length + NONCE_BYTES + TAG_BYTES;

/** The wrapping key version an artifact names is not configured here. Fails closed. */
export class ExportKeyUnavailableError extends Error {
  constructor(readonly keyVersion: number) {
    super(`export wrapping key v${keyVersion} is not configured`);
    this.name = 'ExportKeyUnavailableError';
  }
}

/** Authentication failed: tampered, truncated, or bound to another artifact. */
export class ExportIntegrityError extends Error {
  constructor(readonly stage: 'format' | 'unwrap' | 'decrypt') {
    super(`export artifact failed authentication at ${stage}`);
    this.name = 'ExportIntegrityError';
  }
}

export class ExportKeyringConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportKeyringConfigError';
  }
}

export type ExportKeyring = {
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, Buffer>;
};

const KEY_NAME = /^EXPORT_WRAPPING_KEY_V([1-9][0-9]{0,3})$/;
/** Standard base64 of exactly 32 bytes, as `openssl rand -base64 32` prints it. */
const KEY_VALUE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Reads every `EXPORT_WRAPPING_KEY_V<n>` from a config object (the API's
 * validated env, or the worker's `process.env`). The active version is
 * `EXPORT_WRAPPING_KEY_ACTIVE` when set, otherwise the highest present; older
 * versions stay configured until the artifacts they wrapped are gone.
 *
 * `null` when none is set: the feature is unavailable, never open. A value
 * that is set but malformed throws — a typo must not boot into a cipher with
 * the wrong key length.
 */
export function parseExportKeyring(env: Record<string, unknown>): ExportKeyring | null {
  const keys = new Map<number, Buffer>();
  for (const [name, raw] of Object.entries(env)) {
    const match = KEY_NAME.exec(name);
    if (!match || raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || !KEY_VALUE.test(raw)) {
      throw new ExportKeyringConfigError(`${name} must be 32 random bytes, base64-encoded`);
    }
    keys.set(Number(match[1]), Buffer.from(raw, 'base64'));
  }
  if (keys.size === 0) return null;
  const rawActive = env.EXPORT_WRAPPING_KEY_ACTIVE;
  const activeVersion =
    rawActive === undefined || rawActive === null || rawActive === ''
      ? Math.max(...keys.keys())
      : Number(rawActive);
  if (!keys.has(activeVersion)) {
    throw new ExportKeyringConfigError(
      `EXPORT_WRAPPING_KEY_ACTIVE names v${String(rawActive)}, which is not configured`,
    );
  }
  return { activeVersion, keys };
}

export type ExportIdentity = { exportId: string; subjectUserId: string };

export type WrappedDataKey = {
  keyVersion: number;
  wrappedKey: Buffer;
  wrapNonce: Buffer;
  wrapTag: Buffer;
};

export type SealedExport = WrappedDataKey & {
  /** MAGIC | nonce | ciphertext | tag — what goes to private storage. */
  object: Buffer;
  formatVersion: number;
  plaintextBytes: number;
};

function dataAad(id: ExportIdentity): Buffer {
  return Buffer.from(
    `gogo.privacy-export|v${EXPORT_FORMAT_VERSION}|data|${id.exportId}|${id.subjectUserId}`,
    'utf8',
  );
}

function wrapAad(id: ExportIdentity, keyVersion: number): Buffer {
  return Buffer.from(
    `gogo.privacy-export|v${EXPORT_FORMAT_VERSION}|wrap|${id.exportId}|${id.subjectUserId}|k${keyVersion}`,
    'utf8',
  );
}

export function sealExport(
  plaintext: Buffer,
  id: ExportIdentity,
  keyring: ExportKeyring,
): SealedExport {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(dataAad(id));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const keyVersion = keyring.activeVersion;
    const wrappingKey = keyring.keys.get(keyVersion)!;
    const wrapNonce = randomBytes(NONCE_BYTES);
    const wrap = createCipheriv('aes-256-gcm', wrappingKey, wrapNonce, {
      authTagLength: TAG_BYTES,
    });
    wrap.setAAD(wrapAad(id, keyVersion));
    const wrappedKey = Buffer.concat([wrap.update(dataKey), wrap.final()]);

    return {
      object: Buffer.concat([MAGIC, nonce, ciphertext, tag]),
      formatVersion: EXPORT_FORMAT_VERSION,
      plaintextBytes: plaintext.byteLength,
      keyVersion,
      wrappedKey,
      wrapNonce,
      wrapTag: wrap.getAuthTag(),
    };
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Authenticates everything before returning anything. GCM establishes
 * authenticity at `final()` (Node docs, `decipher.setAuthTag`), so the bytes
 * `update()` produced are held, never exposed, until `final()` has passed; a
 * failure zeroes them and throws `ExportIntegrityError`.
 */
export function openExport(
  object: Uint8Array,
  envelope: WrappedDataKey,
  id: ExportIdentity,
  keyring: ExportKeyring | null,
): Buffer {
  const wrappingKey = keyring?.keys.get(envelope.keyVersion);
  if (!wrappingKey) throw new ExportKeyUnavailableError(envelope.keyVersion);

  const buf = Buffer.from(object.buffer, object.byteOffset, object.byteLength);
  if (buf.byteLength < EXPORT_ENVELOPE_OVERHEAD || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ExportIntegrityError('format');
  }

  let dataKey: Buffer;
  try {
    const unwrap = createDecipheriv('aes-256-gcm', wrappingKey, envelope.wrapNonce, {
      authTagLength: TAG_BYTES,
    });
    unwrap.setAAD(wrapAad(id, envelope.keyVersion));
    unwrap.setAuthTag(envelope.wrapTag);
    dataKey = Buffer.concat([unwrap.update(envelope.wrappedKey), unwrap.final()]);
  } catch {
    throw new ExportIntegrityError('unwrap');
  }

  const nonce = buf.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const tag = buf.subarray(buf.byteLength - TAG_BYTES);
  const ciphertext = buf.subarray(MAGIC.length + NONCE_BYTES, buf.byteLength - TAG_BYTES);
  let held: Buffer | null = null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(dataAad(id));
    decipher.setAuthTag(tag);
    held = decipher.update(ciphertext);
    const tail = decipher.final();
    const plaintext = tail.byteLength > 0 ? Buffer.concat([held, tail]) : held;
    held = null;
    return plaintext;
  } catch {
    held?.fill(0);
    throw new ExportIntegrityError('decrypt');
  } finally {
    dataKey.fill(0);
  }
}

/** The export would exceed the configured plaintext limit. Never truncated. */
export class ExportTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`export exceeds ${limitBytes} bytes`);
    this.name = 'ExportTooLargeError';
  }
}

/**
 * JSON.stringify of a plain export document, written section by section and
 * array element by array element, refusing as soon as the running UTF-8 size
 * passes `maxBytes`. The output is byte-identical to `JSON.stringify(doc)` for
 * the data an export holds (no functions, no cycles).
 */
export function serializeBounded(doc: Record<string, unknown>, maxBytes: number): Buffer {
  const parts: string[] = [];
  let size = 0;
  const push = (chunk: string) => {
    size += Buffer.byteLength(chunk, 'utf8');
    if (size > maxBytes) throw new ExportTooLargeError(maxBytes);
    parts.push(chunk);
  };
  push('{');
  let first = true;
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined || typeof value === 'function') continue;
    push(`${first ? '' : ','}${JSON.stringify(key)}:`);
    first = false;
    if (Array.isArray(value)) {
      push('[');
      value.forEach((item, i) => push(`${i === 0 ? '' : ','}${JSON.stringify(item) ?? 'null'}`));
      push(']');
    } else {
      push(JSON.stringify(value));
    }
  }
  push('}');
  return Buffer.from(parts.join(''), 'utf8');
}
