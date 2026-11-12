import type { Db } from '@gogo/database';
import type { MetricsPort } from '@gogo/observability';
import { sql } from 'drizzle-orm';
import { InviteFoundationError } from '../application/invite-code-crypto';

const indexes = [
  {
    name: 'users_host_share_id_unique',
    table: 'users',
    keys: ['host_share_id'],
    unique: true,
    predicate: '',
  },
  {
    name: 'room_invite_codes_open_lookup_unique',
    table: 'room_invite_codes',
    keys: ['code_lookup'],
    unique: true,
    predicate: "reservation_state='OPEN'",
  },
  {
    name: 'room_invite_codes_open_room_unique',
    table: 'room_invite_codes',
    keys: ['room_id'],
    unique: true,
    predicate: "reservation_state='OPEN'",
  },
  {
    name: 'room_invite_codes_history_idx',
    table: 'room_invite_codes',
    keys: ['room_id', 'issued_at'],
    unique: false,
    predicate: '',
  },
] as const;
const checks = [
  ['rooms', 'rooms_invitation_epoch_nonnegative'],
  ['room_invites', 'room_invites_epoch_nonnegative'],
  ['users', 'users_host_share_id_format'],
  ['share_links', 'share_links_epoch_nonnegative'],
  ['share_links', 'share_links_path_metadata'],
  ...[
    'epoch_nonnegative',
    'lookup_format',
    'ciphertext_format',
    'key_version_format',
    'lifetime',
    'reservation_state',
  ].map((suffix) => ['room_invite_codes', `room_invite_codes_${suffix}`]),
];

/** Internal gate, not general API readiness. Re-probed on every primitive call. */
export async function assertInviteFoundationReady(
  db: Pick<Db, 'execute'>,
  metrics: MetricsPort,
): Promise<void> {
  try {
    // Parse all required columns even with zero rows, without returning stored credentials.
    await db.execute(sql`select r.invitation_epoch,r.automatic_invites_suppressed,r.legacy_invites_revoked_at,
      r.code6_backfill_completed_at,u.host_share_id,i.invitation_epoch,s.path_version,s.host_share_id,s.invitation_epoch,
      c.id,c.room_id,c.invitation_epoch,c.code_lookup,c.code_ciphertext,c.encryption_key_version,
      c.issued_at,c.expires_at,c.revoked_at,c.reservation_state,c.released_at,c.release_reason,c.created_by_member_id
      from rooms r cross join users u cross join room_invites i cross join share_links s cross join room_invite_codes c limit 0`);
    for (const index of indexes) {
      const result = await db.execute(sql`select i.indexrelid from pg_index i
        join pg_class x on x.oid=i.indexrelid join pg_am am on am.oid=x.relam
        where x.oid=to_regclass(${`public.${index.name}`}) and i.indrelid=to_regclass(${`public.${index.table}`})
        and i.indisvalid and i.indisready and i.indislive and i.indisunique=${index.unique}
        and not i.indisexclusion and am.amname='btree'
        and i.indnkeyatts=${index.keys.length} and i.indnatts=${index.keys.length} and i.indexprs is null
        and (select array_agg(a.attname::text order by k.n)
          from unnest(i.indkey) with ordinality k(attnum,n)
          join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)
            =ARRAY[${sql.join(
              index.keys.map((key) => sql`${key}`),
              sql`, `,
            )}]::text[]
        and not exists (select 1 from unnest(i.indclass,i.indcollation,i.indoption,i.indkey) k(opc,coll,opt,attnum)
          join pg_opclass op on op.oid=k.opc join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
          where not op.opcdefault or op.opcnamespace<>'pg_catalog'::regnamespace or k.coll<>a.attcollation or k.opt<>0)
        and regexp_replace(replace(coalesce(pg_get_expr(i.indpred,i.indrelid),''),'::text',''),'[[:space:]()]','','g')=${index.predicate}`);
      if (result.rows.length !== 1) throw new Error();
    }
    const constraints =
      await db.execute(sql`select conname from pg_constraint where contype='c' and convalidated
      and (${sql.join(
        checks.map(
          ([table, name]) => sql`(conrelid=to_regclass(${`public.${table}`}) and conname=${name})`,
        ),
        sql` or `,
      )})`);
    if (constraints.rows.length !== checks.length) throw new Error();
    const triggers =
      await db.execute(sql`select tgname from pg_trigger where not tgisinternal and tgenabled in ('O','A') and (
      (tgrelid=to_regclass('public.rooms') and tgname='rooms_invitation_fence_monotonic' and tgfoid=to_regprocedure('public.preserve_room_invitation_fence()')) or
      (tgrelid=to_regclass('public.room_invite_codes') and tgname='room_invite_codes_generation_immutable' and tgfoid=to_regprocedure('public.preserve_invite_code_generation()'))
    )`);
    if (triggers.rows.length !== 2) throw new Error();
    metrics.increment('room_invite_foundation_readiness_total', {
      operation: 'schema',
      result: 'ready',
    });
  } catch {
    metrics.increment('room_invite_foundation_readiness_total', {
      operation: 'schema',
      result: 'unavailable',
    });
    throw new InviteFoundationError('SCHEMA_NOT_READY');
  }
}
