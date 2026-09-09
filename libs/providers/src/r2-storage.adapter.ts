import { createHash, createHmac } from 'node:crypto';
import {
  ProviderUnavailableError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type StoragePort,
  type StoredObject,
} from './ports';

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
 *
 * ADR-0022 adds the server-side verbs — `getObject`, `putObject`,
 * `deleteObject` — for the one flow where the API does handle bytes: an
 * avatar is read from the private bucket, processed, and written to the
 * public one. Same recipe, signed into the `Authorization` header instead of
 * the query string.
 */
export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Test seam; production uses the global fetch. */
  fetch?: typeof fetch;
};

const SERVICE = 's3';
const REGION = 'auto';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const REQUEST_TIMEOUT_MS = 10_000;
const EMPTY_PAYLOAD_HASH = createHash('sha256').update('').digest('hex');

const sha256Hex = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest();

/** Every path segment is escaped, but the separators stay separators. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function amzTimestamps(now = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export class R2StorageAdapter implements StoragePort {
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: R2Config) {
    this.fetcher = config.fetch ?? fetch;
  }

  private get host(): string {
    return `${this.config.accountId}.r2.cloudflarestorage.com`;
  }

  private signingKey(dateStamp: string): Buffer {
    return hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), REGION), SERVICE),
      'aws4_request',
    );
  }

  async presignUpload(
    key: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const host = this.host;
    const { amzDate, dateStamp } = amzTimestamps();
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
    const signature = createHmac('sha256', this.signingKey(dateStamp))
      .update(stringToSign, 'utf8')
      .digest('hex');

    return {
      url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresInSeconds,
    };
  }

  async getObject(
    key: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<StoredObject> {
    const res = await this.signedRequest('GET', key, { signal: options.signal });
    if (res.status === 404) throw new StorageObjectNotFoundError(key);
    if (!res.ok) throw new ProviderUnavailableError('r2', `GET ${res.status}`);

    const max = options.maxBytes ?? Number.POSITIVE_INFINITY;
    // Refused on the declared length first, so an oversized object is never
    // held in memory; then on the real length, because a header is a claim.
    const declared = Number(res.headers.get('content-length') ?? 'NaN');
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new StorageObjectTooLargeError(key, max);
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > max) throw new StorageObjectTooLargeError(key, max);
    return {
      body,
      contentType: res.headers.get('content-type'),
      contentLength: body.byteLength,
    };
  }

  async putObject(
    key: string,
    body: Uint8Array,
    contentType: string,
    options: { cacheControl?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    const res = await this.signedRequest('PUT', key, {
      body,
      contentType,
      ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
      signal: options.signal,
    });
    if (!res.ok) throw new ProviderUnavailableError('r2', `PUT ${res.status}`);
  }

  async deleteObject(key: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const res = await this.signedRequest('DELETE', key, { signal: options.signal });
    // Gone is the goal: a 404 means someone got there first.
    if (res.status === 404 || res.ok) return;
    throw new ProviderUnavailableError('r2', `DELETE ${res.status}`);
  }

  /**
   * SigV4 with the signature in the `Authorization` header. Every header
   * that is sent is signed, so a proxy cannot rewrite the content type or
   * the cache policy of what lands in the bucket.
   */
  private async signedRequest(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    input: {
      body?: Uint8Array;
      contentType?: string;
      cacheControl?: string;
      signal?: AbortSignal | undefined;
    },
  ): Promise<Response> {
    const host = this.host;
    const { amzDate, dateStamp } = amzTimestamps();
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const payloadHash = input.body ? sha256Hex(input.body) : EMPTY_PAYLOAD_HASH;

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (input.contentType) headers['content-type'] = input.contentType;
    if (input.cacheControl) headers['cache-control'] = input.cacheControl;

    const names = Object.keys(headers).sort();
    const signedHeaders = names.join(';');
    const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
    const canonicalUri = `/${this.config.bucket}/${encodeKey(key)}`;
    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', this.signingKey(dateStamp))
      .update(stringToSign, 'utf8')
      .digest('hex');

    const { host: _host, ...sent } = headers;
    void _host;
    return this.fetcher(`https://${host}${canonicalUri}`, {
      method,
      headers: {
        ...sent,
        authorization: `${ALGORITHM} Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      ...(input.body ? { body: input.body } : {}),
      signal: input.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}
