import { describe, expect, it } from 'vitest';
import {
  EDGE_AUTH_HEADER,
  EDGE_CLIENT_IP_HEADER,
  createEdgeClientIpHook,
  vettedEdgeClientIp,
} from './edge-client-ip';

/**
 * SEC-004 (#445). The property under test is not "the good case works" — it is
 * that every other case is refused *and leaves nothing behind*, because the
 * failure this guards against is a header that outlives its rejection and gets
 * believed by the next reader.
 */

const TOKEN = 'x'.repeat(40);

function headers(extra: Record<string, string | string[]> = {}) {
  return { accept: 'application/json', ...extra } as Record<string, string | string[] | undefined>;
}

describe('vettedEdgeClientIp', () => {
  it('accepts a valid address from an authenticated hop', () => {
    const h = headers({ [EDGE_AUTH_HEADER]: TOKEN, [EDGE_CLIENT_IP_HEADER]: '203.0.113.7' });
    expect(vettedEdgeClientIp(h, TOKEN)).toBe('203.0.113.7');
  });

  it('accepts IPv6 as readily as IPv4', () => {
    const h = headers({ [EDGE_AUTH_HEADER]: TOKEN, [EDGE_CLIENT_IP_HEADER]: '2001:db8::1' });
    expect(vettedEdgeClientIp(h, TOKEN)).toBe('2001:db8::1');
  });

  it('trusts nothing when no token is configured', () => {
    // The state of every environment today. The safe answer has to be the
    // default, not something a deploy remembers to switch on.
    const h = headers({ [EDGE_AUTH_HEADER]: TOKEN, [EDGE_CLIENT_IP_HEADER]: '203.0.113.7' });
    expect(vettedEdgeClientIp(h, '')).toBeNull();
  });

  it('refuses a missing token', () => {
    const h = headers({ [EDGE_CLIENT_IP_HEADER]: '203.0.113.7' });
    expect(vettedEdgeClientIp(h, TOKEN)).toBeNull();
  });

  it('refuses a wrong token, including a prefix of the real one', () => {
    for (const wrong of ['y'.repeat(40), TOKEN.slice(0, 39), `${TOKEN}z`, '']) {
      const h = headers({ [EDGE_AUTH_HEADER]: wrong, [EDGE_CLIENT_IP_HEADER]: '203.0.113.7' });
      expect(vettedEdgeClientIp(h, TOKEN), wrong).toBeNull();
    }
  });

  it('refuses a token sent twice — two answers is not an answer', () => {
    const h = headers({
      [EDGE_AUTH_HEADER]: [TOKEN, 'other'],
      [EDGE_CLIENT_IP_HEADER]: '203.0.113.7',
    });
    expect(vettedEdgeClientIp(h, TOKEN)).toBeNull();
  });

  it('refuses a malformed address even from an authenticated hop', () => {
    const bad = [
      'not-an-ip',
      '203.0.113.7, 198.51.100.4', // an X-Forwarded-For-shaped list
      ' 203.0.113.7', // whitespace would make one visitor two buckets
      '203.0.113.7 ',
      '203.0.113.999',
      '203.0.113.7:443',
      '',
      '::ffff:203.0.113.7%eth0',
      "203.0.113.7'--",
    ];
    for (const value of bad) {
      const h = headers({ [EDGE_AUTH_HEADER]: TOKEN, [EDGE_CLIENT_IP_HEADER]: value });
      expect(vettedEdgeClientIp(h, TOKEN), value).toBeNull();
    }
  });

  it('refuses an address sent twice', () => {
    const h = headers({
      [EDGE_AUTH_HEADER]: TOKEN,
      [EDGE_CLIENT_IP_HEADER]: ['203.0.113.7', '198.51.100.4'],
    });
    expect(vettedEdgeClientIp(h, TOKEN)).toBeNull();
  });

  it('ignores X-Forwarded-For entirely — it is not the header this trusts', () => {
    const h = headers({ [EDGE_AUTH_HEADER]: TOKEN, 'x-forwarded-for': '203.0.113.7' });
    expect(vettedEdgeClientIp(h, TOKEN)).toBeNull();
  });
});

describe('createEdgeClientIpHook', () => {
  it('strips both headers and records the address on an authenticated request', () => {
    const req = {
      headers: headers({ [EDGE_AUTH_HEADER]: TOKEN, [EDGE_CLIENT_IP_HEADER]: '203.0.113.7' }),
    } as { headers: Record<string, string | string[] | undefined>; edgeClientIp?: string };
    createEdgeClientIpHook(TOKEN)(req);
    expect(req.edgeClientIp).toBe('203.0.113.7');
    expect(req.headers[EDGE_AUTH_HEADER]).toBeUndefined();
    expect(req.headers[EDGE_CLIENT_IP_HEADER]).toBeUndefined();
    expect(req.headers.accept).toBe('application/json');
  });

  it('strips a spoofed header and records nothing', () => {
    // The whole point. Anyone who can reach the origin can set this header;
    // what they must not be able to do is have it survive the hook.
    const req = {
      headers: headers({ [EDGE_CLIENT_IP_HEADER]: '203.0.113.7' }),
    } as { headers: Record<string, string | string[] | undefined>; edgeClientIp?: string };
    createEdgeClientIpHook(TOKEN)(req);
    expect(req.edgeClientIp).toBeUndefined();
    expect(req.headers[EDGE_CLIENT_IP_HEADER]).toBeUndefined();
  });

  it('strips the headers even when no token is configured', () => {
    const req = {
      headers: headers({ [EDGE_AUTH_HEADER]: TOKEN, [EDGE_CLIENT_IP_HEADER]: '203.0.113.7' }),
    } as { headers: Record<string, string | string[] | undefined>; edgeClientIp?: string };
    createEdgeClientIpHook('')(req);
    expect(req.edgeClientIp).toBeUndefined();
    expect(req.headers[EDGE_AUTH_HEADER]).toBeUndefined();
    expect(req.headers[EDGE_CLIENT_IP_HEADER]).toBeUndefined();
  });

  it('strips the address when the token is wrong, so the rejection leaves nothing', () => {
    const req = {
      headers: headers({
        [EDGE_AUTH_HEADER]: 'y'.repeat(40),
        [EDGE_CLIENT_IP_HEADER]: '203.0.113.7',
      }),
    } as { headers: Record<string, string | string[] | undefined>; edgeClientIp?: string };
    createEdgeClientIpHook(TOKEN)(req);
    expect(req.edgeClientIp).toBeUndefined();
    expect(req.headers[EDGE_CLIENT_IP_HEADER]).toBeUndefined();
    expect(req.headers[EDGE_AUTH_HEADER]).toBeUndefined();
  });
});
