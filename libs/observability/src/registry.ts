import type { MetricLabels, MetricsPort } from './metrics';

/**
 * PI-SRE-001 (#120) — an in-process metric registry with a scrape endpoint.
 *
 * The alert table in `docs/infrastructure.md` has existed for a while with a
 * note saying the destination was undecided. That decision does not have to be
 * made here: exposing the standard text format means any scraper — Prometheus,
 * Grafana Agent, a Cloudflare Worker, whatever the deployment ends up with —
 * can read it, and choosing one stops being a prerequisite for having alerts
 * at all.
 *
 * Deliberately not a full Prometheus client. Counters and a small fixed
 * histogram cover every metric the spec names, and a dependency that pulls in
 * a registry, a clustering story and a default set of process metrics is not
 * worth it for that.
 */
export type Sample = { value: number; labels: MetricLabels };

/** Fixed buckets, in the units the metrics actually use (ms, hours, units). */
const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

type HistogramState = { counts: number[]; sum: number; count: number };

export class MetricsRegistry implements MetricsPort {
  private readonly counters = new Map<string, Map<string, Sample>>();
  private readonly histograms = new Map<
    string,
    Map<string, HistogramState & { labels: MetricLabels }>
  >();

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, Sample>();
    const key = seriesKey(labels);
    const existing = series.get(key);
    series.set(key, { value: (existing?.value ?? 0) + by, labels: clean(labels) });
    this.counters.set(name, series);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const series =
      this.histograms.get(name) ?? new Map<string, HistogramState & { labels: MetricLabels }>();
    const key = seriesKey(labels);
    const state = series.get(key) ?? {
      counts: new Array<number>(BUCKETS.length).fill(0),
      sum: 0,
      count: 0,
      labels: clean(labels),
    };
    for (let i = 0; i < BUCKETS.length; i += 1) {
      if (value <= BUCKETS[i]!) state.counts[i] = (state.counts[i] ?? 0) + 1;
    }
    state.sum += value;
    state.count += 1;
    series.set(key, state);
    this.histograms.set(name, series);
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

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];

    for (const [name, series] of [...this.counters].sort(byName)) {
      lines.push(`# TYPE ${name} counter`);
      for (const sample of series.values()) {
        lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
      }
    }

    for (const [name, series] of [...this.histograms].sort(byName)) {
      lines.push(`# TYPE ${name} histogram`);
      for (const state of series.values()) {
        for (let i = 0; i < BUCKETS.length; i += 1) {
          lines.push(
            `${name}_bucket${renderLabels({ ...state.labels, le: String(BUCKETS[i]) })} ${state.counts[i]}`,
          );
        }
        lines.push(`${name}_bucket${renderLabels({ ...state.labels, le: '+Inf' })} ${state.count}`);
        lines.push(`${name}_sum${renderLabels(state.labels)} ${state.sum}`);
        lines.push(`${name}_count${renderLabels(state.labels)} ${state.count}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }

  /** Names currently carrying at least one sample — what an alert can match. */
  names(): string[] {
    return [...new Set([...this.counters.keys(), ...this.histograms.keys()])].sort();
  }
}

/**
 * Writes to both. The log line stays the record of record for the MVP (any
 * aggregator can read it), while the registry is what a scraper reads; losing
 * one should not lose the other.
 */
export class TeeMetrics implements MetricsPort {
  constructor(private readonly targets: MetricsPort[]) {}

  increment(name: string, labels?: MetricLabels, by?: number): void {
    for (const t of this.targets) t.increment(name, labels, by);
  }

  observe(name: string, value: number, labels?: MetricLabels): void {
    for (const t of this.targets) t.observe(name, value, labels);
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

const byName = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : 1);

function clean(labels: MetricLabels): MetricLabels {
  return Object.fromEntries(Object.entries(labels).filter(([, v]) => v !== undefined));
}

/** Label order must not create a second series for the same thing. */
function seriesKey(labels: MetricLabels): string {
  return Object.entries(clean(labels))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(',');
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(clean(labels));
  if (entries.length === 0) return '';
  const rendered = entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
  return `{${rendered}}`;
}
