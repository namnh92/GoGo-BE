import { describe, expect, it } from 'vitest';
import { CAMPAIGN_TRANSITIONS, campaignOutcome } from './campaign';

/**
 * NTF-BE-012 (#516) — "Đã gửi" has to be able to point at a message.
 */
describe('campaignOutcome', () => {
  it('is sent when the provider accepted at least one message', () => {
    expect(campaignOutcome({ attempted: 3, accepted: 1 })).toEqual({
      status: 'sent',
      lastError: null,
    });
  });

  it('stays sent on a partial delivery — some people are holding the message', () => {
    // No status can un-send what already landed; the counters carry the rest.
    expect(campaignOutcome({ attempted: 500, accepted: 499 }).status).toBe('sent');
  });

  it('fails, with the count, when nobody was accepted', () => {
    // Campaign AAA on DEV: three recipients, three HTTP 200s with no message
    // id, and a mint "Đã gửi" badge.
    const outcome = campaignOutcome({ attempted: 3, accepted: 0 });
    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).toMatch(/^NO_SUBSCRIPTION_ACCEPTED:/);
    expect(outcome.lastError).toContain('3');
  });

  it('fails when the audience was empty, rather than reporting 0 of 0 sent', () => {
    const outcome = campaignOutcome({ attempted: 0, accepted: 0 });
    expect(outcome.status).toBe('failed');
    expect(outcome.lastError).toMatch(/^EMPTY_AUDIENCE:/);
  });

  it('only ever ends in a status the state machine can leave or is meant to be final in', () => {
    // The point of choosing `failed`: it reopens, so the recipients whose rows
    // still say `push_sent_at is null` can be attempted again.
    expect(CAMPAIGN_TRANSITIONS.failed).toContain('scheduled');
    expect(CAMPAIGN_TRANSITIONS.sent).toEqual([]);
  });
});
