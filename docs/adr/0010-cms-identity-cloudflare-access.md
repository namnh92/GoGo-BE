# ADR-0010 — CMS identity comes from Cloudflare Access

- **Status:** Accepted
- **Date:** 2026-08-31
- **Issue:** GoGo-BE#62 (CMS-001)
- **Supersedes:** nothing. Extends ADR-0003 (auth token model) with a second
  door onto the same session model.

## Context

`.claude/rules/security.md` requires SSO plus MFA for the CMS in production,
and a shorter session than the consumer app. Today the console has password +
TOTP: real MFA, but no central identity. Offboarding means remembering to
suspend a row in `admin_users`, one environment at a time, and nothing outside
this repository knows the account exists.

That is the gap SSO closes, and it is worth being precise about which one it
closes. TOTP already gives a second factor. What it does not give is **one
place where a person stops being staff** — the thing you want to be true within
minutes of somebody leaving, without an engineer running a query.

Four options were considered.

|                       | Cost                                                                                                                                                  | Already in the stack                                                                            | MFA                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------- |
| **Cloudflare Access** | Free to 50 users                                                                                                                                      | **Yes** — `terraform/modules/cloudflare-cms-hosting` already creates the application and policy | From the upstream provider |
| Google Workspace OIDC | Needs paid Workspace; the team's addresses are personal `gmail.com`, so the `hd` claim cannot restrict anything                                       | No                                                                                              | Yes                        |
| Microsoft Entra ID    | Free tier exists; needs an Azure tenant                                                                                                               | No                                                                                              | Yes                        |
| Keycloak              | No licence cost, but we operate it: another service, another backup, another patch cycle, and it becomes a single point of failure for console access | No                                                                                              | Configurable               |

The last three all mean introducing an identity provider for a system with four
roles and a handful of staff. Access is already deployed, already in Terraform,
already fronting `cms-*.gogo.id.vn`, and federates Google, GitHub or a one-time
PIN itself.

## Decision

**Cloudflare Access is the identity provider for the CMS.** GoGo-BE accepts a
verified Access assertion as proof of _who_, and remains the sole authority on
_what that person may do_.

Shape:

```
browser → cms-<env>.gogo.id.vn        Access gate: upstream IdP + MFA
        → CMS Worker                  serves the SPA, proxies /v1/*
        → api-<env>.gogo.id.vn        BE verifies Cf-Access-Jwt-Assertion
        → POST /v1/cms/auth/access-exchange → ordinary admin session
```

`POST /v1/cms/auth/access-exchange` verifies the assertion and issues the same
session as `cmsLogin`: same cookies, same rotating refresh, same revocation
family, same 8-hour lifetime.

### Why an exchange, and not per-request header trust

Trusting the header on every request would put Cloudflare's session in charge
of ours. An admin suspended in the console would keep working until Access's
own session expired, because nothing of ours would be in the loop — and
`logout`, `logout --all-devices` and the refresh-reuse family revoke would all
apply to a session model that path never enters. One exchange point keeps
`AdminGuard`, the audit trail and session revocation exactly as they are.

### What is verified, and why each check is load-bearing

`api-<env>.gogo.id.vn` answers the internet directly. It is not behind Access
and cannot be — the mobile and web clients talk to it too. So
`Cf-Access-Jwt-Assertion` is an ordinary request header that anyone can set.
**The signature is the entire control.** Trusting the header's presence, or
reading the plaintext `Cf-Access-Authenticated-User-Email` that Access also
sends, would let any caller on the internet name themselves any admin.

| Check                                                | Dropping it means                                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| RS256 signature against the team's published key set | anyone forges any identity                                                                                                                         |
| `aud` equals this application's tag                  | a token minted for the cheapest app in the same Cloudflare account opens the console — Access signs every application in a team with the same keys |
| `iss` equals this team's domain                      | somebody else's Cloudflare tenant can mint staff                                                                                                   |
| `exp` / `nbf`                                        | a captured assertion works forever                                                                                                                 |
| `alg` screened before key selection                  | `alg: none` and the RS256→HS256 confusion attack                                                                                                   |
| `email` present                                      | a service token — `common_name`, no address — opens a session whose audit rows name a person who did nothing                                       |

All rejections return one code, `ACCESS_ASSERTION_INVALID`. The caller cannot
act on the difference, and telling signature from audience from expiry is a
probing aid.

### What Access does _not_ decide

**Authorization.** `.claude/rules/core.md` #5 is unchanged: `AdminGuard`
re-reads the `admin_users` row on every request and decides from it. Access
answers "who", never "may they".

**Membership.** A verified assertion is not an account. The Access allow-list
and `admin_users` answer different questions, and are maintained by different
people; auto-provisioning would mean anyone added to an Access policy silently
becomes staff with a role nobody chose. An unknown identity gets 403
`ADMIN_ONLY`.

### What is kept

**Password + TOTP stays.** It is the way in when Access or its upstream
provider is unavailable, and it remains the second factor for `super_admin`.
Two doors onto one session model, not a migration.

### Session lifetime

Already satisfied, and now aligned end to end: `AUTH_ADMIN_REFRESH_TTL_SECONDS`
is 8 hours against 30 days for the consumer refresh, and the Access application
is created with `session_duration = "8h"`. One shift, two layers, same number.

## Consequences

- Production will not boot without `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`
  (`APP_ENV=prod`), because the security rule says SSO is required there. The
  check is on `APP_ENV`, not `NODE_ENV` — every deployed environment runs the
  production build, the mistake fixed in #215/#216.
- Setting one of the two variables without the other fails validation in every
  environment: a team domain alone accepts assertions minted for any other
  application in the account.
- Where they are empty, the endpoint answers 503 `ACCESS_SSO_NOT_CONFIGURED`
  (not retryable) rather than 404. A control that exists but is not configured
  should say so; see `.claude/rules/core.md` #16.
- One outbound dependency on `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  cached an hour, with a one-minute floor between fetches triggered by an
  unknown `kid`. Without that floor, an endpoint that accepts unauthenticated
  input by design is a free amplifier: one request to Cloudflare per forged
  token. Cost of the floor: during a key rotation, up to a minute of rejected
  SSO sign-ins, while password + TOTP keeps working.
- An empty or unreachable key set never overwrites the cache — a momentary bad
  response must not become a sign-in outage that outlives it.
- `admin.login.sso` is a distinct audit action from `admin.login`. Which door
  someone came through is the first question in an incident review and is
  unrecoverable if both write the same row.

### Owned elsewhere

Cloudflare Access itself is GoGo-Infra's: the application, the policy, and the
upstream identity provider are Terraform in
`terraform/modules/cloudflare-cms-hosting`. Two things are needed there before
this is live:

1. Replace the one-time-PIN policy with a real identity provider
   (`cloudflare_zero_trust_access_identity_provider`). The PIN was always
   labelled a stopgap in that module.
2. Publish the application's audience tag and the team domain into SSM so
   deployments receive them like any other configuration.

Until then this code path is present, tested, and answers 503 in every
environment — which is the honest state, not a hidden one.

## Rollback

Clear `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` outside production. The
endpoint starts answering 503, password + TOTP is unaffected, and existing
sessions — issued through either door — keep working until they expire. No
migration, no schema change, nothing to undo in the database.
