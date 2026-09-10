# ADR-0023: What account deletion removes, and what it keeps

- Status: Accepted
- Date: 2026-09-10
- Deciders: product owner
- Related: ADR-0022 (profile and public avatars), GoGo-BE#537, #557

## Context

`DELETE /v1/me` and `POST /v1/cms/users/{id}/delete` have always run one
implementation (`UserContentService.deleteForUser`). What that implementation
does had never been written down as a decision, so two readings of it existed at
once: the app told people it "permanently deletes your account", while the code
soft-deletes the row, nulls the personal fields, and leaves the account's
contributions in place.

A device smoke on 2026-09-10 made the gap concrete. Deleting a test account
nulled its email, password hash, display name, avatar key, home area and usual
budget, revoked every session, dropped its device tokens and push
subscriptions, and deleted the processed avatar from the public bucket. It also
left the user row, its primary key, its reviews, its saved items, its
notifications, and its room membership rows.

## Decision

Deletion is a **soft delete with a named retention list**. It:

- disables login: `status = 'deleted'`, `email` and `password_hash` nulled, so
  no credential can address the account again;
- revokes every session and removes device tokens and push subscriptions;
- clears personal profile data: display name (replaced with a fixed string),
  avatar key, home area, usual budget, and the interests row;
- deletes the processed avatar from the public bucket and purges its URL;
- deletes personal records that are not contributions: saved items,
  notifications, notification preferences;
- pseudonymizes the name on room membership rows, keeping the row so a room
  still adds up for the people left in it.

It **keeps**, deliberately:

- the technical account record (the row and its id), so foreign keys stay valid
  and the id cannot be reissued;
- reviews written by the account;
- photos contributed to a place.

Guest sessions are out of scope: a guest has no account. Expired unclaimed
guest sessions are already revoked and anonymized by the privacy sweep. No
separate deactivation feature is offered — there is one action, and it is this
one.

## Consequences

**The product must say this plainly.** Copy that promises to delete everything
is now wrong by decision, not merely imprecise. The confirmation and the
account screen name both halves: what leaves with the person, and what stays as
a contribution to GoGo.

**Store-policy risk, recorded and accepted, not resolved.** This is a risk
register entry, not a compliance claim; nobody here has confirmed either store
would accept it:

- Apple's guideline 5.1.1(v) support page asks for "the entire account record,
  along with associated personal data", and names user-generated content shared
  with others, such as reviews, as in scope. Retaining reviews and the account
  row is a deliberate divergence from that wording.
- Google Play additionally requires a **web page where deletion can be
  requested without reinstalling the app**, declared in the Play Console Data
  safety form. GoGo has no such page, and the Console declaration is unverified
  by anyone on this team.
- Neither app has been submitted under these rules, so no rejection has
  happened and none has been ruled out.

Further store-driven work is **deferred until a rejection actually occurs**.
The trigger is a review rejection or a Play Console enforcement notice; the
response would be a product decision about reviews and photos, not a change
this ADR can pre-authorize.

**Rollback.** The behaviour change is additive deletion of three personal
tables. Reverting the commit restores the previous behaviour; rows already
deleted are not recoverable from the application, only from a database restore.
