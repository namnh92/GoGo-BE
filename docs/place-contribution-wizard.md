# Wizard đóng góp địa điểm — GoGo-BE#796

ADR: [0048](adr/0048-place-contribution-wizard.md). Contract 7.5.0-alpha.1.
Các API ở dưới `/v1`. Cần registered user; guest/admin không có quyền dùng nháp
hoặc gửi enrichment. Auth guard hiện có kiểm tra session/account. Owner khác
không được đọc/ghi/xóa nháp; response 404 không xác nhận nháp có tồn tại.

| API                                              | Hành vi                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| GET /place-contribution-drafts                   | Tất cả nháp còn hạn của user, tối đa 20, UUID order                                                      |
| PUT /place-contribution-drafts/{id}              | UUID client, `{googlePlaceId, expectedVersion, enrichment}`; 0 tạo mới, version hiện tại để thay toàn bộ |
| GET /place-contribution-drafts/{id}              | Tiếp tục, trả version và expiresAt                                                                       |
| DELETE /place-contribution-drafts/{id}?version=N | Xóa đúng revision của user                                                                               |
| POST /place-submissions                          | Thêm trường tùy chọn `enrichment`, không đổi payload cũ                                                  |
| GET /place-submissions/{id}                      | Owner đọc lại enrichment, verificationStatus unverified                                                  |
| GET /cms/place-submissions/{id}                  | Contribution chứa enrichment để CMS xem; chưa phải place facts                                           |

`enrichment` khi submit cần purposeKeys (suitability active), 1–3 vibeKeys
(mood active), service/space `{rating:1..5, chipKeys:[]}`. Nháp cho phép bỏ các
trường chưa xong; trường đã có vẫn phải hợp lệ. Nhãn lấy `GET /taxonomies`.
Amenity dùng map key → boolean: bỏ key là chưa biết; false là user khai không có.
Sáu key và key mới xem ADR. service chip thuộc checkin_tag, prefix service_;
space chip prefix space_. Không dùng id hoặc label hiển thị làm key.

Giá tùy chọn: `{min:20000,max:50000,currency:"VND",unit:"per_item"}`,
integer minor units, max >= min. `free` chỉ hợp lệ với min=max=0. Giá không biết
thì bỏ trường. recommendedDishes (1000 ký tự), visitTips (2000) tùy chọn.
Không sinh câu mô tả, không viết price/hours/amenity/rating của catalogue.
CMS phải xác minh và dùng review/editor hiện có; enrichment không tự promote
khi approve. Xem xét/duyệt service/space community ratings cần hợp đồng CMS
riêng, không ghi đè provider rating.

Client lưu snapshot nháp, GET để tiếp tục, resolve lại link khi gửi,
POST submission với enrichment, sau thành công DELETE nháp đúng version.
`deduped:true` nghĩa proposal đã tồn tại: enrichment mới **không được lưu**,
client phải giữ nháp và không báo đã lưu các chi tiết mới. Không đổi contributor
được nhận credit. Nếu `ALREADY_EXISTS`, không có submission mới/enrichment mới.
PUT stale trả 409 DRAFT_MODIFIED: GET lại trước khi sửa; không tự ghi đè.
Không lưu payload nháp trong idempotency replay table. PUT dùng UUID/version,
không tạo nháp kép khi retry; retry version cũ trả conflict. API GET private,
no-store. Nháp hết hạn sau 30 ngày từ lần lưu cuối, API ngừng trả ngay; worker
privacy mỗi 6 giờ xóa vật lý, dry-run chỉ đếm. Account erasure xóa nháp và
xóa enrichment trước anonymize submission; export có contributionDrafts và
contributionEnrichments, được tính vào giới hạn byte export hiện có.

## Ảnh BLOCKED trên #794

Tối đa năm `{mediaId:UUID,kind:"menu"|"bill"}`. Nonempty photos ở draft/submit
hiện trả 503 SUBMISSION_EVIDENCE_BLOCKED, retryable false. Không có signed URL,
raw receipt, OCR hay pipeline giả. Chỉ mở khi nối private upload owner claim,
sanitise + strip EXIF, OCR/mask PII và đảm bảo CMS chỉ xem derivative đã che;
phải test cross-user claim, upload replay, transaction rollback, cleanup,
export/erasure. Pipeline ảnh Google ADR-0043 không thay thế pipeline private.

Credit helper hỗ trợ +50/+70 trong cùng transaction; production approval chưa
truyền approved photo count và vẫn +50. #794 phải cung cấp count menu/bill đã
duyệt trong transaction approval trước bật ảnh. Một row ledger/source/venue,
không cộng thêm khi retry, không retroactive upgrade 50→70, tổng tối đa 70.
Không thưởng draft/submit/merged/rejected. Không emit metric mới; limiter dùng
action cố định `places.draft_save`. Không log note/tips/receipt/ảnh/payload.

## Migration và vận hành

