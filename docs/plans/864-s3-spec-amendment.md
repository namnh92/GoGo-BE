# BE #864 / #873 — S3 spec amendment, 2026-11-11

Authority: owner “Theo đề xuất”, `dev/policy/decisions-log.md`, entry
**2026-11-11 — BE#844 S3 (#873): vi-065 là câu hỏi về quán**.
This amendment applies to the S3 interpretation of
`dev/handoffs/sa-shape-be-844-ai-place-qa.rev3.astra.md` §§3.1 and 7.

- Keep the original intent-corpus text for vi-065:
  “Mấy giờ thì quán Highlands đóng cửa?”. It is a named-place hours question
  under §3.1.
- When `assistant.place_qa.enabled` is on, admit vi-065 to `place_qa`, with
  zero Jev/Haiku calls and zero provider-attempt rows. Resolve its explicit
  name under the existing S2 policy. The fictional Layer A catalogue has no
  Highlands, so it returns factual `not_found`, never a borrowed place.
- When the flag is off, preserve the baseline recommendation/model behavior.
- Replace §7's all-157 non-QA requirement with **the other 156 intent cases**
  remaining on their baseline path. vi-065 is the sole named exception;
  no other admission threshold or requirement changes.

Proof: the classifier spec explicitly expects vi-065 as named-place hours QA.
Layer A runs `qa-vi-065-on`, `preserve-vi-065-off` and the other 156
`preserve-vi-NNN` cases. The preservation cases run unchanged on base and head.
Execution evidence and DEV placeholders are in
[864-s3-validation.md](864-s3-validation.md). This amendment resolves authority;
it does not establish the full S4/S5 gate or enable the feature.
