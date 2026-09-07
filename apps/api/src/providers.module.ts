import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  ACQUISITION_LINK_PROVIDER,
  AREA_AUTOCOMPLETE,
  FakeAreaAutocomplete,
  FakePlaceProvider,
  FakePush,
  FakeSheets,
  FakeStorage,
  GooglePlacesAdapter,
  GoogleRoutesAdapter,
  GoogleSheetsAdapter,
  HaversineTravelTime,
  METRICS_QUERY,
  OneSignalPushAdapter,
  NoAcquisitionLinkProvider,
  PLACE_PROVIDER,
  PrometheusQueryAdapter,
  PUSH_PROVIDER,
  SHEETS_PROVIDER,
  R2StorageAdapter,
  STORAGE_PROVIDER,
  TRAVEL_TIME_PROVIDER,
  TenjinAcquisitionLinkProvider,
  UnconfiguredPlaceProvider,
  UnconfiguredPushProvider,
  placeProviderStatus,
  pushProviderStatus,
  warnFakedProviders,
  resolveMetricsQueryConfig,
} from '@gogo/providers';
import {
  LogMetrics,
  METRICS,
  RUNTIME_METRICS,
  RUNTIME_STATE,
  RuntimeStateStore,
  GAUGE_SINK,
  MetricsRegistry,
  TeeMetrics,
  createLogger,
  type MetricsPort,
} from '@gogo/observability';
import { COST_USAGE_LEDGER, DB, DbUsageLedger } from '@gogo/modules';
import type { Db } from '@gogo/database';
import { METRICS_BASE, METRICS_REGISTRY } from './metrics.tokens';
import { APP_CONFIG, type AppConfig } from './config/env';

/**
 * BE-BFF-011 — port binding. Real adapters only when credentials exist;
 * otherwise deterministic fakes so every environment boots and every flow
 * has a fallback. (R2 real adapter lands when credentials are issued —
 * tracked on GoGo-BE#60. Push is OneSignal, #193.)
 */
