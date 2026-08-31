import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { places } from './places';
import { roomMembers, rooms } from './rooms';
import { contentAudience } from './cms';

/**
 * DB-006 — vote/candidate/plan/version/stop schema.
 * Invariants: one current plan per room; votes idempotent per (room, member,
 * target); locked stops survive regenerate; every suggestion result keeps its
 * input snapshot + versions for audit/A-B (FR-SUG-010).
 */

export const suggestionRunStatus = pgEnum('suggestion_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

export const suggestionRuns = pgTable(
  'suggestion_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    status: suggestionRunStatus('status').notNull().default('queued'),
    constraintVersion: integer('constraint_version').notNull(),
    engineVersion: text('engine_version').notNull(),
    weightsVersion: text('weights_version').notNull(),
    // Immutable room snapshot the run was computed from (SG-002).
    inputSnapshot: jsonb('input_snapshot').notNull(),
    aiRefinementUsed: boolean('ai_refinement_used').notNull().default(false),
    /** SG-010 — null means no experiment was active, which is not "control". */
    experimentKey: text('experiment_key'),
    experimentVariant: text('experiment_variant'),
    /** What the run spent, against the latency budget. */
    latencyMs: integer('latency_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('suggestion_runs_room_idx').on(t.roomId, t.createdAt)],
);

export const candidateScores = pgTable(
  'candidate_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => suggestionRuns.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    // Score in [0,1] scaled by 1e6 to keep integer math exact.
    scoreMicros: integer('score_micros').notNull(),
    // Explainable components: preference, consensus, distance, budget,
    // quality, freshness, diversity (FR-SUG-002).
    components: jsonb('components').$type<Record<string, number>>().notNull(),
    reasonCodes: jsonb('reason_codes').$type<string[]>().notNull().default([]),
    isStale: boolean('is_stale').notNull().default(false),
  },
  (t) => [
    uniqueIndex('candidate_scores_run_place_unique').on(t.runId, t.placeId),
    index('candidate_scores_room_idx').on(t.roomId, t.isStale),
  ],
);

export const voteValue = pgEnum('vote_value', ['yes', 'no', 'star']);

export const votes = pgTable(
  'votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => roomMembers.id, { onDelete: 'cascade' }),
    targetPlaceId: uuid('target_place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    value: voteValue('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency anchor: re-voting upserts this row (FR-SUG-004).
    uniqueIndex('votes_room_member_target_unique').on(t.roomId, t.memberId, t.targetPlaceId),
    index('votes_room_target_idx').on(t.roomId, t.targetPlaceId),
  ],
);

export const planStatus = pgEnum('plan_status', ['draft', 'current', 'superseded', 'archived']);

export type PlanTotals = {
  costMin: number;
  costMax: number;
  currency: string;
  durationMinutes: number;
  travelDistanceM: number;
  // FR-SUG-006: overBudget must be flagged from the upper bound, never the
  // lower; uncertainty carried explicitly.
  overBudget: boolean;
  uncertain: boolean;
};

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: planStatus('status').notNull().default('draft'),
    totals: jsonb('totals').$type<PlanTotals>().notNull(),
    isStale: boolean('is_stale').notNull().default(false),
    constraintVersion: integer('constraint_version').notNull(),
    generatedByRunId: uuid('generated_by_run_id').references(() => suggestionRuns.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plans_room_version_unique').on(t.roomId, t.version),
    // Hard invariant: at most one current plan per room (FR-PLAN-001).
    uniqueIndex('plans_room_current_unique')
      .on(t.roomId)
      .where(sql`${t.status} = 'current'`),
  ],
);

export const stopStatus = pgEnum('stop_status', ['planned', 'completed', 'skipped']);

export const planStops = pgTable(
  'plan_stops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    placeId: uuid('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    arriveAt: timestamp('arrive_at', { withTimezone: true }),
    departAt: timestamp('depart_at', { withTimezone: true }),
    durationMinutes: integer('duration_minutes').notNull(),
    travelMinutesFromPrev: integer('travel_minutes_from_prev'),
    travelDistanceMFromPrev: integer('travel_distance_m_from_prev'),
    costMin: bigint('cost_min', { mode: 'number' }),
    costMax: bigint('cost_max', { mode: 'number' }),
    // FR-SUG-007: locked stops are invariant across regenerate.
    isLocked: boolean('is_locked').notNull().default(false),
    lockedByMemberId: uuid('locked_by_member_id'),
    status: stopStatus('status').notNull().default('planned'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plan_stops_plan_position_unique').on(t.planId, t.position),
    index('plan_stops_place_idx').on(t.placeId),
    check('plan_stops_position_positive', sql`${t.position} >= 0`),
  ],
);

