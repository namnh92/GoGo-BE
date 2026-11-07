# ADR-0048: Wizard bổ sung thông tin địa điểm

- Status: proposed — cần Astra và CODEOWNER OpenAPI/migration trước merge
- Date: 2026-11-07
- Scope: GoGo-BE#796; FR-INGEST-010..015; core rules 8, 13

## Context và phương án

Wizard có ba bước: giá/mục đích, vibe/tiện ích, bằng chứng/mẹo/đánh giá.
Không dùng sample Stitch làm dữ liệu. So sánh ghi trực tiếp place facts với lưu
proposal trên submission: chọn proposal; người đóng góp không có quyền xác minh.
Ba screen ID tham chiếu: 10756253768045112131,
2fd3b7e365954d6db9ef612d361a1bbf, 3d9ed7f6136a477c85c76057aafff0b4
(project 17315762413421369447). Stitch MCP chưa có trong phiên triển khai;
chưa tuyên bố đã đối chiếu thiết kế.

## Quyết định

`place_submissions.enrichment` JSONB giữ đề xuất chưa xác minh, tách
`review_draft` của moderator. Submit cũ vẫn chạy; trường enrichment mới tùy chọn,
nhưng khi gửi phải đủ purpose và 1–3 vibe. Service/space tùy chọn; bỏ trường
nghĩa là chưa cung cấp, không tự tạo rating. Nếu có, rating phải là integer 1–5.
Giá tùy chọn; nếu có phải kèm min/max integer minor units, currency VND và unit
per_person/per_group/per_item/per_hour/per_night; miễn phí có unit free và 0/0.
Thiếu giá nghĩa là chưa biết. Không suy ra giá, giờ mở cửa, rating hoặc amenity
catalogue từ enrichment, kể cả khi approve. CMS xem proposal rồi ghi lựa chọn
đã xác minh bằng review/editor hiện có; community rating mới không trộn provider.

Taxonomy lấy từ taxonomies active: purpose dùng suitability hiện có
(couple/group/family/work_reading), vibe dùng mood; amenities dùng amenity,
service/space chips dùng checkin_tag. Tái dùng car_parking, pets_allowed.
Không dùng power_outlets vì không khẳng định ổ cắm **từng bàn**. Seed key mới:
power_at_each_table, separate_smoking_area, open_after_23, tables_over_six
(amenity); service_friendly, service_attentive, space_quiet, space_spacious
(checkin_tag). Cả hai nhóm chip nhận mọi key checkin_tag đang active do CMS quản lý;
không ép prefix service_/space_ hoặc danh sách amenity cố định.
Migration khóa singleton taxonomy_version trước khi seed, rồi tăng generation và
updated_at trong cùng transaction với keys/labels, theo lock order của CMS (ADR-0047).
Client giữ ETag trước migration sẽ nhận 200 với vocabulary mới khi revalidate.
Boolean false là user khai không có; bỏ key nghĩa là chưa biết. Không lưu label.

Nháp nằm trong `place_contribution_drafts`, FK user CASCADE, không có provider
content/token. Client chọn UUID và PUT toàn bộ snapshot với expectedVersion
(0 khi tạo); mỗi lần lưu tăng version. GET tiếp tục, DELETE bỏ nháp; owner-only,
registered user-only; 404 cho nháp của người khác. Hết hạn sau 30 ngày kể từ lần
lưu cuối, API không đọc được; retention worker xóa vật lý. Tối đa 20 nháp/user.
Client đọc nháp, resolve lại link, POST submission với enrichment, rồi DELETE nháp
sau thành công. Không tự xóa nháp khi dedup/submit lỗi. Dedupe không ghi đè đề
xuất của contributor trước (FR-INGEST-012), không thêm credit cho người dedup.

## Ảnh và PII — phụ thuộc #794

Tối đa 5 reference UUID, mỗi reference có kind menu/bill. Không nhận URL/storage
key hoặc cờ masked/approved từ client. Menu/bill được nối vào pipeline #794:
gộp mediaIds và refs, verify owner, sanitise/strip metadata ngoài transaction,
claim upload trong transaction submission; chỉ CMS được xem derivative pending.
Bản public chỉ xuất hiện sau chọn ảnh rõ ràng khi approve/merge, theo ADR-0046, với tập userPhotos riêng theo amendment dưới đây.
Cleanup/export/erasure tái dùng pipeline này. Dedupe không ghi đè enrichment gốc.

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

