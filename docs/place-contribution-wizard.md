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
| GET /place-submissions/{id}                      | Contributor gốc đọc enrichment; contributor dedupe chỉ đọc trạng thái                                    |
| GET /cms/place-submissions/{id}                  | Contribution chứa enrichment để CMS xem; chưa phải place facts                                           |

`enrichment` khi submit cần purposeKeys (suitability active), 1–3 vibeKeys
(mood active). Service/space tùy chọn; bỏ trường nghĩa là chưa cung cấp, không
tự tạo rating. Nếu có, dùng `{rating:1..5, chipKeys:[]}` với rating integer.
Nháp cho phép bỏ các
trường chưa xong; trường đã có vẫn phải hợp lệ. Nhãn lấy `GET /taxonomies`.
Amenity dùng map key → boolean: bỏ key là chưa biết; false là user khai không có.
Mọi key amenity active do CMS quản lý đều hợp lệ; cả service và space nhận
checkin_tag active, không ép prefix. Kiểm tra kind/enabled ở mỗi request.
Không dùng id hoặc label hiển thị làm key.
Migration seed khóa và tăng taxonomy_version cùng transaction với keys/labels;
ETag cache trước migration phải revalidate thành 200 với vocabulary mới.

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

## Ảnh private, receipt và lưu nháp

Tối đa năm `{mediaId:UUID,kind:"menu"|"bill"}`. Menu refs được gộp với mediaIds
và đi qua pipeline private #794: verify/claim owner, sanitize, strip EXIF,
cleanup và chỉ CMS đọc derivative pending. Tổng số ảnh gộp vẫn tối đa năm;
reference trùng giữa hai trường chỉ claim một lần. Approval/merge cần chọn ảnh.

Owner decision cuối cùng 2026-11-07 thay mọi lựa chọn visibility trước đó:
“Không phải việc khách chọn Chỉ GoGo xem hay Công khai. Xác định up là công khai cho mọi người luôn.”
Không nhận trường `visibility`. Mọi ảnh menu/bill là đóng góp công khai **sau khi moderator duyệt**.
Mỗi request lưu nháp hoặc submit có bill phải gửi `enrichment.billPhotoPublicConsent: true`.
Consent bắt buộc hiển thị cho user:
“Tôi đồng ý ảnh hóa đơn được hiển thị công khai sau khi kiểm duyệt và xác nhận đã tự xóa hoặc che thông tin cá nhân trên ảnh.”
Thiếu/false trả 400 `VALIDATION_FAILED`, field error `enrichment.billPhotoPublicConsent`.
Menu không cần consent bổ sung. Không DLP, không provider/dịch vụ xử lý PII bên ngoài;
WebP re-encode chỉ strip metadata, không tự che nội dung ảnh. Moderator có thể bỏ
bất kỳ ảnh nào, ví dụ còn thông tin cá nhân, trước khi duyệt.

