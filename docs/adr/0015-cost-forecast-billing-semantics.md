# ADR-0015: Cost forecasting on billing semantics, not MTD extrapolation

- **Status:** accepted
- **Date:** 2026-09-05
- **Deciders:** product owner (decision), backend, CMS
- **Amends:** `Cost-Spec/GoGo-Cost-Observability-Epic-FINAL.md` §27 (manual /
  fixed costs) and §33 (forecast). Tracked as GoGo-BE#415 (COST-BE-034) and
  GoGo-CMS#115 (COST-CMS-012).

## Context

Epic §33 defined the month forecast as _MTD daily average × days in the
billing month_ over every row of `provider_cost_daily`, and §27 had the
manual-cost materialiser spread a MONTHLY fee over the days of the month and a
YEARLY fee over the days of the year. Together they produced three wrong
numbers on the first real DEV data:

- A **one-time** charge (Play Console, 25 USD on day 3) was divided by the
  elapsed days and multiplied back up — a registration fee became a run-rate.
- An **annual** fee (Apple Developer, 99 USD, renews in January) contributed
  99/365 a day to _September's_ month-to-date and forecast, a month that
  never invoices it.
- A **monthly** fee was spread and then extrapolated, which is circular: the
  forecast of a subscription is its price, not an average of its own daily
  shares.

The Cost Center showed one "Projected month" figure with no statement of
what it was — cash due at month end, or a typical month's run-rate — and the
budget engine compared budgets against it. The product owner ordered a
redesign on 2026-09-05: classify every cost source, extrapolate only usage,
count one-offs once, recognise annual fees in their renewal month only, and
present month actual, end-of-month cash forecast and normalised run-rate as
three separate numbers.

## Options considered

1. **Keep spreading, fix the formula by basis.** Extrapolate only ESTIMATED /
   ACTUAL rows; add FIXED / MANUAL as-is. — Basis says how a number is
   _known_, not how it is _billed_: an ACTUAL row can be a subscription line
   on an invoice, and a MANUAL row can be a one-off. The spread annual fee
   would still be in the wrong month. Rejected.
2. **Classify in the reader** from `source` and `metadata` (the materialiser
   writes `period`; the monitoring model writes `knownMonthlyMicros`). — Works
   for today's two producers and silently breaks on the third. A collector
   that reports a plan fee would be extrapolated as usage. Rejected.
3. **Classify on the row, recognise on the billing day, forecast from a
   schedule** (chosen). Every `provider_cost_daily` row carries `cost_kind`
   (USAGE | RECURRING | ONE_TIME), `billing_cadence` (MONTHLY | ANNUAL,
   required exactly when RECURRING) and `period_amount_micros` (the period's
   full charge, required when RECURRING) under check constraints. Manual
   items materialise one row per **billing day** at the full amount. The
   forecast engine (`domain/forecast.ts`, pure) reads the rows _and_ the
   items' billing schedule.

## Decision

**Every cost source is classified, and only usage is extrapolated.**

