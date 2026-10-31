import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { DB } from '../../shared/tokens';
import type { Tx } from '../../shared/outbox';
import { normalizeVietnamese } from '../../search/domain/normalize';
import { decodeCursor, encodeCursor, isoUs } from '../domain/cursor';
import {
  queryTerms,
  rankGuideSections,
  type GuideDocumentForRanking,
  type RankedGuideSection,
} from '../domain/grounding';

/**
 * GoGo-BE#736 — why a guide question did or did not find a section: `hit`;
 * `no_published` (nothing is live, a content gap); `no_match` (documents are
 * live but none answers this wording, a retrieval or coverage gap).
 */
export type GuideRetrievalOutcome = 'hit' | 'no_match' | 'no_published';

export type GuideRetrieval = {
  outcome: GuideRetrievalOutcome;
  /** The folded terms the question was searched with. */
  terms: string[];
  sections: RankedGuideSection[];
};

/**
 * GoGo-BE#713, GoGo-CMS#249 — the "GoGo guide" the assistant answers product
 * questions from. Drafts are edited by `editor`/`ops_admin`; publishing is an
 * `ops_admin` release decision. A published version is immutable and the
 * history append-only, so whatever a reply cited can be read back. Every write
 * is audited (`resource_type = assistant_document`).
 */
export type CmsActor = { id: string; role: string };

type VersionRow = {
  id: string;
  document_id: string;
  number: number;
  state: string;
  title: string;
  description: string;
  body?: string;
  body_sha256: string;
  revision: number;
  created_at: string;
  published_at: string | null;
  publish_reason: string | null;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_by_role: string | null;
  published_by: string | null;
  published_by_name: string | null;
  published_by_role: string | null;
  withdrawn_by: string | null;
  withdrawn_by_name: string | null;
  withdrawn_by_role: string | null;
};

type DocumentRow = {
  id: string;
  slug: string;
  locale: 'vi' | 'en';
  status: 'draft' | 'published' | 'unpublished';
  published_version_id: string | null;
  draft_version_id: string | null;
  created_at: string;
  updated_at: string;
};

const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');
const searchTextOf = (title: string, description: string, body: string) =>
  normalizeVietnamese(`${title}\n${description}\n${body}`);

const VERSION_SELECT = (withBody: boolean) =>
  sql.raw(`v.id, v.document_id, v.number, v.state, v.title, v.description,
  ${withBody ? 'v.body,' : ''} v.body_sha256, v.revision, ${isoUs('v.created_at')} as created_at,
  ${isoUs('v.published_at')} as published_at, v.publish_reason,
  ${isoUs('v.withdrawn_at')} as withdrawn_at, v.withdraw_reason,
  v.created_by, cb.display_name as created_by_name, cb.role::text as created_by_role,
  v.published_by, pb.display_name as published_by_name, pb.role::text as published_by_role,
  v.withdrawn_by, wb.display_name as withdrawn_by_name, wb.role::text as withdrawn_by_role`);
const VERSION_JOINS = sql.raw(`left join admin_users cb on cb.id = v.created_by
  left join admin_users pb on pb.id = v.published_by
  left join admin_users wb on wb.id = v.withdrawn_by`);
const DOCUMENT_SELECT = sql.raw(`d.id, d.slug, d.locale, d.status, d.published_version_id,
  d.draft_version_id, ${isoUs('d.created_at')} as created_at, ${isoUs('d.updated_at')} as updated_at`);

const actor = (id: string | null, name: string | null, role: string | null) =>
  id ? { adminId: id, ...(name ? { displayName: name } : {}), role: role ?? 'unknown' } : null;

function versionSummary(v: VersionRow) {
  return {
    id: v.id,
    number: v.number,
    state: v.state,
    title: v.title,
    bodySha256: v.body_sha256,
    revision: v.revision,
    createdAt: v.created_at,
    createdBy: actor(v.created_by, v.created_by_name, v.created_by_role) ?? {
      adminId: '00000000-0000-0000-0000-000000000000',
      role: 'unknown',
    },
    publishedAt: v.published_at,
    publishedBy: actor(v.published_by, v.published_by_name, v.published_by_role),
    publishReason: v.publish_reason,
    withdrawnAt: v.withdrawn_at,
    withdrawnBy: actor(v.withdrawn_by, v.withdrawn_by_name, v.withdrawn_by_role),
    withdrawReason: v.withdraw_reason,
  };
}

