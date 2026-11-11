/** Only allowlisted financial evidence crosses this port. No request/response bodies. */
export type AssistantCostReceipt = {
  revision: bigint;
  direct: string;
  upstream: string;
  fee: string;
  /** Provider-attested finality. GoGo policy finality is recorded independently at ingestion. */
  final: boolean;
  generationId?: string | undefined;
};
export interface AssistantCallRecorder {
  readonly requestId: string;
  generation(id: string): Promise<void>;
  receipt(receipt: AssistantCostReceipt): Promise<void>;
}
export interface AssistantBillingObserver {
  /** Must commit the intent and dispatch claim before returning. A retry calls this again. */
  start(provider: 'jev' | 'haiku', model: string): Promise<AssistantCallRecorder>;
}

/** Node >=22 JSON source context preserves decimal lexemes before Number rounding.
 * On older runtimes numeric costs become unknown, never reconstructed from a float. */
export function parseBillingJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (
      ['cost', 'total_cost', 'upstream_inference_cost'].includes(key) &&
      typeof value === 'number'
    )
      return context?.source === undefined
        ? undefined
        : (decimal(context.source) ?? context.source);
    return value;
  });
}
export function decimal(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1000) return null;
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value);
  if (!m) return null;
  const exponent = Number(m[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 500) return null;
  const digits = m[1]! + (m[2] ?? '');
  const point = m[1]!.length + exponent;
  const plain =
    point <= 0
      ? '0.' + '0'.repeat(-point) + digits
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : digits.slice(0, point) + '.' + digits.slice(point);
  const [whole, fraction] = plain.split('.');
  return (whole!.replace(/^0+(?=\d)/, '') || '0') + (fraction ? '.' + fraction : '');
}

export function openRouterReceipt(
  provider: 'jev' | 'haiku',
  raw: Record<string, unknown>,
  revision: bigint,
  generationId?: string,
): AssistantCostReceipt | null {
  const direct = decimal(raw.cost ?? raw.total_cost);
  const details =
    typeof raw.cost_details === 'object' && raw.cost_details !== null
      ? (raw.cost_details as Record<string, unknown>)
      : raw;
  const upstream = decimal(details.upstream_inference_cost);
  if (direct === null)
    return raw.cost == null && raw.total_cost == null
      ? null
      : { revision, direct: 'invalid', upstream: '0', fee: '0', final: false, generationId };
  // Shared-capacity upstream cost is already included in the OpenRouter charge.
  if (provider === 'jev' || raw.is_byok === false)
    return { revision, direct, upstream: '0', fee: '0', final: false, generationId };
  if (raw.is_byok !== true) return null;
  if (upstream === null)
    return details.upstream_inference_cost == null
      ? null
      : { revision, direct: 'invalid', upstream: '0', fee: '0', final: false, generationId };
  return { revision, direct: '0', upstream, fee: direct, final: false, generationId };
}

export function billingGenerationId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined;
}
export interface AssistantReceiptReader {
  read(
    provider: 'jev' | 'haiku',
    generationId: string,
    signal: AbortSignal,
  ): Promise<AssistantCostReceipt | null>;
}
/** Recovery only retrieves metadata. Never dispatches inference and never invents finality.
 * GET generation has no authoritative correction sequence/finality promise. Changed
 * evidence at its fixed revision is quarantined by ingestion, rather than reordered. */
export class OpenRouterAssistantReceiptReader implements AssistantReceiptReader {
  constructor(
    private readonly keys: { jev: string; haiku: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async read(provider: 'jev' | 'haiku', generationId: string, signal: AbortSignal) {
    if (!this.keys[provider]) return null;
    const url = new URL('https://openrouter.ai/api/v1/generation');
    url.searchParams.set('id', generationId);
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.keys[provider]}` },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = parseBillingJson(await response.text()) as { data?: Record<string, unknown> };
    if (!body.data || body.data.id !== generationId) return null;
    return openRouterReceipt(provider, body.data, 2n, generationId);
  }
}
