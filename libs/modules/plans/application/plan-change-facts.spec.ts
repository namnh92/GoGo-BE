import { describe, expect, it } from 'vitest';
import { planChangeFacts } from './plan-change-facts';

const stop = (
  placeId: string,
  position: number,
  overrides: Partial<{
    durationMinutes: number;
    isLocked: boolean;
    isOptional: boolean;
  }> = {},
) => ({
  placeId,
  position,
  durationMinutes: 60,
  isLocked: false,
  isOptional: false,
  ...overrides,
});

describe('planChangeFacts (#753)', () => {
  it('describes replacement, reorder and duration changes when the total count is unchanged', () => {
    expect(
      planChangeFacts(
        [stop('a', 0), stop('b', 1), stop('removed', 2)],
        [stop('b', 0), stop('added', 1), stop('a', 2, { durationMinutes: 90 })],
      ),
    ).toEqual({
      addedStopCount: 1,
      removedStopCount: 1,
      movedStopCount: 2,
      durationChangedStopCount: 1,
      lockChangedStopCount: 0,
      optionalChangedStopCount: 0,
    });
  });

  it('counts retained stop flag changes without treating a new stop as changed', () => {
    expect(
      planChangeFacts(
        [stop('kept', 0), stop('removed', 1)],
        [stop('kept', 0, { isLocked: true, isOptional: true }), stop('added', 1)],
      ),
    ).toEqual({
      addedStopCount: 1,
      removedStopCount: 1,
      movedStopCount: 0,
      durationChangedStopCount: 0,
      lockChangedStopCount: 1,
      optionalChangedStopCount: 1,
    });
  });
});
