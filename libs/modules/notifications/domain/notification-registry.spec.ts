import { describe, expect, it } from 'vitest';
import { schema } from '@gogo/database';
import {
  DEFAULT_CATEGORIES,
  applyPreferencePatch,
  normalizePreferencePatch,
  CONFIGURABLE_CATEGORIES,
  NOTIFICATION_KINDS,
  effectivePush,
  registration,
  inboxFilter,
} from './notification-registry';

describe('ADR-0050 notification registry and master/category truth table', () => {
  it('exhausts database kinds and has exactly five configurable categories', () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual([...schema.notificationKind.enumValues].sort());
    expect(CONFIGURABLE_CATEGORIES).toHaveLength(5);
    for (const kind of CONFIGURABLE_CATEGORIES) {
      expect(registration(kind).category).toBe(kind);
      expect(registration(kind).producer).toBeTruthy();
    }
    expect(registration('campaign').category).toBe('other');
    expect(registration('date_reminder').producer).toBe('room.reminder_due');
  });
  it.each([false, true])('master=%s governs every configurable kind and other', (master) => {
    for (const category of CONFIGURABLE_CATEGORIES)
      for (const enabled of [false, true]) {
        const choices = { ...DEFAULT_CATEGORIES, [category]: enabled };
        expect(effectivePush(category, master, choices)).toBe(master && enabled);
        expect(effectivePush('campaign', master, choices)).toBe(master);
        for (const kind of ['moderation_update', 'privacy_export_ready', 'future_kind', 'toString'])
          expect(effectivePush(kind, master, choices)).toBe(false);
      }
  });
  it('canonicalizes kinds as a set', () => {
    expect(inboxFilter()).toBe('all');
    expect(inboxFilter(['plan_ready', 'invite', 'invite'])).toBe('invite,plan_ready');
  });
});

describe('preference write semantics table', () => {
  const before = { pushEnabled: false, categories: { ...DEFAULT_CATEGORIES, invite: false } };
  it('changes master without losing categories, and category without enabling master', () => {
    expect(applyPreferencePatch(before, { pushEnabled: true })).toEqual({
      ...before,
      pushEnabled: true,
    });
    expect(applyPreferencePatch(before, { categories: { plan_ready: false } })).toEqual({
      pushEnabled: false,
      categories: { ...before.categories, plan_ready: false },
    });
  });
  it('enable all retains master and legacy PUT true restores both', () => {
    expect(applyPreferencePatch(before, { categories: DEFAULT_CATEGORIES })).toEqual({
      pushEnabled: false,
      categories: DEFAULT_CATEGORIES,
    });
    expect(
      applyPreferencePatch(before, normalizePreferencePatch({ pushEnabled: true }, true)),
    ).toEqual({ pushEnabled: true, categories: DEFAULT_CATEGORIES });
    expect(
      applyPreferencePatch(
        { ...before, pushEnabled: true },
        normalizePreferencePatch({ pushEnabled: false }, true),
      ),
    ).toEqual(before);
  });
  it('legacy opt-out is master-only and opt-in is a no-op on choices', () => {
    expect(applyPreferencePatch({ ...before, pushEnabled: true }, { pushEnabled: false })).toEqual(
      before,
    );
    expect(applyPreferencePatch(before, {})).toEqual(before);
  });
});