@Global()
@Module({
  providers: [
    {
      // #279: the mode decides, not the presence of a secret. `google` with no
      // key binds a provider that refuses — never the fake, which would answer
      // a real Google Maps link with "no such place".
      provide: PLACE_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) => {
        const status = placeProviderStatus(config);
        if (status.provider === 'fake') return new FakePlaceProvider();
        if (status.provider === 'unconfigured') return new UnconfiguredPlaceProvider();
        return new GooglePlacesAdapter(config.GOOGLE_PLACES_API_KEY, metrics);
      },
      inject: [APP_CONFIG, METRICS],
    },
    {
      provide: AREA_AUTOCOMPLETE,
      // #321: `metrics` was missing here while the PLACE_PROVIDER binding above
      // had it, so every `google.autocomplete` call — a billed SKU — went
      // uncounted, unlatched from the failure counter and absent from the cost
      // total. Two adapters, one of them instrumented, is worse than neither:
      // the number that exists looks complete.
      useFactory: (config: AppConfig, metrics: MetricsPort) => {
        const status = placeProviderStatus(config);
        if (status.provider === 'fake') return new FakeAreaAutocomplete();
        if (status.provider === 'unconfigured') return new UnconfiguredPlaceProvider();
        return new GooglePlacesAdapter(config.GOOGLE_PLACES_API_KEY, metrics);
      },
      inject: [APP_CONFIG, METRICS],
    },
    {
      // PI-BE-012: the Sheets read takes its own key and no other. PI-BE-021:
      // without it the fake is bound and every import fails — exercisable end
      // to end is what it does in a test, not what it does in a deployed
      // environment. onModuleInit says so out loud.
      provide: SHEETS_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) =>
        config.GOOGLE_SHEETS_API_KEY
          ? new GoogleSheetsAdapter(config.GOOGLE_SHEETS_API_KEY, metrics)
          : new FakeSheets(),
      inject: [APP_CONFIG, METRICS],
    },
    {
      // PI-SRE-001: metrics ride the log stream in the MVP stack — no collector
      // to run, and any aggregator can count and alert on them.
      provide: METRICS_REGISTRY,
      useFactory: () => new MetricsRegistry(),
    },
    {
      // #414 — per-request infrastructure telemetry goes to the Prometheus
      // registry only. Not METRICS_BASE: that tees into LogMetrics, and a log
      // line per SQL statement is the API's log volume doubled for a number
      // the registry already holds. Not METRICS: the usage ledger is a cost
      // meter, and runtime telemetry is not one (epic §8).
      provide: RUNTIME_METRICS,
      useFactory: (registry: MetricsRegistry) => registry,
      inject: [METRICS_REGISTRY],
    },
    {
      // ADM-010 (#463) — the registry as a gauge sink. Gauges live only on the
      // registry, not on `MetricsPort`: a log line is a stream of events and a
      // gauge is a current value, so teeing one into the other would emit a
      // "metric" line every time a number was re-read.
      provide: GAUGE_SINK,
      useFactory: (registry: MetricsRegistry) => registry,
      inject: [METRICS_REGISTRY],
    },
    {
      // #427 — this process's boot-time outcomes (the rate-limit Redis
      // warm-up), read by the Cost Center for `runtime.connection`.
      provide: RUNTIME_STATE,
      useFactory: () => new RuntimeStateStore(),
    },
    {
      // Both: the log line stays the record any aggregator can read, and the
      // registry is what a scraper reads. Losing one must not lose the other.
      //
      // Split out from `METRICS` in #335 so the usage ledger can report its own
      // flush outcomes into these two sinks without being a sink of its own
      // metrics — a ledger teed into the thing it writes to is a cycle, and the
      // cycle only shows up under load.
      provide: METRICS_BASE,
      useFactory: (config: AppConfig, registry: MetricsRegistry) =>
        new TeeMetrics([
          new LogMetrics(createLogger({ level: config.LOG_LEVEL, name: 'gogo-metrics' })),
          registry,
        ]),
      inject: [APP_CONFIG, METRICS_REGISTRY],
    },
    {
      /**
       * #335 — durable provider usage accounting.
       *
       * A third metrics sink rather than a change to any adapter: every
       * provider call already emits `places_provider_requests_total` and, where
       * it is billed, `places_provider_cost_units`. Teeing the ledger off that
       * stream is what makes the accounting complete by construction — a future
       * adapter is counted the day it emits its first metric, with nothing to
       * remember.
       *
       * Buffered, never awaited from the provider call. See
       * `docs/adr/0012-durable-provider-usage-accounting.md` for why that is
       * the boundary, and for what "buffered" is allowed to lose.
       */
      provide: COST_USAGE_LEDGER,
      useFactory: (config: AppConfig, db: Db, base: MetricsPort) =>
        new DbUsageLedger(db, {
          environment: config.APP_ENV,
          flushMs: config.COST_LEDGER_FLUSH_MS,
          enabled: config.COST_LEDGER_ENABLED,
          metrics: base,
        }),
      inject: [APP_CONFIG, DB, METRICS_BASE],
    },
    {
      provide: METRICS,
      useFactory: (base: MetricsPort, ledger: DbUsageLedger) => new TeeMetrics([base, ledger]),
      inject: [METRICS_BASE, COST_USAGE_LEDGER],
    },
    {
      // ADR-0007: the real adapter is only bound when the flag *and* the Routes
      // key are present. Everywhere else the straight-line estimate answers,
      // which is also the fallback path when quota runs out.
      provide: TRAVEL_TIME_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) =>
        config.FLAG_ROUTES_API && config.GOOGLE_ROUTES_API_KEY
          ? new GoogleRoutesAdapter(config.GOOGLE_ROUTES_API_KEY, metrics)
          : new HaversineTravelTime(),
      inject: [APP_CONFIG, METRICS],
    },
    {
      /**
       * #315 — reading the store back, for the CMS ops dashboard only.
       *
       * Bound to `null` when unconfigured rather than to a fake: a fake would
       * answer a dashboard with invented traffic, and the one thing this
       * screen must never do is show a number nobody measured. The service
       * reports `backend.status: "unavailable"` instead.
       *
       * Which store, and whether it is authenticated, is
       * `resolveMetricsQueryConfig`'s single decision — ADR-0007 §E7 makes the
       * read path follow the write path so the two cannot drift apart in a
       * deploy. Read-only credentials only, never the collector's write token.
       */
      provide: METRICS_QUERY,
      useFactory: (config: AppConfig) => {
        const metricsQuery = resolveMetricsQueryConfig(config);
        return metricsQuery === null ? null : new PrometheusQueryAdapter(metricsQuery);
      },
      inject: [APP_CONFIG],
    },
    {
      // #193: the mode decides, not the presence of a secret — `onesignal`
      // with no key binds a provider that refuses and is reported not-ready at
      // boot, never the fake. The API holds this binding for parity with the
      // worker (which is where sends actually happen) and for the ops signal.
      provide: PUSH_PROVIDER,
      useFactory: (config: AppConfig, metrics: MetricsPort) => {
        const status = pushProviderStatus(config);
        if (status.provider === 'fake') return new FakePush();
        if (status.provider === 'unconfigured') return new UnconfiguredPushProvider();
        return new OneSignalPushAdapter(
          { appId: config.ONESIGNAL_APP_ID, restApiKey: config.ONESIGNAL_REST_API_KEY },
          metrics,
        );
      },
      inject: [APP_CONFIG, METRICS],
    },
    {
      // #206: attribution is optional by design (FR-LINK-006). A template binds
      // Tenjin; none binds the provider that attaches nothing, and share links
      // are minted either way. The template was validated by `loadEnv`.
      provide: ACQUISITION_LINK_PROVIDER,
      useFactory: (config: AppConfig) =>
        config.TENJIN_TRACKING_URL_TEMPLATE
          ? new TenjinAcquisitionLinkProvider(config.TENJIN_TRACKING_URL_TEMPLATE)
          : new NoAcquisitionLinkProvider(),
      inject: [APP_CONFIG],
    },
    {
      // Real R2 the moment credentials exist; the fake keeps every other
      // environment able to run the whole upload flow without them.
      provide: STORAGE_PROVIDER,
      useFactory: (config: AppConfig) =>
        config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && config.R2_BUCKET
          ? new R2StorageAdapter({
              accountId: config.R2_ACCOUNT_ID,
              accessKeyId: config.R2_ACCESS_KEY_ID,
              secretAccessKey: config.R2_SECRET_ACCESS_KEY,
              bucket: config.R2_BUCKET,
            })
          : new FakeStorage(),
      inject: [APP_CONFIG],
    },
  ],
  exports: [
    METRICS_REGISTRY,
    RUNTIME_STATE,
    // #422 — a global module shares only what it exports. Provided-but-not-
    // exported, the optional injections in DatabaseModule / IdentityModule /
    // RealtimeBusModule resolved to `undefined` and the API emitted nothing.
    RUNTIME_METRICS,
    GAUGE_SINK,
    COST_USAGE_LEDGER,
    METRICS_QUERY,
    PLACE_PROVIDER,
    AREA_AUTOCOMPLETE,
    SHEETS_PROVIDER,
    TRAVEL_TIME_PROVIDER,
    PUSH_PROVIDER,
    STORAGE_PROVIDER,
    ACQUISITION_LINK_PROVIDER,
    METRICS,
  ],
})
export class ProvidersModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(COST_USAGE_LEDGER) private readonly usageLedger: DbUsageLedger,
  ) {}

  /**
   * #335 — the graceful half of the ledger's durability guarantee.
   *
   * A SIGTERM loses nothing: the interval stops and the buffer is written
   * before the pool closes. `DatabaseModule` is registered ahead of this one,
   * and Nest runs shutdown hooks in reverse registration order, so the
   * connection is still open when this runs. A SIGKILL still loses at most one
   * flush interval, which is the bound the ADR names and the reconciliation
   * procedure covers.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.usageLedger.stop().catch(() => {
      // A flush that cannot land at shutdown is a few counts, and the process
      // is leaving. Throwing here would turn a clean stop into a crash loop.
    });
  }

  /**
   * PI-BE-021 — a fake bound in a deployed environment is a defect, and it used
   * to be an invisible one. Boot is the only moment the choice is still cheap
   * to notice; after that it surfaces as a support ticket about someone's
   * spreadsheet.
   */
  onModuleInit(): void {
    // Nothing is written until this runs, and it is a no-op when the ledger is
    // disabled — `COST_LEDGER_ENABLED=false` is the rollback for this PR.
    this.usageLedger.start();
    const logger = createLogger({ level: this.config.LOG_LEVEL, name: 'gogo-api' });
    const status = placeProviderStatus(this.config);
    const push = pushProviderStatus(this.config);
    warnFakedProviders(
      { ...this.config, PLACE_PROVIDER_MODE: status.mode, PUSH_PROVIDER_MODE: push.mode },
      (meta, message) => logger.warn(meta, message),
    );
    // #193 — same signal for push. Mode and reason only; the key never appears.
    const pushLine = {
      port: 'PUSH_PROVIDER',
      mode: push.mode,
      provider: push.provider,
      ready: push.ready,
      ...(push.reason ? { reason: push.reason } : {}),
    };
    if (push.ready) logger.info(pushLine, 'push provider ready');
    else logger.error(pushLine, 'push provider NOT ready — every push send will be refused');
    // #199 — whether this environment can bind a device to a user at all. The
    // key was validated by `loadEnv`; here only its presence is reported.
    if (this.config.ONESIGNAL_IDENTITY_VERIFICATION_KEY) {
      logger.info({ port: 'PUSH_IDENTITY', ready: true }, 'push identity signing configured');
    } else {
      logger.warn(
        { port: 'PUSH_IDENTITY', ready: false, reason: 'MISSING_SIGNING_KEY' },
        'push identity signing NOT configured — GET /v1/notifications/identity answers 503',
      );
    }
    // #279 — the ops signal. Always emitted, ready or not: "which provider is
    // this process on" is the first question every one of these incidents has
    // started with, and it was never written down anywhere. Carries the mode
    // and a reason code, never a key.
    const line = {
      port: 'PLACE_PROVIDER',
      mode: status.mode,
      provider: status.provider,
      ready: status.ready,
      ...(status.reason ? { reason: status.reason } : {}),
    };
    if (status.ready) logger.info(line, 'place provider ready');
    else logger.error(line, 'place provider NOT ready — place resolution will answer 503');
    // #206 — which attribution vendor new share links carry. `none` is a valid
    // state, reported at info: the canonical link works without it.
    logger.info(
      {
        port: 'ACQUISITION_LINK_PROVIDER',
        provider: this.config.TENJIN_TRACKING_URL_TEMPLATE ? 'tenjin' : 'none',
        shareHost: this.config.SHARE_LINK_BASE_URL || null,
      },
      'share link attribution provider bound',
    );
  }
}