- `cost_kind` is a NOT NULL column with no default: a writer that does not say
  how a charge is billed cannot write it. Producers today: the estimator
  (USAGE, or RECURRING for a `FIXED_MONTHLY` / `FIXED_ANNUAL` pricing rule),
  the AWS and GitHub collectors (USAGE), the monitoring cost model (RECURRING
  MONTHLY, `period_amount_micros = knownMonthlyMicros`), the manual-cost
  materialiser (from the item's period). Migration 0043 backfills existing
  rows from `basis` and the metadata those writers already recorded; a row
  it cannot classify becomes ONE_TIME — counted once, extrapolated never.
- **Recognition is on the billing day.** A MONTHLY item bills on the
  day-of-month of `effectiveFrom` (clamped to shorter months), a YEARLY item
  on its month-day each year (Feb 29 → Feb 28), a ONE_TIME item once. No row
  is a daily share. Month actual is therefore cash-basis: the money the
  month's invoices carry, as of today.
- **Three numbers, never one:**
  - _Month actual_ = `spend()` over the month's rows, by kind.
  - _End-of-month cash_ = USAGE projection (MTD usage ÷ elapsed days × days
    in month, `null` under three elapsed days) + every RECURRING charge whose
    billing date is in the month (landed or scheduled) + every ONE_TIME
    charge of the month. An ANNUAL fee is in it only in its renewal month.
  - _Normalised run-rate_ = USAGE projection + active MONTHLY fees + active
    ANNUAL fees ÷ 12. ONE_TIME never enters it.
- **What is still to come is read from a schedule, not from an average.**
  For manual items the schedule is computed from the item (`manualSchedule`);
  for a recurring source with no item (the monitoring model) the row's
  `period_amount_micros` is the month's commitment and the remainder is
  `period − landed`. A manual row whose item bills nothing this month (a
  moved anchor, a pre-0043 daily share) counts as landed and declares no
  commitment.
- **The usage half can be unknown; the rest never is.** `cash.micros` is
  `null` while `usage.projectedMicros` is, with a reason
  (`INSUFFICIENT_HISTORY`, `NO_USAGE_ROWS`) and a `floorMicros` the CMS shows
  as "≥". A scope nothing in which produces usage (a manual-only provider)
  has a known zero usage half (`NOT_APPLICABLE`) and a complete forecast.
  Budgets project against the cash forecast; a floor above the budget is
  `projected_exceed` even while usage cannot be projected.
- **The API says which number it is.** `cards.projected` is replaced by
  `cards.forecast { actual, usage, recurring, oneTime, scheduled, cash,
runRate }`; `CmsCostBudgetStatus` gains `projectedFloorMicros` and
  `runRateMicros`; `CmsManualCostItem` gains `costKind`, `billingCadence`,
  `nextChargeDay`. The CMS renders month actual, cash forecast and run-rate
  as three labelled figures and never derives one from another.

## Consequences

- Month-to-date changes meaning for manual items: a monthly fee billed on the
  1st is in the month actual in full from the 1st, and an annual fee is in
  the actual of its renewal month only. This is what the invoices say.
- The `today` card carries a manual fee only on its billing day.
- Test-run deltas are unaffected (usage only, epic §27).
- Every test or script that inserts into `provider_cost_daily` must name a
  `cost_kind`; the integration specs were updated accordingly.
- A future collector reporting a plan fee must stamp RECURRING with its
  cadence and period amount; the sample writer defaults a RECURRING sample's
  cadence to MONTHLY and its period amount to the sample amount when the
  collector omits them, and the check constraints refuse a RECURRING row
  with neither.
- An ANNUAL fee known only from rows (no item) reaches the run-rate only in
  its renewal month; manual items are the way to declare one.
- ADR-0014's `/monitoring` cost-data freshness for a MANUAL source was "a row
  for today → FRESH, older rows → STALE". Under charge-day recognition that
  would read STALE on every day that is not a billing day. It now judges the
  materialised rows against the items' billing schedule inside the read
  window: every billing day due so far has its row → FRESH; a due day without
  a row → STALE (the materialiser is behind); rows nothing is due for (a
  moved anchor, a pre-0043 daily share) → STALE until swept; nothing due and
  no rows → `null`. `CostDataFacts.expectedManualDays` carries the schedule;
  the Cost Center reads the manual items once per request for it.

## Migration & rollback

- Forward: migration 0043 adds the columns, backfills, sets NOT NULL, adds the
  check constraints and an index. Deploy BE before CMS; the CMS re-vendors
  the spec in the same wave (GoGo-CMS#115). The worker's first
  `gogo:worker:cost-collectors` tick after deploy (and any CMS manual-item
  write) rebuilds every manual row on its billing day and deletes the daily
  shares. Between deploy and that tick the spread rows are correctly
  classified and count only as landed money.
- Rollback: the down statements in migration 0043 drop the constraints and
  columns; readers on the previous release ignore the columns, and the
  previous materialiser rebuilds daily shares on its first pass. The CMS
  must be rolled back with it (its zod contract requires `cards.forecast`).
