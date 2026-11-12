# GoGo-BE#877 — validation

Ngày 2026-11-12. DEV: Sol. Branch `bugfix/GOGO-877-place-qa-presentation`,
base `ad8f1419` (`origin/re-design`). Không commit, không migration, không triển khai.

## PR #880 — review round 1 fixes (Sol, 2026-11-12)

Basis: `f1b0e3520ea5556cabdd1d0bd5f49c63ff492d04`, worktree hiện tại.
Nguồn findings: `dev/handoffs/codex-review-request-be-880.dev.out` ở workspace
cha. Chỉ sửa F-01/F-02; không commit. Log round này: `/tmp/be-880-round1/`.
Các kết quả ở những phần continuation phía dưới là lịch sử, không thay thế
bằng chứng round này.

### F-01 P1 — emitted identity bị legacy control bắt trước

- **Cause:** parser chạy none/typed-confirm/ordinal trước identity của candidates.
  Option 1 tên `Quán 2` bị hiểu thành ordinal 2, chuyển singleton sang candidate B.
  Tên trùng none control bị chuyển sang narrow; tên giống confirm phrase bị retry.
- **Change:** sau khi xác thực latest pending và các source references, đọc current
  identities trước legacy controls/area parsing. So cả full text và spelling có
  punctuation cuối câu. Nếu identity đụng ordinal của nhánh khác, none hoặc
  typed-confirm control thì giữ toàn bộ candidates và hỏi lại, giữ topic/args.
  Legacy ordinal không collision vẫn yêu cầu singleton confirm. Structured ids
  vẫn chạy trước text. Ba unit assertions cũ được đổi từ “không đọc facts” sang
  “đọc identities nhưng chỉ clarification”, vì đây là read bắt buộc để phát hiện
  collision; không nới assertion chọn nhánh/trả lời.
- **Regression:** `place-qa.service.spec.ts`, describe
  `GoGo-BE#880 F-01 emitted identities before legacy controls`: 6 cells gồm
  `Quán 2`, `Quán 2!`, hai locale của none và hai locale của confirm phrase.
  Trên basis: **6 FAIL**, `Quán 2` thực tế giữ duy nhất candidate B thay vì
  `[A, B]`. Candidate: **6 PASS** trong focused run exit 0.
  Thêm cell public API `880-F-01` vào `apps/api/test/place-qa-877.int.spec.ts`;
  hai fixtures `Quán 2`/`Quán 3` dùng UUID cố định để option order tái lập được.
  Integration **NOT RUN — DEV chạy**, chưa có FAIL/PASS runtime cho cell này.

### F-02 P1 — address lọt vào singleton confirm identity

- **Cause:** `confirmText` nhận discriminator và reader/parser đều truyền address
  của duplicate family, tạo phrase ngoài amendment được duyệt.
- **Change:** bỏ tham số discriminator khỏi `confirmText`; reader chỉ dùng address
  cho place choice (kể cả fuzzy multi-candidate clarification). Singleton prompt,
  label và text không thêm address. Text chính xác
  `Xác nhận <name> · <commune, province>` / `Confirm …`; missing/oversized identity
  dùng ordinal để hỏi lại như `origin/re-design`. Typed confirmation kiểm tra
  name + area trên toàn canonical family; trùng identity thì retry/restate,
  không trả lời nhánh nào. Cặp source-bound ids vẫn trả lời singleton đã chọn.
- **Regression:** hai cells `F-02: vi/en addressed choice…` trong unit service:
  addressed choice chọn B, confirm giữ nguyên name + area, typed text không trả
  lời B khi A có cùng name/area. Basis **2 FAIL** vì thêm ` · 27 Đường Mây`;
  candidate **2 PASS**, kèm unit id-pair PASS. Cell `877-TYPED` integration được
  sửa theo cùng kỳ vọng, kiểm tra cả text re-ask lẫn id-pair answer.
  Integration **NOT RUN — DEV chạy**, không gán unit PASS thành integration PASS.

### FAIL-before / PASS-after và commands

