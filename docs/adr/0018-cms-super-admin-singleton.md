# ADR-0018: One CMS super admin per environment, authenticated by the database

- **Status:** accepted
- **Date:** 2026-09-06
- **Deciders:** product owner, backend, platform
- **Issue:** DB-012 (GoGo-BE #442), INF-069 (GoGo-Infra #144)
- **Related:** GoGo-Infra ADR-0008 (where the bootstrap credentials live),
  ADR-0010 (CMS identity and Cloudflare Access)

## Context

The demo seed created the first CMS `super_admin` from credentials written into
`libs/database/src/seed.ts`, with a literal fallback that applied to every
environment that did not override it. GoGo-BE #442 removed the fallback and split
bootstrap into its own entrypoint; GoGo-Infra #144 put per-environment values in
SSM and delivered them to that one command.

That left one question open, and it is the whole of this ADR: **what is the
authentication source for the CMS super admin, and how many of them are there.**

Two answers were on the table.

The first — explored on this branch and rejected — made SSM authoritative for
login: the API would read the parameter on each expiry of a short TTL cache,
compare the submitted password against it, and keep an `admin_users` row only as
a projection for sessions and audit references, with `password_hash` NULL. It has
one real attraction: a rotation takes effect without a deploy and without anyone
holding a console session.

It also has costs that do not shrink with care:

- **The credential exists in a readable form.** An Argon2id hash cannot be turned
  back into a password. A SecureString can, by anyone holding
  `ssm:GetParameter` + `kms:Decrypt` on that path — which is the deploy role and
  the developer role today.
- **Login gains a network dependency on AWS.** The one account that recovers a
  broken console stops working when SSM is unreachable, and failing closed (the
  only safe choice) means the outage takes the console with it.
- **A rotation leaves no trace anyone can review.** Editing a parameter is not
  authenticated as a person, is not in the audit log, and revokes no session, so
  the sessions opened under the old password keep working.
- **The runtime grows an AWS SDK dependency and AWS credentials** for one login
  path, in the process that faces the internet.

The second answer is the ordinary one: the database authenticates every CMS
account, including this one, and SSM holds the credential the account is created
from.

## Options considered

1. **SSM as the live authentication source** (TTL cache, no stored hash).
   Rotation without a deploy; a readable credential, a runtime AWS dependency on
   the login path, and rotation with no audit trail and no session revocation.
2. **Database as the authentication source, SSM for bootstrap only.** One
   authentication path for every account; rotation is an authenticated, audited,
   session-revoking action; the credential exists in readable form only in the
   window between provisioning and first login. Changing the parameter afterwards
   does nothing, which has to be stated plainly or someone will change it and
   expect a rotation.
3. **Neither — go straight to SSO/MFA for the super admin.** Correct destination
   (ADR-0010, #62), and no help at all for bootstrapping the very first account
   on a fresh environment, which is what this decision is about.

## Decision

**Each CMS environment has exactly one `super_admin`, and the database is the
authentication source for it.**

Stated precisely, because the invariant has two phases and only the second one
is "exactly one":

| Phase            | Invariant                                                   | Held by                                                                                       |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Before bootstrap | **At most one** — an environment may legitimately have none | the partial unique index                                                                      |
| After bootstrap  | **Exactly one** — the account exists and cannot be removed  | the index, plus bootstrap creating it and no mutation path being able to demote or suspend it |

The transition happens once, in `seed-admin.ts`, and is one-way: nothing in the
API or the schema can take an environment back to zero. Writing the lower bound
as a constraint is not possible — a database has no super admin until it is
bootstrapped, and a constraint refusing an empty table refuses the migration
that creates it.

- `admin_users.password_hash` holds an Argon2id hash. Login is the same path as
  every other CMS account; there is no second path and no provider call.
- **SSM stores initial bootstrap credentials only.**
  `/gogo/<env>/backend/cms/seed-admin-{email,password}` is what
  `libs/database/src/seed-admin.ts` reads once. **Changing the SSM values does
  not change how the account signs in**, and is not a rotation.
- **Bootstrap never overwrites an existing account.** An existing row keeps its
  hash, its role and its status. A bootstrap run against an environment that
  already has a super admin under a different address is refused, not applied.
- **Password rotation goes through account management**, and the two routes
  differ in exactly one respect, deliberately:

  | Route                                          | Sessions                                                                            | Why                                                                                                                                                                                                                                                                          |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `POST /v1/cms/auth/change-password`            | **the initiating session survives; every other session of that account is revoked** | the person rotating is authenticated right now and is still working. Signing them out of the tab they just used would make a routine rotation feel like a failure, and a rotation is also how someone responds to a suspected compromise — so every _other_ session must end |
  | `POST /v1/cms/auth/admins/{id}/reset-password` | **every session of the subject is revoked, without exception**                      | a reset happens because control of the account is in doubt; there is no session worth keeping, and the actor is someone else                                                                                                                                                 |

  Both authenticate the actor and write an audit row (`admin.password_changed`,
  `admin.password_reset`). Neither is reachable by editing SSM, which is the
  point: the audit row and the revocation are what make a rotation reviewable.

- **At most one before bootstrap, exactly one after — enforced at the API and at
  the database.** `AdminAuthService` refuses to create or grant the role
  (`SUPER_ADMIN_SINGLETON`, 409) and refuses to demote or suspend the holder
  (`LAST_SUPER_ADMIN`, 409); the database carries a partial unique index
  `admin_users_single_super_admin`, which is the upper bound for every writer
  including a psql session.

  The request enum still lists `super_admin`. Removing a value a client sends
  today is a breaking contract change, and GoGo-CMS renders its role dropdowns
  from exactly this enum (GoGo-CMS#142) — so the console is fixed first, and the
  enum narrows after, as its own deliberate breaking change. The refusal is not
  weaker for being a 409 rather than a 400: it sits in the layer every caller
  goes through, rather than in the one a script can skip.

- **Everything else is the super admin's job.** All other CMS accounts are
  created and managed by it. Creating or promoting a second super admin is
  prohibited.
- **Unchanged:** production still requires SSO/MFA (`MFA_SETUP_REQUIRED`,
  ADR-0010), and the demo seed still creates no account in any environment.

This supersedes the earlier direction in which the super admin authenticated
directly against SSM. No part of it shipped.

## Consequences

- One authentication path to reason about, test and rate-limit. The account
  lockout, the MFA gate and the `mustChangePassword` wall apply to the super
  admin exactly as they do to everyone else.
- The API needs no AWS identity and no AWS SDK; SSM is read by a human running
  one command, not by an internet-facing process.
- **A parameter edit is inert.** Anyone expecting SSM to be a rotation knob will
  be wrong, so the README, the ADR, the command's own output and the OpenAPI
  description all say it in the same words.
- The bootstrap value is a real credential for exactly as long as it takes to log
  in with it and rotate. Until then it is readable by every principal holding the
  backend SSM prefix. **The DEV value predates this work and is unrotated** —
  it is the literal that lived in this repository's source and remains in its
  history. Rotating it is a required follow-up, through the account-management
  flow above; GoGo-Infra `docs/secrets.md` carries the register entry.
- Losing the super admin's password with no session open means issuing a new hash
  against the database. That is the same recovery this system has always had, and
  it is now the only one: SSM cannot be edited to get back in.
- Until the enum narrows, the console can still _offer_ a role the server
  refuses — a dead control by `.claude/rules/core.md` #16, raised as GoGo-CMS#142
  rather than left for someone to find. The alternative was to break that console
  in the same merge.
- `#248`'s "last super admin" guard becomes structural rather than a count. It
  used to ask whether another active `super_admin` existed; there can never be
  one, so the check is now a direct refusal with the same error code.
- Integration tests share one `super_admin` fixture per database, because the
  database refuses a second. The rules that can only be reached below HTTP —
  demotion, suspension, promotion — are tested against `AdminAuthService`
  directly, since reaching them over HTTP would require the second super admin
  that cannot exist.

## Migration & rollback

`migrations/0050_cms-single-super-admin.sql` demotes and suspends any surplus
`super_admin` (oldest by `created_at` is kept, nothing is deleted — audit and
moderation rows reference these ids) and creates the partial unique index. It
touches no password hash, no session and no MFA enrolment; on every environment
today it demotes nothing, because none has more than one.

Rollback is `drop index admin_users_single_super_admin` plus reverting the
service and schema changes. Accounts stay as they are. Do not restore a
source-defined credential and do not restore the SSM-authenticated login path:
the first was the defect #442 removed, and the second never shipped.
