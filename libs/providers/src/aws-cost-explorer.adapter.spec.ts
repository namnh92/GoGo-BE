import { describe, expect, it } from 'vitest';
import {
  AWS_CE_TARGET,
  AwsCostExplorerClient,
  AwsCostExplorerError,
  awsCostExplorerFromEnv,
  decimalToMicros,
  foldCostAndUsage,
  shiftDay,
} from './aws-cost-explorer.adapter';

/**
 * COST-BE-027 (#386) — the adapter against the documented GetCostAndUsage
 * body (docs.aws.amazon.com, fetched 2026-09-03). Nothing here talks to AWS.
 */

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret/key+example' };

const BODY = {
  GroupDefinitions: [{ Key: 'SERVICE', Type: 'DIMENSION' }],
  ResultsByTime: [
    {
      Estimated: false,
      TimePeriod: { Start: '2026-09-01', End: '2026-09-02' },
      Groups: [
        {
          Keys: ['AWS Systems Manager'],
          Metrics: {
            UnblendedCost: { Amount: '0.1337464807', Unit: 'USD' },
            AmortizedCost: { Amount: '0.1337464807', Unit: 'USD' },
          },
        },
        {
          Keys: ['Amazon Simple Storage Service'],
          Metrics: { UnblendedCost: { Amount: '39.1603300457', Unit: 'USD' } },
        },
      ],
      Total: {},
    },
    {
      Estimated: true,
      TimePeriod: { Start: '2026-09-02', End: '2026-09-03' },
      Groups: [
        {
          Keys: ['AWS Systems Manager'],
          Metrics: { UnblendedCost: { Amount: '0', Unit: 'USD' } },
        },
      ],
      Total: {},
    },
  ],
};

type Call = { url: string; init: RequestInit };