`before-final.log`: chỉ overlay tests/docs trên production nguyên bytes của
`f1b0e352`; xác minh không có production diff trước khi chạy, rồi phục hồi
candidate bằng `finally`. `before-manifest.json` ghi source SHA-256,
unit-spec SHA-256 và `candidateRestored: true`. Cùng bytes unit spec chạy
before/after: `12b0a0af4ac2533a7094b9b80ea4cc842fe01089585d43174977566fd215aacf`.
Integration spec được sửa type assertions sau baseline unit run; không được chạy
ở cả hai phía. Không có source overlay từ candidate khi lấy FAIL-before.

```sh
# FAIL-before: original f1b0e352 production + final unit spec
pnpm -s vitest run --project unit libs/modules/assistant/application/place-qa.service.spec.ts -t 'GoGo-BE#880 F-01|F-02: (vi|en) addressed'
# exit 1: 8 FAIL, 109 skipped; before-final.log

# PASS-after: candidate; includes all eight regressions + id-pair/legacy coverage
pnpm -s vitest run --project unit libs/modules/assistant/application/place-qa.service.spec.ts -t 'GoGo-BE#880 F-01|F-02:'
# exit 0: 15 PASS, 102 skipped; after-targeted.log

pnpm -s vitest run --project unit libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/application/place-qa-877.spec.ts libs/modules/assistant/domain/place-qa/pending.spec.ts
# exit 0: 182 PASS / 4 suites; focused.log

pnpm typecheck
# final: exit 0, 8/8 packages; typecheck-final2.log
pnpm exec eslint $(git diff --name-only -- '*.ts')
# final: exit 0; eslint-final.log
pnpm exec prettier --check $(git diff --name-only -- '*.ts' '*.md')
# final: exit 0; prettier-final.log
pnpm api:check
# exit 0; api-check.log
pnpm test
# exit 1: 5014 PASS, 1 skipped, 345 suites PASS; unit.log
# sentry-request.spec.ts BLOCKED: listen EPERM 127.0.0.1 (sandbox)
git diff --check
# final: exit 0
```

Hai lần typecheck trước exit 2 vì test mới thiếu `placeFacts` options và access
`trace.placeQa` dạng unknown. Đã sửa thành options có `signal`/`deadlineAt`
và `toMatchObject`;
không thay đổi expected product behavior. Full unit không có assertion FAIL;
không sửa/skip test socket. DEV vẫn cần full unit trong môi trường cho phép
listen và integration before/after trên basis/candidate. Round này không chạy
integration theo phân công của task.

**Layer A / OpenAPI:** kiểm tra nguyên bytes của cả 9 overlay files, gồm bốn
file Layer A được chỉ định, và toàn bộ `openapi/` so với basis; exit 0.
Không đổi OpenAPI hay generated types. Fingerprint cuối:
`/tmp/be-880-round1/final-manifest.json`.

## Phạm vi và quyết định

1. **Card:** tái dùng nguyên SQL/public projection của PlaceDetail và tách mapper
   `placeCardFromDetail` từ hydrator để hai đường đọc dùng chung. Detail row nằm
   trong cùng statement/snapshot cancellable với bằng chứng prose; vẫn tối đa 30
   ids và deadline 2 giây. Rating Google gồm count + source, tách community
   (ngưỡng 5 lượt); giá chỉ lấy hàng `per_person`. Không tạo policy card thứ ba,
   không cần provider-current hay prose-current để hiện dữ liệu card.
2. **Choice (DEV decision 2026-11-12 continuation):** label `<n>. <name>`
   khi tên khác nhau; cần phân biệt thì `<n>. <name> · <short address>`.
   Ưu tiên house number + street (ví dụ `27 Ngô Đức Kế`); cùng street thì dùng
   thành phần địa chỉ đầu tiên phân biệt được, chỉ ghép thêm phần khi cần.
   Label tối đa 40 Unicode code points: rút NAME với `…` trước, rồi mới rút
   address; giữ ordinal và discriminator không rỗng. Ordinal riêng theo option
   bảo đảm hai label không trùng ngay cả khi phần name/address sau cắt giống nhau.
   Text và prompt không dùng label đã cắt: giữ tên đầy đủ + discriminator.
   Thiếu address dùng public areaKey/current area có sẵn, không bịa mã.
   Singleton confirm cũng dùng label có giới hạn 40, text vẫn là câu xác nhận
   đầy đủ. **Round 1 #880 sửa lại:** địa chỉ chỉ phân biệt ở place_choice;
   singleton dùng đúng tên + commune/province, không thêm địa chỉ.
   Parser dùng cùng identity builder, match text trước area parsing, giữ topic
   và args. Text không phân biệt được thì hỏi lại; cặp ids vẫn quyết định lựa chọn.
