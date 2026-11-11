import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { DB } from '../../shared/tokens';

const cursorPayload = z.tuple([
  z.string().uuid(),
  z
    .string()
    .datetime({ precision: 6 })
    .refine((at) => !at.startsWith('0000-')),
  z.string().uuid(),
]);

type LedgerRow = {
  user_id: string;
  display_name: string;
  balance: number;
  id: string | null;
  created_at: string | null;
  delta: number | null;
  reason: 'submission_approved' | 'submission_evidence' | 'message_spent' | null;
  submission_id: string | null;
  venue_identity: string | null;
  place_id: string | null;
};

@Injectable()
export class CmsAssistantCreditsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async read(
    userId: string,
    query: { limit: number; cursor?: string | undefined },
    actorId: string,
  ) {
    const cursor = query.cursor ? decodeCursor(query.cursor, userId) : null;
    // One statement snapshot: account balance and ledger cannot straddle a grant,
    // spend or erasure. LEFT JOIN keeps zero-credit users and exhausted pages.
    // Text projection preserves all six timestamp digits in the keyset cursor.
    const result = await this.db.execute(sql`
      select u.id as user_id, u.display_name, coalesce(a.balance, 0)::int as balance,
             l.id, l.created_at, l.delta, l.reason, l.submission_id, l.venue_identity,
             s.result_place_id as place_id
      from users u
      left join assistant_credit_accounts a on a.user_id = u.id
      left join lateral (
        select id, to_char(created_at at time zone 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
               delta, reason, submission_id, venue_identity
        from assistant_credit_ledger
        where user_id = u.id
          ${cursor ? sql`and (created_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
        order by assistant_credit_ledger.created_at desc, id desc
        limit ${query.limit + 1}
      ) l on true
      left join place_submissions s on s.id = l.submission_id
      where u.id = ${userId}
      order by l.created_at desc, l.id desc
    `);
    const rows = result.rows as LedgerRow[];
    const user = rows[0];
    if (!user) throw AppError.notFound('USER_NOT_FOUND', 'No such account');
    const ledger = rows.filter((row) => row.id !== null);
    const page = ledger.slice(0, query.limit);
    const last = page[page.length - 1];

    // Staff reading another user's credit history is attributable, like the
    // existing CMS subject export. Never copy the history or name into audit.
    await writeAudit(this.db, {
      actorType: 'admin',
      actorId,
      action: 'user.assistant_credits_viewed',
      resourceType: 'user',
      resourceId: userId,
    });
    return {
      user: { id: user.user_id, displayName: user.display_name },
      balance: user.balance,
      items: page.map((row) => ({
        id: row.id!,
        createdAt: row.created_at!,
        delta: row.delta!,
        // S2 keeps the existing closed public enum; S3 exposes catalogue keys.
        reason: row.reason === 'submission_evidence' ? 'submission_approved' : row.reason!,
        submissionId: row.submission_id,
        venueIdentity: row.venue_identity,
        placeId: row.place_id,
      })),
      nextCursor:
        ledger.length > query.limit && last
          ? Buffer.from(JSON.stringify([userId, last.created_at, last.id])).toString('base64url')
          : null,
    };
  }
}

function decodeCursor(cursor: string, userId: string): { at: string; id: string } {
  try {
    const [subject, at, id] = cursorPayload.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (subject.toLowerCase() !== userId.toLowerCase()) throw new Error('wrong subject');
    return { at, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}
