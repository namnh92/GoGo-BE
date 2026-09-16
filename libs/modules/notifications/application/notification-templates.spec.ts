import { describe, expect, it } from 'vitest';
import {
  PUSH_LOCALES,
  PUSH_PAYLOAD_VERSION,
  pushIdempotencyKey,
  pushLocaleOf,
  renderPushCopy,
  renderPushNotification,
  type PushKind,
} from './notification-templates';
import { EVENT_TO_NOTIFICATION } from './outbox-dispatcher';

/**
 * NTF-BE-005 (#196), GoGo-BE#594 — what a phone shows and what the app routes
 * on. Real pushes on DEV `07c4911` read `GoGo` / `plan_ready` on the lock screen
 * of both test phones; these pin the copy per kind and locale, and the data
 * contract agreed with GoGo-MobileApp#256.
 */

const KINDS = [...new Set(Object.values(EVENT_TO_NOTIFICATION).map((m) => m.kind))].sort();
const EVENT = { id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', eventType: 'plan.published' };
const ROOM = '0b7c1f0e-3a55-4d1c-9a5e-2f6d8c4b1a01';
const PLAN = '5e2a9d7c-8b41-4f0a-b6e3-9c1d2a7f4e02';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('push copy', () => {
  it('covers every kind the outbox pushes', () => {
    expect(KINDS).toEqual([
      'date_reminder',
      'invite',
      'plan_changed',
      'plan_ready',
      'preference_reminder',
    ]);
  });

  it('renders every kind in vi and en', () => {
    const table = Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        Object.fromEntries(PUSH_LOCALES.map((locale) => [locale, renderPushCopy(kind, locale)])),
      ]),
    );
    expect(table).toMatchInlineSnapshot(`
      {
        "date_reminder": {
          "en": {
            "contents": {
              "en": "Open GoGo to see the itinerary.",
            },
            "headings": {
              "en": "Your outing has started",
            },
          },
          "vi": {
            "contents": {
              "en": "Mở GoGo để xem lịch trình.",
              "vi": "Mở GoGo để xem lịch trình.",
            },
            "headings": {
              "en": "Buổi đi chơi đã bắt đầu",
              "vi": "Buổi đi chơi đã bắt đầu",
            },
          },
        },
        "invite": {
          "en": {
            "contents": {
              "en": "Someone just joined your room.",
            },
            "headings": {
              "en": "New member",
            },
          },
          "vi": {
            "contents": {
              "en": "Một người vừa vào phòng của bạn.",
              "vi": "Một người vừa vào phòng của bạn.",
            },
            "headings": {
              "en": "Có thành viên mới",
              "vi": "Có thành viên mới",
            },
          },
        },
        "plan_changed": {
          "en": {
            "contents": {
              "en": "Your room's plan was just updated.",
            },
            "headings": {
              "en": "Plan updated",
            },
          },
          "vi": {
            "contents": {
              "en": "Kế hoạch của phòng vừa được cập nhật.",
              "vi": "Kế hoạch của phòng vừa được cập nhật.",
            },
            "headings": {
              "en": "Kế hoạch có thay đổi",
              "vi": "Kế hoạch có thay đổi",
            },
          },
        },
        "plan_ready": {
          "en": {
            "contents": {
              "en": "Open GoGo to see your room's plan.",
            },
            "headings": {
              "en": "Your plan is ready",
            },
          },
          "vi": {
            "contents": {
              "en": "Mở GoGo để xem kế hoạch của phòng.",
              "vi": "Mở GoGo để xem kế hoạch của phòng.",
            },
            "headings": {
              "en": "Kế hoạch đã sẵn sàng",
              "vi": "Kế hoạch đã sẵn sàng",
            },
          },
        },
        "preference_reminder": {
          "en": {
            "contents": {
              "en": "A member just finished picking. Open the room to see progress.",
            },
            "headings": {
              "en": "Preferences updated",
            },
          },
          "vi": {
            "contents": {
              "en": "Một thành viên vừa chọn xong. Mở phòng để xem tiến độ.",
              "vi": "Một thành viên vừa chọn xong. Mở phòng để xem tiến độ.",
            },
            "headings": {
              "en": "Có cập nhật sở thích",
              "vi": "Có cập nhật sở thích",
            },
          },
        },
      }
    `);
  });

  it('never shows the kind key, the placeholder or an empty line', () => {
    for (const kind of KINDS) {
      for (const locale of PUSH_LOCALES) {
        const { headings, contents } = renderPushCopy(kind, locale);
        for (const line of [...Object.values(headings), ...Object.values(contents)]) {
          expect(line.trim().length).toBeGreaterThan(0);
          expect(line).not.toBe('GoGo');
          expect(line).not.toContain(kind);
          // No template left unfilled, no stable key leaking through.
          expect(line).not.toMatch(/[{}_]/);
        }
      }
    }
  });

  it('fills en and the account locale with the same copy, so the account wins over the phone', () => {
    const vi = renderPushCopy('plan_ready', 'vi');
    expect(Object.keys(vi.headings).sort()).toEqual(['en', 'vi']);
    expect(vi.headings.en).toBe(vi.headings.vi);
    expect(vi.contents.en).toBe(vi.contents.vi);

    const en = renderPushCopy('plan_ready', 'en');
    expect(Object.keys(en.headings)).toEqual(['en']);
    expect(en.headings.en).not.toBe(vi.headings.en);
  });

  it.each([
    ['vi', 'vi'],
    ['vi-VN', 'vi'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['EN_gb', 'en'],
    ['fr', 'vi'],
    ['', 'vi'],
    [null, 'vi'],
    [undefined, 'vi'],
  ])('reads account locale %j as %s', (stored, expected) => {
    expect(pushLocaleOf(stored)).toBe(expected);
  });
});

