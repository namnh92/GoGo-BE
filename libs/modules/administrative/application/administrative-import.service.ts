import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@gogo/database';
import { desc, eq } from 'drizzle-orm';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { AUDIT_ACTION, AUDIT_RESOURCE } from './administrative-audit';
import {
  classifyMapping,
  isCanonical,
  summarise,
  type Classified,
  type QuarantineClass,
  type UnitIndex,
} from '../domain/change-classification';
import { combinedChecksum, combinedDatasetVersion } from '../domain/combined-version';
import { parseMappingCsv } from './mapping-csv';
import { PinnedSnapshotReader } from './pinned-snapshot.reader';
import { parseCurrentUnits, parseHistoricalUnits, REORGANISATION_DATE } from './unit-snapshot';

/**
 * ADM-002 (#455) / ADR-0019 §3 — importing a pinned snapshot set into staging.
 *
 * Three properties this service exists to hold, none of which are incidental:
 *
 * 1. **It never touches the active dataset.** Every row it writes carries the
 *    id of the `STAGED` version it created. Publication is a separate, audited
 *    act (#458); an import is not a deployment.
 * 2. **It is deterministic.** The combined version and checksum are pure
 *    functions of the pinned component checksums, so the same inputs produce
 *    the same identity — which is what makes a duplicate import a condition the
 *    database detects rather than a silent second copy.
 * 3. **It is one transaction (#458).** An import that died between the dataset
 *    row and the units used to leave a version that existed, held half a
 *    country, and could never be re-imported — the checksum guard would call
 *    the retry a duplicate. Now nothing is written unless everything is, so a
 *    retry after a failure is a clean import rather than a permanent orphan.
 * 4. **It cannot invent a unit.** A mapping row is promoted to a canonical
 *    change only when both endpoints resolve against the imported units. The
 *    rest are quarantined with their raw payload, and the largest group by far
 *    — the divided communes — is quarantined precisely because the source
 *    offers a default target that ADR-0019 forbids anyone from trusting.
 */

export type ImportActor = { id: string; type: 'admin' | 'system' };

export type ImportReport = {
  datasetVersionId: string;
  combinedDatasetVersion: string;
  combinedChecksum: string;
  counts: {
    provinces: number;
    communes: number;
    legacyDistricts: number;
    legacyCommunes: number;
    canonicalChanges: number;
    quarantined: number;
  };
  classification: Record<QuarantineClass, number>;
  warnings: string[];
};

/**
 * #489 — a publication candidate with no boundary release to bind to.
 *
 * Refused rather than imported as a `+none` dataset. The old behaviour produced
 * a dataset whose boundary component was permanently absent, and because that
 * component is part of the identity, no later import could ever attach one: the
 * geometry loaded into PostgreSQL was real and the resolver could not reach it,
 * since it looks the boundary version up on the dataset and got null.
 *
 * The one `+none` dataset that already exists on DEV predates this and is left
 * exactly as it is — identities are immutable, and it is the rollback target
 * until its boundary-bound successor is published.
 */
export class BoundaryReleaseRequiredError extends Error {
  readonly code = 'BOUNDARY_RELEASE_REQUIRED';
  constructor(
    readonly expectedVersion: string,
    readonly reason: 'missing' | 'checksum-mismatch',
    readonly foundChecksum?: string,
  ) {
    super(
      reason === 'missing'
        ? `no boundary release ${expectedVersion} has been loaded; load it first — ` +
          `an administrative dataset is only publishable once its geometry is bound to it`
        : `boundary release ${expectedVersion} is loaded from a different archive ` +
          `(ledger has ${foundChecksum ?? 'unknown'}); the manifest pin and the loaded ` +
          `release must be the same bytes`,
    );
    this.name = 'BoundaryReleaseRequiredError';
  }
}

export class DuplicateImportError extends Error {
  constructor(readonly existingVersion: string) {
    super(
      `these exact sources are already imported as ${existingVersion}; ` +
        `re-importing unchanged inputs would create a second copy of one dataset`,
    );
    this.name = 'DuplicateImportError';
  }
}

/** Postgres refuses parameter lists far smaller than 3,300 rows in one insert. */
const INSERT_CHUNK = 500;

async function insertChunked<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await write(rows.slice(i, i + INSERT_CHUNK));
  }
}

