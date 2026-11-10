Owner 2026-11-10: "Phần quên mật khẩu làm luôn đi".

Amendment GoGo-BE#835, owner 2026-11-10 (decisions-log): "Bỏ câu phụ tài khoản đủ điều kiện. Cứ báo tài khoản không tồn tại như các app khác thôi. Khi tài khoản đủ điều kiện thì chuyển màn input mã".

BE contract 9.2.0-alpha.1 (implementation pending gates/DEV rollout):
`POST /v1/auth/password-recovery/request` {email} → 202 + challengeId,
expiresAt, resendAvailableAt for active password accounts (including unverified email).
Missing/passwordless/disabled/deleted → identical 404 `RECOVERY_ACCOUNT_NOT_FOUND`,
retryable=false, message `Tài khoản không tồn tại`; no specific reason.
Quotas include 404/replays: 1/minute + 3/hour/email, 10/minute + 50/hour/IP;
429 honors Retry-After. 503 `RECOVERY_MAIL_NOT_CONFIGURED` or `RECOVERY_UNAVAILABLE`
remains a visible error. Existing eligible idempotency semantics remain.
`POST /v1/auth/password-recovery/complete` {email, challengeId, code(6 digits), password}
→ 204, revokes all sessions, issues no new session; 400 `RECOVERY_INVALID`.

Stitch (Approved Redesign 17315762413421369447): "Quên mật khẩu - GoGo" (9c9a8c32…)
and "Đặt lại mật khẩu - GoGo" (87fdbe76…), Light; Dark follows approved tokens.

AC:

- Login: "Quên?" opens recovery, replacing UnavailableAction.
- Remove the eligibility disclaimer. Email → Gửi mã with button loading;
  only HTTP 202 navigates to code/password input. HTTP 404 stays on email and
  displays `Tài khoản không tồn tại`, without retry or a reason-specific message.
- Show "Mã hết hạn sau 5 phút." and "Quay lại đăng nhập".
- Reset: six labeled code cells, supports pasting all digits; masked email;
  resend countdown 60s then enable; password visibility toggle and existing
  PasswordRequirements five-condition checklist. Successful reset returns to
  login with password-changed feedback.
- 429 waits for Retry-After, 503 displays configuration/outage error, invalid
  proof displays incorrect/expired code; handle offline. No fake success.
- Sync/vend OpenAPI 9.2.0-alpha.1 and regenerate client types.
- vi/en, Light/Dark, accessibility, tests for 202 navigation, identical 404
  behavior, 429/503/invalid proof/offline, and owner simulator acceptance.

The 202/404 split intentionally discloses recovery eligibility; owner accepts
this risk in BE ADR-0041. No distinction among ineligibility reasons.

Refs namnh92/GoGo-BE#772, namnh92/GoGo-BE#777, namnh92/GoGo-BE#835