3. **Format:** vi `90.000–180.000 VND/người. Thông tin tham khảo, xác minh ngày 2026-10-20`; en `90,000–180,000 VND per person` và mọi ngày xác minh/ngày được hỏi giữ ISO `yyyy-MM-dd` ở cả hai locale. BigInt
   quotient/remainder giữ integer minor units; không chia số thực. Giữ HH:mm.
   Tier và bằng chứng của câu trả lời chủ đề không đổi.

Theo core.md 8/13/14/15; SRS FR-SEARCH-007, FR-INGEST-006 và quy tắc integer
minor units. Card không nâng dữ liệu thiếu bằng chứng thành prose đã xác minh.
Giữ telemetry/deadlines cũ; không thêm nhãn metric hay dữ kiện vào trace/history.

Identity có địa chỉ vượt 200 ký tự giữ nguyên tên trong text chip; không cắt
identity thành tên chi nhánh khác. Text này còn mơ hồ thì tiếp tục hỏi lại.

**Không đổi OpenAPI:** đã phục hồi `openapi/gogo.v1.yaml` từ
`origin/re-design` (`ad8f1419`, version `10.2.0-alpha.1`, label `maxLength: 40`).
Sáu contract specs trước đó được phục hồi nguyên bytes (bỏ version/assertion 10.3);
continuation sau DEV integration chỉ đổi ba expected amount literals của
`assistant-place-answer.int.spec.ts` theo yêu cầu, không đổi contract.
`gogo.v1.d.ts` không đổi. Bundle ignored `artifacts/` trước đó còn version 10.3;
đã chạy lại `pnpm artifacts` để YAML/JSON/TS/manifest khớp 10.2.
`pnpm api:check` chỉ kiểm tra TS sinh ra, nên kiểm tra thêm
`git diff --exit-code origin/re-design -- openapi` (exit 0, không contract diff).

**Đếm độ dài:** OpenAPI 3.1/JSON Schema `maxLength` đếm Unicode code points;
`Array.from(value)` dùng cho label, không dùng JS `.length`/`.slice()` có thể cắt
surrogate pair. API hiện không đăng ký response schema/response validator cho
follow-ups (`apps/api/src/main.ts`, assistant controller và SSE writer).
Zod request-side (`presentation/dtos.ts`, Zod 3 `types.js`) dùng `.length`, tức
UTF-16; không có Zod response constraint cho option label. Ajv 8 mặc định dùng
`runtime/ucs2length` (code points), không có override `unicode: false` ở API.
Unit emoji chứng minh label 40 code points/77 UTF-16 units hợp lệ, không xé đôi
surrogate pair. Không đổi request validation.

## Ma trận regression

| Cell                | Unit                                                                                                                                                                            | Integration mới                                                                          | Base / candidate                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| 877-CARD            | assistant/application/place-qa-877.spec.ts `877-CARD`; search/application/place-qa-877.spec.ts `877-CARD-SQL`                                                                   | so card QA với AssistantCardHydrator: address, provider rating/count/source, giá có unit | Primary unit FAIL / PASS; integration BLOCKED |
| 877-CHOICE          | `877-CHOICE`: prompt/label/text có hai địa chỉ khác nhau, numbered label ≤40                                                                                                    | hai The Workshop Coffee cùng commune, hai chip khác nhau                                 | Primary unit FAIL / PASS; integration BLOCKED |
| 877-LABEL           | `877-LABEL`: tên Việt dài, rút name trước address, giữ discriminator và ordinal, label khác nhau; distinct names giữ label cũ; text/prompt đầy đủ; same street/cross-area/emoji | DEV chạy integration ngoài sandbox                                                       | Base 6 FAIL / 1 PASS; candidate 7 PASS        |
| 877-TEXT            | `877-TEXT`: text tên quán                                                                                                                                                       | tên khác nhau; gửi text A nhưng id pair B vẫn chọn B                                     | Primary unit FAIL / PASS; integration BLOCKED |
| 877-AMBIGUOUS       | place-qa.service.spec.ts, describe `GoGo-BE#877 typed choice continuation`: có/không address                                                                                    | gõ tên trùng không ids: hỏi lại cả hai, giữ topic                                        | PASS / integration BLOCKED                    |
| 877-TYPED           | emitted address text → singleton confirm; trùng name/area thì typed text hỏi lại, id pair mới trả lời nhánh; kiểm tra no-address ambiguity                                      | cùng flow qua public API/SSE/history                                                     | PASS / integration BLOCKED                    |
| 877-FORMAT          | `877-FORMAT` vi/en, thêm existing max-safe-integer regression                                                                                                                   | giá 90.000–180.000, 2026-10-20, 09:00–23:00                                              | Primary unit FAIL / PASS; integration BLOCKED |
| Unknown / threshold | search/application/place-qa-877.spec.ts: thiếu address/rating/unit; community 4 lượt; unpublished                                                                               | card parity cell dùng stored Google rating không provider source row                     | 3 unit PASS; integration BLOCKED              |
| Legacy / fence      | giữ ordinal literal 1/2 trong test legacy; cập nhật kỳ vọng formatting; contract pins giữ base                                                                                  | s3, s3-fence, 875                                                                        | Unit PASS; integration BLOCKED                |

