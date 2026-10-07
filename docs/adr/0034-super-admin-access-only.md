# ADR-0034: The super admin signs in only through Access; other staff keep passwords

- **Status:** accepted · **amended 2026-10-07** (GoGo-BE#687 shape rev 5, owner decisions O-1…O-12;
  see _Amendment_ at the end — where the two disagree, the amendment wins)
- **Date:** 2026-10-06
- **Deciders:** product owner, backend (SA shape reviewed by SA review, one round)
- **Issue:** GoGo-BE#687
- **Related:** ADR-0032 (the switchable password door, which this narrows), ADR-0010 (CMS identity
  from Cloudflare Access), ADR-0018 (one super admin, DB authenticates)

## Context

ADR-0032 made the CMS password door a per-environment switch and closed it on DEV for every role.
On the same day that locked out the DEV `moderator` and `ops_admin` accounts, whose addresses are not
on the `cms-dev` Access allow list, and the owner rolled DEV back to `CMS_PASSWORD_LOGIN_ENABLED=true`.
DEV was single-factor again for every role, the super admin included.

The owner's intent is narrower than ADR-0032's switch. The `super_admin`, the one account with the
whole model behind it, signs in only through Access. `editor`, `moderator` and `ops_admin` are
accounts the super admin creates and gives a password, and they keep signing in with it.

## Options considered

1. **A role list, e.g. `CMS_PASSWORD_LOGIN_ROLES`.** Nothing asks for a per-role policy beyond the
   super admin. Role names in an environment variable can drift from the `admin_role` enum, and
   `methods` would have to publish role names to an unauthenticated caller.
2. **Change `methods.password` into an enum** (`none | all | non_super`). This breaks a required
   boolean that two consumers already branch on.
3. **A second boolean switch, `CMS_SUPER_ADMIN_SSO_ONLY` (default `false`)**, orthogonal to
   `CMS_PASSWORD_LOGIN_ENABLED`, and one additive fact in `methods`.

## Decision

Option 3.

| `CMS_PASSWORD_LOGIN_ENABLED` | `CMS_SUPER_ADMIN_SSO_ONLY` | super admin            | other roles          |
| ---------------------------- | -------------------------- | ---------------------- | -------------------- |
| true                         | false                      | password + SSO         | password + SSO       |
| true                         | true                       | SSO                    | password + SSO (DEV) |
| false                        | false                      | SSO                    | SSO                  |
| false                        | true                       | SSO (redundant, valid) | SSO                  |

The redundant row is accepted, not refused. Each switch is flipped and rolled back on its own.

- **No configuration has zero doors.** `CMS_SUPER_ADMIN_SSO_ONLY=true` without
  `CF_ACCESS_TEAM_DOMAIN` is refused at boot, next to ADR-0032's rule, and so by the deploy's
  `config:check` before anything is replaced.
- **The refusal comes after the account read and before the password is compared.**
  `AdminAuthService.login` answers `403 SUPER_ADMIN_SSO_ONLY` (not retryable) for the `super_admin`
  row. Its stored hash is never an oracle, so a correct and a wrong password get the same answer.
  No attempt row and no audit row are written: nothing was verified, and an unauthenticated caller
  must not write rows under that admin's id. Every other address, staff or not, goes through the
  credential check unchanged.
- **Precedence**, in the order the request meets them: `429` from the per-IP `cms.login` limit (a
  guard, before the service) → `403 PASSWORD_LOGIN_DISABLED` (general door closed) → `429` from a
  per-account lockout built by failures recorded before the flip (refusals record none, so such a
  lockout ages out and does not recur) → `403 SUPER_ADMIN_SSO_ONLY` → credential outcomes.
- **A distinct code.** `PASSWORD_LOGIN_DISABLED` tells the console the door is closed and to re-read
  `methods`. Here the door is open for everyone else, and logs need to tell "door closed" apart from
  "wrong door for this account".
- **Sessions.** With the switch on, refreshing a super admin family whose `auth_method` is not
  `access_sso` (ADR-0032; NULL counts as `password`) revokes the whole family
  (`super_admin_sso_only`) and answers `401 SESSION_REVOKED`. The role is read from the admin row
  locked by refresh. ADR-0018 keeps it from changing under a family. Other roles' password sessions
  rotate as before. After the flip, a super admin password session lives at most one access-token
  lifetime. No per-request check is added to `AdminGuard`, the same bound ADR-0032 accepted.
- **`GET /v1/cms/auth/methods` gains `superAdminSsoOnly`**, optional in the contract (alpha.70).
  The field is always sent, and older APIs omit it, which reads as false. `password` still describes
  every other role.
- ~~**Unchanged:** reset, change and TOTP endpoints; `db:seed-admin`; the super admin's stored
  password is the credential of the rollback door.~~ Superseded by the amendment (D-3, D-4).
- ~~**Production is unchanged.**~~ Superseded: staging and production require the switch on (D-8).

### Bootstrap address rule (extends ADR-0032 and ADR-0018) — superseded by D-2/D-3 below

