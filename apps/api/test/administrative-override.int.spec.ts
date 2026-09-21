import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { AdministrativeBoundaryImportService } from '@gogo/modules';

/** Set before any import reads the environment; the config is parsed once. */
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'metrics-token-int-tests';

/**
 * ADM-011 (#484) — reviewer adjudication of the advisory mapping source.
 *
 * 1,033 rows of the pinned upstream are quarantined, every one a commune the
 * source says was divided. ADR-0019 forbids guessing which successor one
 * became, so a person decides — and almost every test here is about what that
 * decision is *not* allowed to touch: the pinned snapshot, the base dataset's
 * rows, the published dataset, an earlier decision, or what the resolver
 * answers before anybody publishes anything.
 *
 * The tests share state in file order deliberately. Review is a sequence —
 * decide, correct, materialise, validate, publish — and truncating between
 * steps would test the steps without testing the sequence.
 */

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: NestFastifyApplication;

const api = () => app.getHttpAdapter().getInstance();
let ipc = 0;
const ip = () => `10.91.${Math.floor(++ipc / 250)}.${(ipc % 250) + 1}`;
const tokens: Record<string, string> = {};
const BASE = '/v1/cms/administrative-datasets';

type Role = 'editor' | 'moderator' | 'ops_admin' | 'super_admin';

const get = (url: string, role?: Role) =>
  api().inject({
    method: 'GET',
    url,
    remoteAddress: ip(),
    ...(role ? { headers: { authorization: `Bearer ${tokens[role]}` } } : {}),
  });

function post(
  url: string,
  role?: Role,
  options: { payload?: Record<string, unknown>; idempotencyKey?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (role) headers.authorization = `Bearer ${tokens[role]}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return api().inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    headers,
    payload: options.payload ?? {},
  });
}

/** The base dataset every decision in this file is taken against. */
let base!: { id: string; version: string };
/** The version materialisation derives from it. */
let derived: { id: string; version: string } | null = null;
/** The second round's version, derived from `derived` (GoGo-BE#622). */
let second: { id: string; version: string } | null = null;
/** Two quarantined rows, picked deterministically so the assertions are stable. */
let rowA!: QuarantineRow;
let rowB!: QuarantineRow;
/** A third source, decided in the second round (GoGo-BE#622). */
let rowC!: QuarantineRow;
/** Another advisory row of rowA's source: the same commune, a different proposal. */
let siblingA!: { id: string; oldCode: string; newCode: string };
/** Rows of rowA's and rowB's sources that their decisions settle without being decided. */
let settledSiblings = 0;

type QuarantineRow = { id: string; oldCode: string; newCode: string; candidates: string[] };

/** The clone of a base row on a derived version: same source and proposal, new id. */
async function rowOn(versionId: string, oldCode: string, newCode: string) {
  const [row] = await db
    .select()
    .from(schema.administrativeMappingQuarantine)
    .where(
      and(
        eq(schema.administrativeMappingQuarantine.datasetVersionId, versionId),
        eq(schema.administrativeMappingQuarantine.oldCode, oldCode),
        eq(schema.administrativeMappingQuarantine.newCode, newCode),
      ),
    )
    .limit(1);
  expect(row).toBeTruthy();
  return row!;
}

async function createAdmin(role: Role) {
  const email = `adm011-${role}@gogo.local`;
  const passwordHash = await argon2.hash('admin-password-123', { type: argon2.argon2id });
  await db.insert(schema.adminUsers).values({ email, passwordHash, displayName: role, role });
  const res = await api().inject({
    method: 'POST',
    url: '/v1/cms/auth/login',
    remoteAddress: ip(),
    payload: { email, password: 'admin-password-123' },
  });
  tokens[role] = res.json().accessToken as string;
}

/** A digest of everything the base dataset owns. Materialisation must not move it. */
async function baseFingerprint(datasetVersionId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.execute(sql`
    select
      (select md5(string_agg(u::text, E'\\n' order by u.id)) from administrative_units u
        where u.dataset_version_id = ${datasetVersionId}::uuid) as units,
      (select md5(string_agg(c::text, E'\\n' order by c.id)) from administrative_unit_changes c
        where c.dataset_version_id = ${datasetVersionId}::uuid) as changes,
      (select md5(string_agg(q::text, E'\\n' order by q.id)) from administrative_mapping_quarantine q
        where q.dataset_version_id = ${datasetVersionId}::uuid) as quarantine`);
  return rows[0] as Record<string, unknown>;
}

async function activeIds(): Promise<string[]> {
  const found = await db
    .select({ id: schema.administrativeDatasetVersions.id })
    .from(schema.administrativeDatasetVersions)
    .where(eq(schema.administrativeDatasetVersions.status, 'PUBLISHED'));
  return found.map((r) => r.id);
}

async function overrideRevisionOf(datasetVersionId: string): Promise<number> {
  const [row] = await db
    .select({ n: schema.administrativeDatasetVersions.overrideRevision })
    .from(schema.administrativeDatasetVersions)
    .where(eq(schema.administrativeDatasetVersions.id, datasetVersionId));
  return row!.n;
}

/** The current draft revision, which every mutation has to send back. */
async function revision(): Promise<number> {
  const body = (await get(`${BASE}/${base.id}/override-set`, 'ops_admin')).json();
  return (body.draft?.revision as number) ?? 0;
}

async function lastAudit(action: string) {
  const [row] = await db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.action, action))
    .orderBy(sql`created_at desc`)
    .limit(1);
  return row;
}

// #489 — a dataset import binds the boundary release that is loaded, so every
// fixture that imports must load one first. The five-entry fixture is real,
// unmodified geometry from the pinned archive and needs no network.
async function loadFixtureBoundaries(database: Parameters<typeof migrate>[0]): Promise<void> {
  await new AdministrativeBoundaryImportService(database as never).load({
    role: 'boundaries-fixture',
    boundaryVersion: 'fixture-v1',
    // The fixture is vendored and has no fetch URL, so the path is explicit.
    archivePath: path.resolve(
      __dirname,
      '../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
    ),
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4')
    .withDatabase('gogo_administrative_override_test')
    .start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = 'redis://localhost:6380';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = 'test-secret-'.padEnd(48, 'x');

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  pool.on('error', () => undefined);
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../../migrations') });
  await loadFixtureBoundaries(db);

  const { createApp } = await import('../src/main.js');
  app = await createApp();
  await app.init();
  await api().ready();

  for (const role of ['editor', 'moderator', 'ops_admin', 'super_admin'] as const) {
    await createAdmin(role);
  }

  // Import and publish the base. A review round runs against the dataset that
  // is actually serving, which is the case that matters.
  const imported = await post(`${BASE}/import`, 'ops_admin');
  expect(imported.statusCode).toBe(201);
  base = {
    id: imported.json().datasetVersionId as string,
    version: imported.json().combinedDatasetVersion as string,
  };
  expect((await post(`${BASE}/${base.id}/validate`, 'ops_admin')).statusCode).toBe(201);
  expect((await post(`${BASE}/${base.id}/publish`, 'ops_admin')).statusCode).toBe(201);

  /*
   * Ordered by the source's own codes, never by id: the ids are random per
   * import, so picking by id picked a different pair of communes on every run —
   * and different rows offer different candidates. An earlier version of this
   * file did exactly that and failed intermittently on a target that happened
   * not to be selectable.
   *
   * The candidates come back from the API rather than from the column, so the
   * targets these tests name are the ones a reviewer would actually be offered.
   */
  const picked = await db
    .select({
      id: schema.administrativeMappingQuarantine.id,
      oldCode: schema.administrativeMappingQuarantine.oldCode,
      newCode: schema.administrativeMappingQuarantine.newCode,
    })
    .from(schema.administrativeMappingQuarantine)
    .where(eq(schema.administrativeMappingQuarantine.datasetVersionId, base.id))
    .orderBy(
      schema.administrativeMappingQuarantine.oldCode,
      schema.administrativeMappingQuarantine.newCode,
    );

  // 1,033 rows describe 471 sources; the fixtures need sources with more than
  // one row, because the rule under test is about the source, not the row.
  const perSource = new Map<string, number>();
  for (const row of picked) perSource.set(row.oldCode!, (perSource.get(row.oldCode!) ?? 0) + 1);

  const usable: QuarantineRow[] = [];
  for (const row of picked) {
    if (usable.length === 3) break;
    // One row per source, so the fixtures cannot collide on one commune.
    if (usable.some((u) => u.oldCode === row.oldCode)) continue;
    if ((perSource.get(row.oldCode!) ?? 0) < 2) continue;
    const detail = (await get(`${BASE}/${base.id}/quarantine/${row.id}`, 'ops_admin')).json();
    const selectable = (detail.candidates as { code: string; selectable: boolean }[])
      .filter((c) => c.selectable)
      .map((c) => c.code);
    if (selectable.length >= 2) {
      usable.push({
        id: row.id,
        oldCode: row.oldCode!,
        newCode: row.newCode!,
        candidates: selectable,
      });
    }
  }
  expect(usable).toHaveLength(3);
  [rowA, rowB, rowC] = usable as [QuarantineRow, QuarantineRow, QuarantineRow];
  const sibling = picked.find((r) => r.oldCode === rowA.oldCode && r.id !== rowA.id)!;
  siblingA = { id: sibling.id, oldCode: sibling.oldCode!, newCode: sibling.newCode! };
  settledSiblings = perSource.get(rowA.oldCode)! - 1 + (perSource.get(rowB.oldCode)! - 1);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe('RBAC', () => {
  it.each([
    ['GET', `/quarantine`],
    ['GET', `/override-set`],
  ] as [string, string][])('refuses %s %s below ops_admin', async (_method, suffix) => {
    for (const role of ['editor', 'moderator'] as const) {
      expect((await get(`${BASE}/${base.id}${suffix}`, role)).statusCode).toBe(403);
    }
    expect((await get(`${BASE}/${base.id}${suffix}`)).statusCode).toBe(401);
  });

  it('refuses every mutation to anyone but ops_admin, and writes nothing', async () => {
    const before = await revision();
    for (const role of ['editor', 'moderator'] as const) {
      const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/reject`, role, {
        payload: { reason: 'nope', expectedRevision: before },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(await revision()).toBe(before);
  });

  it('lets super_admin through the audited bypass', async () => {
    // Read only: the write path is exercised as ops_admin everywhere else, and
    // a bypass decision would leave a decision this file then has to unpick.
    expect((await get(`${BASE}/${base.id}/override-set`, 'super_admin')).statusCode).toBe(200);
  });
});