## Continuation sau DEV integration — quyết định 2026-11-12

Nguồn: `/Users/maxnguyen/MyWorks/GoGo/dev/test-evidence/be-877/int-*.log`
(đã đọc cả năm logs). Đây là kết quả DEV của candidate **trước** continuation
này, không phải kết quả sau sửa:

| Spec                          | Kết quả DEV trước sửa                                    |
| ----------------------------- | -------------------------------------------------------- |
| `assistant-place-qa-s3`       | 416 PASS / 1 FAIL (`date-explicit`)                      |
| `assistant-place-qa-s3-fence` | 42 PASS / 3 FAIL (hai locale, một choice text)           |
| `assistant-place-answer`      | 9 PASS / 2 FAIL (SSE, history/CMS)                       |
| `place-qa-875`                | 5 PASS                                                   |
| `place-qa-877`                | 6 PASS; kỳ vọng ngày cũ, đã được thay bởi quyết định mới |

1. **Ngày:** bỏ hoàn toàn `displayDate`; ngày xác minh dùng lại
   `verifiedAt.slice(0, 10)`, ngày được hỏi dùng lại `query.date`, đúng bytes
   expression trên `origin/re-design`. Cả vi/en giữ `yyyy-MM-dd`. Giữ grouping
   tiền, câu riêng trước reference disclaimer và HH:mm. Đổi unit cells,
   `place-qa-877.int.spec.ts` và docs; không sửa bốn file Layer A.
   Chạy unit trước sửa product: `/tmp/be-877-date-before.log`, exit 1,
   6 FAIL / 34 PASS; sau sửa có thêm hai locale cells kiểm tra đồng thời ngày
   xác minh `2025-02-03`, ngày hỏi `2026-12-25`, tier, sources và HH:mm.
2. **Locale: lỗi kỳ vọng test, không phải product regression.**
   `git show origin/re-design:apps/api/test/assistant-place-qa-s3-fence.int.spec.ts`
   dòng 464–465 giữ locale `vi` và kỳ vọng `12000–24000 VND/người`.
   Patch trước đã đổi nhầm sang tiếng Anh. `PlaceQaService.answer` vẫn dùng
   `input.locale`; parser dùng `latest.locale` chỉ để nhận diện confirm đã phát.
   `QaPending` không thêm pending locale. Đổi expected thành
   `12.000–24.000 VND/người`, giữ mọi input/assertion khác. Unit hai mode
   omitted/changed bổ sung kiểm tra `vi` và số đã group. Không đổi product locale.
3. **Choice text:** test thực tế đọc `option.text`, không phải `option.label`.
   Hai địa điểm trùng tên, không có địa chỉ phân biệt nên fallback area hiện có
   cho text `Song Ngọc · Cầu Giấy, Hà Nội` là chủ đích. Ordinal vẫn nằm trong
   display label để label phân biệt. Chỉ đổi hai text literals trong cell fence;
   các lệnh legacy `2` rồi stale `1`, assertion candidate B/no-answer/no-VND và
   ambiguous confirm đều giữ nguyên. Unit mới cùng tên/cùng area/không address
   chứng minh stale `1` giữ B và text mơ hồ không trả lời.
