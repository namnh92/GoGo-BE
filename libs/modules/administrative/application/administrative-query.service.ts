import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../shared/app-error';
import {
  ADMINISTRATIVE_DATASET,
  type AdministrativeDatasetPort,
} from './administrative-dataset.port';
import {
  isCurrent,
  matches,
  normalizeVietnamese,
  unitAt,
  type ChangeRow,
  type DatasetSnapshot,
  type SearchEntry,
  type UnitRow,
} from '../domain/snapshot';

/**
 * ADM-003 (#456) — the read model over one published snapshot.
 *
 * Everything here is a map lookup or a bounded scan over arrays built at load
 * time. Nothing touches the database, which is what "never query the full
 * dataset per request" means in practice.
 */

export type UnitDto = {
  code: string;
  name: string;
  fullName: string;
  nameEn: string | null;
  codeName: string | null;
  unitType: string;
  level: string;
  parentCode: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
};

export type Page<T> = { items: T[]; nextCursor: string | null; total: number };

export const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function toDto(unit: UnitRow): UnitDto {
  return {
    code: unit.code,
    name: unit.name,
    fullName: unit.fullName,
    nameEn: unit.nameEn,
    codeName: unit.codeName,
    unitType: unit.unitType,
    level: unit.level,
    parentCode: unit.parentCode,
    status: unit.status,
    effectiveFrom: unit.effectiveFrom,
    effectiveTo: unit.effectiveTo,
    isCurrent: isCurrent(unit),
  };
}

/**
 * The cursor is the last code returned, base64url-encoded.
 *
 * Opaque to the client and stable under insertion, because the ordering it
 * pages through is a total order on code rather than an offset — a dataset
 * cannot change under a cursor anyway, since a published version is immutable.
 */
function encodeCursor(code: string): string {
  return Buffer.from(code).toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // The cursor is always an administrative code, so it is validated as one. A
  // looser pattern would accept arbitrary text — `not-a-cursor` decodes to
  // something a permissive regex is happy with, and the endpoint would then
  // page from a position no row can ever match instead of saying the cursor is
  // wrong.
  if (!/^[0-9]{2,5}$/.test(decoded)) {
    throw AppError.badRequest('INVALID_CURSOR', 'cursor is not a value this endpoint issued');
  }
  return decoded;
}

function paginate<T extends { code: string }>(
  rows: readonly T[],
  cursor: string | null,
  limit: number,
): Page<UnitDto> {
  const start = cursor ? rows.findIndex((r) => r.code > cursor) : 0;
  const from = start === -1 ? rows.length : start;
  const slice = rows.slice(from, from + limit);
  const last = slice.at(-1);
  const more = from + slice.length < rows.length;
  return {
    items: slice.map((r) => toDto(r as unknown as UnitRow)),
    nextCursor: more && last ? encodeCursor(last.code) : null,
    total: rows.length,
  };
}

@Injectable()
export class AdministrativeQueryService {
  constructor(
    @Inject(ADMINISTRATIVE_DATASET) private readonly dataset: AdministrativeDatasetPort,
  ) {}

  snapshot(): Promise<DatasetSnapshot> {
    return this.dataset.active();
  }

  version(snapshot: DatasetSnapshot) {
    return {
      datasetVersion: snapshot.datasetVersion,
      effectiveDate: snapshot.effectiveDate,
      publishedAt: snapshot.publishedAt,
      counts: snapshot.counts,
    };
  }

  provinces(
    snapshot: DatasetSnapshot,
    options: { cursor?: string | undefined; limit?: number | undefined },
  ): Page<UnitDto> {
    return paginate(
      snapshot.currentProvinces,
      decodeCursor(options.cursor),
      options.limit ?? DEFAULT_LIMIT,
    );
  }

  /**
   * A province code that is not a current province is a 404, not an empty page.
   * "No communes" and "no such province" are different answers and a client
   * that cannot tell them apart will render the wrong screen.
   */
  communes(
    snapshot: DatasetSnapshot,
    provinceCode: string,
    options: { cursor?: string | undefined; limit?: number | undefined },
  ): Page<UnitDto> {
    const province = snapshot.currentProvinces.find((p) => p.code === provinceCode);
    if (!province) {
      throw AppError.notFound(
        'PROVINCE_NOT_FOUND',
        `no current province with code ${provinceCode}`,
      );
    }
    return paginate(
      snapshot.communesByProvince.get(provinceCode) ?? [],
      decodeCursor(options.cursor),
      options.limit ?? DEFAULT_LIMIT,
    );
  }

