import { Inject, Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';
import {
  ALLOWED_ACTIONS,
  ALLOWED_TRIGGERS,
  CONDITION_SCHEMAS,
  SEVERITY_RANK,
  SUSPENSION_MIN_SEVERITY,
  type SafetyRuleAction,
  type SafetyRuleSeverity,
  type SafetyRuleStatus,
  type SafetyRuleTrigger,
  type SafetyRuleType,
} from '../domain/safety-rule-conditions';

/**
 * BE-CMS-G4d (#225) — Trust & Safety rule definitions.
 *
 * These are *definitions*. Nothing in this service evaluates a rule against
 * content or an account: the enforcement path is separate work, and building
 * half of it here would produce a rule that fires with no audit trail behind
 * the decision.
 *
 * What this does guarantee is that a stored rule is one the system could
 * actually run — closed conditions, an action the rule type can take, a
 * trigger it can be evaluated on, and a machine-readable reason code for
 * whatever it eventually does to someone.
 */

export type SafetyRuleInput = {
  name: string;
  description?: string | undefined;
  ruleType: SafetyRuleType;
  trigger: SafetyRuleTrigger;
  /** Optional in the request; `{}` is a legitimate condition set for some types. */
  conditions?: unknown;
  action: SafetyRuleAction;
  severity?: SafetyRuleSeverity | undefined;
  priority?: number | undefined;
  reasonCode: string;
};

export type SafetyRulePatch = {
  [K in keyof Omit<SafetyRuleInput, 'ruleType'>]?: SafetyRuleInput[K] | undefined;
};

export type SafetyRuleListQuery = {
  ruleType?: SafetyRuleType | undefined;
  status?: SafetyRuleStatus | undefined;
  action?: SafetyRuleAction | undefined;
  severity?: SafetyRuleSeverity | undefined;
  trigger?: SafetyRuleTrigger | undefined;
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

type RuleRow = {
  id: string;
  name: string;
  description: string | null;
  rule_type: SafetyRuleType;
  trigger: SafetyRuleTrigger;
  conditions: unknown;
  action: SafetyRuleAction;
  severity: SafetyRuleSeverity;
  status: SafetyRuleStatus;
  priority: number;
  reason_code: string;
  created_by_admin_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

@Injectable()
export class SafetyRulesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(query: SafetyRuleListQuery) {
    const filters: SQL[] = [sql`true`];
    if (query.ruleType) filters.push(sql`r.rule_type = ${query.ruleType}`);
    if (query.status) filters.push(sql`r.status = ${query.status}`);
    if (query.action) filters.push(sql`r.action = ${query.action}`);
    if (query.severity) filters.push(sql`r.severity = ${query.severity}`);
    if (query.trigger) filters.push(sql`r.trigger = ${query.trigger}`);
    if (query.q) {
      const needle = `%${query.q.trim().toLowerCase()}%`;
      filters.push(sql`(lower(r.name) like ${needle} or lower(r.reason_code) like ${needle})`);
    }

    const countWhere = sql.join(filters, sql` and `);
    const pageFilters = [...filters];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageFilters.push(sql`(r.created_at, r.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        select r.*, a.display_name as created_by_name
        from safety_rules r
        left join admin_users a on a.id = r.created_by_admin_id
        where ${sql.join(pageFilters, sql` and `)}
        order by r.created_at desc, r.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(sql`select count(*)::int as n from safety_rules r where ${countWhere}`),
    ]);

    const rows = page.rows as (RuleRow & { created_by_name: string | null })[];
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => this.toDto(r)),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }

  async get(id: string) {
    return this.toDto(await this.requireRow(id));
  }

  async create(adminId: string, input: SafetyRuleInput) {
    const conditions = this.validate(input.ruleType, input);

    const [row] = await this.db
      .insert(schema.safetyRules)
      .values({
        name: input.name,
        description: input.description ?? null,
        ruleType: input.ruleType,
        trigger: input.trigger,
        conditions,
        action: input.action,
        severity: input.severity ?? 'medium',
        priority: input.priority ?? 100,
        reasonCode: input.reasonCode,
        createdByAdminId: adminId,
      })
      .returning()
      .catch((err: unknown) => {
        throw this.nameConflict(err, input.name);
      });

    // A rule that can act on a person is itself a sensitive write: the audit
    // carries the whole definition, so "why did this account get suspended"
    // can be answered from the log even after the rule is edited.
    await this.audit(adminId, 'safety_rule.created', row!.id, {
      name: input.name,
      ruleType: input.ruleType,
      action: input.action,
      severity: input.severity ?? 'medium',
      reasonCode: input.reasonCode,
      conditions,
    });
    return this.get(row!.id);
  }

  async update(adminId: string, id: string, patch: SafetyRulePatch) {
    const before = await this.requireRow(id);
    const merged = {
      trigger: patch.trigger ?? before.trigger,
      action: patch.action ?? before.action,
      severity: patch.severity ?? before.severity,
      conditions: patch.conditions ?? before.conditions,
      reasonCode: patch.reasonCode ?? before.reason_code,
      name: patch.name ?? before.name,
    };
    // Re-validated as a whole: changing the action alone can make an
    // already-stored condition set illegal for it.
    const conditions = this.validate(before.rule_type, merged);

    await this.db
      .update(schema.safetyRules)
      .set({
        name: merged.name,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        trigger: merged.trigger,
        action: merged.action,
        severity: merged.severity,
        conditions,
        reasonCode: merged.reasonCode,
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.safetyRules.id, id))
      .catch((err: unknown) => {
        throw this.nameConflict(err, merged.name);
      });

    await this.audit(adminId, 'safety_rule.updated', id, {
      before: {
        action: before.action,
        severity: before.severity,
        trigger: before.trigger,
        conditions: before.conditions,
      },
      after: { ...merged, conditions },
    });
    return this.get(id);
  }

  /**
   * Activating and disabling are the same write with opposite consequences, so
   * both are audited the same way. `disabled` is reversible on purpose: the
   * point of a kill switch is that it can be thrown in either direction.
   */
  async setStatus(adminId: string, id: string, status: SafetyRuleStatus) {
    const before = await this.requireRow(id);
    if (before.status === status) return { id, status };

    // Re-check before it can act on anyone: a rule may have been left in draft
    // precisely because its definition was not finished.
    if (status === 'active') {
      this.validate(before.rule_type, {
        trigger: before.trigger,
        action: before.action,
        severity: before.severity,
        conditions: before.conditions,
        reasonCode: before.reason_code,
      });
    }

    await this.db
      .update(schema.safetyRules)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(schema.safetyRules.id, id));
    await this.audit(adminId, 'safety_rule.status_changed', id, {
      before: before.status,
      after: status,
      action: before.action,
      reasonCode: before.reason_code,
    });
    return { id, status };
  }

  // ---------------------------------------------------------------- internals

  /**
   * Everything a stored rule must satisfy, in one place.
   *
   * Conditions are parsed by the closed schema for the rule type — unknown keys
   * are rejected rather than stored and never read — and then the combination
   * is checked: the action must be one this rule type can take, the trigger one
   * it can be evaluated on, and suspension needs a severity that says somebody
   * meant it.
   */
  private validate(
    ruleType: SafetyRuleType,
    input: {
      trigger: SafetyRuleTrigger;
      action: SafetyRuleAction;
      severity?: SafetyRuleSeverity | undefined;
      conditions?: unknown;
      reasonCode: string;
    },
  ): unknown {
    const parsed = CONDITION_SCHEMAS[ruleType].safeParse(input.conditions ?? {});
    if (!parsed.success) {
      throw AppError.badRequest('INVALID_RULE_CONDITIONS', 'Conditions do not fit this rule type', [
        ...parsed.error.issues.slice(0, 5).map((issue) => ({
          field: `conditions.${issue.path.join('.') || '_'}`,
          code: issue.code,
          message: issue.message,
        })),
      ]);
    }

    if (!ALLOWED_ACTIONS[ruleType].includes(input.action)) {
      throw AppError.badRequest('ACTION_NOT_ALLOWED', 'That rule type cannot take that action', [
        {
          field: 'action',
          code: 'unsupported',
          message: `${ruleType} supports: ${ALLOWED_ACTIONS[ruleType].join(', ')}`,
        },
      ]);
    }

    if (!ALLOWED_TRIGGERS[ruleType].includes(input.trigger)) {
      throw AppError.badRequest(
        'TRIGGER_NOT_ALLOWED',
        'That rule type has nothing to check there',
        [
          {
            field: 'trigger',
            code: 'unsupported',
            message: `${ruleType} runs on: ${ALLOWED_TRIGGERS[ruleType].join(', ')}`,
          },
        ],
      );
    }

    const severity = input.severity ?? 'medium';
    if (
      input.action === 'suspend_user' &&
      SEVERITY_RANK[severity] < SEVERITY_RANK[SUSPENSION_MIN_SEVERITY]
    ) {
      // Suspension takes an account away from a person without a human in the
      // loop. A `low` rule doing that at scale is the mistake worth refusing.
      throw AppError.badRequest(
        'SEVERITY_TOO_LOW',
        'Automatic suspension needs a higher severity',
        [
          {
            field: 'severity',
            code: 'min',
            message: `suspend_user requires at least ${SUSPENSION_MIN_SEVERITY}`,
          },
        ],
      );
    }

    return parsed.data;
  }

  private toDto(row: RuleRow & { created_by_name?: string | null }) {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      ruleType: row.rule_type,
      trigger: row.trigger,
      conditions: row.conditions,
      action: row.action,
      severity: row.severity,
      status: row.status,
      priority: row.priority,
      reasonCode: row.reason_code,
      createdBy: row.created_by_admin_id
        ? { id: row.created_by_admin_id, displayName: row.created_by_name ?? null }
        : null,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private async requireRow(id: string): Promise<RuleRow & { created_by_name: string | null }> {
    const { rows } = await this.db.execute(sql`
      select r.*, a.display_name as created_by_name
      from safety_rules r
      left join admin_users a on a.id = r.created_by_admin_id
      where r.id = ${id}::uuid
    `);
    const row = rows[0] as (RuleRow & { created_by_name: string | null }) | undefined;
    if (!row) throw AppError.notFound('SAFETY_RULE_NOT_FOUND', 'Rule not found');
    return row;
  }

  private nameConflict(err: unknown, name: string): unknown {
    for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
      const pg = cause as Error & { code?: string };
      if (pg.code === '23505' || pg.message.includes('safety_rules_name_unique')) {
        return AppError.conflict('RULE_NAME_TAKEN', `A rule named "${name}" already exists`);
      }
    }
    return err;
  }

  private audit(adminId: string, action: string, id: string, diff: unknown) {
    return writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'safety_rule',
      resourceId: id,
      diff,
    });
  }
}