Amendment cuối cùng cùng ngày: ảnh wizard là **ảnh từ người dùng** của địa điểm,
không phải ảnh chính. Approval/merge chỉ liên kết `place_submission_photos.place_id`
và đổi status thành approved trong transaction quyết định; không tạo `place_media`.
GET place detail trả `userPhotos` riêng, credit `contributor.displayName` của uploader gốc;
không dùng làm gallery `photos` hay cover. Pending/rejected không xuất hiện trong tập này.
BFF đọc bytes recheck status approved và place published/community_submitted mỗi lần;
CMS preview chỉ cho pending. Account erased không còn credit định danh.
Chỉ Editor/Moderator được promote vào gallery chính qua endpoint riêng, theo dõi ở
[GoGo-BE#804](https://github.com/namnh92/GoGo-BE/issues/804); không triển khai endpoint promote ở đây.
#804 cũng theo dõi migration/backfill ảnh thường #794 đã nằm trong gallery;
không tự chuyển dữ liệu lịch sử trong migration 0089.

Prefix `submission-photos/menus/` giữ menu trong user-photo set qua nháp/dedupe.
Prefix `submission-photos/bills/` giữ phân loại bill qua nháp/dedupe/relabel,
để không thể bỏ consent bằng cách đổi kind. Ảnh pending luôn ở private storage;
không có public URL trước approval. Bill không được chọn hoặc rejected được enqueue
xóa bytes/derivatives ngay trong transaction, thử cleanup sau commit, worker retry.
Menu rejected giữ retention #794 (7 ngày). Bill approved giữ bytes cho userPhotos.
Original còn PUT URL được xóa theo deadline và giữ job dọn nếu upload tái tạo trước expiry.
Nháp hết hạn/bỏ ref/delete/erasure release bytes qua cleanup queue.
Không log ảnh, nội dung bill hoặc storage error thô.

Save nháp verify owner/bytes, copy derivative vào private `submission-photos/`
ngoài lifecycle `tmp/`, claim cho đúng một nháp và giữ đến hết 30 ngày của nháp.
Mọi bill còn pending/nháp đều ở storage private; chỉ ảnh được duyệt mới có public read trong userPhotos. Save lại tạo derivative mới và gia hạn cùng transaction;
bỏ ref hoặc DELETE đẩy cleanup ngay. Expiry/erasure cũng release bytes qua cleanup
queue có retry. Submit recheck owner/expiry/claim trong transaction và chuyển claim
sang submission; sau đó xóa nháp không ảnh hưởng ảnh submission. Upload ID vẫn ổn
định dù URL PUT hết hạn 900s và original đã bị lifecycle xóa.

Credit +50 khi approved; +20 nếu ít nhất một menu/bill ref trong proposal gốc
có ảnh server-approved, do contributor gốc upload. Count đọc trong transaction
sau photo decision. Không thưởng ảnh thường, dedupe contributor, draft/submit,
rejected hoặc evidence bị bỏ. Merge nhận +20 nếu evidence được chấp nhận; không có +50 base. Một row ledger/source/venue, không cộng
lại khi retry và không retroactive upgrade 50→70. Không log payload.

## Migration và vận hành

Migration **0089** nằm sau upstream 0088 (submission display snapshot), giữ nguyên
idx/tag/time của upstream. Chạy migration trước rollout binary; add nullable enrichment,
nháp FK/index, seed additive taxonomy và nới ledger delta 20/50/70. Không backfill.
Tại rollout đặt lock_timeout phù hợp maintenance budget (ví dụ 5s); DDL ALTER
ledger có ACCESS EXCLUSIVE ngắn. CHECK mới NOT VALID vẫn chặn write sai, không
scan ledger khi giữ lock mạnh. Sau db:migrate COMMIT, chạy
`scripts/ops/validate-contribution-credit-ledger.sql` để scan lịch sử bằng
VALIDATE (lock nhẹ hơn, retry được). Test nâng cấp snapshot có dữ liệu và validate
sau COMMIT trong integration; cần đo lock/latency trên snapshot gần production
trước merge. Không chạy DDL thử trên production trong phiên này.

Rollback ưu tiên binary cũ, **giữ schema/data/ledger 20/70**. Binary cũ chỉ cộng
50 cho nguồn mới; unique source/venue tiếp tục chống cộng lại. Tắt CTA wizard
ở client/CMS khi rollback. Không hạ ledger CHECK về delta=50 khi đã có row 20/70;
không đảo credits hoặc sửa ledger lịch sử.

Schema rollback chỉ sau backup/export an toàn, dừng writer/worker nháp và xác
nhận được phép bỏ dữ liệu mới:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Dừng writer mới; backup user-photo links để roll forward.
-- Không duyệt menu/bill bằng binary cũ: nó sẽ ghi nhầm vào gallery.
ALTER TABLE place_submission_photos DROP COLUMN place_id;
DROP TABLE place_contribution_drafts;
ALTER TABLE place_submissions DROP COLUMN enrichment;
COMMIT;
```

Giữ seed taxonomy và CHECK 20/50/70 để tránh phá references/ledger. Nếu roll forward
sau schema rollback, khôi phục table/cột từ phần DDL 0089 (không chạy lại toàn
migration và không sửa migration journal tùy tiện). Bản backup chứa free text
phải nằm trong cơ chế retention/privacy của môi trường.

## Gate và phụ thuộc

Astra + CODEOWNER OpenAPI/migration chưa được thực hiện. #794/#795/#798/#800
đã nằm trong base rebase `45d9d082`. Owner decision cuối cùng yêu cầu public consent, bỏ visibility và tách userPhotos.
Chưa tuyên bố visual acceptance hoặc DEV acceptance. Không install/commit/push.

## Kết quả lịch sử trước bản sửa Astra r2 (2026-11-07)

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

Kết quả mới của bản sửa r2 nằm trong `artifacts/be-802-r2/README.md`.
Docker integration và fresh oasdiff vẫn cần kiểm tra ngoài sandbox.
Local gates không thay
Astra/CODEOWNER, đo lock trên snapshot gần production, đối chiếu Stitch hoặc
CMS/mobile acceptance. CMS/mobile cần regenerate client trước rollout credit 70.

## F-06: tương thích request (r2/r3)

`estimatedPrice.min/max` của request cũ không required trong OpenAPI. Runtime
chấp nhận field bị bỏ qua thay vì siết contract (breaking). Đây là mismatch riêng
với F-06 của service/space. Enrichment chỉ required purposeKeys/vibeKeys;
service/space tùy chọn cả trong OpenAPI, generated types và runtime, không tự tạo
rating khi bỏ qua. ContributionPrice và ContributionRating vẫn kiểm tra đầy đủ
required fields khi object được cung cấp. Client cũ không phải gửi field mới.

## Payload consent và kiểm chứng owner decision

Ví dụ phần enrichment của request lưu nháp (submit thêm các bước bắt buộc):

```json
{
  "billPhotoPublicConsent": true,
  "photos": [{ "mediaId": "00000000-0000-4000-8000-000000000001", "kind": "bill" }]
}
```

`approvedPhotoIds` chọn menu/bill để hiển thị trong `userPhotos` có credit uploader,
không ghi gallery/cover. Sau commit, API thử cleanup bill bị loại; durable queue retry
nếu storage lỗi. Original giữ deadline PUT expiry để chống tái upload.
Ledger giữ reason lịch sử `submission_approved` cho cả grant 20 khi merge;
unique submission/venue không đổi, không tạo grant thứ hai khi retry.
Gate hiện tại và output oasdiff: `docs/verification/be-802-owner-visibility.md`.
