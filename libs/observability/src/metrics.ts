import type { AppLogger } from './logger';

/**
 * PI-SRE-001 — metric emission for the single-VPS MVP.
 *
 * There is no Prometheus/OTLP collector in the MVP stack, so metrics go out as
 * structured log lines with a stable shape (`metric`, `type`, `value`, labels).
 * Any log aggregator can count and alert on them, and swapping in a real
 * exporter later means changing this file, not every call site.
 *
 * Metric names come from GOGO_PLACE_INGESTION_SPEC §13.
 */

export type MetricLabels = Record<string, string | number | boolean | undefined>;

export interface MetricsPort {
  increment(name: string, labels?: MetricLabels, by?: number): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
  /** Times `fn`, records the duration, and labels the outcome ok/error. */
  time<T>(name: string, labels: MetricLabels, fn: () => Promise<T>): Promise<T>;
}

export class LogMetrics implements MetricsPort {
  constructor(private readonly logger: AppLogger) {}

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    this.logger.info({ metric: name, type: 'counter', value: by, ...clean(labels) }, 'metric');
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    this.logger.info({ metric: name, type: 'histogram', value, ...clean(labels) }, 'metric');
  }

  async time<T>(name: string, labels: MetricLabels, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.observe(name, Date.now() - started, { ...labels, outcome: 'ok' });
      return result;
    } catch (err) {
      this.observe(name, Date.now() - started, { ...labels, outcome: 'error' });
      throw err;
    }
  }
}

/** Drops metrics entirely — the default outside the API/worker processes. */
export class NoopMetrics implements MetricsPort {
  increment(): void {}
  observe(): void {}
  time<T>(_name: string, _labels: MetricLabels, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

function clean(labels: MetricLabels): MetricLabels {
  const out: MetricLabels = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export const METRICS = Symbol('METRICS');
