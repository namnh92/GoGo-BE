import { idempotencyKeyFrom } from './idempotency-key';
import {
  NO_PROVIDER_METRICS,
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  type NotificationProviderPort,
  type ProviderMetrics,
  type PushSendResult,
  type UserNotification,
} from './ports';
import { withResilience } from './resilience';

/**
 * NTF-BE-002 (#193) — the one place GoGo-BE speaks to OneSignal.
 *
 * REST only, `Authorization: Key <App API key>` on `api.onesignal.com` (the
 * current key generation; the legacy `Basic` scheme on `onesignal.com/api/v1`
 * is not used — GoGo-Infra#13 verified the DEV key against this host). Targets
 * are `include_aliases.external_id`, i.e. `users.id`; GoGo never sees a device
 * token (spec §24–§26).
 *
 * Failure classes, so the worker can decide what to do with each:
 *
 * - network error, 429, 5xx → transient. `withResilience` retries with jitter
 *   and trips the breaker; what escapes is `ProviderUnavailableError`, which
 *   the outbox backs off and retries. Safe because every send carries an
 *   `idempotency_key` the provider honours for 30 days — a retry after a
 *   half-delivered attempt is a replay, not a second push.
 * - 401/403 → `ProviderConfigurationError`. Retrying a refused credential
 *   produces the same answer; not retried, does not touch the breaker.
 * - 400 → `ProviderInvalidRequestError`. Our payload, our bug; same treatment.
 *
 * Nothing here logs. The key sits in one header and is never interpolated into
 * an error message or a metric label.
 */
export const ONESIGNAL_API_BASE = 'https://api.onesignal.com';

/**
 * The provider accepts 20,000 external_ids per request. Chunking well below
 * that keeps one bad id from poisoning a large batch's 400 and bounds the body.
 */
export const ONESIGNAL_MAX_ALIASES_PER_REQUEST = 2_000;

export type OneSignalPushConfig = {
  /** Public app id — also the `iss` of identity JWTs (#199). */
  appId: string;
  /** The App API key. Server-side only; SSM `onesignal/rest-api-key`. */
  restApiKey: string;
  /** Override for tests. */
  baseUrl?: string;
};

type OneSignalCreateResponse = {
  id?: string;
  external_id?: string | null;
  errors?: string[] | { invalid_aliases?: { external_id?: string[] } };
};

const RESILIENCE = {
  name: 'onesignal.push',
  timeoutMs: 10_000,
  retries: 2,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
} as const;

export class OneSignalPushAdapter implements NotificationProviderPort {
  private readonly baseUrl: string;

  constructor(
    private readonly config: OneSignalPushConfig,
    private readonly metrics: ProviderMetrics = NO_PROVIDER_METRICS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!config.appId || !config.restApiKey) {
      throw new ProviderConfigurationError('onesignal.push', 'MISSING_CREDENTIAL');
    }
    this.baseUrl = (config.baseUrl ?? ONESIGNAL_API_BASE).replace(/\/+$/, '');
  }

  sendToUser(userId: string, notification: UserNotification): Promise<PushSendResult> {
    return this.sendToUsers([userId], notification);
  }

  async sendToUsers(
    userIds: readonly string[],
    notification: UserNotification,
  ): Promise<PushSendResult> {
    const unique = [...new Set(userIds)].filter((id) => id.length > 0);
    if (unique.length === 0) {
      return {
        providerMessageId: null,
        providerMessageIds: [],
        emptyResponses: 0,
        unknownUserIds: [],
      };
    }

    const results: PushSendResult[] = [];
    for (let offset = 0; offset < unique.length; offset += ONESIGNAL_MAX_ALIASES_PER_REQUEST) {
      const chunk = unique.slice(offset, offset + ONESIGNAL_MAX_ALIASES_PER_REQUEST);
      // The first chunk keeps the caller's key; later chunks derive their own,
      // so a retry of a five-chunk send replays five sends, not one.
      const key =
        notification.idempotencyKey === undefined
          ? undefined
          : offset === 0
            ? idempotencyKeyFrom(notification.idempotencyKey)
            : idempotencyKeyFrom(
                `${notification.idempotencyKey}:${offset / ONESIGNAL_MAX_ALIASES_PER_REQUEST}`,
              );
      results.push(await this.create(chunk, notification, key));
    }
    const providerMessageIds = results.flatMap((r) => r.providerMessageIds);
    return {
      providerMessageId: providerMessageIds[0] ?? null,
      providerMessageIds,
      emptyResponses: results.reduce((n, r) => n + r.emptyResponses, 0),
      unknownUserIds: results.flatMap((r) => r.unknownUserIds),
    };
  }

  private async create(
    externalIds: string[],
    notification: UserNotification,
    idempotencyKey: string | undefined,
  ): Promise<PushSendResult> {
    const body = JSON.stringify({
      app_id: this.config.appId,
      include_aliases: { external_id: externalIds },
      target_channel: 'push',
      headings: notification.headings,
      contents: notification.contents,
      ...(notification.data ? { data: notification.data } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    });

    return withResilience(RESILIENCE, async (signal) => {
      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/notifications?c=push`, {
          method: 'POST',
          headers: {
            authorization: `Key ${this.config.restApiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
          signal,
        });
      } catch (err) {
        this.metrics.increment('push_provider_requests_total', { status: 'network' });
        throw err;
      }
      const status = response.status;
      this.metrics.increment('push_provider_requests_total', { status });
      this.metrics.observe(
        'push_provider_request_duration_seconds',
        (Date.now() - started) / 1000,
        {
          status,
        },
      );

      if (status === 401 || status === 403) {
        throw new ProviderConfigurationError('onesignal.push', 'AUTH_FAILED', `HTTP ${status}`);
      }
      if (status === 400) {
        // The body names the offending field; keep it as the cause for a
        // debugger, never in the message a log line would carry.
        const detail = await response.text().catch(() => '');
        throw new ProviderInvalidRequestError('onesignal.push', 'INVALID_ARGUMENT', detail);
      }
      if (!response.ok) {
        // 429 and 5xx — transient by contract (spec §30); the wrapper decides
        // whether to try again and when to stop.
        throw new Error(`onesignal responded ${status}`);
      }

      const json = (await response.json()) as OneSignalCreateResponse;
      // `id: ""` with `errors: ["All included players are not subscribed"]` is
      // the documented "accepted, nobody to deliver to" answer — HTTP 200, no
      // message. It is reported as an empty response, never as a send.
      const id = typeof json.id === 'string' && json.id.length > 0 ? json.id : null;
      const unknownUserIds =
        json.errors && !Array.isArray(json.errors)
          ? (json.errors.invalid_aliases?.external_id ?? [])
          : [];
      return {
        providerMessageId: id,
        providerMessageIds: id ? [id] : [],
        emptyResponses: id ? 0 : 1,
        unknownUserIds,
      };
    });
  }
}
