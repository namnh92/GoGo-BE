import { sql, type SQL } from 'drizzle-orm';

/**
 * GoGo-BE#360 — what the provider last said about the business, as one fact.
 *
 * One rule for every surface that shows it: the consumer place detail (#656)
 * and the CMS place editor read the same rows through this fragment, so an
 * editor never sees a place as open that the consumer client warns about.
 *
 * The most severe report wins (closed > temporarily_closed > moved > active >
 * unknown), so a detail never calls open a place search excludes on *any* shut
 * source (#339). Newest fetch breaks ties. DB only — no provider call on read.
 */
export function providerStatusSubquery(placeId: SQL): SQL {
  return sql`(select json_build_object('status', ps.source_status, 'fetchedAt', ps.fetched_at)
          from place_provider_sources ps
          where ps.place_id = ${placeId}
          order by case ps.source_status
              when 'closed' then 0 when 'temporarily_closed' then 1
              when 'moved' then 2 when 'active' then 3 else 4 end,
            ps.fetched_at desc
          limit 1)`;
}

export type ProviderStatus = { status: string; fetchedAt: string };

/**
 * `json_build_object` hands the timestamp back as text; the contract says
 * ISO-8601. Absent when no provider has reported on the place.
 */
export function toProviderStatus(raw: unknown): ProviderStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as { status?: unknown; fetchedAt?: unknown };
  if (typeof value.status !== 'string') return undefined;
  const fetchedAt = isoOrUndefined(value.fetchedAt);
  return fetchedAt ? { status: value.status, fetchedAt } : undefined;
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
