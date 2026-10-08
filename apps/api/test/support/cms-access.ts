import { generateKeyPairSync, sign } from 'node:crypto';

/**
 * GoGo-BE#687 D-4 — every CMS password login needs a verified Cloudflare Access
 * assertion for the same mailbox, with no exception. Integration specs get a
 * test Access application here, once per worker: the env names it (so the app
 * every spec builds is configured), `globalThis.fetch` answers its key set, and
 * `cmsAssertion(email)` signs an assertion the API verifies like a real one.
 *
 * Loaded as a vitest `setupFiles` entry, so it runs before any spec module sets
 * its own env and builds its app. Nothing here is reachable from production
 * code: it only supplies what Cloudflare would.
 */
export const TEST_ACCESS_TEAM = 'gogo-test.cloudflareaccess.com';
export const TEST_ACCESS_AUD = 'a'.repeat(64);
const KID = 'test-access-1';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });

process.env.CF_ACCESS_TEAM_DOMAIN ||= TEST_ACCESS_TEAM;
process.env.CF_ACCESS_AUD ||= TEST_ACCESS_AUD;

const CERTS_URL = `https://${TEST_ACCESS_TEAM}/cdn-cgi/access/certs`;
const realFetch = globalThis.fetch;
/**
 * Answers the test team's key set and passes everything else through. Also
 * exported: a spec that replaces `globalThis.fetch` before building its app
 * (the cost baseline's Google stub answers every unknown URL 404) hands this to
 * `CloudflareAccessService` directly.
 */
export const testAccessFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === CERTS_URL) {
    return Response.json({
      keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' }],
    });
  }
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = testAccessFetch;

/** An RS256 assertion for `email`, signed by the key the test team publishes. */
export function cmsAssertion(email: string): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${part({
    iss: `https://${TEST_ACCESS_TEAM}`,
    aud: TEST_ACCESS_AUD,
    sub: `sub-${email.toLowerCase()}`,
    email,
    iat: now,
    exp: now + 300,
  })}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}`;
}

/** The header a browser behind Access sends with a login. */
export const cmsAccessHeaders = (email: string) => ({
  'cf-access-jwt-assertion': cmsAssertion(email),
});
