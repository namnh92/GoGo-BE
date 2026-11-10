# GoGo-BE#837 — Recovery email presentation

Preview: [recovery-mail-vi.html](recovery-mail-vi.html), rendered from the pure
`renderRecoveryMail` template with synthetic code `482913` and fixed expiry
`2026-11-10T08:01:00.000Z` → `15:01, 10/11/2026 (giờ Việt Nam)`.
No real recipient, challenge or account data is included.

## Local verification — 2026-11-10

- `pnpm format`: PASS; no unrelated formatter changes.
- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS, all 8 packages. Turbo emitted sandbox cache IO warnings;
  TypeScript checks completed successfully.
- `pnpm exec vitest run --project unit libs/modules/identity apps/api/test/password-recovery-http.spec.ts`:
  PASS, 18 files / 222 tests.
- Focused Prettier check for the changed sender, template, specs, ADR and preview:
  PASS.

Tests cover both SES Simple body alternatives and subjects (vi default / en),
Vietnam expiry and year rollover, shared visible text, hidden preheader without
the code, HTML escaping, no URLs/images/links, no account/challenge identifiers,
WCAG AA contrast ≥4.5:1 for every text/background pair, decoy suppression,
configuration failures and sanitized provider errors. SDK options stay unchanged.

The original sender used only `Body.Text` and `expiresAt.toISOString()` with a UTC
label; source inspection establishes the pre-change gap. No git command was run.
No API contract, IAM policy, telemetry or delivery-lifecycle changes were made.

## DEV acceptance — NOT RUN

This worktree session has no SES sender/region/configuration-set or access-key
pair in its process environment; only an AWS profile is present. ADR-0041 requires
the deployed DEV credential configuration. Owner mailbox and the approved DEV
access route have been requested. No real email has been sent from this patch.

After rollout containing this template, request a recovery email for the owner
through DEV and record the build identity. Verify the subject, code, Vietnam
expiry, safety copy and footer in Gmail Light and Dark, and capture both views.
Inspect the received message's original headers for SPF/DKIM/DMARC PASS and MIME
`multipart/alternative` with HTML and text parts. The owner's earlier PASS result
predates this patch and is not acceptance evidence for this template. The light
color-scheme metadata and opaque fills are safeguards; local contrast checks do
not establish Gmail's actual dark-mode rendering.