  /**
   * One code, every effective period it has had, newest-relevant first in the
   * `current` field and the whole history beside it. A caller asking for
   * `00004` gets Phường Ba Đình *and* is told the code meant Phường Trúc Bạch
   * before 2025-07-01, because hiding that is how a stored code silently
   * resolves to the wrong commune.
   */
  unit(snapshot: DatasetSnapshot, code: string, includeLegacy: boolean) {
    const periods = snapshot.byCode.get(code);
    if (!periods || periods.length === 0) {
      throw AppError.notFound('UNIT_NOT_FOUND', `no administrative unit with code ${code}`);
    }
    const current = periods.find(isCurrent) ?? null;
    if (!current && !includeLegacy) {
      throw AppError.notFound(
        'UNIT_NOT_CURRENT',
        `code ${code} names no current unit; pass includeLegacy=true to read its history`,
      );
    }
    return {
      current: current ? toDto(current) : null,
      periods: includeLegacy ? periods.map(toDto) : periods.filter(isCurrent).map(toDto),
    };
  }

  search(
    snapshot: DatasetSnapshot,
    options: {
      query: string;
      provinceCode?: string | undefined;
      includeLegacy: boolean;
      limit?: number | undefined;
      cursor?: string | undefined;
    },
  ): Page<UnitDto> {
    const needle = normalizeVietnamese(options.query);
    if (needle.length === 0) {
      throw AppError.badRequest('EMPTY_QUERY', 'query must contain at least one letter or digit');
    }
    if (
      options.provinceCode &&
      !snapshot.currentProvinces.some((p) => p.code === options.provinceCode)
    ) {
      throw AppError.notFound(
        'PROVINCE_NOT_FOUND',
        `no current province with code ${options.provinceCode}`,
      );
    }

    const pools: readonly SearchEntry[][] = options.includeLegacy
      ? [snapshot.currentSearch as SearchEntry[], snapshot.legacySearch as SearchEntry[]]
      : [snapshot.currentSearch as SearchEntry[]];

    const hits: UnitRow[] = [];
    for (const pool of pools) {
      for (const entry of pool) {
        if (options.provinceCode) {
          const owner = entry.unit.level === 'PROVINCE' ? entry.unit.code : entry.unit.parentCode;
          if (owner !== options.provinceCode) continue;
        }
        if (matches(entry, needle)) hits.push(entry.unit);
      }
    }
    // Each pool is already ordered by code and current units precede legacy
    // ones, so the concatenation is a total order — the same query always pages
    // the same way.
    return paginate(hits, decodeCursor(options.cursor), options.limit ?? DEFAULT_LIMIT);
  }

  /**
   * What a code meant, and where it went.
   *
   * Without `at`, the answer is the current unit. With `at`, it is the unit that
   * held the code on that date — which for 2,212 of the 3,321 current commune
   * codes is a *different place*. Successors come from canonical changes only:
   * a divided commune is quarantined, never resolved, so `resolve` reports it
   * as unresolved rather than naming the source's guess.
   */
  resolve(snapshot: DatasetSnapshot, code: string, at: string | null) {
    const periods = snapshot.byCode.get(code);
    if (!periods || periods.length === 0) {
      throw AppError.notFound('UNIT_NOT_FOUND', `no administrative unit with code ${code}`);
    }
    const matched = at ? unitAt(periods, at) : (periods.find(isCurrent) ?? null);
    if (!matched) {
      throw AppError.notFound(
        'UNIT_NOT_EFFECTIVE',
        at
          ? `code ${code} named no unit on ${at}`
          : `code ${code} names no current unit; pass ?at= to resolve a historical period`,
      );
    }

    const successors = isCurrent(matched)
      ? []
      : (snapshot.changesByOldCode.get(code) ?? []).map((c: ChangeRow) => ({
          code: c.newCode,
          changeType: c.changeType,
          effectiveDate: c.effectiveDate,
          legalReference: c.legalReference,
        }));

    return {
      requested: { code, at },
      unit: toDto(matched),
      // Absent successors for a dissolved unit is the honest answer when the
      // only mapping GoGo has is a quarantined split. `unresolved` says so in a
      // field rather than leaving the client to infer it from an empty list.
      successors,
      unresolved: !isCurrent(matched) && successors.length === 0,
    };
  }
}