Migration **0089** nằm sau upstream 0088 (submission display snapshot), giữ nguyên
idx/tag/time của upstream. Chạy migration trước rollout binary; add nullable enrichment,
nháp FK/index, seed additive taxonomy và nới ledger delta 50/70. Không backfill.
Tại rollout đặt lock_timeout phù hợp maintenance budget (ví dụ 5s); DDL ALTER
ledger có ACCESS EXCLUSIVE ngắn. CHECK mới NOT VALID vẫn chặn write sai, không
scan ledger khi giữ lock mạnh. Sau db:migrate COMMIT, chạy
`scripts/ops/validate-contribution-credit-ledger.sql` để scan lịch sử bằng
VALIDATE (lock nhẹ hơn, retry được). Test nâng cấp snapshot có dữ liệu và validate
sau COMMIT trong integration; cần đo lock/latency trên snapshot gần production
trước merge. Không chạy DDL thử trên production trong phiên này.

Rollback ưu tiên binary cũ, **giữ schema/data/ledger 70**. Binary cũ chỉ cộng
50 cho nguồn mới; unique source/venue tiếp tục chống cộng lại. Tắt CTA wizard
ở client/CMS khi rollback. Không hạ ledger CHECK về delta=50 khi đã có row 70;
không đảo credits hoặc sửa ledger lịch sử.

Schema rollback chỉ sau backup/export an toàn, dừng writer/worker nháp và xác
nhận được phép bỏ dữ liệu mới:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE place_contribution_drafts;
ALTER TABLE place_submissions DROP COLUMN enrichment;
COMMIT;
```

Giữ seed taxonomy và CHECK 50/70 để tránh phá references/ledger. Nếu roll forward
sau schema rollback, khôi phục table/cột từ phần DDL 0089 (không chạy lại toàn
migration và không sửa migration journal tùy tiện). Bản backup chứa free text
phải nằm trong cơ chế retention/privacy của môi trường.

## Gate và phụ thuộc

Astra + CODEOWNER OpenAPI/migration chưa được thực hiện. #794 còn BLOCKED như
trên; #795 (migration 0085/ADR 0045) đang song song và chưa được nhập. Chưa truy
cập được Stitch MCP trong phiên này, không tuyên bố visual acceptance.
CMS/mobile regenerate client, dựng state lỗi/nháp và QA trên build có SHA sau
merge; local unit/integration không thay DEV acceptance. Không commit/push.

## Kết quả kiểm tra local 2026-11-07

Base `1ee7544`, branch `feature/GOGO-796-place-wizard`, working tree chưa commit.
Không install/commit/push. PostgreSQL/PostGIS chạy bằng Testcontainers; provider
và storage trong integration là test adapters hiện có, không phải DEV acceptance.

| Check                                                                                                                                  | Kết quả                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm exec vitest run --project unit`                                                                                                  | PASS: 256 files, 3443 tests                               |
| Unit enrichment sau sửa extension import cho NodeNext                                                                                  | PASS: 22 tests                                            |
| `pnpm exec vitest run --project integration apps/api/test/contribution-wizard.int.spec.ts apps/api/test/submission-review.int.spec.ts` | PASS: 2 files, 58 tests                                   |
| `pnpm exec turbo run typecheck --cache-dir=/tmp/gogo-796-turbo-cache`                                                                  | PASS: 8 packages                                          |
| `pnpm lint` + ESLint các file thay đổi sau lượt cuối                                                                                   | PASS                                                      |
| Prettier các file TS/YAML/JSON/docs thay đổi                                                                                           | PASS                                                      |
| `pnpm api:types` / `pnpm api:check`                                                                                                    | PASS, generated types khớp spec                           |
| `pnpm api:routes`                                                                                                                      | PASS: 310 served / 310 documented, zero missing/duplicate |
| `pnpm api:version /tmp/gogo-796-base.yaml openapi/gogo.v1.yaml`                                                                        | PASS: 7.0.0-alpha.1 → 7.1.0-alpha.1                       |
| `git diff --check`                                                                                                                     | PASS                                                      |

Lượt integration đầu phát hiện test double thiếu knownProviderPlace; fixture đã
sửa. Lượt HTTP đầu thiếu seed của photo adapter khi flag đã bật bởi test trước;
đã seed rõ ràng và chạy lại toàn bộ hai suite. Approval với ảnh Google vẫn chỉ
+50; ảnh này không phải evidence menu/bill. Các lỗi fixture không phải bằng chứng
FAIL-before của một defect production.

Local tests không thay Astra/CODEOWNER, oasdiff CI, đo lock trên snapshot gần
production, đối chiếu Stitch hoặc CMS/mobile acceptance. Không chạy cả bộ
integration toàn repository. Cần owner chốt các lựa chọn mới: taxonomy/chip ở
ADR, retention 30 ngày/cap 20 nháp, và quy trình mask/duyệt receipt của #794.
