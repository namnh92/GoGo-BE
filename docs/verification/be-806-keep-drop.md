# GoGo-BE #806 — Kết quả local và bàn giao

Ngày 2026-11-07. Branch `feature/GOGO-806-wizard-keep-drop`, base
`origin/re-design`. Chỉ sửa worktree; không install/commit/push. Code, contract,
migration, unit/integration specs và docs đã viết. Không tuyên bố integration,
oasdiff, review hoặc DEV acceptance đã đạt.

Thiết kế/rollout/rollback: [runbook](../place-contribution-keep-drop.md).
Selection optional để backward-compatible; CMS mới gửi explicit khi có wizard.
Giá per_group/free được giữ nguyên unit trong contributionFacts, không ép vào
enum price_unit cũ. Không tự nâng rating cá nhân thành provider/community aggregate.

| Gate                                                                  | Kết quả                                                                      | Evidence local                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| `pnpm test --maxWorkers=2`                                            | FAIL do môi trường: 273 suites PASS, 1 suite lỗi; 3655 tests PASS, 1 skipped | `/tmp/be806-unit.log`            |
| Final focused unit: ingestion, CMS, credits, PlaceDetail              | PASS: 45 suites, 722 tests                                                   | `/tmp/be806-focused.log`         |
| `pnpm typecheck` final                                                | PASS: 8/8 tasks; cache-write warnings do sandbox                             | `/tmp/be806-typecheck-final.log` |
| `pnpm lint` final                                                     | PASS                                                                         | `/tmp/be806-lint-final.log`      |
| `pnpm format:check`                                                   | PASS                                                                         | `/tmp/be806-format.log`          |
| `pnpm api:types`                                                      | PASS, generated types đã ghi                                                 | tool output                      |
| `pnpm api:check`                                                      | PASS                                                                         | `/tmp/be806-api-check.log`       |
| `pnpm api:version /tmp/be806-contract/base.yaml openapi/gogo.v1.yaml` | PASS, 7.6.0-alpha.1                                                          | `/tmp/be806-api-version.log`     |
| `pnpm api:routes`                                                     | PASS: 318 served/spec, không thiếu hoặc trùng                                | `/tmp/be806-api-routes.log`      |
| Legacy decide oneOf structural parity                                 | PASS; hai branch giống origin/re-design                                      | `/tmp/be806-contract-shape.log`  |
| Real oasdiff                                                          | BLOCKED: Docker socket permission denied, exit 1                             | `/tmp/be806-oasdiff.log`         |
| Compatibility policy khi tool thất bại                                | FAIL CLOSED đúng dự kiến, exit 2; không thêm exception                       | `/tmp/be806-oasdiff-policy.log`  |
| Integration + migration execution                                     | NOT RUN theo phân công: Claude chạy Docker                                   | specs đã typecheck               |
| `git diff --check`                                                    | PASS                                                                         | local command                    |

Full-unit lỗi `apps/api/src/sentry-request.spec.ts`: listen EPERM trên 127.0.0.1.
Không sửa test/mở quyền/đổi timeout để né lỗi. Full-unit chạy trước các sửa cuối
về lock target, price timestamp/allowlist và các assertion bổ sung; focused unit,
final typecheck/lint/format kiểm tra cây sau các sửa đó. Không relabel full run
thành full-final PASS. Không có executed FAIL-before; source #802 cho thấy chưa
có đường selection/fact application. Đây là feature coverage, không phải bằng
chứng hồi quy chạy trên base.

## Claude cần chạy

```sh
pnpm test:integration apps/api/test/submission-photos.int.spec.ts apps/api/test/submission-review.int.spec.ts apps/api/test/contribution-wizard.int.spec.ts apps/api/test/contribution-taxonomy-migration.int.spec.ts --maxWorkers=2
```

Các test mới nằm ở describe `wizard explicit keep/drop HTTP (#806)` trong
submission-photos: partial approved/merged + facts/photos + server preview,
all-drop +50, consumer 403, foreign selection 400, retry cùng key trả cùng response,
đổi payload 422, ledger/audit một lần, public userPhotos nhưng không gallery.
Các spec hiện có giữ regression omission và đường merge bonus-only cũ.
Migration 0090 được chạy khi setup DB từ migrations journal; xác minh rollout
schema-first và rollback giữ cột trước acceptance.

Đo oasdiff thật, không thêm exception và không dùng projected report làm PASS:

```sh
mkdir -p /tmp/be806-contract
git show origin/re-design:openapi/gogo.v1.yaml > /tmp/be806-contract/base.yaml
docker run --rm --pull=never \
  -v /tmp/be806-contract:/base:ro -v "$PWD:/work:ro" \
  tufin/oasdiff:stable breaking /base/base.yaml /work/openapi/gogo.v1.yaml
```

Lệnh local đã thử đúng dạng này và bị từ chối socket. Structural parity không
thay thế oasdiff. Final contract compatibility vẫn UNVERIFIED cho tới khi đo
thật trên runner có Docker. Astra/CODEOWNER, CI và acceptance là các cổng riêng;
không commit/push trong phiên này.
