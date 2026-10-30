import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_API_BASE,
  OpenRouterUsageClient,
  OpenRouterUsageError,
  foldActivity,
  foldKeys,
  openRouterUsageFromEnv,
} from './openrouter-usage.adapter';

/**
 * GoGo-BE#709 — the adapter against `/keys` and `/activity`. Bodies follow
 * the `@openrouter/sdk` 1.5.3 schemas (openrouter.ai was not reachable from
 * the authoring session); nothing here talks to OpenRouter.
 */

const KEY = ['sk', 'or', 'v1', 'management', 'test'].join('-');
const WS = '6c0053e7-ee6e-48c0-8e45-4ff6b0237c7e';
const HASH = 'f01d52606dc8f0a8303a7b5cc3fa07109c2e346cec7c0a16b40de462992ce943';

// Shape seen on the live account (2026-10-22): `label` is a masked preview of
// the key itself, the name the owner typed is `name`.
const KEYS = {
  data: [
    {
      hash: HASH,
      name: 'gogo_jev_dev',
      label: 'sk-or-v1-f2c...61a',
      disabled: false,
      usage: 1.5,
      usage_daily: 0.02,
      usage_weekly: 0.4,
      usage_monthly: 1.2,
    },
    {
      hash: 'abc12345def',
      name: 'gogo_claude_dev',
      label: 'sk-or-v1-f20...a88',
      disabled: true,
      usage_daily: 0,
      usage_monthly: 0.3,
    },
  ],
};

const ACTIVITY = {
  data: [
    {
      date: '2026-10-21',
      model: 'typesafe/jev-1.14',
      model_permaslug: 'typesafe/jev-1.14-20261014',
      endpoint_id: 'e',
      provider_name: 'TypeSafe',
      usage: 0.000042,
      byok_usage_inference: 0,
      requests: 3,
      prompt_tokens: 1000,
      completion_tokens: 6,
      reasoning_tokens: 0,
    },
    { date: '2026-10-20', model: 'other/model', usage: 0.01, requests: 1 },
  ],
};

type Call = { url: string; init: RequestInit };

