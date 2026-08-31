import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import type { PushPort } from '@gogo/providers';
import {
  campaignDedupeKey,
  type CampaignAudience,
  type CampaignDestination,
} from '../domain/campaign';
import { audiencePredicate, respectsPushPreference } from './campaign-audience';

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
    private readonly push: PushPort,
    private readonly metrics?: { increment(name: string, labels?: Record<string, string>): void },
  ) {}

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
      returning id, title, body, audience_type, audience_filter,
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
          if (delivered === 'sent') sent += 1;
          else if (delivered === 'failed') failed += 1;
        }
        await this.db.execute(sql`
          update notification_campaigns
          set sent_count = ${sent}, failed_count = ${failed}, updated_at = now()
          where id = ${campaign.id}::uuid
        `);
      }

      // `sent` is what the provider accepted. It is not "seen", and the column
      // is named for what it can honestly claim.
      await this.db.execute(sql`
        update notification_campaigns
        set status = 'sent', completed_at = now(), sent_count = ${sent},
            failed_count = ${failed}, updated_at = now()
        where id = ${campaign.id}::uuid
      `);
      this.metrics?.increment('campaign_dispatched_total', { result: 'sent' });
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
   * The notification row is inserted first with `on conflict do nothing`: if it
   * is already there, this recipient was handled by an earlier run and the push
   * is skipped. That ordering is what makes a retry safe — the row is the
   * record of "already sent", and it exists before the provider is called.
   */
  private async deliver(
    campaign: DueCampaign,
    userId: string,
    options: { dedupeKey: string },
  ): Promise<'sent' | 'skipped' | 'failed'> {
    const payload = {
      campaignId: campaign.id,
      title: campaign.title,
      body: campaign.body,
      destinationType: campaign.destination_type,
      ...(campaign.destination_value ? { destination: campaign.destination_value } : {}),
    };

    const { rows: inserted } = await this.db.execute(sql`
      insert into notifications (user_id, kind, payload, dedupe_key)
      values (${userId}::uuid, 'campaign', ${JSON.stringify(payload)}::jsonb, ${options.dedupeKey})
      on conflict (dedupe_key) where dedupe_key is not null do nothing
      returning id
    `);
    if (inserted.length === 0) return 'skipped';

    const { rows: devices } = await this.db.execute(sql`
      select token from device_tokens where user_id = ${userId}::uuid
    `);

    let anyDelivered = false;
    for (const device of devices as { token: string }[]) {
      try {
        await this.push.send(device.token, {
          title: campaign.title,
          body: campaign.body,
          data: {
            campaignId: campaign.id,
            destinationType: campaign.destination_type,
            ...(campaign.destination_value ? { destination: campaign.destination_value } : {}),
          },
        });
        anyDelivered = true;
      } catch {
        // One dead token does not fail the recipient: another device may work,
        // and a whole campaign must not stop on a stale registration.
      }
    }
    return anyDelivered ? 'sent' : 'failed';
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
      returning id, title, body, audience_type, audience_filter, destination_type,
                destination_value, dispatch_key, test_send_user_id
    `);

    for (const row of rows as (DueCampaign & { test_send_user_id: string })[]) {
      await this.deliver(row, row.test_send_user_id, {
        // Unique per request, so a composer can preview a campaign as many
        // times as they need without the dedupe key silencing the second one.
        dedupeKey: `campaign_test:${row.id}:${row.test_send_user_id}:${Date.now()}`,
      });
    }
    return rows.length;
  }
}
