# ADR-0039: Consumer registration password policy

Status: Accepted by owner decision, 2026-11-06 (GoGo-MobileApp#482, S56).

The re-design owner requires registration passwords of at least eight
characters with uppercase, lowercase, digit and special characters. Apply
the policy only when setting a consumer password, never when authenticating
an existing account. Registration is the only current consumer setter;
consumer password reset/change and admin-created consumers are not implemented.
CMS staff credentials remain under their separate policy.

Use 8–128 UTF-16 code units, Unicode Lu/Ll for case, ASCII 0–9 for digits,
and characters outside Unicode L/N/M for specials. This accepts Vietnamese
letters from phone keyboards in either composed or decomposed input; a
combining mark alone cannot satisfy the special-character requirement.
Whitespace and emoji qualify as specials. Do not trim or normalize passwords.
Keep the existing login length semantics so every newly accepted password can
also pass unchanged login validation. Supplementary characters use two units;
decomposed combining marks also count individually toward length.

Reuse `VALIDATION_FAILED` with `field_errors[].field = password`, without
returning or logging the password. The shared exported consumer password
schema is used by registration and is the policy for future consumer setters.
Hashing and verification remain policy-independent because CMS shares the
password service and legacy consumer credentials must continue to authenticate.

Composition withdraws a published registration guarantee, even though the
minimum length decreases from 10 to 8. Bump the contract MAJOR from
4.0.0-alpha.10 to 5.0.0-alpha.1, regenerate artifacts, and notify consumers
through the contract changelog. Clients must align sign-up hints and validation;
login requires no client migration. No stored credential migration is needed.