Nháp claim media_uploads vào contribution_draft, thay storageKey bằng derivative
server riêng ngoài tmp/ và giữ đến expiresAt nháp. Snapshot/version, claim và
cleanup deadline commit cùng transaction. Save lại gia hạn; bỏ ref/delete/expiry/
erasure đẩy cleanup ngay. Khi gửi, recheck owner/nháp/claim dưới khóa rồi chuyển
claim sang submission; DELETE nháp sau đó không xóa ảnh đã chuyển. Original chỉ
đợi presigned URL hết hạn; không phụ thuộc lifecycle một ngày để giữ nháp.

## Credit

Chỉ khi decision approved: +50 cơ bản; +20 nếu ít nhất một ảnh menu/bill của
submission được duyệt, tổng +70. Merge chỉ +20 khi có evidence được chấp nhận; rejected/draft/submit không cộng.
Một ledger row approval có delta 20, 50 hoặc 70, unique submission và venue giữ
idempotency xuyên retry/concurrency. Account lock + ledger insert + balance
update trong transaction decision. Reason ledger lịch sử `submission_approved`
cũng dùng cho bonus-only 20 khi merge; không đổi unique source/venue. Sau photos.decide, đếm ảnh approved của submission có mediaUploadId trong
proposal gốc và uploader là contributor gốc, trong transaction approval.
Ảnh thường/ảnh của contributor dedupe không làm tăng bonus; không tin count client.
Menu/bill chỉ kích hoạt bonus khi ảnh đã qua pipeline private và được moderator duyệt.

## Hệ quả, rollout và rollback

OpenAPI additive MINOR 7.5.0-alpha.1, client cũ không đổi. Migration 0089
(sau 0088 submission display snapshot), ADR 0048; giữ nguyên migration/ADR upstream.
Triển khai schema trước binary; không backfill facts hoặc credits lịch sử.
Runbook `docs/place-contribution-wizard.md` mô tả rollback/retention.
Không emit metric mới; dùng rate limiter/log redaction hiện có, không log payload.
Astra/CODEOWNER và tích hợp CMS/mobile vẫn là merge/acceptance gates riêng.

## Contract compatibility exception (2026-11-07)

Owner quyết định giữ MINOR `7.5.0-alpha.1` và ghi exception
`BE-796-credit-delta-extensible` cho finding `response-property-became-not-enum`
của GET `/cms/users/{id}/assistant-credits`, property `items/items/delta`.
`delta` là integer với `x-extensible-enum: [20, 50, 70, -1]`, không còn closed enum.
CMS phải regenerate client và chấp nhận integer mới trước rollout +70.
Report oasdiff thực do owner cung cấp có thêm `request-body-one-of-removed` do
sửa description trong hai inline branch của decide. Khôi phục nguyên bytes hai
branch từ `origin/re-design`; chuyển quy tắc userPhotos/cleanup lên description
của operation. Mọi ảnh menu/bill được duyệt đều public trong userPhotos, không
vào official gallery/cover. Rebind exception hiện có theo SHA-256 raw YAML cuối.
Replay policy với riêng finding credit được giữ lại PASS; đây không phải đo mới.
Docker socket vẫn bị từ chối nên chưa xác minh tập finding cuối bằng oasdiff.
Không miễn finding nào khác. Output và command replay:
`docs/verification/be-802-owner-visibility.md`.

## Amendment #806 — Giữ/bỏ từng mục (2026-11-07)

Task PLACES-WIZ-BE-2 bổ sung lựa chọn explicit của moderator/editor, không tự
promote proposal. Quyết định giữ là xác nhận từng fact, độc lập với quyết định
chỉ chấp nhận danh tính địa điểm. Chọn các stable keys và photo mediaIds, bỏ
các mục còn lại; lưu nguyên proposal gốc. `places.contribution_facts` nullable
JSONB giữ facts đã chọn, không user id/ảnh/consent. Price/taxonomy dùng đường
catalogue hiện có khi biểu diễn được; per_group/free giữ đúng unit trong facts,
không chuyển đơn vị giả định. Service/space không thành aggregate rating.

Chọn giữ/bỏ là additive contract 7.6.0-alpha.1. Không chọn field bắt buộc vì sẽ
phá CMS cũ; omission giữ đúng #802 (no facts, merge bonus-only). CMS mới phải
explicit selection trong flow wizard. Đường mới approve/merge +50 base và +20
khi giữ ít nhất một menu/bill gốc, vẫn bị ràng buộc unique ledger hiện có.
Preview và award dùng chung công thức BE; không client math.

Migration 0090 schema-first, không backfill. Giữ cột khi rollback binary; không
xóa lịch sử ledger/audit. Runbook/mapping/rollback đầy đủ:
[place-contribution-keep-drop.md](../place-contribution-keep-drop.md).
Astra/CODEOWNER và fresh oasdiff/integration vẫn là cổng riêng trước merge.
