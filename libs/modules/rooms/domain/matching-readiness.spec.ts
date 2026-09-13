import { describe, expect, it } from 'vitest';
import { assertMatchingReady, matchingReadiness } from './matching-readiness';
const complete = { selectionStatus: 'completed' };
const pending = { selectionStatus: 'pending' };
describe('partial preference policy', () => {
  it('requires two completed responses even with acknowledgement', () => {
    expect(() => assertMatchingReady([complete, pending], true)).toThrow();
  });
  it('requires explicit acknowledgement for remaining incomplete members', () => {
    expect(() => assertMatchingReady([complete, complete, pending], false)).toThrow();
    expect(assertMatchingReady([complete, complete, pending], true).pendingCount).toBe(1);
  });
  it('keeps the all-complete path', () =>
    expect(assertMatchingReady([complete, complete], false).canStart).toBe(true));
  it.each(['member', 'guest'])('never grants %s a host capability', (role) => {
    expect(matchingReadiness('collecting', role, [complete, complete]).blockedReason).toBe(
      'HOST_ONLY',
    );
  });
  it.each(['draft', 'ready', 'active', 'completed', 'cancelled', 'expired'])(
    'blocks %s',
    (status) => {
      expect(matchingReadiness(status, 'host', [complete, complete]).canStart).toBe(false);
    },
  );
});
