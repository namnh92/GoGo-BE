# GoGo-BE#801 — Tái dùng resolution token, không nâng SKU

Worktree `be-801`, branch `bugfix/GOGO-801-snapshot-facts`, base HEAD
`44bc0c84`, PR #813. Owner 2026-11-08: fallback vẫn `core`/Pro; không
commit/push, không sửa Mobile hoặc Infra.

## Nguyên nhân và giới hạn bằng chứng

[DEV evidence](https://github.com/namnh92/GoGo-BE/issues/801#issuecomment-6721215220)
ghi nhận submission `0d157036-203c-437c-bb24-9aefb5f5c4b3` lúc
`2026-11-08T11:56:51Z`: preview đủ ảnh, 4.4/376 và giờ; snapshot có
rating null/count 0/hours rỗng. Các giá trị đó đúng với nhánh fallback core,
nhưng evidence không có response token, payload submit hay metric runtime.
Không suy ra token đã được phát rồi bị Mobile bỏ chỉ từ snapshot.

**Đã xác định một lỗi activation trong đường deploy thông thường:**

- `GoGo-Infra/config/secrets.manifest.yml:1048` ghi quyết định park ngày
  2026-10-29 (#308); `:1070–1074` đánh dấu
  `places/resolution-attestation-secret` / `PLACE_RESOLUTION_ATTESTATION_SECRET`
  là `parked`. TTL cũng parked ở `:1080–1084`. Đối chiếu cả local và
  [Infra develop](https://github.com/namnh92/GoGo-Infra/blob/develop/config/secrets.manifest.yml).
- `GoGo-Infra/scripts/lib/manifest.py:979` bỏ parked rows. Deploy
  `scripts/deploy/render-env.sh:104` và local `scripts/secrets/pull.sh:106`
  dùng reader không có `--include-parked`: secret **không vào runtime env**,
  kể cả khi SSM đã có parameter. Đã chạy reader, không đọc giá trị secret:

  ```sh
  python3 scripts/lib/manifest.py dev --namespace backend --consumer runtime --field lifecycle
  python3 scripts/lib/manifest.py dev --namespace backend --consumer runtime --include-parked --field lifecycle
  ```

  Lệnh thứ nhất không có hai resolution rows; lệnh thứ hai trả cả hai là
  `parked`.

- `apps/api/src/config/env.ts:538` mặc định secret rỗng.
  `place-submission.service.ts:586` vì vậy trả full preview **không token**,
  emit `place_resolution_attestation_total{result="unconfigured"}`.
  Submit không token đi qua `:698` rồi core fallback `:865`; facts đầy đủ
  không có để snapshot. Nâng fallback lên Enterprise chỉ che lỗi activation.

Đây là nguyên nhân tái lập được ở deployment pipeline; **chưa xác minh env/metric
của container DEV tại thời điểm incident**, nên chưa khẳng định là nguyên nhân
duy nhất của submission lịch sử. Cần Claude kiểm tra secret có/không trong
runtime (chỉ boolean), flag override và counter `unconfigured`/`disabled`
theo cửa sổ request; không in secret/token/payload. Không tự bật lại nhóm
parked hay sinh fallback secret trong BE.

## BE trace

- `libs/modules/shared/feature-flags.ts:115`: attestation mặc định **true**;
  override false vẫn là rollback. `env.ts:548`: TTL mặc định 600 giây,
  bounds 60–3600. Không kéo dài TTL cho nháp 30 ngày.
- `domain/resolution-attestation.ts`: HMAC bind purpose/version/Place ID,
  verifiedAt/expiresAt và resolutionId. Không bind user/session/link/room;
  resolve public. Submit vẫn kiểm tra quyền actor/room và identity độc lập.
- `place-submission.service.ts:582`: mint chỉ khi secret có, flag bật,
  provider `OPERATIONAL`; record không ghi được trả 503. DB-first/candidate
  selection/closed preview không tự mint token. Legacy identity-only token
  hợp lệ không có display snapshot, giữ tương thích.
- `:694`: token không gửi, secret rỗng hoặc flag tắt mới dùng fallback.
  Token sai/hết hạn/sai Place ID/mất snapshot khi feature bật trả
  `RESOLUTION_TOKEN_INVALID`; không tự thêm Google call.
- `presentation/ingestion.controller.ts:112` forward token, cùng endpoint
  POST `/place-submissions` nhận wizard enrichment. Không có endpoint
  submit-from-draft riêng. Save/read draft không mua Google và không lưu token
  (`contribution-drafts.service.ts:20`, `:77`); client gửi enrichment đã đọc
  và proof còn hạn trên POST submission.
- Snapshot không chứa Google photo ref/URL/bytes. List/detail dựng lazy BFF
  proxy reference (`domain/submission-display-snapshot.ts:67`); Google photos
  không phải user uploads, nên `place_submission_photos = 0` không chứng minh
  thiếu ảnh Google.

## Mobile trace — chỉ đọc

Đã kiểm tra `dev/worktrees/mobile-546` tại `3d1259e` (head PR #572,
thực tế tên branch `bugfix/GOGO-564-placecard-regression`), local
`origin/re-design` tại `f28f617`, và file `import-flow.ts` trên remote
`re-design`. Các dòng dưới giống nhau ở hai ref.

- `src/features/place-import/import.view.tsx:210` chuyển nguyên preview vào
  `controller.resolved`; `import-flow.ts:201` giữ `result.resolutionToken`.
- `import-flow.ts:288` PUT draft chỉ gửi Place ID/version/enrichment. Hàm
  `install` ở `:93` spread state nên save/resume (`:248`) **giữ token và link
  đang có trong memory**. Không thấy nhánh save/read nháp bỏ token.
- `import-flow.ts:438–440` POST submission gửi resolutionToken khi có,
  cùng enrichment; `:449–465` re-resolve và retry một lần khi BE trả
  `RESOLUTION_TOKEN_INVALID`, chỉ khi cùng Place ID và nhận proof mới.
- Controller mới (`:64`, `:149`) không khôi phục token từ draft. Đây đúng
  contract: proof không được persist; mở lại flow phải resolve mới, rồi
  resume enrichment. Không có bằng chứng flow full-preview của owner bị mất
  token ở Mobile.
- Nhánh candidate selection riêng: `import.view.tsx:146` gọi
  `selectPlace`, `import-flow.ts:186` chỉ chọn ID và giữ token cũ/null,
  không resolve ID đã chọn. Response CANDIDATE_SELECTION của BE chỉ có
  tên/địa chỉ/confidence, không full facts/token. Nhánh này có thể submit
  không token nhưng **không giải thích preview full facts đã ghi nhận**.
  Nếu mở Mobile issue cho nhánh này, yêu cầu resolve selected ID trước khi
  submit, không tăng fallback SKU; không gộp nó thành kết luận incident.

## Thay đổi và regression

- Hoàn nguyên tier fallback và các kỳ vọng Enterprise sai trong unit,
  ingestion integration và contribution-wizard integration. Giữ tests
  disabled/unconfigured/not-forwarded, preview facts và lazy photo.
- Thêm integration trong `apps/api/test/my-place-submissions.int.spec.ts`:
  preview → PUT draft → GET draft → POST submission với cùng token →
  GET list/detail → DELETE draft. Qua HTTP controller và PostgreSQL;
  Google adapter thật với fetch stub và `DbUsageLedger` thật. Assert một
  quality Details ở preview, snapshot giữ rating 4.4/count 376/hours/fetchedAt,
  response có lazy photo, không thêm Details/refs/media sau preview, cả
  `provider_usage_daily` lẫn `provider_usage_meter_daily` không đổi.
- Test này kiểm BE HTTP contract, không thay thế Mobile E2E hoặc deployment
  activation acceptance. Google bytes/ref không vào snapshot, không backfill
  submission lịch sử. Public contract/schema/ledger pricing không đổi.

## Follow-up cho Claude

1. Xác minh DEV runtime secret presence và attestation flag bằng dữ liệu đã
   redacted. Nếu đi đúng renderer hiện tại, secret sẽ bị omitted do parked.
2. Xử lý activation riêng trong Infra theo quyết định owner; provision secret
   trong SSM, chuyển đúng resolution row sang active/required cho DEV, kiểm
   renderer thực sự bao gồm key và deploy. Không dùng `--include-parked` cho
   toàn bộ runtime, không bật place refresh hay nâng Google tier. TTL có thể
   giữ default 600.
3. Sau activation: quan sát `issued` ở preview và `accepted` ở submit; một
   quality preview, không core/quality bổ sung khi submit token còn hạn.
   Kiểm snapshot + lazy photo của một submission mới. Row cũ không tự đầy lại.
4. Docker không khả dụng trong sandbox: chạy các specs dưới trên môi trường
   có Docker, bao gồm cost-pinning gốc chưa sửa:

   ```sh
   pnpm exec vitest run --project integration \
     apps/api/test/my-place-submissions.int.spec.ts \
     apps/api/test/contribution-wizard.int.spec.ts \
     apps/api/test/ingestion.int.spec.ts \
     apps/api/test/submission-review.int.spec.ts
   ```

   Test cost-pinning: `costs one Pro Details to submit, one Enterprise each to
preview and to approve` (`submission-review.int.spec.ts:925`).

## Local gates

- `pnpm typecheck`: PASS, 8/8 packages (có cảnh báo quyền ghi Turbo cache,
  các compiler đều exit 0).
- `pnpm lint`, `pnpm format:check`, `git diff --check`: PASS.
- Focused unit: PASS, 40/40 (attestation, snapshot store, submit attribution,
  contribution drafts).
- `pnpm test`: 274 suites PASS, 3669 tests PASS, 1 skipped. Một suite
  `apps/api/src/sentry-request.spec.ts` không khởi động được do sandbox chặn
  listener `127.0.0.1`: `listen EPERM`. Đây là suite lỗi môi trường, không
  tuyên bố full unit gate xanh.
- Integration mới đã được typecheck, chưa chạy vì Docker không khả dụng.
  Claude cần chạy bốn specs ở trên và suite Sentry ngoài sandbox.
- Không commit/push, không sửa Mobile/Infra hoặc runtime DEV. Activation
  còn là follow-up bắt buộc; patch BE này chưa chứng minh DEV acceptance.