4. **SSE/history:** hai test cells có ba positive amount assertions (SSE,
   history, CMS). Chỉ đổi `12000` thành `12,000` tại ba positive assertions;
   giữ nguyên toàn bộ assertion khác theo chỉ định.

Không chạy lại integration trong sandbox; DEV cần chạy lại ba spec từng fail
và `place-qa-877` với kỳ vọng ISO mới. Kết quả DEV cũ không chứng minh candidate
sau sửa đã PASS integration. Log checks mới ở `/tmp/be-877-*-iso.log`.

### Checks sau sửa ISO (candidate hiện tại)

| Lệnh/check                                             | Exit | Kết quả/log                                                                                                                             |
| ------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                       | 0    | 8/8 packages; Turbo cache IO warnings; `/tmp/be-877-typecheck-final-iso.log`                                                            |
| ESLint mọi TS touched (lệnh đầy đủ bên dưới)           | 0    | `/tmp/be-877-eslint-final-iso.log`                                                                                                      |
| Prettier mọi TS/MD/YAML touched (lệnh đầy đủ bên dưới) | 0    | `/tmp/be-877-prettier-iso.log`                                                                                                          |
| `pnpm api:check`                                       | 0    | `/tmp/be-877-api-check-iso.log`                                                                                                         |
| Focused unit 8 suites (lệnh đầy đủ bên dưới)           | 0    | 223 PASS; `/tmp/be-877-focused-final-iso.log`                                                                                           |
| `pnpm test`                                            | 1    | 5.006 PASS, 1 skipped; 345 suites PASS; duy nhất `sentry-request.spec.ts` bị `listen EPERM 127.0.0.1`; `/tmp/be-877-unit-final-iso.log` |
| `git diff --exit-code origin/re-design -- openapi`     | 0    | Không contract diff                                                                                                                     |
| Layer A bytes/hash so với `origin/re-design`           | 0    | Cả 9 overlay files nguyên bytes, bao gồm 4 file được chỉ định; `/tmp/be-877-layer-a-iso.json`                                           |
| `git diff --check`                                     | 0    | Không whitespace errors                                                                                                                 |

```sh
pnpm exec eslint $(git ls-files --modified --others --exclude-standard | rg '\.ts$')
pnpm exec prettier --check $(git ls-files --modified --others --exclude-standard | rg '\.(ts|md|yaml)$')
pnpm -s vitest run --project unit libs/modules/assistant/application/place-qa-877.spec.ts libs/modules/search/application/place-qa-877.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/domain/place-qa/pending.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts libs/modules/assistant/presentation/assistant-place-answer.contract.spec.ts libs/modules/search/domain/place-facts.spec.ts
```

Lần full unit đầu sau rollback exit 1: 5.005 PASS, 1 assertion FAIL do hai
kỳ vọng ngày localized còn sót trong `search/domain/place-facts.spec.ts`, cùng
lỗi socket sandbox. Đã đổi hai kỳ vọng về ISO, giữ sentence break; final full
run ở bảng trên không còn assertion FAIL. Không sửa/skip test socket.
Fingerprint TS hiện tại: `/tmp/be-877-ts-snapshot-iso.json` (19 touched files).

Các bảng, fingerprint primary spec và bằng chứng base FAIL bên dưới là **lịch sử
trước quyết định bỏ format ngày**; không gán chúng cho bytes candidate hiện tại.

## Continuation — lệnh và exit code

Log trong `/tmp/be-877-evidence/`. Integration do DEV chạy ngoài sandbox theo
chỉ định; continuation này không chạy lại integration. Các kết quả integration
ở bảng lịch sử bên dưới chỉ mô tả lần trước.