@Injectable()
export class AdministrativeImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reader: PinnedSnapshotReader = new PinnedSnapshotReader(),
  ) {}

  async importPinnedSnapshot(
    options: { overrideRevision?: number; actor?: ImportActor } = {},
  ): Promise<ImportReport> {
    const overrideRevision = options.overrideRevision ?? 0;

    // Checksums are verified inside `read`, before a byte is parsed.
    const current = this.reader.readJson<Parameters<typeof parseCurrentUnits>[0]>('current-units');
    const historical =
      this.reader.readJson<Parameters<typeof parseHistoricalUnits>[0]>('historical-units');
    const mapping = this.reader.readText('change-mapping');

    // #489 — the boundary release is a separate pinned upstream (#460), loaded
    // by its own operational step. Read it from the ledger and bind it, so the
    // geometry is part of this dataset's identity rather than something that
    // happens to be in the database beside it.
    //
    // Refused when absent. Importing without it produced a `+none` dataset whose
    // boundary component could never be filled in afterwards — the component is
    // part of the version, so a later import with a boundary is a *different*
    // dataset, and the one already published stayed blind to geometry forever.
    const boundary = await this.boundaryRelease();

    const components = {
      currentSourceVersion: current.source.ref,
      currentChecksum: current.source.sha256,
      historicalSourceVersion: historical.source.ref,
      historicalChecksum: historical.source.sha256,
      mappingSourceCommit: mapping.source.commit,
      mappingChecksum: mapping.source.sha256,
      boundarySourceVersion: boundary.version,
      boundaryChecksum: boundary.checksum,
      overrideRevision,
    };
    const version = combinedDatasetVersion(components);
    const checksum = combinedChecksum(components);

    const currentUnits = parseCurrentUnits(current.data);
    const historicalUnits = parseHistoricalUnits(historical.data);
    const rows = parseMappingCsv(mapping.text);

    const index: UnitIndex = {
      currentCommuneProvince: new Map(
        currentUnits.units
          .filter((u) => u.level === 'COMMUNE')
          .map((u) => [u.code, u.parentCode!] as const),
      ),
      currentProvinces: new Set(
        currentUnits.units.filter((u) => u.level === 'PROVINCE').map((u) => u.code),
      ),
      historicalCommunes: new Set(
        historicalUnits.units.filter((u) => u.level === 'COMMUNE').map((u) => u.code),
      ),
      historicalDistricts: new Set(
        historicalUnits.units.filter((u) => u.level === 'LEGACY_DISTRICT').map((u) => u.code),
      ),
    };
    const classified = classifyMapping(rows, index);

    // Everything below is one transaction. The duplicate check is inside it so
    // it cannot pass and then lose the race to a concurrent import: the unique
    // index on the checksum is what finally decides, and this only turns that
    // into a readable error for the common case.
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ version: schema.administrativeDatasetVersions.combinedDatasetVersion })
        .from(schema.administrativeDatasetVersions)
        .where(eq(schema.administrativeDatasetVersions.combinedChecksum, checksum))
        .limit(1);
      if (existing) throw new DuplicateImportError(existing.version);

      const [dataset] = await tx
        .insert(schema.administrativeDatasetVersions)
        .values({
          combinedDatasetVersion: version,
          combinedChecksum: checksum,
          currentSourceVersion: components.currentSourceVersion,
          historicalSourceVersion: components.historicalSourceVersion,
          mappingSourceCommit: components.mappingSourceCommit,
          boundarySourceVersion: components.boundarySourceVersion,
          overrideRevision,
          source: `${current.source.repository}@${current.source.ref}`,
          sourceUrl: `https://github.com/${current.source.repository}/tree/${current.source.ref}`,
          effectiveDate: current.source.effectiveDate ?? REORGANISATION_DATE,
          status: 'STAGED',
        })
        .returning();
      const datasetVersionId = dataset!.id;

      const allUnits = [...currentUnits.units, ...historicalUnits.units];
      await insertChunked(allUnits, (chunk) =>
        tx.insert(schema.administrativeUnits).values(
          chunk.map((u) => ({
            datasetVersionId,
            code: u.code,
            name: u.name,
            fullName: u.fullName,
            nameEn: u.nameEn,
            nameNormalized: u.nameNormalized,
            fullNameNormalized: u.fullNameNormalized,
            codeName: u.codeName,
            unitType: u.unitType,
            level: u.level,
            parentCode: u.parentCode,
            status: u.status,
            effectiveFrom: u.effectiveFrom,
            effectiveTo: u.effectiveTo,
            source:
              u.status === 'ACTIVE' ? current.source.repository : historical.source.repository,
            sourceVersion: u.status === 'ACTIVE' ? current.source.ref : historical.source.ref,
          })),
        ),
      );

      const canonical = classified.filter((c) => isCanonical(c.classification) && c.edge);
      await insertChunked(canonical, (chunk) =>
        tx.insert(schema.administrativeUnitChanges).values(
          chunk.map((c) => ({
            datasetVersionId,
            oldCode: c.edge!.oldCode,
            newCode: c.edge!.newCode,
            changeType: c.edge!.changeType,
            effectiveDate: REORGANISATION_DATE,
            legalReference: 'Nghị quyết 202/2025/QH15',
            sourceVersion: mapping.source.commit,
            resolution: 'resolved' as const,
          })),
        ),
      );

      const quarantined = classified.filter((c) => !isCanonical(c.classification));
      await insertChunked(quarantined, (chunk) =>
        tx.insert(schema.administrativeMappingQuarantine).values(
          chunk.map((c: Classified) => ({
            datasetVersionId,
            rawPayload: c.row,
            sourceProvenance: `${mapping.source.repository}@${mapping.source.commit}:${mapping.source.path}`,
            upstreamFlags: {
              isMergedWard: c.row.isMergedWard,
              isDividedWard: c.row.isDividedWard,
            },
            oldCode: c.row.wardCode ?? c.row.districtCode,
            newCode: c.row.newWardCode,
            oldName: c.row.ward || c.row.district,
            newName: c.row.newWard,
            classification: c.classification,
            validationReason: c.reason,
            suggestedCandidates: c.candidates,
            // Filled by #457 once places carry codes; an import counts no places.
            affectedPlaceCount: 0,
          })),
        ),
      );

      const report: ImportReport = {
        datasetVersionId,
        combinedDatasetVersion: version,
        combinedChecksum: checksum,
        counts: {
          provinces: currentUnits.units.filter((u) => u.level === 'PROVINCE').length,
          communes: currentUnits.units.filter((u) => u.level === 'COMMUNE').length,
          legacyDistricts: historicalUnits.units.filter((u) => u.level === 'LEGACY_DISTRICT')
            .length,
          legacyCommunes: historicalUnits.units.filter((u) => u.level === 'COMMUNE').length,
          canonicalChanges: canonical.length,
          quarantined: quarantined.length,
        },
        classification: summarise(classified),
        warnings: [...currentUnits.warnings, ...historicalUnits.warnings],
      };

      // Inside the transaction: an import nobody can see in the audit log did not
      // happen as far as review is concerned, so it must not survive on its own.
      await writeAudit(tx, {
        actorType: options.actor?.type ?? 'system',
        actorId: options.actor?.id ?? null,
        action: AUDIT_ACTION.import,
        resourceType: AUDIT_RESOURCE,
        resourceId: datasetVersionId,
        diff: {
          combinedDatasetVersion: version,
          combinedChecksum: checksum,
          sources: {
            currentSourceVersion: components.currentSourceVersion,
            historicalSourceVersion: components.historicalSourceVersion,
            mappingSourceCommit: components.mappingSourceCommit,
            boundarySourceVersion: components.boundarySourceVersion,
            overrideRevision,
          },
          counts: report.counts,
          classification: report.classification,
        },
      });

      return report;
    });
  }

  /**
   * The loaded boundary release this import binds to.
   *
   * Read from `administrative_boundary_loads`, which only ever receives a row
   * after validation passes inside the loader's transaction — a rejected or
   * failed load rolls back before the insert, so a failed release is not
   * selectable here by construction rather than by a status column anyone has
   * to remember to check.
   *
   * Pinned, not "latest": the version and checksum must be the ones the manifest
   * names. A ledger row under the right version but from different bytes is a
   * refusal, not a warning — it means the geometry in the database is not the
   * geometry the pin describes, and binding it would put a false identity on the
   * dataset.
   */
  private async boundaryRelease(): Promise<{ version: string; checksum: string }> {
    // Every boundary release the manifest pins. A ledger row is bindable only
    // if its bytes are one of these — the version name is chosen by whoever ran
    // the loader, so it identifies nothing on its own; the checksum is what says
    // which pinned release actually sits in the table.
    const pinned = new Set<string>();
    for (const role of ['current-boundaries', 'boundaries-fixture'] as const) {
      try {
        pinned.add(this.reader.source(role).sha256);
      } catch {
        // A manifest without that role simply offers one fewer bindable release.
      }
    }
    const production = this.reader.source('current-boundaries').sha256;

    const rows = await this.db
      .select({
        boundaryVersion: schema.administrativeBoundaryLoads.boundaryVersion,
        sourceChecksum: schema.administrativeBoundaryLoads.sourceChecksum,
      })
      .from(schema.administrativeBoundaryLoads)
      .orderBy(desc(schema.administrativeBoundaryLoads.loadedAt));

    if (rows.length === 0) {
      throw new BoundaryReleaseRequiredError(this.reader.source('current-boundaries').ref, 'missing');
    }

    // The real release wins over a fixture whenever both are loaded, so an
    // environment that has the production geometry can never bind the five-entry
    // test archive by accident of ordering.
    const chosen =
      rows.find((r) => r.sourceChecksum === production) ??
      rows.find((r) => pinned.has(r.sourceChecksum));

    if (!chosen) {
      throw new BoundaryReleaseRequiredError(
        this.reader.source('current-boundaries').ref,
        'checksum-mismatch',
        rows[0]!.sourceChecksum,
      );
    }
    return { version: chosen.boundaryVersion, checksum: chosen.sourceChecksum };
  }
}