function versionFull(v: VersionRow) {
  return {
    ...versionSummary(v),
    documentId: v.document_id,
    description: v.description,
    body: v.body ?? '',
  };
}

@Injectable()
export class GuideDocumentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // --- retrieval (assistant turn) ---------------------------------------------

  /**
   * Published versions only, ranked by Postgres FTS over the folded text, the
   * caller's locale first. The version id is pinned per turn by the caller.
   */
  async searchPublished(
    question: string,
    locale: 'vi' | 'en',
    limit = 5,
  ): Promise<GuideDocumentForRanking[]> {
    const terms = queryTerms(question)
      .map((t) => t.replace(/[^a-z0-9]/g, ''))
      .filter((t) => t.length >= 2)
      .slice(0, 12);
    if (terms.length === 0) return [];
    const tsquery = terms.map((t) => `${t}:*`).join(' | ');
    const res = await this.db.execute(sql`
      select d.id as document_id, v.id as version_id, d.slug, v.title, v.description, v.body
      from assistant_document_versions v
      join assistant_documents d on d.id = v.document_id
      where v.state = 'published' and d.status = 'published' and d.published_version_id = v.id
        and v.search_vector @@ to_tsquery('simple', ${tsquery})
      order by (d.locale = ${locale}) desc, ts_rank(v.search_vector, to_tsquery('simple', ${tsquery})) desc, d.slug
      limit ${limit}`);
    return (
      res.rows as {
        document_id: string;
        version_id: string;
        slug: string;
        title: string;
        description: string;
        body: string;
      }[]
    ).map((r) => ({
      documentId: r.document_id,
      versionId: r.version_id,
      slug: r.slug,
      title: r.title,
      description: r.description,
      body: r.body,
    }));
  }

  /**
   * GoGo-BE#736 — the one retrieval path: the assistant turn and the CMS
   * coverage check both read it, so a preview shows exactly what a reply would
   * cite. Only an empty result pays for the extra "is anything live" read.
   */
  async retrieve(question: string, locale: 'vi' | 'en', limit = 3): Promise<GuideRetrieval> {
    const terms = queryTerms(question);
    const sections = rankGuideSections(
      await this.searchPublished(question, locale),
      question,
      limit,
    );
    if (sections.length > 0) return { outcome: 'hit', terms, sections };
    return {
      outcome: (await this.hasPublished()) ? 'no_match' : 'no_published',
      terms,
      sections,
    };
  }

  /** Whether any document is live for the assistant, in any locale. */
  async hasPublished(): Promise<boolean> {
    const res = await this.db.execute(sql`
      select exists (
        select 1 from assistant_documents d
        join assistant_document_versions v on v.id = d.published_version_id
        where d.status = 'published' and v.state = 'published'
      ) as live`);
    return (res.rows as { live: boolean }[])[0]?.live === true;
  }

  // --- CMS ---------------------------------------------------------------------

  async list(query: {
    status?: string | undefined;
    locale?: string | undefined;
    q?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const conditions: SQL[] = [sql`true`];
    if (query.status) conditions.push(sql`d.status = ${query.status}`);
    if (query.locale) conditions.push(sql`d.locale = ${query.locale}`);
    if (query.q) {
      const pattern = `%${normalizeVietnamese(query.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(sql`(d.slug ilike ${pattern} or exists (
        select 1 from assistant_document_versions t
        where t.id in (d.published_version_id, d.draft_version_id)
          and lower(f_unaccent(t.title)) like ${pattern}))`);
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor)
      conditions.push(sql`(d.updated_at, d.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`);
    const res = await this.db.execute(sql`
      select ${DOCUMENT_SELECT} from assistant_documents d
      where ${sql.join(conditions, sql` and `)}
      order by d.updated_at desc, d.id desc limit ${query.limit + 1}`);
    const rows = res.rows as DocumentRow[];
    const page = rows.slice(0, query.limit);
    const items = await Promise.all(page.map((d) => this.documentView(d)));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.updated_at, last.id) : null,
    };
  }

  async create(
    input: { slug: string; locale: 'vi' | 'en'; title: string; description: string; body: string },
    by: CmsActor,
  ) {
    const doc = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        insert into assistant_documents as d (slug, locale, status)
        values (${input.slug}, ${input.locale}, 'draft')
        on conflict (slug, locale) do nothing
        returning ${DOCUMENT_SELECT}`);
      const row = (inserted.rows as DocumentRow[])[0];
      if (!row) {
        throw AppError.conflict(
          'DOCUMENT_SLUG_TAKEN',
          'A document with that slug and locale exists',
        );
      }
      const version = await this.insertVersion(tx, row.id, 1, input, by.id);
      await tx.execute(
        sql`update assistant_documents set draft_version_id = ${version} where id = ${row.id}`,
      );
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: by.id,
        action: 'assistant_document.created',
        resourceType: 'assistant_document',
        resourceId: row.id,
        diff: {
          after: {
            slug: input.slug,
            locale: input.locale,
            title: input.title,
            bodySha256: sha256(input.body),
          },
        },
      });
      return row.id;
    });
    return (await this.detail(doc)).document;
  }

  async detail(id: string) {
    const doc = await this.findDocument(this.db, id);
    if (!doc) throw AppError.notFound('NOT_FOUND', 'Document not found');
    const [draft, published] = await Promise.all([
      doc.draft_version_id ? this.findVersion(this.db, id, doc.draft_version_id, true) : null,
      doc.published_version_id
        ? this.findVersion(this.db, id, doc.published_version_id, true)
        : null,
    ]);
    return {
      document: await this.documentView(doc),
      draft: draft ? versionFull(draft) : null,
      published: published ? versionFull(published) : null,
    };
  }

  async updateDraft(
    id: string,
    patch: {
      baseRevision: number;
      title?: string | undefined;
      description?: string | undefined;
      body?: string | undefined;
    },
    by: CmsActor,
  ) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lockDocument(tx, id);
      if (doc.draft_version_id) {
        const draft = (await this.findVersion(tx, id, doc.draft_version_id, true))!;
        if (draft.revision !== patch.baseRevision) {
          throw AppError.conflict('REVISION_CONFLICT', 'The draft changed since it was loaded', [
            {
              field: 'baseRevision',
              code: 'stale',
              message: `current revision is ${draft.revision}`,
            },
          ]);
        }
        const next = {
          title: patch.title ?? draft.title,
          description: patch.description ?? draft.description,
          body: patch.body ?? draft.body ?? '',
        };
        await tx.execute(sql`
          update assistant_document_versions set
            title = ${next.title}, description = ${next.description}, body = ${next.body},
            body_sha256 = ${sha256(next.body)}, search_text = ${searchTextOf(next.title, next.description, next.body)},
            revision = revision + 1
          where id = ${draft.id}`);
        await this.audit(tx, by, id, 'assistant_document.draft_updated', {
          before: {
            versionId: draft.id,
            revision: draft.revision,
            title: draft.title,
            description: draft.description,
            bodySha256: draft.body_sha256,
          },
          after: {
            versionId: draft.id,
            revision: draft.revision + 1,
            title: next.title,
            description: next.description,
            bodySha256: sha256(next.body),
          },
        });
      } else {
        if (patch.baseRevision !== 0) {
          throw AppError.conflict('REVISION_CONFLICT', 'No draft is open; send baseRevision 0', [
            { field: 'baseRevision', code: 'stale', message: 'current revision is 0' },
          ]);
        }
        const base = doc.published_version_id
          ? await this.findVersion(tx, id, doc.published_version_id, true)
          : await this.latestVersion(tx, id);
        const next = {
          title: patch.title ?? base?.title ?? '',
          description: patch.description ?? base?.description ?? '',
          body: patch.body ?? base?.body ?? '',
        };
        if (!next.title || !next.body) {
          throw AppError.badRequest('VALIDATION_FAILED', 'A draft needs a title and a body');
        }
        const number = (await this.maxNumber(tx, id)) + 1;
        const versionId = await this.insertVersion(tx, id, number, next, by.id);
        await tx.execute(
          sql`update assistant_documents set draft_version_id = ${versionId} where id = ${id}`,
        );
        await this.audit(tx, by, id, 'assistant_document.draft_updated', {
          before: base
            ? {
                versionId: base.id,
                title: base.title,
                description: base.description,
                bodySha256: base.body_sha256,
              }
            : null,
          after: {
            versionId,
            revision: 1,
            title: next.title,
            description: next.description,
            bodySha256: sha256(next.body),
          },
        });
      }
      await tx.execute(sql`update assistant_documents set updated_at = now() where id = ${id}`);
    });
    return this.detail(id);
  }

  async publish(
    id: string,
    input: { versionId: string; revision?: number | undefined; reason?: string | undefined },
    by: CmsActor,
  ) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lockDocument(tx, id);
      const target = await this.findVersion(tx, id, input.versionId, false);
      if (!target)
        throw AppError.notFound('VERSION_NOT_FOUND', "The version is not one of this document's");
      if (target.state === 'published') {
        throw AppError.conflict('VERSION_ALREADY_PUBLISHED', 'This version is already published');
      }
      // GoGo-BE#736 — the revision the publisher reviewed. A draft edited after
      // review is a different text; publishing it would ship what nobody saw.
      if (input.revision !== undefined && input.revision !== target.revision) {
        throw AppError.conflict('REVISION_CONFLICT', 'The version changed since it was reviewed', [
          {
            field: 'revision',
            code: 'stale',
            message: `current revision is ${target.revision}`,
          },
        ]);
      }
      const previous = doc.published_version_id;
      if (previous) {
        await tx.execute(
          sql`update assistant_document_versions set state = 'superseded' where id = ${previous}`,
        );
      }
      await tx.execute(sql`
        update assistant_document_versions set state = 'published', published_at = now(),
          published_by = ${by.id}, publish_reason = ${input.reason ?? null}
        where id = ${target.id}`);
      // A draft other than the one published stays open; publishing the draft closes it.
      const draftId = doc.draft_version_id === target.id ? null : doc.draft_version_id;
      await tx.execute(sql`
        update assistant_documents set status = 'published', published_version_id = ${target.id},
          draft_version_id = ${draftId}, updated_at = now()
        where id = ${id}`);
      await this.audit(tx, by, id, 'assistant_document.published', {
        before: { publishedVersionId: previous },
        after: {
          publishedVersionId: target.id,
          number: target.number,
          revision: target.revision,
          bodySha256: target.body_sha256,
        },
        reason: input.reason ?? null,
      });
    });
    return this.detail(id);
  }

  async unpublish(id: string, reason: string, by: CmsActor) {
    await this.db.transaction(async (tx) => {
      const doc = await this.lockDocument(tx, id);
      if (doc.status !== 'published' || !doc.published_version_id) {
        throw AppError.conflict('DOCUMENT_NOT_PUBLISHED', 'The document is not published');
      }
      await tx.execute(sql`
        update assistant_document_versions set state = 'withdrawn', withdrawn_at = now(),
          withdrawn_by = ${by.id}, withdraw_reason = ${reason}
        where id = ${doc.published_version_id}`);
      await tx.execute(sql`
        update assistant_documents set status = 'unpublished', published_version_id = null, updated_at = now()
        where id = ${id}`);
      await this.audit(tx, by, id, 'assistant_document.unpublished', {
        before: { publishedVersionId: doc.published_version_id },
        after: { publishedVersionId: null },
        reason,
      });
    });
    return this.detail(id);
  }

  async versions(id: string, query: { limit: number; cursor?: string | undefined }) {
    if (!(await this.findDocument(this.db, id)))
      throw AppError.notFound('NOT_FOUND', 'Document not found');
    const before = query.cursor ? decodeNumberCursor(query.cursor) : null;
    const res = await this.db.execute(sql`
      select ${VERSION_SELECT(false)} from assistant_document_versions v ${VERSION_JOINS}
      where v.document_id = ${id} ${before !== null ? sql`and v.number < ${before}` : sql``}
      order by v.number desc limit ${query.limit + 1}`);
    const rows = res.rows as VersionRow[];
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(versionSummary),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(String(last.number)).toString('base64url')
          : null,
    };
  }

  async version(id: string, versionId: string) {
    const v = await this.findVersion(this.db, id, versionId, true);
    if (!v) throw AppError.notFound('NOT_FOUND', 'Version not found');
    return versionFull(v);
  }

  // --- helpers -----------------------------------------------------------------

  private async documentView(d: DocumentRow) {
    const [published, draft] = await Promise.all([
      d.published_version_id
        ? this.findVersion(this.db, d.id, d.published_version_id, false)
        : null,
      d.draft_version_id ? this.findVersion(this.db, d.id, d.draft_version_id, false) : null,
    ]);
    return {
      id: d.id,
      slug: d.slug,
      locale: d.locale,
      status: d.status,
      title: published?.title ?? draft?.title ?? '',
      publishedVersion: published ? versionSummary(published) : null,
      draftVersion: draft ? versionSummary(draft) : null,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    };
  }

  private async insertVersion(
    tx: Tx,
    documentId: string,
    number: number,
    v: { title: string; description: string; body: string },
    by: string,
  ): Promise<string> {
    const res = await tx.execute(sql`
      insert into assistant_document_versions
        (document_id, number, state, title, description, body, body_sha256, revision, search_text, created_by)
      values (${documentId}, ${number}, 'draft', ${v.title}, ${v.description}, ${v.body}, ${sha256(v.body)}, 1,
        ${searchTextOf(v.title, v.description, v.body)}, ${by})
      returning id`);
    return (res.rows as { id: string }[])[0]!.id;
  }

  private async findDocument(exec: Pick<Db, 'execute'>, id: string): Promise<DocumentRow | null> {
    const res = await exec.execute(
      sql`select ${DOCUMENT_SELECT} from assistant_documents d where d.id = ${id}`,
    );
    return (res.rows as DocumentRow[])[0] ?? null;
  }

  private async lockDocument(tx: Tx, id: string): Promise<DocumentRow> {
    const res = await tx.execute(
      sql`select ${DOCUMENT_SELECT} from assistant_documents d where d.id = ${id} for update`,
    );
    const row = (res.rows as DocumentRow[])[0];
    if (!row) throw AppError.notFound('NOT_FOUND', 'Document not found');
    return row;
  }

  private async findVersion(
    exec: Pick<Db, 'execute'>,
    documentId: string,
    versionId: string,
    withBody: boolean,
  ): Promise<VersionRow | null> {
    const res = await exec.execute(sql`
      select ${VERSION_SELECT(withBody)} from assistant_document_versions v ${VERSION_JOINS}
      where v.id = ${versionId} and v.document_id = ${documentId}`);
    return (res.rows as VersionRow[])[0] ?? null;
  }

  private async latestVersion(tx: Tx, documentId: string): Promise<VersionRow | null> {
    const res = await tx.execute(sql`
      select ${VERSION_SELECT(true)} from assistant_document_versions v ${VERSION_JOINS}
      where v.document_id = ${documentId} order by v.number desc limit 1`);
    return (res.rows as VersionRow[])[0] ?? null;
  }

  private async maxNumber(tx: Tx, documentId: string): Promise<number> {
    const res = await tx.execute(sql`
      select coalesce(max(number), 0)::int as n from assistant_document_versions where document_id = ${documentId}`);
    return (res.rows as { n: number }[])[0]!.n;
  }

  private audit(tx: Tx, by: CmsActor, id: string, action: string, diff: Record<string, unknown>) {
    return writeAudit(tx, {
      actorType: 'admin',
      actorId: by.id,
      action,
      resourceType: 'assistant_document',
      resourceId: id,
      diff,
    });
  }
}

function decodeNumberCursor(cursor: string): number {
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  if (!Number.isInteger(n) || n < 1)
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  return n;
}