function fetchWith(status: number, body: unknown, calls: Call[] = []) {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function caught(p: Promise<unknown>): Promise<OpenRouterUsageError> {
  try {
    await p;
  } catch (err) {
    return err as OpenRouterUsageError;
  }
  throw new Error('expected a rejection');
}

describe('foldKeys', () => {
  it('keeps hash, name, disabled and daily/monthly USD, sorted by name', () => {
    expect(foldKeys(KEYS)).toEqual([
      {
        hash: 'abc12345def',
        name: 'gogo_claude_dev',
        disabled: true,
        usageDailyUsd: 0,
        usageMonthlyUsd: 0.3,
      },
      {
        hash: HASH,
        name: 'gogo_jev_dev',
        disabled: false,
        usageDailyUsd: 0.02,
        usageMonthlyUsd: 1.2,
      },
    ]);
  });

  it('never reads or keeps the masked key preview in `label`', () => {
    const out = foldKeys(KEYS);
    expect(JSON.stringify(out)).not.toContain('sk-or-v1');
    expect(out.every((k) => !('label' in k))).toBe(true);
  });

  it('a key without a name is kept as (unnamed) — its spend still counts', () => {
    const body = {
      data: [{ hash: 'abc12345', label: 'sk-or-v1-aaa...bbb', usage_daily: 0.5, usage_monthly: 1 }],
    };
    expect(foldKeys(body).map((k) => [k.name, k.usageDailyUsd])).toEqual([['(unnamed)', 0.5]]);
  });

  it('drops entries without a hash or a usable usage figure — never reads them as zero', () => {
    const body = {
      data: [
        { name: 'x', usage_daily: 0, usage_monthly: 0 },
        { hash: 'abc12345', name: 'x', usage_daily: 'n/a', usage_monthly: 0 },
        { hash: 'abc12345', name: 'x', usage_daily: -1, usage_monthly: 0 },
        null,
      ],
    };
    expect(foldKeys(body)).toEqual([]);
  });

  it('a body without a data list is BAD_RESPONSE', () => {
    for (const body of [{}, { data: {} }, null, []]) {
      expect(() => foldKeys(body)).toThrow(expect.objectContaining({ code: 'BAD_RESPONSE' }));
    }
  });
});

describe('foldActivity', () => {
  it('maps items, optional counters default to 0, sorted by day then model', () => {
    expect(foldActivity(ACTIVITY)).toEqual([
      {
        day: '2026-10-20',
        model: 'other/model',
        modelPermaslug: null,
        providerName: null,
        usageUsd: 0.01,
        byokUsageUsd: null,
        requests: 1,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
      },
      {
        day: '2026-10-21',
        model: 'typesafe/jev-1.14',
        modelPermaslug: 'typesafe/jev-1.14-20261014',
        providerName: 'TypeSafe',
        usageUsd: 0.000042,
        byokUsageUsd: 0,
        requests: 3,
        promptTokens: 1000,
        completionTokens: 6,
        reasoningTokens: 0,
      },
    ]);
  });

  it('drops an item without a valid date, model or USD figure', () => {
    const body = {
      data: [
        { date: '21/10/2026', model: 'm', usage: 1 },
        { date: '2026-10-21', usage: 1 },
        { date: '2026-10-21', model: 'm' },
        { date: '2026-10-21', model: 'm', usage: Number.NaN },
      ],
    };
    expect(foldActivity(body)).toEqual([]);
  });

  it('an explicit empty list is a measured "no spend"; a missing list is BAD_RESPONSE', () => {
    expect(foldActivity({ data: [] })).toEqual([]);
    expect(() => foldActivity({})).toThrow(expect.objectContaining({ code: 'BAD_RESPONSE' }));
  });
});

describe('OpenRouterUsageClient', () => {
  it('GETs /keys and /activity with the bearer key, nothing else', async () => {
    const calls: Call[] = [];
    const k = new OpenRouterUsageClient(KEY, fetchWith(200, KEYS, calls).fetchImpl);
    await k.keys();
    const a = new OpenRouterUsageClient(KEY, fetchWith(200, ACTIVITY, calls).fetchImpl);
    await a.activity(HASH);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', `${OPENROUTER_API_BASE}/keys`],
      ['GET', `${OPENROUTER_API_BASE}/activity?api_key_hash=${HASH}`],
    ]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('maps 401/403/429/5xx to codes, and no message carries the key, URL or body', async () => {
    for (const [status, code] of [
      [401, 'AUTH_FAILED'],
      [403, 'FORBIDDEN'],
      [429, 'RATE_LIMITED'],
      [502, 'HTTP_502'],
    ] as const) {
      const err = await caught(
        new OpenRouterUsageClient(
          KEY,
          fetchWith(status, { error: { message: `echo ${KEY}` } }).fetchImpl,
        ).keys(),
      );
      expect(err).toBeInstanceOf(OpenRouterUsageError);
      expect(err.code).toBe(code);
      expect(err.message).not.toContain(KEY);
      expect(err.message).not.toContain('openrouter.ai');
    }
  });

  it('a network error or a non-JSON body is BAD_RESPONSE without the raw error', async () => {
    const throwing = (async () => {
      throw new Error(`connect failed Authorization: Bearer ${KEY}`);
    }) as typeof fetch;
    const net = await caught(new OpenRouterUsageClient(KEY, throwing).keys());
    expect(net.code).toBe('BAD_RESPONSE');
    expect(net.message).not.toContain(KEY);
    const text = await caught(
      new OpenRouterUsageClient(KEY, fetchWith(200, 'not json').fetchImpl).keys(),
    );
    expect(text.code).toBe('BAD_RESPONSE');
  });

  it('refuses a malformed key hash before any request', async () => {
    const calls: Call[] = [];
    const c = new OpenRouterUsageClient(KEY, fetchWith(200, ACTIVITY, calls).fetchImpl);
    for (const bad of ['', 'short', 'abc12345&x=1', '../keys']) {
      expect((await caught(c.activity(bad))).code).toBe('INVALID_ARGUMENT');
    }
    expect(calls).toEqual([]);
  });

  it('GoGo-BE#729: a workspace id scopes /keys; /activity stays key-hash only', async () => {
    const calls: Call[] = [];
    const k = new OpenRouterUsageClient(KEY, fetchWith(200, KEYS, calls).fetchImpl, undefined, WS);
    await k.keys();
    const a = new OpenRouterUsageClient(
      KEY,
      fetchWith(200, ACTIVITY, calls).fetchImpl,
      undefined,
      WS,
    );
    await a.activity(HASH);
    expect(calls.map((c) => c.url)).toEqual([
      `${OPENROUTER_API_BASE}/keys?workspace_id=${WS}`,
      `${OPENROUTER_API_BASE}/activity?api_key_hash=${HASH}`,
    ]);
  });

  it('GoGo-BE#729: refuses a workspace slug or anything but a UUID before any request', () => {
    for (const bad of ['', 'gogo', `${WS}&x=1`, `${WS} `, '../keys']) {
      expect(() => new OpenRouterUsageClient(KEY, fetch, undefined, bad)).toThrow(
        OpenRouterUsageError,
      );
    }
  });

  it('refuses an empty or whitespace key', () => {
    expect(() => new OpenRouterUsageClient('')).toThrow(OpenRouterUsageError);
    expect(() => new OpenRouterUsageClient('a b')).toThrow(OpenRouterUsageError);
  });
});

describe('openRouterUsageFromEnv', () => {
  it('needs OPENROUTER_MANAGEMENT_KEY; the runtime OPENROUTER_API_KEY is not used', () => {
    expect(openRouterUsageFromEnv({})).toBeNull();
    expect(openRouterUsageFromEnv({ OPENROUTER_MANAGEMENT_KEY: ' ' })).toBeNull();
    expect(openRouterUsageFromEnv({ OPENROUTER_API_KEY: KEY })).toBeNull();
    expect(openRouterUsageFromEnv({ OPENROUTER_MANAGEMENT_KEY: KEY })).toBeInstanceOf(
      OpenRouterUsageClient,
    );
  });

  it('GoGo-BE#729: OPENROUTER_WORKSPACE_ID scopes /keys; blank keeps the Default Workspace', async () => {
    for (const [ws, url] of [
      [` ${WS} `, `${OPENROUTER_API_BASE}/keys?workspace_id=${WS}`],
      ['  ', `${OPENROUTER_API_BASE}/keys`],
      [undefined, `${OPENROUTER_API_BASE}/keys`],
    ] as const) {
      const calls: Call[] = [];
      const env = { OPENROUTER_MANAGEMENT_KEY: KEY, OPENROUTER_WORKSPACE_ID: ws };
      await openRouterUsageFromEnv(env, fetchWith(200, KEYS, calls).fetchImpl)!.keys();
      expect(calls.map((c) => c.url)).toEqual([url]);
    }
    expect(() =>
      openRouterUsageFromEnv({ OPENROUTER_MANAGEMENT_KEY: KEY, OPENROUTER_WORKSPACE_ID: 'gogo' }),
    ).toThrow(OpenRouterUsageError);
  });
});
