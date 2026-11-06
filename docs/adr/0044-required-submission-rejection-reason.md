# ADR-0044: Bắt buộc reason key khi từ chối đóng góp địa điểm

- **Status:** accepted
- **Date:** 2026-11-07
- **Deciders:** product owner / CODEOWNER `openapi/gogo.v1.yaml`, quyết định
  trong session GoGo-BE#787 / PR #790 ngày 2026-11-07.

## Context

GoGo-BE#787 (MobileApp#482 nhóm 03, màn 3.4) cần trả lý do từ chối ổn định cho
người gửi, không lộ ghi chú moderator. FR-INGEST-015 yêu cầu lưu audit quyết định.
API cũ chấp nhận `POST /v1/cms/place-submissions/{id}/decide` với
`{"decision":"rejected","reason":"duplicate"}`. API mới dùng `oneOf` theo
decision và bắt buộc `rejectionReason` khi rejected; payload cũ nay trả 400
`VALIDATION_FAILED`, `field_errors` trỏ tới `rejectionReason`.

CI tại `7b5e8b8` báo đúng một finding `request-body-wrapped-in-one-of` trên
operation này. Dù response chỉ thêm trường tùy chọn, việc thu hẹp request đã
rút lại một bảo đảm công khai; phân loại MINOR trước đó không đúng BE-BFF-012.

## Options considered

1. Cho phép thiếu key hoặc suy diễn từ ghi chú nội bộ để giữ tương thích — không
   bảo đảm key cho rejection mới; ghi chú tự do không có ánh xạ đáng tin cậy.
2. Giữ key bắt buộc tại API và công bố breaking change — đáp ứng quyết định
   owner, yêu cầu CMS và BE triển khai phối hợp.

## Decision

Chọn phương án 2 theo quyết định owner ngày 2026-11-07. Contract tăng MAJOR từ
`6.5.0-alpha.1` lên **`7.0.0-alpha.1`**, theo BE-BFF-012 và tiền lệ ADR-0027 /
ADR-0040. Không nới validation để né oasdiff. `rejectionReason` phải là một
trong sáu key `SubmissionRejectionReason` khi rejected. `reason` là ghi chú nội
bộ, tùy chọn khi rejected và vẫn bắt buộc khi approved/merged.

`openapi/CHANGELOG.md` ghi consumer note. `.github/oasdiff-exceptions.json`
chỉ nhận một finding đầy đủ cho đúng method/path và cặp SHA-256 của base/revision
cuối cùng. Thay đổi contract bytes hoặc có finding khác vẫn phải fail; không
sửa checker hay policy workflow. CODEOWNER contract là `@namnh92` (CODEOWNERS);
quyết định owner trong session là căn cứ, không thay cho kết quả CI hay review.

## Consequences

GoGo-CMS phải deploy cùng GoGo-BE: đồng bộ contract, regenerate client và bắt
buộc chọn reason key khi reject. CMS cũ chỉ gửi ghi chú nay nhận 400; không có
fallback. Client hiển thị nhãn qua i18n, không đưa ghi chú moderator vào response
công khai. Các consumer regenerate client; rejection lịch sử thiếu key tiếp tục
bỏ trường `rejectionReason` và hiển thị thông báo chung. Quyền, audit, ownership
và các quyết định approved/merged giữ nguyên.

## Migration & rollback

Áp dụng migration 0084 và validation sau COMMIT theo
`docs/submission-rejection-reasons.md`, rồi rollout CMS và BE cùng đợt. Thử CMS
reject với key hợp lệ và xác nhận payload cũ thiếu key trả 400 trước acceptance.
Consumer công khai phải chịu được key bị thiếu trên dữ liệu lịch sử.

Nếu rollback, phối hợp rollback CMS/BE, ưu tiên rollback binary và giữ cột
nullable cùng key/audit đã ghi. Binary cũ có thể ghi rejection thiếu key; client
vẫn dùng thông báo chung. Không suy diễn hoặc backfill key từ ghi chú. Chỉ drop
schema theo runbook khi đã dừng writer và bảo toàn dữ liệu cần giữ; không đổi
hash exception để hợp thức hóa contract khác.
