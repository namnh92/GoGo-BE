# ADR-0032: The CMS password door is switchable; DEV is Access-only

- **Status:** accepted
- **Date:** 2026-10-06
- **Deciders:** product owner, backend (SA shape reviewed by SA review, two rounds)
- **Issue:** GoGo-BE#679 (split from GoGo-Infra#154)
- **Related:** ADR-0010 (CMS identity from Cloudflare Access), ADR-0018 (one super admin, DB authenticates)

## Context

`/v1/cms/*` on the API host answers the internet directly. ADR-0010 explains why it cannot sit
behind Access: mobile and web share the host. Only `cms-<env>` is behind Access. Outside
production, MFA is optional and `DEV_TOTP_CODE` is accepted, so `POST /v1/cms/auth/login` on DEV is
a single-factor door into the console from anywhere. GoGo-Infra#154 found the super admin using it
with a guessable password. The password was rotated, but the door stayed open.

Owner decision 2026-10-06: sign-in to the DEV CMS goes through Cloudflare Access
(`access-exchange`, ADR-0010), and password sign-in is turned off on DEV.

## Options considered

1. **Derive from `APP_ENV`.** This hides policy inside a branch on the environment name, and
   staging or local would need a code change to behave differently.
2. **"Access configured ⇒ password refused".** Writing `CF_ACCESS_*` would close the password door
   in the same deploy, before any console could use the exchange: a self-lockout. Production
   requires `CF_ACCESS_*`, so this would also silently remove its break-glass door.
3. **A separate flag, `CMS_PASSWORD_LOGIN_ENABLED` (default `true`).** Turning Access on and
   turning the password off become two deploys, with an observation between them. Rollback is one
   value.

## Decision

Option 3.

- **No configuration has zero doors.** Every environment refuses `CMS_PASSWORD_LOGIN_ENABLED=false`
  without `CF_ACCESS_TEAM_DOMAIN`. GoGo-Infra's deploy runs `config:check` before it replaces
  anything, so a bad value keeps the previous revision serving.
- **A closed door says so first.** `AdminAuthService.login` answers `403 PASSWORD_LOGIN_DISABLED`
  (not retryable) before the lockout count, the account read, or the attempt record. A correct
  password and a wrong one get the same answer. No lockout row or audit row is written, because no
  credential was checked and there is no actor.
- **Sessions remember their door.** `refresh` slides `expires_at` forward, so a session opened by
  password before the flip would otherwise live for as long as it is used. `admin_sessions.auth_method`
  (`password | access_sso`; NULL predates the column and counts as `password`) is set when the
  session opens and inherited on rotation. With the flag off, refreshing a non-SSO family revokes the
  whole family (`password_login_disabled`) and answers `401 SESSION_REVOKED`. After the flip, such a
  session outlives the decision by at most one access-token lifetime.
- **The console asks which doors exist at runtime.** `GET /v1/cms/auth/methods` returns
  `{ password, accessSso }`. These are facts, not copy, and are not cached. A CMS build flag was
  rejected: it can drift from the API, and rolling back would then need a CMS deploy from someone who
  may be locked out of the console.
- **The exchange refuses cross-origin browser requests.** It is `@Public`, so the CSRF double-submit
  does not cover it. A request carrying `Sec-Fetch-Site` with any value other than `same-origin` is
  answered `403 CROSS_SITE_REQUEST` before any verification. Callers that send no such header pass:
  these are scripts presenting an assertion they hold themselves.
- **Unchanged:** password reset, change, TOTP and account creation (none of them issues a session),
  `db:seed-admin`, and the stored hashes. The stored password is the credential for the rollback door.
- **Production is unchanged.** The flag stays `true` there, and password plus mandatory TOTP remains
  ADR-0010's break-glass door. Making production Access-only needs its own owner decision.
- **Machine callers use a person's assertion** (`cloudflared access token -app=…`). Service tokens
  are still refused, because the exchange requires `email` (ADR-0010).

### Bootstrap address rule (amends ADR-0018)

Once the password door is off, the exchange joins on `lower(admin_users.email)`, and that column is
the credential binding. In any environment where the door is off, the super admin's bootstrap
address in SSM must be an address the Access policy admits, or the `super_admin` role becomes
unreachable. Changing the address of an existing row is an audited API act (tracked separately,
GoGo-BE issue for the email change), never a SQL edit.

## Consequences

- The DEV console is reachable only by people on the `cms-dev` Access allow list who also hold an
  active `admin_users` row.
- If Access or its identity provider has an outage, the browser console is unreachable whatever the
  flag says, because `cms-<env>` itself sits behind Access. Re-opening the password door restores API
  and script access only.
- `accessSso: true` means Access is configured. It does not mean Access is healthy.
- An agent cannot sign in on its own while the owner's Access session has expired. Script actions
  are audited under the person whose assertion was used.
- Every refusal (login, and refresh of a password-born session) logs a warning with no email or IP.
  Boot logs one line when the door is closed.

## Migration & rollback

Migration `0071` adds a nullable column with no table rewrite and a bounded lock wait. Its check
constraint is added `NOT VALID`, so no scan of existing rows happens under the exclusive lock (every
existing row is NULL, which satisfies it). An older API ignores the column, so keep it on rollback.

Rollout order (each step leaves a working door): API with this change → CMS that reads `methods` →
`CF_ACCESS_*` in SSM → observe an SSO session authorise a super-admin request → only then
`cms/password-login-enabled=false` in SSM.

Rollback:

- **Re-open the door:** set `CMS_PASSWORD_LOGIN_ENABLED=true` and redeploy the API. This is one
  action, and it needs neither a CMS deploy nor a console session. Families already revoked stay
  revoked.
- **Rolling back the API below this change while SSM holds `false`** silently re-opens the password
  door, because an older API ignores the flag. Record it as a rollback of this decision.
- **Rolling back the CMS below the first build that reads `methods` while the door is closed**
  leaves the console with a password form only. Re-open the door first, then roll back.
