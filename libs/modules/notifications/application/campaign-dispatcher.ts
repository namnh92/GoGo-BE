import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { idempotencyKeyFrom, type NotificationProviderPort } from '@gogo/providers';
import {
  campaignDedupeKey,
  campaignOutcome,
  type CampaignAudience,
  type CampaignDestination,
} from '../domain/campaign';
import { audiencePredicate, respectsPushPreference } from './campaign-audience';
import { publicCatalogueUrl } from '../../shared/media-url';

/**
 * BE-CMS-G4e (#226) — the half of a campaign that actually sends.
 *
 * Lives in the worker, never in a request. The API only ever writes a row; this
 * is what turns one into messages, and it does so on its own tick — so a
 * request that times out, retries, or is replayed cannot cause a second send.
 *
 * Delivery is at-least-once, so every step is written to be repeatable: the
 * claim is a conditional UPDATE, each recipient's notification carries a dedupe
 * key with a unique index behind it, and a re-run after a crash re-sends only
 * to the recipients whose row was never inserted.
 *
 * Plain class, like `OutboxDispatcher`: the worker wires it without Nest.
 */

type DueCampaign = {
  id: string;
  title: string;
  body: string;
  image_key: string | null;
  audience_type: CampaignAudience;
  audience_filter: Record<string, unknown>;
  destination_type: CampaignDestination;
  destination_value: string | null;
  dispatch_key: string;
};

/** How many recipients one tick handles, so a large send does not block. */
const RECIPIENT_BATCH = 500;

export class CampaignDispatcher {
  constructor(
    private readonly db: Db,
    private readonly push: NotificationProviderPort,
    private readonly metrics?: { increment(name: string, labels?: Record<string, string>): void },
    /**
     * Where public media is readable in this environment. The provider fetches
     * the picture itself at delivery time, so what it needs is the durable
     * public URL — never the presigned upload URL, which is signed for PUT and
     * has expired long before a campaign scheduled for next week goes out.
     */
    private readonly mediaPublicBaseUrl?: string,
  ) {}

  /** Null for a text campaign, and for a key no public host will serve. */
  private imageUrl(campaign: DueCampaign): string | null {
    return publicCatalogueUrl(this.mediaPublicBaseUrl, campaign.image_key);
  }

  /** One tick: due campaigns first, then any pending test send. */
  async tick(): Promise<{ campaigns: number; testSends: number }> {
    const campaigns = await this.dispatchDue();
    const testSends = await this.deliverTestSends();
    return { campaigns, testSends };
  }

  /**
   * Claims and sends every campaign whose time has come.
   *
   * The claim is `scheduled → sending` in one conditional UPDATE, so two worker
   * replicas racing for the same campaign produce one winner and one no-op.
   * That single statement is the entire concurrency control, and it is why a
   * campaign cannot go out twice.
   */
  async dispatchDue(limit = 5): Promise<number> {
    const { rows } = await this.db.execute(sql`
      update notification_campaigns
      set status = 'sending', started_at = now(), updated_at = now()
      where id in (
        select id from notification_campaigns
        where status = 'scheduled' and scheduled_at <= now()
        order by scheduled_at
        limit ${limit}
        for update skip locked
      )
      returning id, title, body, image_key, audience_type, audience_filter,
                destination_type, destination_value, dispatch_key
    `);

    for (const campaign of rows as DueCampaign[]) {
      await this.send(campaign);
    }
    return rows.length;
  }

  private async send(campaign: DueCampaign): Promise<void> {
    try {
      const predicate = audiencePredicate(campaign.audience_type, campaign.audience_filter);
      const preference = respectsPushPreference();

      // Resolved here rather than at schedule time: the audience is whoever
      // qualifies when the send happens, and an estimate taken days earlier
      // would quietly exclude everyone who joined since.
      const { rows: recipients } = await this.db.execute(sql`
        select u.id from users u
        where ${predicate} and ${preference}
        order by u.id
      `);

      await this.db.execute(sql`
        update notification_campaigns
        set recipient_count = ${recipients.length}, updated_at = now()
        where id = ${campaign.id}::uuid
      `);

      let sent = 0;
      let failed = 0;
      for (let offset = 0; offset < recipients.length; offset += RECIPIENT_BATCH) {
        const batch = (recipients as { id: string }[]).slice(offset, offset + RECIPIENT_BATCH);
        for (const recipient of batch) {
          const delivered = await this.deliver(campaign, recipient.id, {
            dedupeKey: campaignDedupeKey(campaign.dispatch_key, recipient.id),
          });
          // `already_sent` is a push an earlier run of this same dispatch got
          // through before an outage; it counts toward the campaign's total.
          if (delivered === 'sent' || delivered === 'already_sent') sent += 1;
          else if (delivered === 'no_target') failed += 1;
        }
        await this.db.execute(sql`
          update notification_campaigns
          set sent_count = ${sent}, failed_count = ${failed}, updated_at = now()
          where id = ${campaign.id}::uuid
        `);
      }

      // NTF-BE-012 (#516): the terminal status is decided by what the provider
      // accepted, not by the loop having run to the end.
      //
      // It used to be `sent` unconditionally. Campaign AAA on DEV finished
      // `sent` — mint badge, check glyph — with `sent_count = 0` and three
      // no-target failures, and `sent` has no outgoing transition, so those
      // three recipients could never be retried either. A campaign that reached
      // nobody was indistinguishable from one that reached everybody.
      //
      // `failed` is the honest end for both empty cases, and it is a state an
      // operator can act from: `failed → scheduled` reopens, and a re-run skips
      // whoever already has `push_sent_at` set.
      const outcome = campaignOutcome({ attempted: recipients.length, accepted: sent });
      await this.db.execute(sql`
        update notification_campaigns
        set status = ${outcome.status}, completed_at = now(), sent_count = ${sent},
            failed_count = ${failed}, last_error = ${outcome.lastError},
            updated_at = now()
        where id = ${campaign.id}::uuid
      `);
      this.metrics?.increment('campaign_dispatched_total', { result: outcome.status });
    } catch (err) {
      // A provider outage must not leave the row in `sending` forever: `failed`
      // is a state an operator can re-schedule from, and the error is kept.
      await this.db.execute(sql`
        update notification_campaigns
        set status = 'failed', completed_at = now(),
            last_error = ${err instanceof Error ? err.message.slice(0, 500) : 'unknown error'},
            updated_at = now()
        where id = ${campaign.id}::uuid
      `);
      this.metrics?.increment('campaign_dispatched_total', { result: 'failed' });
    }
  }

