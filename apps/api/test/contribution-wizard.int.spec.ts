import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import { ContributionDraftsService } from '../../../libs/modules/ingestion/application/contribution-drafts.service';
import { PlaceSubmissionService } from '../../../libs/modules/ingestion/application/place-submission.service';
import { SubmissionPhotosService } from '../../../libs/modules/ingestion/application/submission-photos.service';
import { UploadsService } from '../../../libs/modules/uploads/application/uploads.service';
import { MediaCleanupService } from '../../../libs/modules/profile/application/media-cleanup.service';
import { FakeStorage } from '@gogo/providers';
import { grantSubmissionCredits } from '../../../libs/modules/shared/assistant-credits';
import { eraseAssistantDataForUser } from '../../../libs/modules/assistant/application/assistant-privacy';
import { PrivacyJobs } from '../../../libs/modules/shared/privacy-jobs';
import { collectUserExport } from '../../../libs/modules/reviews/application/user-export';
import type { Actor } from '../../../libs/modules/identity/domain/actor';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let drafts: ContributionDraftsService;
let owner: Actor;
let other: Actor;
const enrichment = {
  purposeKeys: ['work_reading'],
  vibeKeys: ['chill'],
  amenities: { car_parking: false },
  service: { rating: 5, chipKeys: ['service_friendly'] },
  space: { rating: 3, chipKeys: ['space_quiet'] },
  visitTips: 'Nhớ đặt bàn',
};
const input = { googlePlaceId: 'wizard-provider-id', expectedVersion: 0, enrichment };
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  const folder = path.resolve(__dirname, '../../../migrations');
  const journal = JSON.parse(await readFile(path.join(folder, 'meta/_journal.json'), 'utf8'));
  const prior = journal.entries.filter(
    (entry: { tag: string }) => entry.tag !== '0089_place-contribution-wizard',
  );
  const snapshot = await mkdtemp(path.join(os.tmpdir(), 'gogo-796-snapshot-'));
  try {
    await mkdir(path.join(snapshot, 'meta'));
    await writeFile(
      path.join(snapshot, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: prior }),
    );
    for (const entry of prior)
      await cp(path.join(folder, `${entry.tag}.sql`), path.join(snapshot, `${entry.tag}.sql`));
    await migrate(db, { migrationsFolder: snapshot });
    await pool.query("insert into place_submissions(google_place_id) values ('legacy-796')");
    await pool.query(
      "insert into assistant_credit_ledger(delta,reason,submission_id,venue_identity) values (50,'submission_approved',gen_random_uuid(),'legacy:796')",
    );
    await migrate(db, { migrationsFolder: folder });
    expect(
      (
        await pool.query(
          "select enrichment from place_submissions where google_place_id='legacy-796'",
        )
      ).rows,
    ).toEqual([{ enrichment: null }]);
    expect(
      (
        await pool.query(
          "select delta from assistant_credit_ledger where venue_identity='legacy:796'",
        )
      ).rows,
    ).toEqual([{ delta: 50 }]);
    expect(
      (
        await pool.query(
          "select convalidated from pg_constraint where conname='assistant_credit_ledger_check'",
        )
      ).rows,
    ).toEqual([{ convalidated: false }]);
    await pool.query(
      await readFile(
        path.resolve(__dirname, '../../../scripts/ops/validate-contribution-credit-ledger.sql'),
        'utf8',
      ),
    );
    expect(
      (
        await pool.query(
          "select convalidated from pg_constraint where conname='assistant_credit_ledger_check'",
        )
      ).rows,
    ).toEqual([{ convalidated: true }]);
    await pool.query("delete from place_submissions where google_place_id='legacy-796'");
    await pool.query("delete from assistant_credit_ledger where venue_identity='legacy:796'");
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }

  await db.insert(schema.taxonomies).values({ kind: 'mood', key: 'chill' }).onConflictDoNothing();
  const users = await db
    .insert(schema.users)
    .values([{ displayName: 'Contributor' }, { displayName: 'Other' }])
    .returning();
  owner = { type: 'user', id: users[0]!.id, sessionId: randomUUID() };
  other = { type: 'user', id: users[1]!.id, sessionId: randomUUID() };
  drafts = new ContributionDraftsService(db);
});
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('private contribution lifecycle against PostgreSQL (#796)', () => {
  it('saves, resumes, version-checks and deletes only own drafts', async () => {
    const id = randomUUID();
    const saved = await drafts.save(owner, id, input);
    expect(saved).toMatchObject({ version: 1, enrichment, verificationStatus: 'unverified' });
    expect(new Date(saved.expiresAt).getTime() - new Date(saved.updatedAt).getTime()).toBeCloseTo(
      30 * 86400000,
      -2,
    );
    expect((await drafts.get(owner, id)).enrichment.amenities?.car_parking).toBe(false);
    await expect(drafts.get(other, id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(drafts.save(other, id, input)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(drafts.delete(other, id, 1)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(drafts.save(owner, id, { ...input, expectedVersion: 9 })).rejects.toMatchObject({
      code: 'DRAFT_MODIFIED',
    });
    const updated = await drafts.save(owner, id, {
      ...input,
      expectedVersion: 1,
      enrichment: { visitTips: 'Lưu bước đầu' },
    });
    expect(updated).toMatchObject({ version: 2, enrichment: { visitTips: 'Lưu bước đầu' } });
    await expect(drafts.delete(owner, id, 1)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await drafts.delete(owner, id, 2)).toEqual({ deleted: true });
    await expect(drafts.get(owner, id)).rejects.toMatchObject({ httpStatus: 404 });
  });
  it('rejects guest/admin, inactive users, bad taxonomy and raw receipts without writes', async () => {
    for (const type of ['guest', 'admin'] as const) {
      const actor = { ...owner, type };
      await expect(drafts.list(actor)).rejects.toMatchObject({ code: 'REGISTERED_USER_REQUIRED' });
      await expect(drafts.get(actor, randomUUID())).rejects.toMatchObject({ httpStatus: 403 });
      await expect(drafts.save(actor, randomUUID(), input)).rejects.toMatchObject({
        httpStatus: 403,
      });
      await expect(drafts.delete(actor, randomUUID(), 1)).rejects.toMatchObject({
        httpStatus: 403,
      });
    }
    await expect(
      drafts.save(owner, randomUUID(), { ...input, enrichment: { vibeKeys: ['not_active'] } }),
    ).rejects.toMatchObject({ code: 'INVALID_TAXONOMY_KEYS' });
    await expect(
      drafts.save(owner, randomUUID(), {
        ...input,
        enrichment: { photos: [{ kind: 'bill', mediaId: randomUUID() }] },
      }),
    ).rejects.toMatchObject({ code: 'SUBMISSION_EVIDENCE_BLOCKED' });
    await db.update(schema.users).set({ status: 'suspended' }).where(eq(schema.users.id, other.id));
    await expect(drafts.save(other, randomUUID(), input)).rejects.toMatchObject({
      httpStatus: 403,
    });
    await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, other.id));
    expect((await drafts.list(owner)).items).toEqual([]);
  });
  it('accepts CMS-managed keys of the right kind and rechecks enabled state per request', async () => {
    await db
      .insert(schema.taxonomies)
      .values([
        { kind: 'amenity', key: 'cms_new_amenity' },
        { kind: 'checkin_tag', key: 'friendly_staff' },
        { kind: 'checkin_tag', key: 'quiet_private' },
      ])
      .onConflictDoNothing();
    const id = randomUUID();
    const dynamic = {
      ...enrichment,
      amenities: { cms_new_amenity: false },
      service: { rating: 5, chipKeys: ['friendly_staff'] },
      space: { rating: 3, chipKeys: ['quiet_private'] },
    };
    expect((await drafts.save(owner, id, { ...input, enrichment: dynamic })).enrichment).toEqual(
      dynamic,
    );
    await db
      .update(schema.taxonomies)
      .set({ isActive: false })
      .where(eq(schema.taxonomies.key, 'friendly_staff'));
    await expect(
      drafts.save(owner, id, { ...input, expectedVersion: 1, enrichment: dynamic }),
    ).rejects.toMatchObject({ code: 'INVALID_TAXONOMY_KEYS' });
    await expect(
      drafts.save(owner, id, {
        ...input,
        expectedVersion: 1,
        enrichment: { vibeKeys: ['quiet_private'] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TAXONOMY_KEYS' });
    await drafts.delete(owner, id, 1);
  });
  it('serialises concurrent updates and enforces the owner draft cap', async () => {
    const id = randomUUID();
    await drafts.save(owner, id, input);
    const results = await Promise.allSettled([
      drafts.save(owner, id, { ...input, expectedVersion: 1, enrichment: { visitTips: 'A' } }),
      drafts.save(owner, id, { ...input, expectedVersion: 1, enrichment: { visitTips: 'B' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (let i = 0; i < 19; i++) await drafts.save(owner, randomUUID(), input);
    await expect(drafts.save(owner, randomUUID(), input)).rejects.toMatchObject({
      code: 'DRAFT_LIMIT_REACHED',
    });
    await db
      .delete(schema.placeContributionDrafts)
      .where(eq(schema.placeContributionDrafts.userId, owner.id));
  });
  it('expires drafts immediately, purges them via the real retention job', async () => {
    const id = randomUUID();
    await drafts.save(owner, id, input);
    await db.execute(
      sql`update place_contribution_drafts set expires_at=now()-interval '1 second' where id=${id}`,
    );
    await expect(drafts.get(owner, id)).rejects.toMatchObject({ httpStatus: 404 });
    expect((await drafts.list(owner)).items).toEqual([]);
    expect((await new PrivacyJobs(db).run(true)).contributionDraftsPurged).toBe(1);
    expect(await db.select().from(schema.placeContributionDrafts)).toHaveLength(1);
    expect((await new PrivacyJobs(db).run(false)).contributionDraftsPurged).toBe(1);
    expect(await db.select().from(schema.placeContributionDrafts)).toHaveLength(0);
  });
  it('submits proposal only; dedup never replaces the first contributor claims', async () => {
    const resolver = {
      resolveByProviderId: async () => ({
        status: 'RESOLVED',
        details: { providerPlaceId: 'wizard-provider-id', businessStatus: 'OPERATIONAL' },
      }),
    };
    const dedup = {
      knownProviderPlace: async () => ({ kind: 'MISS', reason: 'absent' }),
      check: async () => ({ kind: 'NEW' }),
      reportIdMismatch: () => {},
      resolveGoogleIdentity: async () => ({ kind: 'UNRESOLVED' }),
    };
    const submissions = new PlaceSubmissionService(
      db,
      resolver as never,
      dedup as never,
      {} as never,
      { PLACE_RESOLVE_DBFIRST_ENABLED: false } as never,
      new SubmissionPhotosService(
        db,
        new UploadsService(db, new FakeStorage(), new FakeStorage(), true, true, true),
        new MediaCleanupService(
          db,
          { private: new FakeStorage(), public: new FakeStorage() },
          {} as never,
          '',
        ),
        new FakeStorage(),
      ),
    );
    const result = await submissions.submit(owner, {
      googlePlaceId: input.googlePlaceId,
      enrichment,
    });
    expect(result).toMatchObject({ status: 'PENDING', deduped: false });
    const id = 'submissionId' in result ? result.submissionId! : '';
    const [row] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, id));
    expect(row!.enrichment).toEqual(enrichment);
    expect(await db.select().from(schema.places)).toHaveLength(0);
    expect(await db.select().from(schema.assistantCreditLedger)).toHaveLength(0);
    expect(await submissions.getSubmission(owner, id)).toMatchObject({
      enrichment,
      verificationStatus: 'unverified',
    });
    expect(
      await submissions.submit(other, {
        googlePlaceId: input.googlePlaceId,
        enrichment: { ...enrichment, visitTips: 'Other' },
      }),
    ).toMatchObject({ deduped: true });
    const [unchanged] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, id));
    expect(unchanged!.enrichment).toEqual(enrichment);
    await expect(
      submissions.submit(
        { ...owner, type: 'guest' },
        { googlePlaceId: input.googlePlaceId, enrichment },
      ),
    ).rejects.toMatchObject({ httpStatus: 403 });
    const exported = await collectUserExport(
      db,
      owner.id,
      { actorType: 'user', actorId: owner.id },
      { mediaPublicBaseUrl: '' },
    );
    expect(exported.contributionEnrichments).toContainEqual({
      submissionId: id,
      enrichment,
      verificationStatus: 'unverified',
    });
  });
  it('grants 50 or at most 70 once per approved source/venue and rolls back with approval failure', async () => {
    const a = randomUUID(),
      b = randomUUID();
    await db.transaction((tx) => grantSubmissionCredits(tx, owner.id, a, 'google:credit-a', 0));
    await db.transaction((tx) => grantSubmissionCredits(tx, owner.id, a, 'google:credit-a', 5));
    await db.transaction((tx) =>
      grantSubmissionCredits(tx, other.id, randomUUID(), 'google:credit-a', 1),
    );
    await db.transaction((tx) => grantSubmissionCredits(tx, owner.id, b, 'google:credit-b', 5));
    const ledger = await db.select().from(schema.assistantCreditLedger);
    expect(ledger.map((r) => r.delta).sort()).toEqual([50, 70]);
    expect(
      (
        await db
          .select()
          .from(schema.assistantCreditAccounts)
          .where(eq(schema.assistantCreditAccounts.userId, owner.id))
      )[0]!.balance,
    ).toBe(120);
    await expect(
      db.transaction(async (tx) => {
        await grantSubmissionCredits(tx, owner.id, randomUUID(), 'google:rolledback', 1);
        throw new Error('Approval failed');
      }),
    ).rejects.toThrow('Approval failed');
    expect(await db.select().from(schema.assistantCreditLedger)).toHaveLength(2);
  });
  it('exports own drafts then removes draft and proposal free text during erasure', async () => {
    const id = randomUUID();
    const [proposal] = await db
      .insert(schema.placeSubmissions)
      .values({
        googlePlaceId: 'wizard-erasure-independent',
        submittedByUserId: owner.id,
        enrichment,
      })
      .returning();
    await drafts.save(owner, id, input);
    const exported = await collectUserExport(
      db,
      owner.id,
      { actorType: 'user', actorId: owner.id },
      { mediaPublicBaseUrl: '' },
    );
    expect(exported.contributionDrafts).toHaveLength(1);
    expect(JSON.stringify(exported)).toContain('Nhớ đặt bàn');
    await db.transaction((tx) => eraseAssistantDataForUser(tx, owner.id));
    expect(await db.select().from(schema.placeContributionDrafts)).toHaveLength(0);
    const [row] = await db
      .select()
      .from(schema.placeSubmissions)
      .where(eq(schema.placeSubmissions.id, proposal!.id));
    expect(row!.enrichment).toBeNull();
    expect(row!.submittedByUserId).toBeNull();
  });
});

it('supports the documented schema rollback without changing credit ledger history', async () => {
  const before = (await pool.query('select id,delta from assistant_credit_ledger order by id'))
    .rows;
  await pool.query(
    "BEGIN; SET LOCAL lock_timeout = '5s'; DROP TABLE place_contribution_drafts; ALTER TABLE place_submissions DROP COLUMN enrichment; COMMIT;",
  );
  expect(
    (await pool.query('select id,delta from assistant_credit_ledger order by id')).rows,
  ).toEqual(before);
  const migration = await readFile(
    path.resolve(__dirname, '../../../migrations/0089_place-contribution-wizard.sql'),
    'utf8',
  );
  for (const ddl of migration.split('--> statement-breakpoint').slice(0, 4)) await pool.query(ddl);
  expect(
    (await pool.query('select enrichment from place_submissions')).rows.every(
      (row) => row.enrichment === null,
    ),
  ).toBe(true);
});