| Lệnh                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Exit | Kết quả / log                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | 8/8 packages; Turbo cache IO permission warning; `typecheck-continuation.log`                                                 |
| `pnpm exec eslint $(git ls-files --modified --others --exclude-standard \| rg '\.ts$')`                                                                                                                                                                                                                                                                                                                                                                                 | 0    | `eslint-continuation.log`                                                                                                     |
| `pnpm exec prettier --check $(git ls-files --modified --others --exclude-standard \| rg '\.(ts\|md\|yaml)$')`                                                                                                                                                                                                                                                                                                                                                           | 0    | `prettier-continuation.log`                                                                                                   |
| `pnpm api:check`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | `api-check-continuation.log`                                                                                                  |
| `git diff --exit-code origin/re-design -- openapi`                                                                                                                                                                                                                                                                                                                                                                                                                      | 0    | `contract-diff-continuation.log`, empty                                                                                       |
| `pnpm artifacts`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0    | `artifacts-continuation.log`, 10.2.0-alpha.1                                                                                  |
| `pnpm -s vitest run --project unit libs/modules/assistant/application/place-qa-877.spec.ts libs/modules/search/application/place-qa-877.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts libs/modules/assistant/application/place-answer-reader.spec.ts libs/modules/assistant/domain/place-qa/pending.spec.ts libs/modules/assistant/domain/place-qa/templates.spec.ts libs/modules/assistant/presentation/assistant-place-answer.contract.spec.ts` | 0    | 209 PASS, 7 suites; `focused-continuation.log`                                                                                |
| `pnpm test`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 1    | 5.003 PASS, 1 skipped; 345 suites PASS, `sentry-request.spec.ts` blocked by `listen EPERM 127.0.0.1`; `unit-continuation.log` |
| Base: `node node_modules/vitest/vitest.mjs run --project unit libs/modules/assistant/application/place-qa-877.spec.ts`                                                                                                                                                                                                                                                                                                                                                  | 1    | 11 FAIL / 1 PASS (12); `base-unit-continuation.log`                                                                           |
| `git diff --check`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 0    | no whitespace errors                                                                                                          |

## Lệnh và exit code — lịch sử trước continuation

Chạy từ worktree trừ base archive. Log đầy đủ trong `/tmp/be-877-evidence/`.
Các lệnh integration chạy lần lượt, không song song.

| Lệnh chính xác                                                                                                                                                                                               | Exit | Kết quả / log                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                                                                                                             | 0    | 8/8 packages; `typecheck-final2.log` (Turbo cảnh báo cache IO permission, compiler đều thành công)                                                             |
| `pnpm test`                                                                                                                                                                                                  | 1    | 4.996 PASS, 1 skipped; 345 suites PASS, duy nhất `apps/api/src/sentry-request.spec.ts` bị `listen EPERM: operation not permitted 127.0.0.1`; `unit-final2.log` |
| `pnpm -s vitest run --project unit libs/modules/assistant/application/place-qa-877.spec.ts libs/modules/search/application/place-qa-877.spec.ts libs/modules/assistant/application/place-qa.service.spec.ts` | 0    | 116 PASS; `focused-final.log`                                                                                                                                  |
| `pnpm exec eslint $(git ls-files --modified --others --exclude-standard \| rg '\.ts$')`                                                                                                                      | 0    | mọi TS thay đổi; `eslint-final.log`                                                                                                                            |
| `pnpm exec prettier --check $(git ls-files --modified --others --exclude-standard \| rg '\.(ts\|md\|yaml)$')`                                                                                                | 0    | mọi file thay đổi; `prettier-final.log`                                                                                                                        |
| `pnpm api:check`                                                                                                                                                                                             | 0    | `api-check.log`                                                                                                                                                |
| `pnpm -s vitest run --project integration --no-file-parallelism apps/api/test/place-qa-877.int.spec.ts`                                                                                                      | 1    | BLOCKED, 6 skipped; `new-int.log`                                                                                                                              |
| `pnpm -s vitest run --project integration --no-file-parallelism apps/api/test/assistant-place-qa-s3.int.spec.ts`                                                                                             | 1    | BLOCKED, 417 skipped; `s3-int.log`                                                                                                                             |
| `pnpm -s vitest run --project integration --no-file-parallelism apps/api/test/assistant-place-qa-s3-fence.int.spec.ts`                                                                                       | 1    | BLOCKED, 45 skipped; `s3-fence-int.log`                                                                                                                        |
| `pnpm -s vitest run --project integration --no-file-parallelism apps/api/test/place-qa-875.int.spec.ts`                                                                                                      | 1    | BLOCKED, 5 skipped; `875-int.log`                                                                                                                              |
| `git diff --check`                                                                                                                                                                                           | 0    | không whitespace errors                                                                                                                                        |

Lệnh lint/format nguyên văn (pipe trong bảng được escape cho Markdown):

```sh
pnpm exec eslint $(git ls-files --modified --others --exclude-standard | rg '\.ts$')
pnpm exec prettier --check $(git ls-files --modified --others --exclude-standard | rg '\.(ts|md|yaml)$')
```

