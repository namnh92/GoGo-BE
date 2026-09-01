/**
 * PR3 / COST-BE-003 (#336) — reading the scrape endpoint back as numbers.
 *
 * The baseline needs three things out of `/metrics` that the ledger cannot
 * give it: the HTTP status Google answered (the ledger folds status into
 * attempted/succeeded and throws the code away), latency, and the counts of
 * an operation the ledger deliberately ignores. So the runner scrapes the
 * text exposition before and after each scenario and diffs it.
 *
 * A diff, not a reading. An absolute counter includes every call the process
 * made since boot — other traffic, the previous scenario, a health probe — and
 * a baseline that reported absolutes would be measuring the process's uptime.
 *
 * Histograms are diffed the same way: bucket counts are monotonic, so
 * `after − before` is the distribution of exactly the requests the scenario
 * made, and a quantile off that is a quantile of the scenario. Reading a
 * quantile off the absolute histogram would blend in every earlier request.
 */

export type SeriesKey = { name: string; labels: Record<string, string> };

export type CounterSample = SeriesKey & { value: number };

export type HistogramSample = {
  name: string;
  labels: Record<string, string>;
  /** Cumulative `le` buckets, ascending. `+Inf` is stored as `Infinity`. */
  buckets: { le: number; count: number }[];
  sum: number;
  count: number;
};

export type MetricsSnapshot = {
  counters: CounterSample[];
  histograms: HistogramSample[];
};

const LINE = /^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?<labels>[^}]*)\})?\s+(?<value>\S+)$/;

/**
 * Parse the Prometheus text exposition format.
 *
 * Only what `MetricsRegistry.render()` emits is supported — counters and
 * histograms with `_bucket`/`_sum`/`_count` suffixes. Anything else is
 * ignored rather than guessed at: a baseline that silently reinterpreted an
 * unfamiliar metric type would produce a number nobody could re-derive.
 */
export function parseMetricsText(text: string): MetricsSnapshot {
  const counters: CounterSample[] = [];
  const histograms = new Map<string, HistogramSample>();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m?.groups) continue;
    const name = m.groups.name!;
    const labels = parseLabels(m.groups.labels ?? '');
    const value = Number(m.groups.value);
    if (!Number.isFinite(value)) continue;

    if (name.endsWith('_bucket')) {
      const { le, ...rest } = labels;
      const base = name.slice(0, -'_bucket'.length);
      const hist = histogramSlot(histograms, base, rest);
      hist.buckets.push({ le: le === '+Inf' ? Infinity : Number(le), count: value });
      continue;
    }
    if (name.endsWith('_sum')) {
      histogramSlot(histograms, name.slice(0, -'_sum'.length), labels).sum = value;
      continue;
    }
    if (name.endsWith('_count')) {
      histogramSlot(histograms, name.slice(0, -'_count'.length), labels).count = value;
      continue;
    }
    counters.push({ name, labels, value });
  }

  for (const hist of histograms.values()) hist.buckets.sort((a, b) => a.le - b.le);
  return { counters, histograms: [...histograms.values()] };
}

/**
 * `after − before`, per series.
 *
 * A series present only in `after` counts from zero; a series that vanished is
 * dropped rather than reported as a negative, because a counter cannot fall
 * and a negative would mean the process restarted mid-scenario. That is a
 * contaminated run, and `preflight` is where it gets caught — not here, by
 * quietly producing a plausible-looking number.
 */
export function diffSnapshots(before: MetricsSnapshot, after: MetricsSnapshot): MetricsSnapshot {
  const priorCounters = new Map(before.counters.map((c) => [seriesId(c.name, c.labels), c.value]));
  const counters = after.counters
    .map((c) => ({
      ...c,
      value: c.value - (priorCounters.get(seriesId(c.name, c.labels)) ?? 0),
    }))
    .filter((c) => c.value > 0);

  const priorHists = new Map(before.histograms.map((h) => [seriesId(h.name, h.labels), h]));
  const histograms = after.histograms
    .map((h) => {
      const prior = priorHists.get(seriesId(h.name, h.labels));
      return {
        name: h.name,
        labels: h.labels,
        buckets: h.buckets.map((b) => ({
          le: b.le,
          count: b.count - (prior?.buckets.find((p) => p.le === b.le)?.count ?? 0),
        })),
        sum: h.sum - (prior?.sum ?? 0),
        count: h.count - (prior?.count ?? 0),
      };
    })
    .filter((h) => h.count > 0);

  return { counters, histograms };
}

/** Every counter of one metric, keyed by one label's value. */
export function countBy(
  snapshot: MetricsSnapshot,
  metric: string,
  label: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of snapshot.counters) {
    if (c.name !== metric) continue;
    const key = c.labels[label];
    if (key === undefined) continue;
    out.set(key, (out.get(key) ?? 0) + c.value);
  }
  return out;
}

/**
 * Linear-interpolated quantile over cumulative buckets — the same arithmetic
 * `histogram_quantile()` does, so a number here and a number on the dashboard
 * are comparable rather than merely similar.
 *
 * `null` when the window observed nothing: an absent latency is not a fast
 * one, and a baseline that printed `0 ms` for an operation nobody called would
 * be the same zero-versus-unknown failure the cost registry exists to avoid.
 */
export function quantile(hist: HistogramSample, q: number): number | null {
  if (hist.count <= 0) return null;
  const target = q * hist.count;
  let prevLe = 0;
  let prevCount = 0;
  for (const bucket of hist.buckets) {
    if (bucket.count >= target) {
      if (!Number.isFinite(bucket.le)) return prevLe;
      const span = bucket.count - prevCount;
      if (span <= 0) return bucket.le;
      return prevLe + ((target - prevCount) / span) * (bucket.le - prevLe);
    }
    prevLe = Number.isFinite(bucket.le) ? bucket.le : prevLe;
    prevCount = bucket.count;
  }
  return prevLe;
}

/** Merge every series of a histogram matching `match`, then take a quantile. */
export function quantileOf(
  snapshot: MetricsSnapshot,
  metric: string,
  match: (labels: Record<string, string>) => boolean,
  q: number,
): number | null {
  const series = snapshot.histograms.filter((h) => h.name === metric && match(h.labels));
  if (series.length === 0) return null;
  const les = [...new Set(series.flatMap((h) => h.buckets.map((b) => b.le)))].sort((a, b) => a - b);
  const merged: HistogramSample = {
    name: metric,
    labels: {},
    buckets: les.map((le) => ({
      le,
      count: series.reduce((sum, h) => sum + (h.buckets.find((b) => b.le === le)?.count ?? 0), 0),
    })),
    sum: series.reduce((s, h) => s + h.sum, 0),
    count: series.reduce((s, h) => s + h.count, 0),
  };
  return quantile(merged, q);
}

function histogramSlot(
  into: Map<string, HistogramSample>,
  name: string,
  labels: Record<string, string>,
): HistogramSample {
  const id = seriesId(name, labels);
  const existing = into.get(id);
  if (existing) return existing;
  const created: HistogramSample = { name, labels, buckets: [], sum: 0, count: 0 };
  into.set(id, created);
  return created;
}

function seriesId(name: string, labels: Record<string, string>): string {
  const rendered = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
  return `${name}{${rendered}}`;
}

function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Values are rendered with `JSON.stringify`, so a quoted-string scan is
  // exact rather than a best effort at splitting on commas.
  const pair = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(raw)) !== null) {
    out[m[1]!] = m[2]!.replace(/\\(.)/g, '$1');
  }
  return out;
}