describe('push data contract v1', () => {
  it('carries exactly the contract fields, legacy ones included', () => {
    const { data } = renderPushNotification({
      kind: 'plan_ready',
      locale: 'vi',
      event: EVENT,
      roomId: ROOM,
      currentPlanId: PLAN,
    });
    expect(data).toEqual({
      type: 'plan_ready',
      version: PUSH_PAYLOAD_VERSION,
      notificationId: EVENT.id,
      route: `gogo://plan/${PLAN}`,
      entityType: 'plan',
      entityId: PLAN,
      kind: 'plan_ready',
      roomId: ROOM,
      eventType: 'plan.published',
    });
  });

  it.each<[PushKind, string | null, string]>([
    ['invite', PLAN, `gogo://room/${ROOM}`],
    ['preference_reminder', PLAN, `gogo://room/${ROOM}`],
    ['plan_ready', PLAN, `gogo://plan/${PLAN}`],
    ['plan_changed', PLAN, `gogo://plan/${PLAN}`],
    ['date_reminder', PLAN, `gogo://plan/${PLAN}`],
    ['plan_ready', null, `gogo://room/${ROOM}`],
    ['plan_changed', null, `gogo://room/${ROOM}`],
    ['date_reminder', null, `gogo://room/${ROOM}`],
  ])('%s with current plan %s routes to %s', (kind, currentPlanId, route) => {
    const { data } = renderPushNotification({
      kind,
      locale: 'vi',
      event: EVENT,
      roomId: ROOM,
      currentPlanId,
    });
    expect(data.route).toBe(route);
    expect(`gogo://${data.entityType}/${data.entityId}`).toBe(route);
  });

  it('holds nothing private: ids, stable keys and a route only', () => {
    const allowed: Record<string, RegExp> = {
      type: /^[a-z_]+$/,
      kind: /^[a-z_]+$/,
      version: /^\d+$/,
      notificationId: UUID,
      roomId: UUID,
      entityId: UUID,
      entityType: /^(room|plan)$/,
      eventType: /^[a-z_]+\.[a-z_]+$/,
      route: new RegExp(`^gogo://(room|plan)/${UUID.source.slice(1, -1)}$`),
    };
    for (const kind of KINDS) {
      for (const locale of PUSH_LOCALES) {
        for (const currentPlanId of [PLAN, null]) {
          const push = renderPushNotification({
            kind,
            locale,
            event: EVENT,
            roomId: ROOM,
            currentPlanId,
          });
          expect(Object.keys(push.data).sort()).toEqual(Object.keys(allowed).sort());
          for (const [field, value] of Object.entries(push.data)) {
            expect(value).toMatch(allowed[field]!);
          }
          // The provider caps `data` at 2 KB.
          expect(Buffer.byteLength(JSON.stringify(push.data))).toBeLessThan(2048);
          // Lock-screen copy names no id at all.
          const copy = JSON.stringify([push.headings, push.contents]);
          for (const id of [EVENT.id, ROOM, PLAN]) expect(copy).not.toContain(id);
        }
      }
    }
  });

  it('keeps the bare event id as the provider key for the default locale', () => {
    expect(pushIdempotencyKey(EVENT.id, 'vi')).toBe(EVENT.id);
    expect(pushIdempotencyKey(EVENT.id, 'en')).toBe(`${EVENT.id}:en`);
  });
});
