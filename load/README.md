# Load, soak and failure injection (QP-005, #76)

These are [k6](https://k6.io) scripts. **They have not been run** — there is no
environment to run them against yet (#21), and a load number from a laptop
against a container is worse than no number, because someone will quote it.

What they are for now: the SLOs in `docs/runbooks.md` §3 exist as prose, so
nothing can fail when one is broken. Here they are thresholds, which means a
run either passes or names the SLO it broke.

```bash
BASE_URL=https://api.example.vn k6 run load/smoke.js      # 1 VU,  30s — is it alive
BASE_URL=... k6 run load/browse.js                        # ramp,  10m — the read path
BASE_URL=... k6 run load/plan.js                          # ramp,  10m — the write path
BASE_URL=... k6 run load/soak.js                          # steady, 2h — leaks and drift
```

## SLOs, as thresholds

| Flow           | SLO         | Where it comes from                             |
| -------------- | ----------- | ----------------------------------------------- |
| BFF reads      | p95 ≤ 500ms | runbooks §3                                     |
| Search         | p95 ≤ 700ms | runbooks §3                                     |
| Suggestion run | p95 ≤ 3s    | runbooks §3, and `SUGGESTION_LATENCY_BUDGET_MS` |
| Availability   | ≥ 99.9%     | runbooks §3                                     |

`browse.js` and `plan.js` fail the run if any of these is breached, so the
threshold is the assertion rather than a chart someone has to interpret.

## Failure injection

The dependency failures are already covered by tests that run on every commit,
which is a better place for them than a load run — they are deterministic, and
a load harness would only make them slower to observe:

| Failure                                       | Where it is asserted                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| Provider down / slow / quota exhausted        | `libs/providers/src/resilience.spec.ts`                                   |
| AI provider down, slow, or returning nonsense | `libs/modules/suggestions/application/feedback.service.spec.ts`           |
| Redis down                                    | `apps/api/test/platform.int.spec.ts` — rate limiting fails open           |
| Poison event in the outbox                    | `apps/api/test/user-providers.int.spec.ts` — backs off, then dead-letters |
| Place taken down under a saved plan           | `apps/api/test/suggestion-plan.int.spec.ts` — warned, not dropped         |

What a load run adds that those cannot: **queue depth under sustained write
load**, and whether the outbox drains faster than it fills. `plan.js` reports
it; nothing asserts it yet, because the threshold depends on hardware nobody
has provisioned.
