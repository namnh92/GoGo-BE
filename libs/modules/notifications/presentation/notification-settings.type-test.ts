import type { operations } from '../../../../openapi/gogo.v1';

type Patch = operations['patchNotificationSettings']['requestBody']['content']['application/json'];

// Compiled by the modules typecheck. An accidental `unknown` makes the error
// assertions below fail, so generation cannot erase these constraints.
const valid: Patch[] = [
  { pushEnabled: false },
  { quietHours: { enabled: false } },
  { quietHours: { enabled: true, timezone: 'Asia/Ho_Chi_Minh' } },
  { quietHours: { timezone: 'America/New_York' } },
  { categories: { invite: false } },
  { categories: { date_reminder: true, plan_ready: false } },
  { pushEnabled: true, categories: {} },
  { pushEnabled: true, categories: { plan_changed: false } },
  { pushEnabled: false, categories: {}, quietHours: { enabled: false } },
  { categories: { invite: true }, quietHours: { timezone: 'Asia/Ho_Chi_Minh' } },
];
const invalid: Patch[] = [
  // @ts-expect-error Empty quiet-hours mutation is not a change.
  { quietHours: {} },
  // @ts-expect-error Timezone cannot be null on mutation.
  { quietHours: { timezone: null } },
  // @ts-expect-error Quiet hours must be an object.
  { quietHours: false },
  // @ts-expect-error A change is required.
  {},
  // @ts-expect-error A category-only change cannot be empty.
  { categories: {} },
  // @ts-expect-error Master must be a boolean.
  { pushEnabled: 'yes' },
  // @ts-expect-error Category must be a boolean.
  { categories: { invite: 'yes' } },
  // @ts-expect-error Categories must be an object.
  { categories: false },
  // @ts-expect-error Other is not configurable.
  { categories: { other: true } },
  // @ts-expect-error Unknown fields cannot replace a change.
  { unexpected: true },
];
void valid;
void invalid;
