import { describe, expect, it } from 'vitest';
import type { MetricLabels, MetricsPort } from '@gogo/observability';
import type { SearchRepository } from '../infrastructure/search.repository';
import { SearchService } from './search.service';

/**
 * GoGo-BE#217 (ADR-0028) — how Place Detail maps the rating aggregate and what
 * it says about it in telemetry. The SQL itself is exercised against a real
 * database in `apps/api/test/place-gogo-rating.int.spec.ts`.
 */
class RecordingMetrics implements MetricsPort {
  readonly calls: { name: string; labels: MetricLabels | undefined }[] = [];
  increment(name: string, labels?: MetricLabels): void {
    this.calls.push({ name, labels });
  }
  observe(): void {}
  time<T>(_n: string, _l: MetricLabels, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

const baseRow = {
  id: '5b0f3c8e-6a52-4c1e-9a37-2f7d1e8b4c10',
  name: 'Quán',
  status: 'published',
  lat: '10.77',
  lng: '106.7',
  rating: '4.6',
  rating_count: 980,
  sources: [{ provider: 'google', attribution: 'Data © Google' }],
};

function service(placeDetail: () => Promise<Record<string, unknown> | undefined>) {
  const metrics = new RecordingMetrics();
  const repo = { placeDetail } as unknown as SearchRepository;
  return { svc: new SearchService(repo, {} as never, undefined, metrics), metrics };
}

const ratingCalls = (m: RecordingMetrics) =>
  m.calls.filter((c) => c.name === 'place_gogo_rating_total').map((c) => c.labels);

describe('Place Detail GoGo rating mapping (#217)', () => {
  it('omits the score below the threshold and reports insufficient', async () => {
    const { svc, metrics } = service(async () => ({
      ...baseRow,
      gogo_rating_count: 4,
      gogo_rating_mean: '4.8',
    }));
    const detail = await svc.placeDetail(baseRow.id);
    expect(detail).not.toHaveProperty('gogoRating');
    expect(detail.gogoRatingCount).toBe(4);
    expect(ratingCalls(metrics)).toEqual([{ outcome: 'insufficient' }]);
  });

  it('returns a numeric score at the threshold, beside the untouched provider rating', async () => {
    const { svc, metrics } = service(async () => ({
      ...baseRow,
      gogo_rating_count: 5,
      gogo_rating_mean: '4.3',
    }));
    const detail = await svc.placeDetail(baseRow.id);
    expect(detail).toMatchObject({
      gogoRating: 4.3,
      gogoRatingCount: 5,
      rating: 4.6,
      ratingCount: 980,
    });
    expect(ratingCalls(metrics)).toEqual([{ outcome: 'available' }]);
  });

  it('a failed read is an error, never "not enough reviews"', async () => {
    const { svc, metrics } = service(async () => {
      throw new Error('connection terminated');
    });
    await expect(svc.placeDetail(baseRow.id)).rejects.toThrow('connection terminated');
    expect(ratingCalls(metrics)).toEqual([{ outcome: 'error' }]);
  });

  it('a row missing the aggregate is an error, not a count of 0', async () => {
    const { svc, metrics } = service(async () => ({ ...baseRow }));
    await expect(svc.placeDetail(baseRow.id)).rejects.toThrow();
    expect(ratingCalls(metrics)).toEqual([{ outcome: 'error' }]);
  });

  it('a missing place is a 404 and no rating outcome at all', async () => {
    const { svc, metrics } = service(async () => undefined);
    await expect(svc.placeDetail(baseRow.id)).rejects.toMatchObject({ code: 'PLACE_NOT_FOUND' });
    expect(ratingCalls(metrics)).toEqual([]);
  });

  it('labels carry the outcome and nothing that identifies a place or reader', async () => {
    const { svc, metrics } = service(async () => ({
      ...baseRow,
      gogo_rating_count: 9,
      gogo_rating_mean: '3.9',
    }));
    await svc.placeDetail(baseRow.id);
    for (const labels of ratingCalls(metrics))
      expect(Object.keys(labels ?? {})).toEqual(['outcome']);
  });
});