describe('the queue reports the backlog it actually has', () => {
  it('separates canonical classification from the review backlog', async () => {
    const body = (await get(`${BASE}/${base.id}/quarantine?limit=1`, 'ops_admin')).json();

    // Measured on the pinned source. Not a universal constant — a re-pin moves
    // these and somebody has to look.
    expect(body.counts.backlog).toEqual({ DIVIDED_REQUIRES_REVIEW: 1033 });
    // The canonical side is nine times larger, which is exactly why the import
    // report's `classification` cannot stand in for a backlog.
    const canonicalTotal = Object.values(body.counts.canonical as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(canonicalTotal).toBe(9569);
    expect(body.counts.decisions.UNDECIDED).toBe(1033);
  });

  it('pages on a keyset, so a decision mid-review cannot shift the boundary', async () => {
    const first = (await get(`${BASE}/${base.id}/quarantine?limit=5`, 'ops_admin')).json();
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBeTruthy();

    const second = (
      await get(
        `${BASE}/${base.id}/quarantine?limit=5&cursor=${encodeURIComponent(first.nextCursor)}`,
        'ops_admin',
      )
    ).json();
    expect(second.items).toHaveLength(5);
    const overlap = second.items.filter((i: { id: string }) =>
      first.items.some((f: { id: string }) => f.id === i.id),
    );
    expect(overlap).toEqual([]);
  });

  it('filters by classification, and refuses one it does not have', async () => {
    const hit = (
      await get(
        `${BASE}/${base.id}/quarantine?classification=DIVIDED_REQUIRES_REVIEW&limit=3`,
        'ops_admin',
      )
    ).json();
    expect(hit.items).toHaveLength(3);
    const miss = (
      await get(`${BASE}/${base.id}/quarantine?classification=TARGET_NOT_FOUND`, 'ops_admin')
    ).json();
    expect(miss.items).toEqual([]);
    expect(
      (await get(`${BASE}/${base.id}/quarantine?classification=NONSENSE`, 'ops_admin')).statusCode,
    ).toBe(400);
  });
});

describe('the detail is enough to decide on, and no more', () => {
  it('carries every candidate as an identity, never as a bare code', async () => {
    const body = (await get(`${BASE}/${base.id}/quarantine/${rowA.id}`, 'ops_admin')).json();

    expect(body.classification).toBe('DIVIDED_REQUIRES_REVIEW');
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const candidate of body.candidates) {
      // A code alone is ambiguous across 2025-07-01; the effective date is what
      // makes it mean something.
      expect(candidate.code).toBeTruthy();
      expect(candidate.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(candidate).toHaveProperty('hierarchyValid');
      expect(candidate).toHaveProperty('selectable');
    }
    // The source's guess is reported and never presented as a default.
    expect(body.candidates.some((c: { proposedByUpstream: boolean }) => c.proposedByUpstream)).toBe(
      true,
    );
  });

  it('bounds the raw payload and the affected-place sample', async () => {
    const body = (await get(`${BASE}/${base.id}/quarantine/${rowA.id}`, 'ops_admin')).json();
    expect(body.rawPayload).toHaveProperty('truncated');
    expect(body.affectedPlaces.sampleLimit).toBe(20);
    expect(body.affectedPlaces.samples.length).toBeLessThanOrEqual(20);
    expect(body.decisionState).toBe('UNDECIDED');
    expect(body.history).toEqual([]);
  });
});

describe('accepting names a target; it never picks one', () => {
  it('refuses a body with no target at all', async () => {
    const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/accept`, 'ops_admin', {
      payload: { reason: 'the first one', expectedRevision: await revision() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a candidate index, because there is no such field', async () => {
    // The contract is `.strict()`: there is deliberately no positional way in.
    const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/accept`, 'ops_admin', {
      payload: { candidateIndex: 0, reason: 'first', expectedRevision: await revision() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a decision nobody explained', async () => {
    const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/accept`, 'ops_admin', {
      payload: {
        targetCode: rowA.candidates[0],
        targetEffectiveFrom: '2025-07-01',
        reason: '   ',
        expectedRevision: await revision(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a target this dataset does not hold', async () => {
    const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/accept`, 'ops_admin', {
      payload: {
        targetCode: '99999',
        targetEffectiveFrom: '2025-07-01',
        reason: 'a code that is not here',
        expectedRevision: await revision(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('OVERRIDE_TARGET_NOT_FOUND');
  });

  it('refuses a target whose identity is the wrong effective period', async () => {
    // Same code, a period this dataset does not carry. The refusal is the point
    // of requiring the date at all.
    const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/accept`, 'ops_admin', {
      payload: {
        targetCode: rowA.candidates[0],
        targetEffectiveFrom: '1999-01-01',
        reason: 'wrong period',
        expectedRevision: await revision(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('OVERRIDE_TARGET_NOT_FOUND');
  });

  it('accepts an exact identity, and appends rather than writing anything else', async () => {
    const beforeBase = await baseFingerprint(base.id);
    const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/accept`, 'ops_admin', {
      payload: {
        targetCode: rowA.candidates[0],
        targetEffectiveFrom: '2025-07-01',
        reason: 'field survey: the market side went to this ward',
        expectedRevision: await revision(),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().decision).toBe('ACCEPT');
    expect(res.json().overrideSetRevision).toBe(1);
    expect(res.json().supersededDecisionId).toBeNull();

    // Nothing about the base moved, and no canonical edge appeared.
    expect(await baseFingerprint(base.id)).toEqual(beforeBase);
    const [edge] = await db
      .select()
      .from(schema.administrativeUnitChanges)
      .where(
        and(
          eq(schema.administrativeUnitChanges.datasetVersionId, base.id),
          eq(schema.administrativeUnitChanges.oldCode, rowA.oldCode),
        ),
      );
    expect(edge).toBeUndefined();
  });

  it('audits the decision with both identities and the reason', async () => {
    const row = await lastAudit('administrative_mapping_override.accepted');
    expect(row).toBeTruthy();
    const diff = row!.diff as Record<string, unknown>;
    expect(diff.quarantineRowId).toBe(rowA.id);
    expect(diff.reason).toContain('field survey');
    expect(diff.baseCombinedDatasetVersion).toBe(base.version);
  });

  it('shows the row as decided, with its history', async () => {
    const body = (await get(`${BASE}/${base.id}/quarantine/${rowA.id}`, 'ops_admin')).json();
    expect(body.decisionState).toBe('ACCEPTED_DRAFT');
    expect(body.decision.reason).toContain('field survey');
    expect(body.history).toHaveLength(1);
  });

  it('refuses a second successor for the same source on a sibling row of this draft', async () => {
    // GoGo-BE#622 — DEV 2026-09-17: 00016 → 00008 and 00016 → 00004 were both
    // accepted in one draft, and the materialised version could never publish
    // (OVERRIDE_CONFLICT). The decision is on a row; the fact is about the
    // source, so the second row is refused here with the first one's target.
    const before = await revision();
    const conflict = await post(
      `${BASE}/${base.id}/quarantine/${siblingA.id}/accept`,
      'ops_admin',
      {
        payload: {
          targetCode: rowA.candidates[1],
          targetEffectiveFrom: '2025-07-01',
          reason: 'the other half of the ward',
          expectedRevision: before,
        },
      },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('OVERRIDE_SOURCE_CONFLICT_IN_DRAFT');
    expect(conflict.json().message).toContain(rowA.candidates[0]);

    // The same target twice would write the same edge twice.
    const twice = await post(`${BASE}/${base.id}/quarantine/${siblingA.id}/accept`, 'ops_admin', {
      payload: {
        targetCode: rowA.candidates[0],
        targetEffectiveFrom: '2025-07-01',
        reason: 'agreeing with the first row',
        expectedRevision: before,
      },
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe('OVERRIDE_SOURCE_ALREADY_DECIDED_IN_DRAFT');

    expect(await revision()).toBe(before);
    const audit = await lastAudit('administrative_mapping_override.decision_rejected');
    expect((audit!.diff as Record<string, unknown>).reason).toBe(
      'OVERRIDE_SOURCE_ALREADY_DECIDED_IN_DRAFT',
    );
  });
});

describe('a correction appends; it never rewrites', () => {
  it('supersedes an accept with a reject, and keeps the accept exactly as written', async () => {
    const [first] = await db
      .select()
      .from(schema.administrativeMappingOverrideDecisions)
      .where(eq(schema.administrativeMappingOverrideDecisions.quarantineRowId, rowA.id));
    /** Everything a decision asserts. None of it may ever be rewritten. */
    const content = (row: typeof first) => ({
      id: row!.id,
      decision: row!.decision,
      targetCode: row!.targetCode,
      targetEffectiveFrom: row!.targetEffectiveFrom,
      reason: row!.reason,
      evidence: row!.evidence,
      sequence: row!.sequence,
      createdBy: row!.createdBy,
      createdAt: row!.createdAt.toISOString(),
      supersedesDecisionId: row!.supersedesDecisionId,
    });
    const before = content(first);

    const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/reject`, 'ops_admin', {
      payload: {
        reason: 'the survey was of the wrong ward; withdraw it',
        expectedRevision: await revision(),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().supersededDecisionId).toBe(first!.id);

    const [after] = await db
      .select()
      .from(schema.administrativeMappingOverrideDecisions)
      .where(eq(schema.administrativeMappingOverrideDecisions.id, first!.id));
    // Only the back-pointer moved. Decision, target, reason and evidence are
    // exactly as they were written.
    expect(content(after)).toEqual(before);
    expect(after!.supersededById).toBe(res.json().decisionId);
  });

  it('supersedes the reject with an accept onto a different target', async () => {
    // A different target from the first accept, so the supersede is a real
    // change of mind rather than a repetition.
    const target = rowA.candidates[1]!;
    const res = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/accept`, 'ops_admin', {
      payload: {
        targetCode: target,
        targetEffectiveFrom: '2025-07-01',
        reason: 're-surveyed: this is the one',
        expectedRevision: await revision(),
      },
    });
    expect(res.statusCode).toBe(201);

    const body = (await get(`${BASE}/${base.id}/quarantine/${rowA.id}`, 'ops_admin')).json();
    expect(body.decisionState).toBe('ACCEPTED_DRAFT');
    expect(body.decision.targetCode).toBe(target);
    // Three opinions, newest first, none of them lost.
    expect(body.history).toHaveLength(3);
    expect(body.history.map((h: { decision: string }) => h.decision)).toEqual([
      'ACCEPT',
      'REJECT',
      'ACCEPT',
    ]);
    expect(
      body.history.filter((h: { supersededById: string | null }) => h.supersededById).length,
    ).toBe(2);
  });

  it('holds exactly one effective decision per row, in the database', async () => {
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeMappingOverrideDecisions)
      .where(
        and(
          eq(schema.administrativeMappingOverrideDecisions.quarantineRowId, rowA.id),
          sql`superseded_by_id is null`,
        ),
      );
    expect(count!.n).toBe(1);
  });
});

describe('two reviewers cannot silently overwrite each other', () => {
  it('refuses a decision taken against a revision that has moved', async () => {
    const stale = (await revision()) - 1;
    const res = await post(`${BASE}/${base.id}/quarantine/${rowB.id}/reject`, 'ops_admin', {
      payload: { reason: 'stale read', expectedRevision: stale },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('OVERRIDE_SET_REVISION_CONFLICT');
    expect(res.json().message).toContain('somebody else decided a row');
  });

  it('lets exactly one of two concurrent decisions on the same revision win', async () => {
    const at = await revision();
    const [a, b] = await Promise.all([
      post(`${BASE}/${base.id}/quarantine/${rowB.id}/reject`, 'ops_admin', {
        payload: { reason: 'reviewer one', expectedRevision: at },
      }),
      post(`${BASE}/${base.id}/quarantine/${rowB.id}/reject`, 'ops_admin', {
        payload: { reason: 'reviewer two', expectedRevision: at },
      }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().code).toBe('OVERRIDE_SET_REVISION_CONFLICT');
  });

  it('replays an identical decision carrying the same Idempotency-Key', async () => {
    const at = await revision();
    const key = 'adm011-reject-rowb';
    const first = await post(`${BASE}/${base.id}/quarantine/${rowB.id}/accept`, 'ops_admin', {
      idempotencyKey: key,
      payload: {
        targetCode: rowB.candidates[0],
        targetEffectiveFrom: '2025-07-01',
        reason: 'decided once',
        expectedRevision: at,
      },
    });
    expect(first.statusCode).toBe(201);
    const replay = await post(`${BASE}/${base.id}/quarantine/${rowB.id}/accept`, 'ops_admin', {
      idempotencyKey: key,
      payload: {
        targetCode: rowB.candidates[0],
        targetEffectiveFrom: '2025-07-01',
        reason: 'decided once',
        expectedRevision: at,
      },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.json().decisionId).toBe(first.json().decisionId);
  });
});

describe('a draft decision changes nothing that is running', () => {
  it('leaves the divided commune unresolved in the public read', async () => {
    /*
     * The payoff assertion, taken *before* materialisation so the two halves
     * can be told apart. A divided commune has no canonical successor, so the
     * public read reports `unresolved` rather than the source's guess — and a
     * reviewer having decided it in a draft must not change that by one field.
     */
    const res = await get(`/v1/administrative/resolve?code=${rowA.oldCode}&at=2025-01-01`);
    expect(res.statusCode).toBe(200);
    expect(res.json().unresolved).toBe(true);
    expect(res.json().successors).toEqual([]);
  });

  it('adds no canonical edge and leaves the published dataset serving', async () => {
    const [edges] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeUnitChanges)
      .where(
        and(
          eq(schema.administrativeUnitChanges.datasetVersionId, base.id),
          sql`override_decision_id is not null`,
        ),
      );
    expect(edges!.n).toBe(0);
    expect(await activeIds()).toEqual([base.id]);
    expect(await overrideRevisionOf(base.id)).toBe(0);

    // The public read is unchanged and still answers from the base.
    const version = await get('/v1/administrative/version');
    expect(version.statusCode).toBe(200);
    expect(version.json().datasetVersion).toBe(base.version);
  });
});

describe('materialisation', () => {
  it('refuses a revision that is not the one the reviewer read', async () => {
    const res = await post(`${BASE}/${base.id}/override-set/materialize`, 'ops_admin', {
      payload: { reason: 'stale', expectedRevision: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('OVERRIDE_SET_REVISION_CONFLICT');
  });

  it('creates exactly one STAGED dataset and leaves the base byte-identical', async () => {
    const beforeBase = await baseFingerprint(base.id);
    const beforeCount = (
      await db.select({ n: sql<number>`count(*)::int` }).from(schema.administrativeDatasetVersions)
    )[0]!.n;

    const startedAt = Date.now();
    const res = await post(`${BASE}/${base.id}/override-set/materialize`, 'ops_admin', {
      payload: { reason: 'first review round', expectedRevision: await revision() },
    });
    const elapsed = Date.now() - startedAt;
    expect(res.statusCode).toBe(201);
    const body = res.json();
    derived = { id: body.datasetVersionId, version: body.combinedDatasetVersion };

    expect(body.status).toBe('STAGED');
    expect(body.overrideRevision).toBe(1);
    expect(body.combinedDatasetVersion).toContain('+r1');
    expect(body.combinedDatasetVersion).not.toBe(base.version);
    expect(body.decisions.accepted).toBe(2);
    expect(body.decisions.edges).toBe(2);

    const afterCount = (
      await db.select({ n: sql<number>`count(*)::int` }).from(schema.administrativeDatasetVersions)
    )[0]!.n;
    expect(afterCount).toBe(beforeCount + 1);
    // The base is evidence. Nothing about it may move.
    expect(await baseFingerprint(base.id)).toEqual(beforeBase);
    expect(await activeIds()).toEqual([base.id]);

    // Reported rather than asserted against a threshold: what matters is that a
    // review round costs one copy, and how long that copy takes is a fact worth
    // having in the log when it changes.
    const counts = await db.execute(sql`
      select
        (select count(*)::int from administrative_units where dataset_version_id = ${derived.id}::uuid) as units,
        (select count(*)::int from administrative_unit_changes where dataset_version_id = ${derived.id}::uuid) as changes,
        (select count(*)::int from administrative_mapping_quarantine where dataset_version_id = ${derived.id}::uuid) as quarantine,
        pg_total_relation_size('administrative_units') as units_bytes`);
    const c = counts.rows[0] as Record<string, number>;
    // eslint-disable-next-line no-console
    console.log(
      `[ADM-011] materialised ${c.units} units + ${c.changes} changes + ${c.quarantine} quarantine ` +
        `rows in ${elapsed}ms (administrative_units total ${Math.round(Number(c.units_bytes) / 1_048_576)} MiB)`,
    );
    // Measured against the pinned source, like every other count in this suite.
    expect(c.units).toBe(14149);
    expect(c.quarantine).toBe(1033);
    // 9,569 copied plus the two the reviewer decided.
    expect(c.changes).toBe(9571);
  }, 180_000);

  it('writes the accepted edges only in the derived dataset, bound to their decisions', async () => {
    const edges = await db
      .select()
      .from(schema.administrativeUnitChanges)
      .where(
        and(
          eq(schema.administrativeUnitChanges.datasetVersionId, derived!.id),
          sql`override_decision_id is not null`,
        ),
      );
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.resolution).toBe('resolved');
      expect(edge.changeType).toBe('SPLIT');
      expect(edge.overrideDecisionId).toBeTruthy();
      expect(edge.sourceVersion).toBe('override:r1');
    }
    // The rejected row produced none — a rejection changes provenance, not content.
    expect(edges.some((e) => e.oldCode === rowA.oldCode)).toBe(true);
  });

  it('carries every quarantine row forward with its decision recorded', async () => {
    const [decided] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeMappingQuarantine)
      .where(
        and(
          eq(schema.administrativeMappingQuarantine.datasetVersionId, derived!.id),
          sql`reviewer_decision is not null`,
        ),
      );
    expect(decided!.n).toBe(2);
    // And the base's own rows still say nothing, because nobody decided them there.
    const [baseDecided] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeMappingQuarantine)
      .where(
        and(
          eq(schema.administrativeMappingQuarantine.datasetVersionId, base.id),
          sql`reviewer_decision is not null`,
        ),
      );
    expect(baseDecided!.n).toBe(0);
  });

  it('reports the carried decisions as settled, and takes them out of the backlog', async () => {
    // GoGo-BE#619: the derived version carried the decision on every row it
    // was taken for, and the queue still called each of them UNDECIDED and
    // counted it in the backlog — a published round looked like nobody had
    // reviewed anything.
    type Item = {
      id: string;
      decisionState: string;
      decidedAt: string | null;
      source: { code: string | null };
    };
    type Counts = { decisions: Record<string, number>; backlog: Record<string, number> };
    type Page = { items: Item[]; counts: Counts; nextCursor: string | null };
    const items: Item[] = [];
    let counts!: Counts;
    let cursor: string | null = null;
    do {
      const page: Page = (
        await get(
          `${BASE}/${derived!.id}/quarantine?limit=100` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
          'ops_admin',
        )
      ).json();
      items.push(...page.items);
      counts = page.counts;
      cursor = page.nextCursor;
    } while (cursor);
    expect(items).toHaveLength(1033);

    const settled = items.filter((i) => i.decisionState === 'MATERIALIZED_ACCEPT');
    expect(settled.map((i) => i.source.code).sort()).toEqual([rowA.oldCode, rowB.oldCode].sort());
    expect(settled.every((i) => i.decidedAt)).toBe(true);
    expect(items.some((i) => i.decisionState === 'MATERIALIZED_REJECT')).toBe(false);

    // The other rows of the two decided sources are settled by those decisions
    // (GoGo-BE#622): not decided themselves, not in the backlog either.
    const settledBySource = items.filter((i) => i.decisionState === 'SOURCE_SETTLED');
    expect(settledBySource).toHaveLength(settledSiblings);
    expect(
      settledBySource.every(
        (i) => i.source.code === rowA.oldCode || i.source.code === rowB.oldCode,
      ),
    ).toBe(true);

    expect(counts.decisions.MATERIALIZED_ACCEPT).toBe(2);
    expect(counts.decisions.MATERIALIZED_REJECT).toBe(0);
    expect(counts.decisions.SOURCE_SETTLED).toBe(settledSiblings);
    expect(counts.decisions.UNDECIDED).toBe(1031 - settledSiblings);
    expect(counts.backlog).toEqual({ DIVIDED_REQUIRES_REVIEW: 1031 - settledSiblings });

    // The filter knows the new state.
    const filtered = await get(
      `${BASE}/${derived!.id}/quarantine?decisionState=MATERIALIZED_ACCEPT&limit=10`,
      'ops_admin',
    );
    expect(filtered.statusCode).toBe(200);
    expect(
      (filtered.json().items as Item[]).every((i) => i.decisionState === 'MATERIALIZED_ACCEPT'),
    ).toBe(true);

    // The detail names the decision and the successor the accepted edge points at.
    const carried = settled.find((i) => i.source.code === rowA.oldCode)!;
    const detail = (
      await get(`${BASE}/${derived!.id}/quarantine/${carried.id}`, 'ops_admin')
    ).json();
    expect(detail.decisionState).toBe('MATERIALIZED_ACCEPT');
    expect(detail.materialized).toEqual({
      decision: 'ACCEPT',
      targetCode: rowA.candidates[1],
      reason: expect.any(String),
      decidedAt: expect.any(String),
    });
    // Nothing is drafted on the derived version; a settled decision is not a draft.
    expect(detail.decision).toBeNull();
    expect(detail.history).toEqual([]);
    expect(detail.sourceSettled).toBeNull();

    // The sibling row names the decision that settled it, and where it went.
    const sibling = await rowOn(derived!.id, siblingA.oldCode, siblingA.newCode);
    const siblingDetail = (
      await get(`${BASE}/${derived!.id}/quarantine/${sibling.id}`, 'ops_admin')
    ).json();
    expect(siblingDetail.decisionState).toBe('SOURCE_SETTLED');
    expect(siblingDetail.materialized).toBeNull();
    expect(siblingDetail.sourceSettled).toEqual({
      targetCode: rowA.candidates[1],
      sourceVersion: 'override:r1',
      decisionId: expect.any(String),
    });

    // The base is evidence and stays as it was: nothing there is settled.
    const baseCounts = (await get(`${BASE}/${base.id}/quarantine?limit=1`, 'ops_admin')).json()
      .counts;
    expect(baseCounts.decisions.MATERIALIZED_ACCEPT).toBe(0);
    expect(baseCounts.backlog).toEqual({ DIVIDED_REQUIRES_REVIEW: 1033 });
  }, 120_000);

  it('closes the set and refuses to materialise it twice', async () => {
    const [set] = await db
      .select()
      .from(schema.administrativeMappingOverrideSets)
      .where(eq(schema.administrativeMappingOverrideSets.baseDatasetId, base.id));
    expect(set!.status).toBe('MATERIALIZED');
    expect(set!.materializedDatasetId).toBe(derived!.id);

    const again = await post(`${BASE}/${base.id}/override-set/materialize`, 'ops_admin', {
      payload: { reason: 'again', expectedRevision: set!.revision },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('OVERRIDE_SET_NOT_FOUND');
  });

  it('does not serve the derived version to anybody until it is published', async () => {
    const version = await get('/v1/administrative/version');
    expect(version.json().datasetVersion).toBe(base.version);
    expect(await activeIds()).toEqual([base.id]);
  });

  it('audits the materialisation with both identities and the decision counts', async () => {
    const row = await lastAudit('administrative_mapping_override_set.materialized');
    const diff = row!.diff as Record<string, unknown>;
    expect(diff.materializedDatasetId).toBe(derived!.id);
    expect(diff.baseDatasetId).toBe(base.id);
    expect((diff.decisions as Record<string, number>).accepted).toBe(2);
  });
});

describe('the derived dataset goes through the ordinary path', () => {
  it('validates, and its override gates pass', async () => {
    const res = await post(`${BASE}/${derived!.id}/validate`, 'ops_admin');
    expect(res.statusCode).toBe(201);
    const validation = res.json().validation;
    const gates = validation.findings.map((f: { gate: string }) => f.gate);
    // The SPLIT edges are canonical *because a reviewer decided them*, so the
    // structural gate must not call them malformed.
    expect(gates).not.toContain('MERGE_SPLIT_STRUCTURE');
    expect(gates).not.toContain('QUARANTINE_EXCLUDED');
    expect(gates).not.toContain('OVERRIDE_CONFLICT');
    expect(gates).not.toContain('OVERRIDE_PROVENANCE');
    expect(gates).not.toContain('OVERRIDE_REVISION_CONSISTENT');
    expect(validation.publishable).toBe(true);
  }, 180_000);

  it('diffs as two override entries, not as 9,569 replayed migrations', async () => {
    const diff = (await get(`${BASE}/${derived!.id}/diff?limit=50`, 'ops_admin')).json();
    expect(diff.fromVersion).toBe(base.version);
    expect(diff.countsByCategory.OVERRIDE_ACCEPTED).toBe(2);
    expect(diff.countsByCategory.MERGED).toBe(0);
    expect(diff.countsByCategory.RENAMED).toBe(0);
    // One entry for the override revision moving, and nothing else drifted.
    expect(diff.countsByCategory.SOURCE_DRIFT).toBe(1);

    const entry = diff.entries.find(
      (e: { category: string }) => e.category === 'OVERRIDE_ACCEPTED',
    );
    expect(entry.provenance).toContain('GoGo reviewer decision');
    expect(entry.detail).toContain('accepted by a reviewer');
    expect(entry.from.effectiveFrom).toBeTruthy();
    expect(entry.to.effectiveFrom).toBeTruthy();
  });

  it('publishes through the existing path, and only then does the resolver change', async () => {
    const res = await post(`${BASE}/${derived!.id}/publish`, 'ops_admin');
    expect(res.statusCode).toBe(201);
    expect(await activeIds()).toEqual([derived!.id]);

    const version = await get('/v1/administrative/version');
    expect(version.json().datasetVersion).toBe(derived!.version);
    expect(version.json().datasetVersion).toContain('+r1');
  }, 120_000);

  it('answers the reviewer’s decision, and only now', async () => {
    // The same read that reported `unresolved` before the round now names the
    // successor a person chose. This is the whole feature, end to end.
    const res = await get(`/v1/administrative/resolve?code=${rowA.oldCode}&at=2025-01-01`);
    expect(res.statusCode).toBe(200);
    expect(res.json().unresolved).toBe(false);
    expect(res.json().successors.map((s: { code: string }) => s.code)).toContain(
      rowA.candidates[1],
    );
  });
});

describe('a second round opens against the derived version', () => {
  it('refuses to reuse the materialised set and opens a new draft', async () => {
    const [row] = await db
      .select({ id: schema.administrativeMappingQuarantine.id })
      .from(schema.administrativeMappingQuarantine)
      .where(eq(schema.administrativeMappingQuarantine.datasetVersionId, derived!.id))
      .orderBy(schema.administrativeMappingQuarantine.id)
      .limit(1);

    const res = await post(`${BASE}/${derived!.id}/quarantine/${row!.id}/reject`, 'ops_admin', {
      payload: { reason: 'second round', expectedRevision: 0 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().overrideSetRevision).toBe(1);

    const sets = await db
      .select()
      .from(schema.administrativeMappingOverrideSets)
      .where(eq(schema.administrativeMappingOverrideSets.baseDatasetId, derived!.id));
    expect(sets).toHaveLength(1);
    expect(sets[0]!.status).toBe('DRAFT');
  });

  it('abandons a draft, and then refuses every write to it', async () => {
    const at = (
      await db
        .select()
        .from(schema.administrativeMappingOverrideSets)
        .where(
          and(
            eq(schema.administrativeMappingOverrideSets.baseDatasetId, derived!.id),
            eq(schema.administrativeMappingOverrideSets.status, 'DRAFT'),
          ),
        )
    )[0]!.revision;

    const abandoned = await post(`${BASE}/${derived!.id}/override-set/abandon`, 'ops_admin', {
      payload: { reason: 'wrong dataset, starting again', expectedRevision: at },
    });
    expect(abandoned.statusCode).toBe(201);
    expect(abandoned.json().status).toBe('ABANDONED');

    // Abandoning does not delete the decisions; it stops the set accepting more.
    const [kept] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeMappingOverrideDecisions)
      .where(eq(schema.administrativeMappingOverrideDecisions.baseDatasetId, derived!.id));
    expect(kept!.n).toBe(1);

    // Nothing left to materialise: the abandoned set is not a draft any more.
    const materialize = await post(`${BASE}/${derived!.id}/override-set/materialize`, 'ops_admin', {
      payload: { reason: 'the abandoned one', expectedRevision: at },
    });
    expect(materialize.statusCode).toBe(409);
    expect(materialize.json().code).toBe('OVERRIDE_SET_NOT_FOUND');

    // A new decision opens a fresh draft rather than reviving the abandoned one.
    const [row] = await db
      .select({ id: schema.administrativeMappingQuarantine.id })
      .from(schema.administrativeMappingQuarantine)
      .where(eq(schema.administrativeMappingQuarantine.datasetVersionId, derived!.id))
      .orderBy(schema.administrativeMappingQuarantine.id)
      .limit(1);
    const next = await post(`${BASE}/${derived!.id}/quarantine/${row!.id}/reject`, 'ops_admin', {
      payload: { reason: 'third round', expectedRevision: 0 },
    });
    expect(next.statusCode).toBe(201);
    expect(next.json().overrideSetRevision).toBe(1);
  });
});

describe('a settled source stays settled across rounds (GoGo-BE#622)', () => {
  const draftRevision = async (versionId: string) =>
    (
      await db
        .select({ revision: schema.administrativeMappingOverrideSets.revision })
        .from(schema.administrativeMappingOverrideSets)
        .where(
          and(
            eq(schema.administrativeMappingOverrideSets.baseDatasetId, versionId),
            eq(schema.administrativeMappingOverrideSets.status, 'DRAFT'),
          ),
        )
    )[0]?.revision ?? 0;

  it('refuses to send a settled source elsewhere, and says where it already goes', async () => {
    // DEV 2026-09-17: r1 said 00007 → 00025; the sibling row still read
    // "undecided", and accepting it onto 00008 minted a version with two
    // successors for one commune.
    const sibling = await rowOn(derived!.id, siblingA.oldCode, siblingA.newCode);
    const before = await draftRevision(derived!.id);
    const res = await post(`${BASE}/${derived!.id}/quarantine/${sibling.id}/accept`, 'ops_admin', {
      payload: {
        targetCode: rowA.candidates[0],
        targetEffectiveFrom: '2025-07-01',
        reason: 'second thoughts about the first round',
        expectedRevision: before,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('OVERRIDE_SOURCE_ALREADY_RESOLVED');
    expect(res.json().message).toContain(rowA.candidates[1]);
    expect(res.json().message).toContain('override:r1');
    expect(await draftRevision(derived!.id)).toBe(before);
  });

  it('materialises a second round that carries the first round with it', async () => {
    const third = await rowOn(derived!.id, rowC.oldCode, rowC.newCode);
    const before = await draftRevision(derived!.id);
    const accepted = await post(
      `${BASE}/${derived!.id}/quarantine/${third.id}/accept`,
      'ops_admin',
      {
        payload: {
          targetCode: rowC.candidates[0],
          targetEffectiveFrom: '2025-07-01',
          reason: 'second round: a third commune',
          expectedRevision: before,
        },
      },
    );
    expect(accepted.statusCode).toBe(201);

    // What the live draft on r1 holds besides that accept: the previous
    // describe rejected r1's first row by id, which is random per import and
    // may be any row — including one the first round decided. The expectations
    // below are computed from that, not assumed.
    const [liveSet] = await db
      .select({ id: schema.administrativeMappingOverrideSets.id })
      .from(schema.administrativeMappingOverrideSets)
      .where(
        and(
          eq(schema.administrativeMappingOverrideSets.baseDatasetId, derived!.id),
          eq(schema.administrativeMappingOverrideSets.status, 'DRAFT'),
        ),
      );
    const liveRejects = await db
      .select({
        oldCode: schema.administrativeMappingQuarantine.oldCode,
        newCode: schema.administrativeMappingQuarantine.newCode,
      })
      .from(schema.administrativeMappingOverrideDecisions)
      .innerJoin(
        schema.administrativeMappingQuarantine,
        eq(
          schema.administrativeMappingQuarantine.id,
          schema.administrativeMappingOverrideDecisions.quarantineRowId,
        ),
      )
      .where(
        and(
          eq(schema.administrativeMappingOverrideDecisions.overrideSetId, liveSet!.id),
          eq(schema.administrativeMappingOverrideDecisions.decision, 'REJECT'),
          isNull(schema.administrativeMappingOverrideDecisions.supersededById),
        ),
      );
    const key = (r: { oldCode: string | null; newCode: string | null }) =>
      `${r.oldCode}>${r.newCode}`;
    const rejectedKeys = new Set(liveRejects.map(key));

    const res = await post(`${BASE}/${derived!.id}/override-set/materialize`, 'ops_admin', {
      payload: { reason: 'second review round', expectedRevision: before + 1 },
    });
    expect(res.statusCode).toBe(201);
    second = { id: res.json().datasetVersionId, version: res.json().combinedDatasetVersion };
    expect(second.version).toContain('+r2');

    // Before #622 the copy carried only this round's decisions, and the rows
    // decided in r1 went back to "undecided" while their edges stayed canonical.
    // A row this round re-decided carries this round's decision instead.
    for (const source of [rowA, rowB, rowC]) {
      const row = await rowOn(second.id, source.oldCode, source.newCode);
      const item = (await get(`${BASE}/${second.id}/quarantine/${row.id}`, 'ops_admin')).json();
      const reDecided = rejectedKeys.has(key(row));
      expect(item.decisionState).toBe(reDecided ? 'MATERIALIZED_REJECT' : 'MATERIALIZED_ACCEPT');
      expect(row.reviewerDecision).toBe(reDecided ? 'REJECT' : 'ACCEPT');
      expect(row.reviewedAt).toBeTruthy();
      if (source === rowA && !reDecided) {
        expect(item.materialized.targetCode).toBe(rowA.candidates[1]);
      }
    }

    // Stamped rows on r2: the three accepts across two rounds plus this
    // round's rejects, counted once per row.
    const [stamped] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeMappingQuarantine)
      .where(
        and(
          eq(schema.administrativeMappingQuarantine.datasetVersionId, second.id),
          sql`reviewer_decision is not null`,
        ),
      );
    const decided = new Set([...[rowA, rowB, rowC].map(key), ...rejectedKeys]);
    expect(stamped!.n).toBe(decided.size);

    // And the sibling of the first round's source is still settled by it.
    const sibling = await rowOn(second.id, siblingA.oldCode, siblingA.newCode);
    const siblingItem = (
      await get(`${BASE}/${second.id}/quarantine/${sibling.id}`, 'ops_admin')
    ).json();
    expect(['SOURCE_SETTLED', 'MATERIALIZED_REJECT']).toContain(siblingItem.decisionState);
    if (siblingItem.decisionState === 'SOURCE_SETTLED') {
      expect(siblingItem.sourceSettled.sourceVersion).toBe('override:r1');
    }
  }, 180_000);

  it('validates the second round without a source conflict', async () => {
    const res = await post(`${BASE}/${second!.id}/validate`, 'ops_admin');
    expect(res.statusCode).toBe(201);
    const gates = res.json().validation.findings.map((f: { gate: string }) => f.gate);
    expect(gates).not.toContain('OVERRIDE_CONFLICT');
    expect(res.json().validation.publishable).toBe(true);
  }, 180_000);
});

describe('a materialised override can be retracted in a later round (GoGo-BE#623)', () => {
  let third: { id: string; version: string } | null = null;
  let siblingC!: { id: string; oldCode: string; newCode: string };

  it('publishes the second round, so there is a served override to retract', async () => {
    const res = await post(`${BASE}/${second!.id}/publish`, 'ops_admin');
    expect(res.statusCode).toBe(201);
    expect(await activeIds()).toEqual([second!.id]);
    const served = await get(`/v1/administrative/resolve?code=${rowC.oldCode}&at=2025-01-01`);
    expect(served.json().unresolved).toBe(false);
    expect(served.json().successors.map((s: { code: string }) => s.code)).toContain(
      rowC.candidates[0],
    );
  }, 120_000);

  it('records a REJECT on the decided row as a retraction, and on a sibling as nothing', async () => {
    const decided = await rowOn(second!.id, rowC.oldCode, rowC.newCode);
    const [sibling] = await db
      .select()
      .from(schema.administrativeMappingQuarantine)
      .where(
        and(
          eq(schema.administrativeMappingQuarantine.datasetVersionId, second!.id),
          eq(schema.administrativeMappingQuarantine.oldCode, rowC.oldCode),
          sql`${schema.administrativeMappingQuarantine.id} <> ${decided.id}::uuid`,
        ),
      )
      .limit(1);
    siblingC = { id: sibling!.id, oldCode: sibling!.oldCode!, newCode: sibling!.newCode! };

    const retract = await post(
      `${BASE}/${second!.id}/quarantine/${decided.id}/reject`,
      'ops_admin',
      {
        payload: { reason: 'the survey was wrong: this ward went elsewhere', expectedRevision: 0 },
      },
    );
    expect(retract.statusCode).toBe(201);
    expect(retract.json().retracts).toEqual({
      decisionId: expect.any(String),
      targetCode: rowC.candidates[0],
      sourceVersion: 'override:r2',
    });

    const plain = await post(
      `${BASE}/${second!.id}/quarantine/${siblingC.id}/reject`,
      'ops_admin',
      {
        payload: { reason: 'not this proposal either', expectedRevision: 1 },
      },
    );
    expect(plain.statusCode).toBe(201);
    expect(plain.json().retracts).toBeNull();
  });

  it('materialises without the retracted edge, and says so', async () => {
    const res = await post(`${BASE}/${second!.id}/override-set/materialize`, 'ops_admin', {
      payload: { reason: 'third round: retract', expectedRevision: 2 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().decisions).toMatchObject({
      accepted: 0,
      rejected: 2,
      edges: 0,
      retracted: 1,
    });
    third = { id: res.json().datasetVersionId, version: res.json().combinedDatasetVersion };
    expect(third.version).toContain('+r3');

    const overrides = await db
      .select({ oldCode: schema.administrativeUnitChanges.oldCode })
      .from(schema.administrativeUnitChanges)
      .where(
        and(
          eq(schema.administrativeUnitChanges.datasetVersionId, third.id),
          sql`override_decision_id is not null`,
        ),
      );
    // The first round's two overrides are still there; the retracted one is not.
    expect(overrides.map((o) => o.oldCode).sort()).toEqual([rowA.oldCode, rowB.oldCode].sort());
    // And the previous version is untouched: the edge still exists where it was decided.
    const [kept] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.administrativeUnitChanges)
      .where(
        and(
          eq(schema.administrativeUnitChanges.datasetVersionId, second!.id),
          eq(schema.administrativeUnitChanges.oldCode, rowC.oldCode),
          sql`override_decision_id is not null`,
        ),
      );
    expect(kept!.n).toBe(1);
  }, 180_000);

  it('reads the retracted row as a carried rejection naming what it withdrew', async () => {
    const decided = await rowOn(third!.id, rowC.oldCode, rowC.newCode);
    const detail = (await get(`${BASE}/${third!.id}/quarantine/${decided.id}`, 'ops_admin')).json();
    expect(detail.decisionState).toBe('MATERIALIZED_REJECT');
    expect(detail.materialized).toMatchObject({
      decision: 'REJECT',
      targetCode: null,
      retracted: { targetCode: rowC.candidates[0], decisionId: expect.any(String) },
    });
    expect(detail.sourceSettled).toBeNull();

    // The sibling's rejection withdrew nothing, and the source is open again:
    // nothing settles its other rows any more.
    const sibling = await rowOn(third!.id, siblingC.oldCode, siblingC.newCode);
    const siblingDetail = (
      await get(`${BASE}/${third!.id}/quarantine/${sibling.id}`, 'ops_admin')
    ).json();
    expect(siblingDetail.decisionState).toBe('MATERIALIZED_REJECT');
    expect(siblingDetail.materialized.retracted).toBeNull();
    expect(siblingDetail.sourceSettled).toBeNull();
  });

  it('diffs against the published version as one retraction, not as an acceptance', async () => {
    const diff = (await get(`${BASE}/${third!.id}/diff?limit=50`, 'ops_admin')).json();
    expect(diff.fromVersion).toBe(second!.version);
    expect(diff.countsByCategory.OVERRIDE_RETRACTED).toBe(1);
    expect(diff.countsByCategory.OVERRIDE_ACCEPTED).toBe(0);
    const entry = diff.entries.find(
      (e: { category: string }) => e.category === 'OVERRIDE_RETRACTED',
    );
    expect(entry.key).toBe(`OVERRIDE_RETRACTED:${rowC.oldCode}>${rowC.candidates[0]}`);
    expect(entry.detail).toContain('retracted');
  });

  it('validates, publishes, and the resolver forgets the retracted successor only now', async () => {
    const validation = await post(`${BASE}/${third!.id}/validate`, 'ops_admin');
    expect(validation.statusCode).toBe(201);
    const gates = validation.json().validation.findings.map((f: { gate: string }) => f.gate);
    expect(gates).not.toContain('OVERRIDE_CONFLICT');
    expect(validation.json().validation.publishable).toBe(true);

    // Still served from r2 until publication.
    expect(
      (await get(`/v1/administrative/resolve?code=${rowC.oldCode}&at=2025-01-01`)).json()
        .unresolved,
    ).toBe(false);

    const published = await post(`${BASE}/${third!.id}/publish`, 'ops_admin');
    expect(published.statusCode).toBe(201);
    expect(await activeIds()).toEqual([third!.id]);

    const forgotten = await get(`/v1/administrative/resolve?code=${rowC.oldCode}&at=2025-01-01`);
    expect(forgotten.json().unresolved).toBe(true);
    // The first round's decision is unaffected by the third.
    const kept = await get(`/v1/administrative/resolve?code=${rowA.oldCode}&at=2025-01-01`);
    expect(kept.json().unresolved).toBe(false);
    expect(kept.json().successors.map((s: { code: string }) => s.code)).toContain(
      rowA.candidates[1],
    );
  }, 300_000);

  it('lets the source be decided again, now that nothing settles it', async () => {
    const sibling = await rowOn(third!.id, siblingC.oldCode, siblingC.newCode);
    const res = await post(`${BASE}/${third!.id}/quarantine/${sibling.id}/accept`, 'ops_admin', {
      payload: {
        targetCode: rowC.candidates[1],
        targetEffectiveFrom: '2025-07-01',
        reason: 'fourth round: the corrected successor',
        expectedRevision: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().retracts).toBeNull();
  });
});

describe('the whole surface calls no provider and issues no Redis command', () => {
  it('reads, decides and refuses without touching Google or Upstash', async () => {
    const google = await metricCount('google');
    const upstash = await metricCount('upstash');

    expect((await get(`${BASE}/${base.id}/quarantine?limit=2`, 'ops_admin')).statusCode).toBe(200);
    expect((await get(`${BASE}/${base.id}/quarantine/${rowA.id}`, 'ops_admin')).statusCode).toBe(
      200,
    );
    expect((await get(`${BASE}/${base.id}/override-set`, 'ops_admin')).statusCode).toBe(200);
    // The base already produced a version; the next round belongs on that one.
    const refused = await post(`${BASE}/${base.id}/quarantine/${rowA.id}/reject`, 'ops_admin', {
      payload: { reason: 'the base is spent', expectedRevision: 0 },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('OVERRIDE_BASE_ALREADY_MATERIALIZED');

    expect(await metricCount('google')).toBe(google);
    expect(await metricCount('upstash')).toBe(upstash);
  });

  it('emits only the declared, bounded labels', async () => {
    const body = await scrape();
    const lines = body
      .split('\n')
      .filter((line) => line.startsWith('administrative_override_') && !line.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const labels = /\{([^}]*)\}/.exec(line)?.[1] ?? '';
      const keys = labels
        .split(',')
        .filter(Boolean)
        .map((pair) => pair.split('=')[0]!.trim());
      // No dataset id, no row id, no reviewer: those are unbounded and live in
      // the audit row.
      for (const key of keys) {
        expect(['view', 'decision', 'result', 'operation', 'le']).toContain(key);
      }
    }
  });
});

async function scrape(): Promise<string> {
  const metrics = await api().inject({
    method: 'GET',
    url: '/v1/metrics',
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN ?? ''}` },
  });
  if (metrics.statusCode !== 200) {
    throw new Error(
      `metrics scrape failed with ${metrics.statusCode}; the assertion would be vacuous`,
    );
  }
  return metrics.body;
}

/** Sums `provider_requests_total` samples whose labels mention a provider. */
async function metricCount(provider: string): Promise<number> {
  return (await scrape())
    .split('\n')
    .filter((line) => line.startsWith('provider_requests_total') && line.includes(provider))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}