Mọi integration dừng trước assertion tại `startAssistantFixture`:
`Could not find a working container runtime strategy`. Docker probe trả exit 1:
`permission denied ... unix:///Users/maxnguyen/.docker/run/docker.sock`.
Không có integration base-FAIL hay candidate-PASS được chứng minh trong sandbox.
Không coi lỗi runtime/container là product regression; không đổi test để né quyền.
SQL runtime/performance và public SSE/history vẫn cần chạy ở môi trường có Docker.
Không có DEV/simulator acceptance từ kết quả unit này.

## Bằng chứng base FAIL

Đã chạy primary spec trước thay đổi trên chính cwd sạch `ad8f1419`:
`pnpm -s vitest run --project unit libs/modules/assistant/application/place-qa-877.spec.ts`
→ exit 1, 5/5 FAIL (`base-unit.log`). Bản spec trước continuation cũng 5/5 FAIL
(`base-unit-final.log`). Continuation chạy lại **cùng bytes spec cuối hiện tại**
trên archive sạch của base, không overlay implementation:

```sh
# cwd /tmp/be-877-base
node node_modules/vitest/vitest.mjs run --project unit libs/modules/assistant/application/place-qa-877.spec.ts
# exit 1; 11 FAIL / 1 PASS (12), base-unit-continuation.log
```

- CARD: base thiếu addressText/providerRating/count/source/community score.
- CHOICE: base prompt không chứa `12 Đường Mây` hay `27 Đường Mây`.
- TEXT: base gửi `"1"`, kỳ vọng `"The Workshop Coffee"`.
- LABEL: base không có discriminator/ellipsis; cắt theo UTF-16, mất full text.
  6/7 cell LABEL FAIL vì product behavior; cell ordinal uniqueness PASS do base
  cũng giữ ordinal. Candidate toàn bộ 12 primary cells PASS.
- FORMAT vi: base `90000–180000 VND/người Thông tin tham khảo, xác minh ngày 2026-10-20`.
- FORMAT en: base `90000–180000 VND/person Reference information verified on 2026-10-20`.

Đối chiếu SHA-256 bản primary spec candidate/base:
`26a3e506b1f87b7b8b0abd07f66323ec1a9443d8d3ee2461ce18e6a2b98f0630`.
Integration spec cũng cùng bytes, SHA-256:
`7fcf8aee719775ceaa31653e7330b77c2761239d831414b1a7ee54e7d2382597`.
Toàn bộ 1.475 tracked files trong archive đã so blob hash với `origin/re-design`;
27 symlink `@gogo/*` resolve bên trong archive. Evidence:
`base-source-continuation.json`. Chỉ overlay hai specs đã nêu, không source.
Integration spec có cùng bytes nhưng chưa chạy theo chỉ định DEV.

Tái lập thông thường (không commit/reset worktree hiện tại):

```sh
candidate="$PWD"
base_dir=$(mktemp -d /tmp/be-877-base.XXXXXX)
git archive ad8f1419 | tar -x -C "$base_dir"
cp libs/modules/assistant/application/place-qa-877.spec.ts "$base_dir/libs/modules/assistant/application/"
cp apps/api/test/place-qa-877.int.spec.ts "$base_dir/apps/api/test/"
cd "$base_dir"
pnpm install --offline --frozen-lockfile
pnpm -s vitest run --project unit libs/modules/assistant/application/place-qa-877.spec.ts
pnpm -s vitest run --project integration --no-file-parallelism apps/api/test/place-qa-877.int.spec.ts
```

Trong lần này offline install exit 1 (`ERR_PNPM_NO_OFFLINE_TARBALL`, thiếu
`@eslint/js` trong pnpm store). Để chạy lại cùng dependency versions mà không
cài mạng, đã clone các **node_modules** hiện có bằng `cp -cR` vào archive tại đúng
vị trí tương ứng: root, apps/api, apps/worker, libs/modules, libs/database,
libs/providers, libs/observability, libs/cost-observability, scripts. Đây chỉ là
dependencies, không copy production source. Đã xác minh toàn bộ 27 symlink
`@gogo/*` resolve bên trong archive (`base-dependencies.json`), không trỏ về
candidate. Gọi Vitest bằng `node .../vitest.mjs` vì pnpm khi phát hiện module
store metadata của vị trí cũ cố chạy install lại. Log product FAIL ở trên đến
từ Node/Vitest chạy thành công, không phải từ lỗi install.