function fetchWith(
  responses: { status: number; body: unknown }[] | { status: number; body: unknown },
  calls: Call[] = [],
): { fetchImpl: typeof fetch; calls: Call[] } {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/x-amz-json-1.1' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const client = (fetchImpl: typeof fetch) => new AwsCostExplorerClient(CREDS, fetchImpl);
const WINDOW = { from: '2026-09-01', to: '2026-09-02' };

describe('decimalToMicros', () => {
  it('converts a decimal string exactly, truncating past the sixth digit', () => {
    expect(decimalToMicros('0.1337464807')).toBe(133_746);
    expect(decimalToMicros('39.1603300457')).toBe(39_160_330);
    expect(decimalToMicros('0')).toBe(0);
    expect(decimalToMicros('12')).toBe(12_000_000);
    expect(decimalToMicros('.5')).toBe(500_000);
    expect(decimalToMicros('-1.25')).toBe(-1_250_000);
    // A credit or refund keeps its sign; nothing clamps money at zero here.
    expect(decimalToMicros('-0.000001')).toBe(-1);
  });

  it('accepts a JSON number and refuses anything that is not a number', () => {
    expect(decimalToMicros(1.5)).toBe(1_500_000);
    expect(() => decimalToMicros('abc')).toThrow(AwsCostExplorerError);
    expect(() => decimalToMicros('')).toThrow(/bad amount/);
    expect(() => decimalToMicros(null)).toThrow(/not a string/);
    expect(() => decimalToMicros('999999999999999999')).toThrow(/out of range/);
  });
});

describe('shiftDay', () => {
  it('moves across month and year boundaries in UTC', () => {
    expect(shiftDay('2026-09-02', 1)).toBe('2026-09-03');
    expect(shiftDay('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('foldCostAndUsage (pure)', () => {
  it('folds the documented body to (day, service) rows, sorted, carrying the Estimated flag', () => {
    // Sorted by day, then service under locale collation: "Amazon" before
    // "AWS" (m before w), which byte order would have reversed.
    expect(foldCostAndUsage(BODY)).toEqual([
      {
        day: '2026-09-01',
        service: 'Amazon Simple Storage Service',
        unblendedMicros: 39_160_330,
        amortizedMicros: null,
        currency: 'USD',
        estimated: false,
      },
      {
        day: '2026-09-01',
        service: 'AWS Systems Manager',
        unblendedMicros: 133_746,
        amortizedMicros: 133_746,
        currency: 'USD',
        estimated: false,
      },
      {
        day: '2026-09-02',
        service: 'AWS Systems Manager',
        unblendedMicros: 0,
        amortizedMicros: null,
        currency: 'USD',
        estimated: true,
      },
    ]);
  });

  it('drops a group with no UnblendedCost — an unreported cost is not a zero', () => {
    const body = {
      ResultsByTime: [
        {
          TimePeriod: { Start: '2026-09-01' },
          Groups: [
            { Keys: ['Amazon EC2'], Metrics: { UsageQuantity: { Amount: '10', Unit: 'N/A' } } },
            { Keys: [], Metrics: { UnblendedCost: { Amount: '1' } } },
            { Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '1.5' } } },
          ],
        },
      ],
    };
    expect(foldCostAndUsage(body)).toEqual([
      {
        day: '2026-09-01',
        service: 'Amazon EC2',
        unblendedMicros: 1_500_000,
        amortizedMicros: null,
        // Unit absent defaults to USD, the only currency the API reports here.
        currency: 'USD',
        estimated: false,
      },
    ]);
  });

  it('treats an absent list as empty, skips an unparseable day, and refuses a bad shape', () => {
    expect(foldCostAndUsage({})).toEqual([]);
    expect(foldCostAndUsage({ ResultsByTime: [] })).toEqual([]);
    expect(
      foldCostAndUsage({ ResultsByTime: [{ TimePeriod: { Start: 'nope' }, Groups: [] }] }),
    ).toEqual([]);
    expect(() => foldCostAndUsage({ ResultsByTime: 'x' })).toThrow(/not a list/);
    expect(() => foldCostAndUsage([])).toThrow(/not an object/);
    expect(() =>
      foldCostAndUsage({ ResultsByTime: [{ TimePeriod: { Start: '2026-09-01' }, Groups: 'x' }] }),
    ).toThrow(/Groups/);
  });
});

describe('AwsCostExplorerClient', () => {
  it('POSTs a SigV4-signed JSON-1.1 request with the daily SERVICE grouping and an exclusive End', async () => {
    const { fetchImpl, calls } = fetchWith({ status: 200, body: BODY });
    const costs = await client(fetchImpl).costsByService(WINDOW);
    expect(costs).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ce.us-east-1.amazonaws.com/');
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-amz-target']).toBe(AWS_CE_TARGET);
    expect(headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(headers.host).toBe('ce.us-east-1.amazonaws.com');
    expect(headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/ce\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    // The port's `to` is inclusive; the API's End is exclusive.
    expect(JSON.parse(String(init.body))).toEqual({
      TimePeriod: { Start: '2026-09-01', End: '2026-09-03' },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost', 'AmortizedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    });
  });

  it('signs the session token in when the identity is temporary', async () => {
    const { fetchImpl, calls } = fetchWith({ status: 200, body: BODY });
    await new AwsCostExplorerClient({ ...CREDS, sessionToken: 'tok' }, fetchImpl).costsByService(
      WINDOW,
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-amz-security-token']).toBe('tok');
    expect(headers.Authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target',
    );
  });

  it('follows NextPageToken and stops when it does not change', async () => {
    const page2 = {
      ResultsByTime: [
        {
          TimePeriod: { Start: '2026-09-02' },
          Groups: [{ Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '2' } } }],
        },
      ],
    };
    const { fetchImpl, calls } = fetchWith([
      { status: 200, body: { ...BODY, NextPageToken: 'page-2' } },
      { status: 200, body: page2 },
    ]);
    const costs = await client(fetchImpl).costsByService(WINDOW);
    expect(costs).toHaveLength(4);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init.body)).NextPageToken).toBe('page-2');
  });

  it('maps the JSON protocol’s __type onto a code, not the bare 400', async () => {
    const cases: [number, string, string][] = [
      [400, 'AccessDeniedException', 'ACCESS_DENIED'],
      [400, 'UnrecognizedClientException', 'AUTH_FAILED'],
      [400, 'InvalidSignatureException', 'AUTH_FAILED'],
      [400, 'LimitExceededException', 'THROTTLED'],
      [400, 'DataUnavailableException', 'DATA_UNAVAILABLE'],
      [400, 'BillExpirationException', 'DATA_UNAVAILABLE'],
      [400, 'ValidationException', 'BAD_REQUEST'],
      [403, '', 'ACCESS_DENIED'],
      [429, '', 'THROTTLED'],
      [500, '', 'HTTP_500'],
    ];
    for (const [status, type, code] of cases) {
      const { fetchImpl } = fetchWith({
        status,
        body: { __type: `com.amazonaws#${type}`, message: 'no' },
      });
      await expect(
        client(fetchImpl).costsByService(WINDOW),
        `${status} ${type}`,
      ).rejects.toMatchObject({ code });
    }
  });

  it('refuses a non-JSON body and an unreachable host', async () => {
    const { fetchImpl } = fetchWith({ status: 200, body: 'not json' });
    await expect(client(fetchImpl).costsByService(WINDOW)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(client(down).costsByService(WINDOW)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
      message: 'cost explorer unreachable',
    });
  });

  it('passes the abort signal through and lets an abort surface as itself', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    await expect(
      client(fetchImpl).costsByService({ ...WINDOW, signal: controller.signal }),
    ).rejects.toThrow('aborted');
  });

  it('refuses bad credentials and a bad window before any request is made', async () => {
    expect(() => new AwsCostExplorerClient({ accessKeyId: '', secretAccessKey: 'x' })).toThrow(
      /bad aws credentials/,
    );
    const { fetchImpl, calls } = fetchWith({ status: 200, body: BODY });
    for (const bad of [
      { from: '2026-09-02', to: '2026-09-01' },
      { from: 'nope', to: '2026-09-02' },
    ]) {
      await expect(client(fetchImpl).costsByService(bad)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
    expect(calls).toEqual([]);
  });
});

describe('awsCostExplorerFromEnv (INF-060 #114)', () => {
  it('returns null unless the dedicated key pair is present — an ambient AWS identity is not a fallback', () => {
    expect(awsCostExplorerFromEnv({})).toBeNull();
    expect(awsCostExplorerFromEnv({ AWS_COST_EXPLORER_ACCESS_KEY_ID: 'a' })).toBeNull();
    expect(awsCostExplorerFromEnv({ AWS_COST_EXPLORER_SECRET_ACCESS_KEY: 'b' })).toBeNull();
    expect(
      awsCostExplorerFromEnv({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }),
    ).toBeNull();
    expect(
      awsCostExplorerFromEnv({
        AWS_COST_EXPLORER_ACCESS_KEY_ID: '  ',
        AWS_COST_EXPLORER_SECRET_ACCESS_KEY: 'b',
      }),
    ).toBeNull();
  });

  it('builds a client, honouring the optional region and session token', () => {
    expect(
      awsCostExplorerFromEnv({
        AWS_COST_EXPLORER_ACCESS_KEY_ID: 'a',
        AWS_COST_EXPLORER_SECRET_ACCESS_KEY: 'b',
      }),
    ).toBeInstanceOf(AwsCostExplorerClient);
    const { fetchImpl, calls } = fetchWith({ status: 200, body: BODY });
    const c = awsCostExplorerFromEnv(
      {
        AWS_COST_EXPLORER_ACCESS_KEY_ID: 'a',
        AWS_COST_EXPLORER_SECRET_ACCESS_KEY: 'b',
        AWS_COST_EXPLORER_REGION: 'eu-central-1',
        AWS_COST_EXPLORER_SESSION_TOKEN: 'tok',
      },
      fetchImpl,
    )!;
    return c.costsByService(WINDOW).then(() => {
      expect(calls[0]!.url).toBe('https://ce.eu-central-1.amazonaws.com/');
      expect(calls[0]!.init.headers).toMatchObject({ 'x-amz-security-token': 'tok' });
    });
  });
});
