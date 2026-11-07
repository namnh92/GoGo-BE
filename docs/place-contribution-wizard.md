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
Mọi key amenity active do CMS quản lý đều hợp lệ; cả service và space nhận
checkin_tag active, không ép prefix. Kiểm tra kind/enabled ở mỗi request.
Không dùng id hoặc label hiển thị làm key.

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

## Ảnh private và phần receipt còn thiếu

Tối đa năm `{mediaId:UUID,kind:"menu"|"bill"}`. Menu refs được gộp với mediaIds
và đi qua pipeline private #794: verify/claim owner, sanitize, strip EXIF,
cleanup và chỉ CMS đọc derivative pending. Tổng số ảnh gộp vẫn tối đa năm;
reference trùng giữa hai trường chỉ claim một lần. Approval/merge cần chọn ảnh.

Bill refs vẫn trả 503 SUBMISSION_EVIDENCE_BLOCKED, retryable false, vì repo chưa
có OCR/mask PII server-side theo ADR-0048. Không bật receipt hoặc thay bằng OCR
giả. Đây là blocker hoàn tất #796, độc lập với Docker/integration.

Credit +50 khi approved; +20 nếu ít nhất một menu/bill ref trong proposal gốc
có ảnh server-approved, do contributor gốc upload. Count đọc trong transaction
sau photo decision. Không thưởng ảnh thường, dedupe contributor, draft/submit,
merged/rejected hoặc evidence bị bỏ. Một row ledger/source/venue, không cộng
lại khi retry và không retroactive upgrade 50→70. Không log payload.

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

Astra + CODEOWNER OpenAPI/migration chưa được thực hiện. #794/#795/#798/#800
đã nằm trong base rebase `45d9d082`; #794 chưa có receipt OCR/mask PII.
Chưa tuyên bố visual acceptance hoặc DEV acceptance. Không install/commit/push.

## Kết quả kiểm tra local sau rebase 2026-11-07

Base `origin/re-design` = `45d9d082`, tree trên HEAD `58371ffc`, chưa commit.
Output đầy đủ và command replay:
[artifacts/be-796-gates/README.md](../artifacts/be-796-gates/README.md).

- Typecheck: 8/8 tasks pass; lint, prettier, api:types, diff check pass.
- Focused wizard/photo/identity/contract unit: 4 files, 62 tests pass.
- Full unit: 262 files pass, 3 fail. `sentry-request` bị sandbox chặn listen;
  hai lỗi timing ở grounding và room-subscription pass khi chạy lại riêng
  (55 tests), không sửa test/tăng timeout. Full gate vẫn chưa xanh.
- Full integration đã thử: 103 suites không khởi tạo được container runtime,
  1 suite skipped; 15 tests pass, 2137 skipped. Docker socket permission denied.
  Không tuyên bố DB/HTTP regressions mới đã pass.
- Oasdiff Docker bị từ chối; checker actual outcome=failure trả exit 2.
  Exception owner cho credit delta đã ghi exact-byte hash. Fixture replay nhận
  đúng một exception nhưng live measurement/replay vẫn UNVERIFIED.

Receipt masking thật còn thiếu để hoàn tất #796. Local gates không thay
Astra/CODEOWNER, đo lock trên snapshot gần production, đối chiếu Stitch hoặc
CMS/mobile acceptance. CMS/mobile cần regenerate client trước rollout credit 70.