/** FR-PLAN-008/009 — in-the-moment stop check-in with optional verified bill. */
export const stopCheckins = pgTable(
  'stop_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planStopId: uuid('plan_stop_id')
      .notNull()
      .references(() => planStops.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => roomMembers.id, { onDelete: 'cascade' }),
    rating: smallint('rating'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    note: text('note'),
    // Max 3 photos enforced at the application layer + check constraint.
    photoKeys: jsonb('photo_keys').$type<string[]>().notNull().default([]),
    billTotal: bigint('bill_total', { mode: 'number' }),
    billPeopleCount: integer('bill_people_count'),
    billPhotoKey: text('bill_photo_key'),
    moderation: text('moderation').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stop_checkins_stop_member_unique').on(t.planStopId, t.memberId),
    check('stop_checkins_rating_range', sql`${t.rating} is null or ${t.rating} between 1 and 5`),
    check('stop_checkins_photo_limit', sql`jsonb_array_length(${t.photoKeys}) <= 3`),
    // FR-PLAN-009: a bill amount requires the bill photo as evidence.
    check(
      'stop_checkins_bill_photo_required',
      sql`${t.billTotal} is null or ${t.billPhotoKey} is not null`,
    ),
  ],
);

// --------------------------------------------------------- plan templates

export const planTemplateStatus = pgEnum('plan_template_status', [
  'draft',
  'published',
  'archived',
]);

/**
 * What an amount is *per*. `per_person` and `per_group` are different numbers,
 * so an amount is never stored without one (`.claude/rules/core.md` §13).
 */
export const budgetScope = pgEnum('budget_scope', ['per_person', 'per_group']);

/**
 * BE-CMS-G4b (#223) — CMS-managed plan templates.
 *
 * Source material for future plans, not live ones. Nothing here references a
 * room, a plan or a plan stop, and that is deliberate: editing a template must
 * never reach a plan somebody already has, and the surest way to guarantee it
 * is to have no path from one to the other.
 */
export const planTemplates = pgTable(
  'plan_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    locale: text('locale').notNull().default('vi'),
    /** The editorial name; `title` is what a user would read. */
    internalName: text('internal_name').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    audience: contentAudience('audience'),
    areaKey: text('area_key'),
    /** Integer minor units, with the currency and scope beside them. */
    budgetMin: bigint('budget_min', { mode: 'number' }),
    budgetMax: bigint('budget_max', { mode: 'number' }),
    budgetCurrency: text('budget_currency'),
    budgetScope: budgetScope('budget_scope'),
    expectedDurationMinutes: integer('expected_duration_minutes'),
    status: planTemplateStatus('status').notNull().default('draft'),
    createdByAdminId: uuid('created_by_admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plan_templates_slug_locale_unique').on(t.slug, t.locale),
    index('plan_templates_list_idx').on(t.status, t.createdAt, t.id),
  ],
);

export const planTemplateStops = pgTable(
  'plan_template_stops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => planTemplates.id, { onDelete: 'cascade' }),
    /** Order is meaning: a template is a sequence, not a set. */
    position: integer('position').notNull(),
    categoryTaxonomyId: uuid('category_taxonomy_id').notNull(),
    /** A template may name a place or leave the choice to matching. */
    preferredPlaceId: uuid('preferred_place_id').references(() => places.id, {
      onDelete: 'set null',
    }),
    /** A property of the stop, not a convention the reader has to infer. */
    isOptional: boolean('is_optional').notNull().default(false),
    expectedDurationMinutes: integer('expected_duration_minutes').notNull(),
    budgetMin: bigint('budget_min', { mode: 'number' }),
    budgetMax: bigint('budget_max', { mode: 'number' }),
    budgetCurrency: text('budget_currency'),
    budgetScope: budgetScope('budget_scope'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('plan_template_stops_position_unique').on(t.templateId, t.position),
    index('plan_template_stops_template_idx').on(t.templateId, t.position),
  ],
);

/** Mood/vibe as stable taxonomy keys, never display labels. */
export const planTemplateTaxonomies = pgTable(
  'plan_template_taxonomies',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => planTemplates.id, { onDelete: 'cascade' }),
    taxonomyId: uuid('taxonomy_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.taxonomyId] }),
    index('plan_template_taxonomies_taxonomy_idx').on(t.taxonomyId),
  ],
);