Để tái lập đúng dependency-clone fallback trên macOS sau `git archive`:

```sh
# base_dir đã có production source của ad8f1419 và hai test overlays ở trên.
for rel in node_modules apps/api/node_modules apps/worker/node_modules \
  libs/modules/node_modules libs/database/node_modules libs/providers/node_modules \
  libs/observability/node_modules libs/cost-observability/node_modules scripts/node_modules; do
  rm -rf "$base_dir/$rel"
  cp -cR "$candidate/$rel" "$base_dir/$rel"
done
cd "$base_dir"
node node_modules/vitest/vitest.mjs run --project unit libs/modules/assistant/application/place-qa-877.spec.ts
```

## Layer A giữ nguyên

Không sửa `assistant-place-qa-s3.int.spec.ts` hay bất kỳ file nào trong overlay
của `scripts/eval/place-qa-layer-a-base.sh`. Cả 9 file đã so bytes với base;
không assertion khóa hash nào được sửa. Corpus chỉ yêu cầu chứa `VND/người`,
vẫn được giữ. Fence spec không thuộc allowlist khóa hash: cập nhật riêng các
kỳ vọng text/format cũ, giữ input ordinal literal cho regression legacy.

- `apps/api/test/assistant-place-qa-s3.int.spec.ts` — `9c504fcd4f14502e84dd24b6a4a41bb9ce04d3ea12ac1f08be41dde96d59f5a3`
- `libs/modules/assistant/eval/place-qa-cases.vi.json` — `c8a3d1005830e8df53e46be7964f72fdea0e6c4b8d400a23038728a588cbb39f`
- `libs/modules/assistant/eval/place-qa-fixtures.json` — `789eee8cd81519e179b22499ef28908fa142edf7eae0f89b1f3dff87aa4fb634`
- `libs/modules/search/eval/intent-cases.vi.json` — `48c1cc3317309907d43235f6f5425252d8eca83cca1799fd3b562204217ba6a6`
- `apps/api/test/support/assistant-fixture.ts` — `66f996d4da8043d0a31e3beaed259fb38b63fd2980831d374de0dd31622259e2`
- `apps/api/test/support/place-name-key.ts` — `b3c24ab0067edcda65a665b1b60b07ce0f28122574c0db027d6bbbc881188d5d`
- `apps/api/test/support/credit-events.ts` — `8502c22418b2a594c34a2903e3f1a97a6d32785aebda1fa294a17a2659f5d493`
- `apps/api/test/support/cms-access.ts` — `35c46d992374b6f3a99643bf881f6912177171af1375b3741e267f612522db75`
- `apps/api/test/support/pg-shutdown.ts` — `e7c76d6d24f035766a00c1d69861b2da58ffc63703476567600e9b10b0521463`

## Files thay đổi

- `apps/api/test/place-qa-877.int.spec.ts`
- `apps/api/test/assistant-place-answer.int.spec.ts`
- `libs/modules/assistant/application/place-card.ts`
- `libs/modules/assistant/application/place-qa-877.spec.ts`
- `libs/modules/search/application/place-qa-877.spec.ts`
- `apps/api/test/assistant-place-qa-s3-fence.int.spec.ts`
- `docs/assistant.md`
- `libs/modules/assistant/application/card-hydrator.service.ts`
- `libs/modules/assistant/application/place-answer-reader.spec.ts`
- `libs/modules/assistant/application/place-answer-reader.ts`
- `libs/modules/assistant/application/place-qa.service.spec.ts`
- `libs/modules/assistant/application/place-qa.service.ts`
- `libs/modules/assistant/domain/place-qa/pending.ts`
- `libs/modules/assistant/domain/place-qa/place-facts.ts`
- `libs/modules/assistant/domain/place-qa/templates.spec.ts`
- `libs/modules/assistant/domain/place-qa/templates.ts`
- `libs/modules/search/application/search.service.ts`
- `libs/modules/search/domain/place-facts.spec.ts`
- `libs/modules/search/infrastructure/place-qa-queries.ts`
- `libs/modules/search/infrastructure/search.repository.ts`
- `docs/plans/877-validation.md`
