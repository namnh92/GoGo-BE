import { createHash, createHmac } from 'node:crypto';
import type { StoragePort } from './ports';

/**
 * BE-BFF-011/016 — presigned PUT against R2 (S3-compatible), signed here
 * rather than through an SDK.
 *
 * SigV4 is a hashing recipe, not a protocol: implementing it directly avoids
 * pulling the AWS SDK in for one URL, and keeps the signing rules visible at
 * the point where a mistake would silently produce a URL the storage rejects.
 *
 * The bytes never touch the API. That is the point of presigning: a phone
 * uploads a 4 MB photo straight to storage, and the API only ever handles the
 * key.
 */
export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

const SERVICE = 's3';
const REGION = 'auto';
const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest();

/** Every path segment is escaped, but the separators stay separators. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export class R2StorageAdapter implements StoragePort {
  constructor(private readonly config: R2Config) {}

  async presignUpload(
    key: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const host = `${this.config.accountId}.r2.cloudflarestorage.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

    // content-type is signed, so storage rejects an upload whose type does not
    // match what was authorized. Advertising a limit the server does not
    // enforce would leave the allowlist decorative.
    const signedHeaders = 'content-type;host';
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;

    const query = new URLSearchParams({
      'X-Amz-Algorithm': ALGORITHM,
      'X-Amz-Credential': `${this.config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': signedHeaders,
    });
    // S3 requires the query string sorted by key, byte order.
    const canonicalQuery = [...query.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const canonicalUri = `/${this.config.bucket}/${encodeKey(key)}`;
    const canonicalRequest = [
      'PUT',
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      // The body is unknown at signing time; the client sends whatever it has.
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), REGION), SERVICE),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return {
      url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresInSeconds,
    };
  }
}
