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
nhưng khi gửi phải đủ purpose, 1–3 vibe, rating phục vụ/không gian 1–5.
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
(checkin_tag). Các chip checkin_tag được kiểm tra theo nhóm service/space.
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
key hoặc cờ masked/approved từ client. BLOCKED trên #794: upload private,
claim owner trong cùng transaction, decode/re-encode và strip metadata, OCR +
mask tên/số điện thoại/địa chỉ cá nhân/mã thanh toán, rà soát mask trước CMS,
private signed delivery chỉ cho bản sanitised, cleanup/export/erasure.
Không dùng pipeline ảnh Google công khai ADR-0043. Trong binary này, nonempty
photos trả 503 SUBMISSION_EVIDENCE_BLOCKED (retryable false) trước khi ghi DB;
CMS không nhận bytes hay URL ảnh thô. Không giả lập OCR hoặc cho client tự xác
nhận đã che. Điểm nối credit chỉ được gọi với số ảnh menu/bill đã duyệt từ
pipeline server; không nhận trường credit/approved từ request.

## Credit

Chỉ khi decision approved: +50 cơ bản; +20 nếu ít nhất một ảnh menu/bill của
submission được duyệt, tổng +70. Không cộng khi draft, submit, merged/rejected.
Một ledger row approval có delta 50 hoặc 70, unique submission và venue giữ
idempotency xuyên retry/concurrency. Account lock + ledger insert + balance
update trong transaction approval. Hiện chưa có #794 nên grant vẫn +50;
không cấp bonus dựa trên reference do user gửi. Cần nối kiểm tra ảnh đã duyệt
trong cùng transaction approval sau merge #794, trước khi bật ảnh cho client.

## Hệ quả, rollout và rollback

OpenAPI additive MINOR 7.5.0-alpha.1, client cũ không đổi. Migration 0089
(sau 0088 submission display snapshot), ADR 0048; giữ nguyên migration/ADR upstream.
Triển khai schema trước binary; không backfill facts hoặc credits lịch sử.
Runbook `docs/place-contribution-wizard.md` mô tả rollback/retention.
Không emit metric mới; dùng rate limiter/log redaction hiện có, không log payload.
Astra/CODEOWNER và tích hợp CMS/mobile vẫn là merge/acceptance gates riêng.
