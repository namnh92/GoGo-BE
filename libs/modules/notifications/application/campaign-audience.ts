import { sql, type SQL } from 'drizzle-orm';
import type { CampaignAudience } from '../domain/campaign';

/**
 * BE-CMS-G4e (#226) — who a campaign reaches, as one SQL predicate over
 * `users u`.
 *
 * One definition, used by both the estimate endpoint and the worker, because
 * the whole point of an estimate is that it is the same question the send will
 * ask. Two implementations would drift and the number shown before an
 * irreversible action would stop being the number it acts on.
 *
 * Every audience excludes deleted accounts and requires a live push
 * subscription — a "recipient" with nothing to receive on inflates the estimate
 * and makes the delivery counts unreadable.
 *
 * NTF-BE-011 (#515): that requirement used to read `device_tokens`, and no
 * runtime ever wrote to it. `PUT /me/device-tokens` shipped with a mobile
 * wrapper and hook that no screen called, so on DEV the table held exactly the
 * three `contract-<timestamp>` rows the mobile contract test leaves behind —
 * three throwaway accounts that had never opened the app. Campaign "AAA"
 * (b04fa2bb) selected all three, OneSignal answered HTTP 200 with no message id
 * for each ("nobody subscribed"), and every real user — who does have a
 * verified OneSignal subscription — was excluded by the same predicate.
 *
 * `push_subscriptions` is the corrected source: rows the provider confirmed,
 * revoked when a confirmed logout proves the device is gone. It is still not a
 * routing table (ADR-0016) — the send is addressed to `external_id`.
 */
function livePushSubscription(platform?: string): SQL {
  const onPlatform = platform === undefined ? sql`` : sql` and ps.platform = ${platform}`;
  return sql`exists (
    select 1 from push_subscriptions ps
    where ps.user_id = u.id and ps.revoked_at is null${onPlatform}
  )`;
}

export function audiencePredicate(
  audienceType: CampaignAudience,
  filter: Record<string, unknown>,
): SQL {
  const base = sql`u.status <> 'deleted' and ${livePushSubscription()}`;

  switch (audienceType) {
    case 'all':
      return base;

    // Membership in at least one room of that type. A person who has planned a
    // group outing is the audience for a group feature; nothing else in the
    // data says "this is a group user".
    case 'couple':
    case 'group':
      return sql`${base} and exists (
        select 1 from room_members rm
        join rooms r on r.id = rm.room_id
        where rm.user_id = u.id and rm.removed_at is null and r.type = ${audienceType}
      )`;

    case 'platform':
      return sql`u.status <> 'deleted' and ${livePushSubscription(String(filter['platform']))}`;
  }
}

/**
 * Respecting the recipient's own switch.
 *
 * A campaign is marketing; `notification_preferences` is where someone said
 * they did not want it. The default is on — a row only exists once a preference
 * was expressed — so this excludes the people who turned it off rather than
 * requiring everyone to opt in.
 */
export function respectsPushPreference(): SQL {
  return sql`not exists (
    select 1 from notification_preferences np
    where np.user_id = u.id and np.channel = 'push'
      and np.kind = 'campaign' and np.enabled = false
  )`;
}
