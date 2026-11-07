# GoGo-BE#802 — F-05/F-06 r3

Ngày 2026-11-07. Worktree trên HEAD `5da73e32f736fa752c8ac9e39277e05c7eb8f738`,
base `45d9d0822bef579929b603032e6e6b0dca37bc93`. Không install, commit hoặc push.

## Thay đổi

- F-05: migration 0088 khóa singleton `taxonomy_version` trước khi seed keys/labels,
  sau đó tăng `version` và `updated_at` trong cùng transaction Drizzle. Lock order
  giống CMS writes. Không có generation mới nếu migration rollback.
- F-06: giữ service/space tùy chọn theo generated-client contract. Runtime chấp
  nhận bỏ một hoặc cả hai, không tạo giá trị mặc định; rating đã gửi vẫn integer
  1–5. OpenAPI chỉ required purposeKeys/vibeKeys. Không thay legacy-price behavior.
- PostgreSQL regression mới: giữ ETag vi/en trước migration, inject label failure
  để kiểm tra rollback, migrate lại và đòi 200 với generation mới + cả tám key/label;
  validator mới phải trả 304. Submission integration mở rộng bốn trường hợp rating
  (đầy đủ, bỏ service, bỏ space, bỏ cả hai), kiểm tra persistence/dedupe/export.
- Test CMS version dùng generation hiện tại thay vì giả định mọi migration đều
  giữ nguyên generation khởi tạo 1.

## FAIL-before / PASS-after

Lệnh chạy trên production code chưa sửa, sau đó chạy lại sau sửa:

```sh
pnpm exec vitest run --project unit \
  libs/database/src/contribution-taxonomy-migration.spec.ts \
  libs/modules/ingestion/domain/contribution-enrichment.spec.ts \
  libs/modules/ingestion/presentation/contribution-wizard.contract.spec.ts
```

- Before: 3 files failed; 5 tests failed, 33 passed. F-05 thiếu singleton lock;
  ba trường hợp F-06 lỗi Zod `Required`; contract vẫn required service/space.
- After: 3 files passed, 38 tests passed.
- F-05 unit ghi driver calls của **Drizzle migrator thật** để kiểm tra thứ tự
  BEGIN → lock → keys → labels → increment → COMMIT. Đây không phải bằng chứng
  PostgreSQL/HTTP đã chạy; integration bên dưới bị chặn.
- Raw logs local: `/tmp/be-802-regression-before.log`, `/tmp/be-802-regression-after.log`.

## Gates

| Lệnh                                   | Kết quả                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                            | 268 files pass; 3,588 tests pass, 1 skipped. Suite sentry-request lỗi `listen EPERM 127.0.0.1` do sandbox. Exit 1. |
| `pnpm test:integration --maxWorkers=4` | 104 suites fail, 1 skipped; 15 tests pass, 2,148 skipped. Container runtime không khả dụng. Exit 1.                |
| `pnpm typecheck`                       | 8/8 tasks pass. Exit 0.                                                                                            |
| `pnpm lint`                            | Pass, exit 0.                                                                                                      |
| `pnpm format:check`                    | Pass, exit 0. Docs cuối được check riêng sau khi viết evidence.                                                    |
| `pnpm api:types`                       | Pass, exit 0. Generated file byte-identical với HEAD; service/space vẫn optional.                                  |
| `git diff --check`                     | Pass.                                                                                                              |

`docker info` trả permission denied tại
`unix:///Users/maxnguyen/.docker/run/docker.sock`. Các integration mới không đến
test body: Testcontainers báo `Could not find a working container runtime strategy`.
Không đổi permission mode hoặc bypass sandbox. Không tuyên bố integration pass.
Logs còn lại: `/tmp/be-802-{unit,integration,typecheck,prettier,lint}.log`.

## Contract bytes

- Decide request `oneOf`: so trực tiếp raw subtree với base; identical, 2,632 bytes.
  SHA-256: `54fcb8fa2a9bbb106ca24f33a198f3acd559536a2b6605298a5a03d55abbaf90`.
- Base YAML SHA-256: `4b744cd0994a727443292fc160992e277ea9eca14da51bac24bbcf85e3868620`.
- Final YAML SHA-256: `bb76de8e00f3eec150575a1863a865546715c57078a7545636f93367913eb514`.
  `BE-796-credit-delta-extensible.revisionSha256` khớp hash này; không thêm exception.

Đây là kết quả working tree, không phải CI hoặc DEV acceptance.