Whenever either switch closes the super admin's password door (`CMS_PASSWORD_LOGIN_ENABLED=false`
or `CMS_SUPER_ADMIN_SSO_ONLY=true`), the super admin's `admin_users.email` and
`cms/seed-admin-email` must be addresses the Access policy admits. Change that address (the audited
`PATCH /v1/cms/auth/admins/{id}`, #681) or re-seed it only while both switches leave its password
door open. To recover from a wrong binding, set `CMS_SUPER_ADMIN_SSO_ONLY=false` **and**
`CMS_PASSWORD_LOGIN_ENABLED=true`, redeploy, and check that the super admin's password login answers 201. Then correct the address and restore the intended values. Turning off only the first switch does
not help while the general door is closed.

## Consequences

- On DEV the super admin's password is no longer a door from the internet. `editor`, `moderator`
  and `ops_admin` remain single-factor from the internet (`DEV_TOTP_CODE` is accepted outside
  production, and TOTP is optional). The mitigations are Argon2id, the per-account lockout, the
  per-IP limit and forced change of temporary passwords. Real TOTP outside production is tracked
  separately (GoGo-BE#688), and the owner decides on it.
- Anyone who types the super admin's address learns that it is the super admin's: it gets a 403,
  not a 401, and no Argon2 delay. The owner accepted this.
- An Access outage makes the browser console unreachable for every role, because `cms-<env>` sits
  behind Access. Other roles keep their API and script door. The super admin has none while the
  switch is on, and once the deploy-time sync has erased its hash (amendment, D-3) there is no
  password to re-open: recovery waits for Access (O-1).
- `superAdminSsoOnly: true` means the API refuses that account's password. It does not mean that
  Access is healthy.

## Migration & rollback

There is no migration: `auth_method` (0071) and the free-text `revoke_reason` already carry what is
needed.

Rollout: API with this change → console that renders the fact → Infra manifest row → prove an SSO
session authorises a super-admin request on those revisions → only then
`cms/super-admin-sso-only=true` in SSM.

Rollback: ~~set `CMS_SUPER_ADMIN_SSO_ONLY=false` and redeploy~~ — superseded (amendment, O-1). Before
the hash is erased, turning the switch off re-opens the password door on DEV only (staging and
production refuse `false`, D-8). After it is erased there is nothing to re-open: every way out is
Access SSO plus SSM → `terraform-apply-<env>` → deploy (GoGo-Infra `docs/secrets.md`).

While SSM holds `true`, three floors apply. Crossing any of them is a rollback of this decision:

- **API below this change.** An older API ignores the variable and silently re-opens the super
  admin's password door.
- **Infra manifest below the row for `cms/super-admin-sso-only`.** The deploy renders the env from
  the manifest it runs with. Without the row, the variable is not rendered and even this API reads
  `false`.
- **CMS below ADR-0032's first build that reads `methods`.** That build has no SSO button, so the
  super admin is left with a form that refuses. Re-open and verify the password door before going
  below it.

## Amendment (2026-10-07, GoGo-BE#687 shape rev 5)

The owner widened the decision (O-1…O-12). Built in stages — BE-a (this switch), BE-b (the row
follows SSM), BE-c (the Access assertion replaces TOTP on the password door), BE-c2 (TOTP columns
dropped) — and the Infra work in GoGo-Infra#194/#196/#199. The shape file
`dev/handoffs/sa-shape-GoGo-BE-687.fable.md` (workspace) is the detailed record.

- **D-2 · One super admin, address from SSM.** `CMS_SUPER_ADMIN_EMAIL`, rendered from
  `cms/super-admin-email`, is the only source of the super admin's address. The staff allow list is
  `cms/access-staff-emails`, read by Terraform only. `cms/seed-admin-*` and `db:seed-admin` are
  retired.
- **D-3 · The row follows SSM at deploy.** `cms:sync-super-admin` runs in the migrate container after
  migrations: insert when absent, update the address and revoke its sessions when SSM moved, refuse
  when the SSM address belongs to a staff row. The password hash is erased only when the switch is
  on **and** an `admin.sso_confirmed` audit row exists for the current address (written by
  `POST /v1/cms/auth/super-admin/confirm-sso` from an Access session). Revocation truth is the
  database: `AdminGuard` reads `admin_sessions.revoked_at` for the token's session. The API refuses
  to change the super admin's address (`409 SUPER_ADMIN_EMAIL_FROM_SSM`) and, with the switch on,
  refuses reset, change and temporary password for it (`403 SUPER_ADMIN_SSO_ONLY`).
  The API re-runs the erase gate at boot (review F-05), because the previous process could still
  serve a reset between the sync and its own shutdown. That run is a start condition, not
  best-effort: a database error is retried six times (15.5 s of backoff in all); no `super_admin`
  row, a row at another address than `CMS_SUPER_ADMIN_EMAIL`, or an exhausted retry rejects the
  bootstrap hook, so the process never listens and the deploy's health wait fails. `pending` (no
  confirmation yet) starts. Its `admin.password_erased` row carries `GOGO_REVISION`, which the
  deploy exports on every `up -d` that starts the API as well as on `run --rm migrate` (F-06).
- **D-4 · Cloudflare carries the second factor.** CMS TOTP is removed; the password door requires a
  verified Access assertion for the same mailbox (BE-c).
- **D-7 · Doors.** super_admin: Access exchange only. editor/moderator/ops_admin: Access exchange,
  or password plus the matching Access assertion. A direct call to `api-<env>` without an assertion
  is refused.
- **D-8 · Staging and production.** `APP_ENV` staging, `prod` or `production` requires
  `CMS_SUPER_ADMIN_SSO_ONLY=true` and `CF_ACCESS_*` (config check fails otherwise; built in BE-a).
  Access requires MFA there (`require_mfa`, GoGo-Infra#199); one-time PIN does not satisfy it.
- **Recovery (O-1, owner 2026-10-07).** There is no password break-glass for the super admin. Every
  way out is Access SSO plus SSM → `terraform-apply-<env>` → deploy; the address-change overlap and
  recovery table live in GoGo-Infra `docs/secrets.md`.
