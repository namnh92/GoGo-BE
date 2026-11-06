import {
  beginIdempotent,
  completeIdempotentWithin,
  releaseIdempotent,
  type IdempotencyScope,
} from './idempotency.interceptor';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { AppError } from './app-error';
import { writeAudit } from './audit';

/** Evidence must independently establish both identity and location. */
export const verificationSchema = z
  .object({
    status: z.enum(['verified', 'unverified']),
    evidenceType: z.enum(['site_visit', 'official_registry', 'venue_document']).optional(),
    evidenceReference: z.string().trim().min(1).max(500).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine(
    (v) =>
      v.status !== 'verified' ||
      (v.evidenceType !== undefined && v.evidenceReference !== undefined),
    {
      message: 'Verified identity/location requires approved evidence type and reference',
      path: ['evidenceReference'],
    },
  );

export async function readVenueVerification(db: Pick<Db, 'execute'>, placeId: string) {
  const res = await db.execute(sql`select p.identity_revision, coalesce(v.version,0) as version,
    case when v.status = 'verified' and v.identity_revision = p.identity_revision then 'verified' else 'unverified' end as status,
    case when v.status = 'verified' and v.identity_revision = p.identity_revision then v.verified_at else null end as verified_at
    from places p left join place_verifications v on v.place_id=p.id where p.id=${placeId}`);
  const row = res.rows[0] as
    | {
        identity_revision: number;
        version: number;
        status: string;
        verified_at: string | Date | null;
      }
    | undefined;
  if (!row) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');
  return {
    status: row.status,
    ...(row.verified_at ? { verifiedAt: new Date(row.verified_at).toISOString() } : {}),
    identityRevision: row.identity_revision,
    version: row.version,
    etag: `"${row.identity_revision}:${row.version}"`,
  };
}

/** Place row → verification row. Trigger revocation uses the same order. */
export async function setVenueVerification(
  db: Db,
  adminId: string,
  placeId: string,
  ifMatch: string | undefined,
  input: z.infer<typeof verificationSchema>,
  scope: IdempotencyScope,
) {
  input = verificationSchema.parse(input);
  if (!ifMatch) throw new AppError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  const begun = await beginIdempotent(db, scope);
  if (begun.kind === 'replay')
    return begun.body as Awaited<ReturnType<typeof readVenueVerification>>;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select id from places where id=${placeId} for update`);
      const before = await readVenueVerification(tx, placeId);
      if (before.etag !== ifMatch)
        throw new AppError('PRECONDITION_FAILED', 'Identity or verification revision changed', 412);
      await tx.execute(sql`insert into place_verifications(place_id,status,identity_revision,evidence_type,evidence_reference,verified_at,decided_by_admin_id)
      values (${placeId},${input.status},${before.identityRevision},${input.evidenceType ?? null},${input.evidenceReference ?? null},
        case when ${input.status}='verified' then clock_timestamp() else null end,${adminId})
      on conflict (place_id) do update set status=excluded.status, identity_revision=excluded.identity_revision,
        evidence_type=excluded.evidence_type, evidence_reference=excluded.evidence_reference,
        verified_at=case when excluded.status='unverified' then null
          when place_verifications.status='verified' and place_verifications.identity_revision=excluded.identity_revision
            and place_verifications.evidence_type is not distinct from excluded.evidence_type
            and place_verifications.evidence_reference is not distinct from excluded.evidence_reference then place_verifications.verified_at
          else excluded.verified_at end,
        decided_by_admin_id=excluded.decided_by_admin_id, version=place_verifications.version+1, updated_at=clock_timestamp()`);
      const after = await readVenueVerification(tx, placeId);
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'place.verification_decided',
        resourceType: 'place',
        resourceId: placeId,
        diff: {
          status: input.status,
          evidenceType: input.evidenceType,
          evidenceReference: input.evidenceReference,
          reason: input.reason,
          identityRevision: after.identityRevision,
          version: after.version,
        },
      });
      if (!(await completeIdempotentWithin(tx, begun.claim, 200, after)))
        throw AppError.conflict('IDEMPOTENT_REQUEST_IN_FLIGHT', 'Original request is processing');
      return after;
    });
  } catch (err) {
    await releaseIdempotent(db, begun.claim).catch(() => undefined);
    throw err;
  }
}
