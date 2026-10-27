import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { APP_CONFIG } from '../../shared/config';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { decodeCursor, encodeCursor, isoUs } from '../domain/cursor';
import { renderPlaceTexts } from './place-text';
import type {
  AssistantCardRef,
  AssistantNotice,
  AssistantSourceData,
} from '../domain/assistant.types';

type QueueRow = {
  message_id: string;
  conversation_id: string;
  rating: 'up' | 'down';
  reason: string | null;
  created_at: string;
  status: string;
  text: string;
  cards: AssistantCardRef[];
  notice: AssistantNotice | null;
  model: string | null;
  sources: AssistantSourceData[] | null;
  proposal_kinds: string[] | null;
};

/**
 * GoGo-CMS#249 — the moderation queue: the assistant's rated reply, its cited
 * sources and the reason code. Never who rated it, the user's own message
 * (Q3), attachments, the context place/plan or any id the app sees: the row id
 * and `conversationRef` are keyed hashes, stable per message / conversation and
 * unrelated to either id.
 */
@Injectable()
export class AssistantFeedbackQueueService {
  private readonly key: Buffer;
  /** Seals the page cursor, which names a message by its real id (A-R-13). */
  private readonly cursorKey: Buffer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) config: { AUTH_JWT_SECRET: string },
  ) {
    this.key = createHmac('sha256', config.AUTH_JWT_SECRET)
      .update('assistant-feedback-ref')
      .digest();
    this.cursorKey = createHmac('sha256', config.AUTH_JWT_SECRET)
      .update('assistant-feedback-cursor')
      .digest();
  }

  async list(query: {
    rating?: 'up' | 'down' | undefined;
    reason?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }) {
    const conditions: SQL[] = [sql`true`];
    if (query.rating) conditions.push(sql`f.rating = ${query.rating}`);
    if (query.reason) conditions.push(sql`f.reason = ${query.reason}`);
    if (query.from) conditions.push(sql`f.created_at >= ${query.from}::timestamptz`);
    if (query.to) conditions.push(sql`f.created_at < ${query.to}::timestamptz`);
    const cursor = this.openCursor(query.cursor);
    if (cursor) {
      conditions.push(
        sql`(f.created_at, f.message_id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const res = await this.db.execute(sql`
      select f.message_id, f.conversation_id, f.rating, f.reason,
        ${sql.raw(isoUs('f.created_at'))} as created_at,
        m.status, m.text, m.cards, m.notice,
        coalesce(l.haiku_model, l.jev_model) as model,
        (select json_agg(json_build_object('index', s.idx, 'kind', s.kind, 'documentId', s.document_id,
            'versionId', s.version_id, 'slug', s.slug, 'title', s.title, 'description', s.description,
            'checkedAt', s.checked_at) order by s.idx)
          from assistant_message_sources s where s.message_id = f.message_id) as sources,
        (select array_agg(distinct p.kind) from assistant_proposals p where p.message_id = f.message_id) as proposal_kinds
      from assistant_feedback f
      join assistant_messages m on m.id = f.message_id
      left join assistant_usage_ledger l on l.message_id = f.message_id
      where ${sql.join(conditions, sql` and `)}
      order by f.created_at desc, f.message_id desc
      limit ${query.limit + 1}`);
    const rows = res.rows as QueueRow[];
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    // Replies name places by token (A-R-04): moderators read today's names.
    const texts = await renderPlaceTexts(
      this.db,
      page.map((r) => r.text),
    );
    return {
      items: page.map((r, i) => ({
        id: this.uuidRef(r.message_id),
        rating: r.rating,
        ...(r.reason ? { reason: r.reason } : {}),
        createdAt: r.created_at,
        conversationRef: this.ref(r.conversation_id),
        reply: {
          status: r.status,
          text: texts[i]!,
          sources: (r.sources ?? []).map((s) =>
            Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== undefined)),
          ),
          cardKinds: [...new Set((r.cards ?? []).map((c) => c.kind))],
          proposalKinds: r.proposal_kinds ?? [],
          ...(r.notice ? { notice: r.notice } : {}),
          model: r.model ?? 'deterministic',
        },
      })),
      // The cursor names the row by its real key, so it travels sealed: a
      // moderator cannot read the app's message id out of it (A-R-13).
      nextCursor:
        rows.length > query.limit && last
          ? this.sealCursor(encodeCursor(last.created_at, last.message_id))
          : null,
    };
  }

  private sealCursor(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cursorKey, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  private openCursor(sealed: string | undefined): { at: string; id: string } | null {
    if (!sealed) return null;
    let plain: string;
    try {
      const raw = Buffer.from(sealed, 'base64url');
      if (raw.length < 29) throw new Error('short');
      const decipher = createDecipheriv('aes-256-gcm', this.cursorKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
    }
    return decodeCursor(plain);
  }

  private ref(id: string): string {
    return createHmac('sha256', this.key).update(`c:${id}`).digest('base64url').slice(0, 22);
  }

  /** A UUID-shaped keyed hash: stable per message, unlinkable to it. */
  private uuidRef(id: string): string {
    const h = createHmac('sha256', this.key).update(`m:${id}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}