  /**
   * One recipient.
   *
   * Two facts, two columns. The notification row (inbox) is inserted first with
   * `on conflict do nothing`; `push_sent_at` on that row is the delivery fact
   * and is written only after the provider created a message. So a re-run of
   * the same dispatch — after a crash, or after an outage failed the campaign
   * and an operator rescheduled it — skips recipients whose row says the push
   * went through and retries the ones whose row says it did not. Before this
   * split the row alone meant "sent", and an outage half-way left the hit
   * recipient owed forever while a reschedule pushed everyone else twice.
   */
  private async deliver(
    campaign: DueCampaign,
    userId: string,
    options: { dedupeKey: string },
  ): Promise<'sent' | 'already_sent' | 'no_target'> {
    const payload = {
      campaignId: campaign.id,
      title: campaign.title,
      body: campaign.body,
      destinationType: campaign.destination_type,
      ...(campaign.destination_value ? { destination: campaign.destination_value } : {}),
    };

    await this.db.execute(sql`
      insert into notifications (user_id, kind, payload, dedupe_key)
      values (${userId}::uuid, 'campaign', ${JSON.stringify(payload)}::jsonb, ${options.dedupeKey})
      on conflict (dedupe_key) where dedupe_key is not null do nothing
    `);
    const { rows } = await this.db.execute(sql`
      select id, push_sent_at from notifications where dedupe_key = ${options.dedupeKey}
    `);
    const row = rows[0] as { id: string; push_sent_at: Date | string | null } | undefined;
    if (!row) throw new Error('notification row missing after insert');
    if (row.push_sent_at !== null) return 'already_sent';

    // #193: addressed by user id; the provider owns the device list. A thrown
    // provider error propagates to `send`, which marks the campaign `failed`
    // with the reason kept — a refused credential or an outage is something an
    // operator re-schedules from, not something to burn through 500 recipients
    // discovering. The row above stays without push_sent_at, which is exactly
    // what the reschedule retries.
    const image = this.imageUrl(campaign);
    const result = await this.push.sendToUser(userId, {
      headings: { en: campaign.title },
      contents: { en: campaign.body },
      ...(image ? { imageUrl: image } : {}),
      data: {
        campaignId: campaign.id,
        destinationType: campaign.destination_type,
        ...(campaign.destination_value ? { destination: campaign.destination_value } : {}),
      },
      // The dedupe key already identifies this recipient of this dispatch; the
      // provider gets the same identity, so even a crash between the send and
      // the update below is a replay at the provider, not a second push.
      idempotencyKey: idempotencyKeyFrom(options.dedupeKey),
    });
    // A message id is a delivery the provider accepted. None means no
    // subscription for this person right now — recorded in failed_count, as an
    // account with no registered device was before.
    //
    // The row keeps `push_sent_at` null, so any later run of this dispatch
    // attempts it again — and since #516 a dispatch that accepted nothing
    // finishes `failed`, which reopens, rather than `sent`, which does not.
    // A no-target recipient of a campaign that did reach other people is still
    // never retried: that campaign is `sent`, correctly, and what an
    // unsubscribed recipient is owed after a partial send is a product
    // decision, not a dispatcher fix (review finding R4).
    if (result.providerMessageId === null) return 'no_target';
    await this.db.execute(sql`
      update notifications
      set push_sent_at = now(), push_message_id = ${result.providerMessageId}
      where id = ${row.id}::uuid
    `);
    return 'sent';
  }

  /**
   * Test sends: one copy, to the composer's own account.
   *
   * Claimed the same way as a campaign, so it cannot be delivered twice by two
   * ticks, and it never touches `status` — a test is not a send.
   */
  async deliverTestSends(limit = 10): Promise<number> {
    const { rows } = await this.db.execute(sql`
      update notification_campaigns
      set test_send_requested_at = null, test_send_completed_at = now(), updated_at = now()
      where id in (
        select id from notification_campaigns
        where test_send_requested_at is not null and test_send_user_id is not null
        order by test_send_requested_at
        limit ${limit}
        for update skip locked
      )
      returning id, title, body, image_key, audience_type, audience_filter,
                destination_type, destination_value, dispatch_key, test_send_user_id
    `);

    for (const row of rows as (DueCampaign & { test_send_user_id: string })[]) {
      try {
        await this.deliver(row, row.test_send_user_id, {
          // Unique per request, so a composer can preview a campaign as many
          // times as they need without the dedupe key silencing the second one.
          dedupeKey: `campaign_test:${row.id}:${row.test_send_user_id}:${Date.now()}`,
        });
      } catch {
        // A test send is a preview, not a send: a provider fault here is
        // counted and the row already says the request was handled, so the
        // composer's next attempt is not silenced by a stuck one.
        this.metrics?.increment('campaign_dispatched_total', { result: 'test_failed' });
      }
    }
    return rows.length;
  }
}
