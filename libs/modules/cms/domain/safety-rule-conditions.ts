import { z } from 'zod';

/**
 * BE-CMS-G4d (#225) — what a Trust & Safety rule is allowed to say.
 *
 * The mockup excludes a visual rule builder, and that exclusion is the design,
 * not a scoping shortcut. A free-form condition language would mean the console
 * could write logic nobody reviewed: unbounded evaluation cost, behaviour that
 * cannot be reasoned about before it fires, and — the moment anything
 * interprets it — a write endpoint that executes what it is given.
 *
 * So conditions are a closed union: one schema per rule type, every field
 * named here, every bound stated. Nothing is evaluated as an expression, and
 * there is no operator the server did not ship. Adding a capability means
 * adding a case below, with the code that acts on it.
 */

export const SAFETY_RULE_TYPES = [
  'spam',
  'abusive_content',
  'blocked_words',
  'review_abuse',
  'user_abuse',
  'repeated_reports',
  'rate_limit',
] as const;
export type SafetyRuleType = (typeof SAFETY_RULE_TYPES)[number];

export const SAFETY_RULE_TRIGGERS = [
  'review_created',
  'review_updated',
  'report_created',
  'checkin_created',
  'place_submitted',
  'user_registered',
] as const;
export type SafetyRuleTrigger = (typeof SAFETY_RULE_TRIGGERS)[number];

export const SAFETY_RULE_ACTIONS = [
  'flag_for_review',
  'auto_hide',
  'require_moderation',
  'suspend_user',
  'block_action',
] as const;
export type SafetyRuleAction = (typeof SAFETY_RULE_ACTIONS)[number];

export const SAFETY_RULE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SafetyRuleSeverity = (typeof SAFETY_RULE_SEVERITIES)[number];

export const SAFETY_RULE_STATUSES = ['draft', 'active', 'disabled'] as const;
export type SafetyRuleStatus = (typeof SAFETY_RULE_STATUSES)[number];

/** Actions that can be rate-limited by a rule; not an open string. */
export const RATE_LIMITED_ACTIONS = [
  'review_create',
  'report_create',
  'checkin_create',
  'place_submit',
  'room_join',
] as const;

const term = z.string().trim().min(1).max(64);
const hours = z
  .number()
  .int()
  .min(1)
  .max(24 * 30);

/**
 * One schema per rule type. `.strict()` everywhere: an unrecognised key is a
 * rejection, not a field quietly stored and never read.
 */
export const CONDITION_SCHEMAS = {
  blocked_words: z
    .object({
      terms: z.array(term).min(1).max(500),
      matchMode: z.enum(['exact', 'substring']).default('substring'),
      caseSensitive: z.boolean().default(false),
    })
    .strict(),

  spam: z
    .object({
      /** Links in one piece of content before it counts as spam. */
      maxLinks: z.number().int().min(0).max(50).optional(),
      /** Near-identical submissions by one actor inside the window. */
      maxDuplicatesPerWindow: z.number().int().min(1).max(100).optional(),
      windowHours: hours.default(24),
      /** Accounts younger than this are the ones spam comes from. */
      minAccountAgeHours: z
        .number()
        .int()
        .min(0)
        .max(24 * 365)
        .optional(),
    })
    .strict()
    .refine(
      (c) => c.maxLinks !== undefined || c.maxDuplicatesPerWindow !== undefined,
      'a spam rule needs at least one of maxLinks or maxDuplicatesPerWindow',
    ),

  abusive_content: z
    .object({
      terms: z.array(term).max(500).default([]),
      /** Reports against one piece of content before the rule fires. */
      minReports: z.number().int().min(1).max(100).default(1),
      windowHours: hours.default(24),
    })
    .strict(),

  review_abuse: z
    .object({
      maxReviewsPerWindow: z.number().int().min(1).max(500),
      windowHours: hours.default(24),
      /** Repeat reviews of the same place by one author. */
      maxReviewsPerPlace: z.number().int().min(1).max(50).optional(),
    })
    .strict(),

  user_abuse: z
    .object({
      maxReportsAgainstUser: z.number().int().min(1).max(500),
      windowHours: hours.default(24 * 7),
      /** Only reports already upheld by a moderator count, if set. */
      upheldOnly: z.boolean().default(false),
    })
    .strict(),

  repeated_reports: z
    .object({
      minReports: z.number().int().min(2).max(500),
      windowHours: hours.default(24),
      /** Distinct reporters, so one person cannot manufacture a threshold. */
      distinctReporters: z.boolean().default(true),
    })
    .strict(),

  rate_limit: z
    .object({
      action: z.enum(RATE_LIMITED_ACTIONS),
      limit: z.number().int().min(1).max(10_000),
      windowSeconds: z.number().int().min(1).max(86_400),
    })
    .strict(),
} as const satisfies Record<SafetyRuleType, z.ZodType>;

/**
 * Which actions each rule type may take.
 *
 * A blocked-words rule suspending an account, or a rate-limit rule hiding
 * content it never looked at, are configurations that make sense to a form and
 * not to the system. Refusing them here is cheaper than discovering the
 * mismatch when the rule fires on somebody.
 */
export const ALLOWED_ACTIONS: Record<SafetyRuleType, readonly SafetyRuleAction[]> = {
  blocked_words: ['flag_for_review', 'auto_hide', 'require_moderation', 'block_action'],
  spam: ['flag_for_review', 'auto_hide', 'require_moderation', 'block_action'],
  abusive_content: ['flag_for_review', 'auto_hide', 'require_moderation'],
  review_abuse: ['flag_for_review', 'require_moderation', 'block_action', 'suspend_user'],
  user_abuse: ['flag_for_review', 'require_moderation', 'suspend_user'],
  repeated_reports: ['flag_for_review', 'auto_hide', 'require_moderation', 'suspend_user'],
  rate_limit: ['block_action'],
};

/** Which triggers each rule type can be evaluated on. */
export const ALLOWED_TRIGGERS: Record<SafetyRuleType, readonly SafetyRuleTrigger[]> = {
  blocked_words: ['review_created', 'review_updated', 'checkin_created', 'place_submitted'],
  spam: ['review_created', 'review_updated', 'checkin_created', 'place_submitted'],
  abusive_content: ['review_created', 'review_updated', 'report_created', 'checkin_created'],
  review_abuse: ['review_created', 'review_updated'],
  user_abuse: ['report_created', 'user_registered'],
  repeated_reports: ['report_created'],
  rate_limit: [
    'review_created',
    'report_created',
    'checkin_created',
    'place_submitted',
    'user_registered',
  ],
};

/**
 * Suspension takes an account away from a person automatically. It is allowed
 * only where the rule is actually about that person's conduct, and only at a
 * severity that says someone meant it — a `low` rule that suspends accounts is
 * a configuration mistake waiting to happen at scale.
 */
export const SUSPENSION_MIN_SEVERITY: SafetyRuleSeverity = 'high';

export const SEVERITY_RANK: Record<SafetyRuleSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
