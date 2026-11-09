# ADR-0043: Một ảnh Google khi admin duyệt đề xuất địa điểm

- **Status:** accepted, owner authorization 2026-11-07, GoGo-BE#786
- **Date:** 2026-11-07

## Context

FR-INGEST-010 yêu cầu xem trước ảnh khi thêm địa điểm bằng link. ADR-0030 chỉ
cho phép ảnh tạm thời. Owner cho phép ngoại lệ hẹp: sau khi admin duyệt đề xuất,
GoGo giữ tối đa một ảnh provider để Place Detail có ảnh. Ngoại lệ này không biến
ảnh Google thành dữ liệu GoGo-owned và không mở đường lưu nội dung Google khác.

## Options

1. Lưu ảnh hoặc tên ảnh từ lúc resolve/pending: loại vì vi phạm ranh giới duyệt.
2. Token chứa ảnh/tên ảnh rồi lưu theo submission: loại vì vẫn lưu trước duyệt.
3. Resolve chỉ trả tham chiếu BFF; duyệt lấy lại ảnh đầu hiện tại: chọn.

## Decision

- Resolve tra danh sách ảnh, không mua media, trả tối đa một `candidate.photo`
  với URL BFF, Google Maps attribution và credit tác giả; không có ảnh hoặc flag
  tắt thì bỏ trường. Không cache/persist ref, URL hay bytes trước duyệt.
- App GET URL BFF nhận JSON theo `PlaceProviderPhotos`, tối đa một ảnh base64.
  URL này không phải image src. Credit trong response proxy là authoritative:
  Google có thể đổi thứ tự ảnh giữa resolve, tải preview và admin duyệt.
- Khi admin duyệt, BE lấy ảnh đầu hiện tại, không bảo đảm đúng bytes của preview
  cũ. Reject/merge không tải hoặc lưu ảnh. Google identity đổi thì không lấy ảnh.
- Dùng chung `place_provider_photos.enabled`, default-off env flag, budget
  `google.places.display`, cost metering của adapter, 800px, 400KiB, deadline 6s,
  retry một lần nếu ref hết hạn; endpoint proxy giới hạn 10/min/IP và no-store.
- Ảnh được lưu trong public catalogue bucket dưới `places/provider/`, cache
  private/no-store; ghi `place_media` approved, `source_type=google_derived`.
  `provider_photo` giữ Google Place ID, thời điểm fetch, credit có cấu trúc và
  Google Maps URI. Không lưu Google photo name hoặc media retrieval URL/key.
  Card/detail trả `source=google`, attribution và credit riêng từng ảnh.
- Provider/budget/storage failure: trả 503 retryable, đề xuất vẫn pending để
  admin thử lại. Flag tắt hoặc provider xác nhận không có ảnh thì vẫn duyệt được.
  DB failure vẫn rollback như cũ. Không giữ transaction trong lúc gọi provider/storage.
- Trước upload, ghi cleanup intent có delay một giờ; commit media xoá intent
  trong cùng transaction. Upload/transaction lỗi hoặc process crash để lại intent
  cho worker hiện có; compensation kiểm tra tham chiếu sống trước khi xoá.
  CMS không được xoá/thay Google attribution khi reorder/chỉnh caption.
- Resolve có `Idempotency-Key` vẫn không lưu/replay response; mỗi lần retry lấy
  preview mới. CMS mutation và detail trả `authorAttributions`, `googleMapsUri`
  của ảnh đã lưu để client hiển thị credit riêng từng ảnh.
- Detach tham chiếu cuối của ảnh provider enqueue cleanup public trong cùng
  transaction; lỗi enqueue rollback cả detach. Các detach cùng storage key
  được tuần tự hoá để không mất cleanup khi hai tham chiếu bị xoá đồng thời.

## Consequences

Có tối đa một lần photoRefs miễn phí ở resolve; proxy và approve mỗi lần có tối
đa hai media calls (retry ref hết hạn), đều reserve budget. Google photo không
trở thành canonical ownership của GoGo. Chiều rộng/chiều cao gốc không được ghi
thành kích thước bytes đã resize. Không tạo media_uploads giả hoặc cấp quyền
upload cho client. Nguồn requirement workspace cần cập nhật ngoại lệ này bởi
owner/Claude; file ngoài worktree không thay trong task này.

## Migration & rollback

Migration 0083 thêm cột jsonb nullable, không rewrite/backfill. Tắt flag dừng
preview và lưu ảnh mới; ảnh đã duyệt vẫn giữ attribution trên detail. Muốn xoá
ngoại lệ: enqueue từng storage_key provider trong cleanup queue khi detach media,
đợi worker xoá bytes rồi drop cột provider_photo. Không drop metadata trước khi
xoá media vì sẽ mất credit. Không thay hành vi transient detail ADR-0030.

## Owner extension 2026-11-07 — GoGo-BE#797

Owner cho phép ops backfill một ảnh Google cho địa điểm published có Google
Place ID và chưa có media approved, chấp nhận chi phí một ảnh/địa điểm. Script
`places:backfill-provider-photos` dùng lại pipeline approve #786 (fetch, budget,
storage, cleanup intent, metadata/credit); không mở rộng sang nội dung khác.
Dry-run mặc định chỉ đọc; probe chỉ Details; persist chỉ với `--apply` rõ ràng.
Recheck eligibility/identity dưới row lock trước attach, system moderation và
audit riêng. F-01 r1: loại mọi media pending/approved và mọi cover (kể cả rejected)
trước purchase và attach. Reserve at-most-once bằng audit append-only
`place.provider_photo_backfill_attempt`, commit dưới row lock trước provider I/O;
giữ reservation khi lỗi/crash/không có ảnh để rerun không mua lại. Không tự retry
attempt đã reserve; không đổi hành vi retry approval của #786. Không đổi contract/schema. Xem
[runbook #797](../runbooks/place-provider-photo-backfill.md) cho giới hạn, chi phí,
kill switch, cleanup và rollback.

## Amendment — GoGo-BE#822 (2026-11-09)

[ADR-0052](0052-stored-submission-provider-photo.md) supersedes the photo timing,
transient-only/cache and CMS no-provider guarantees for **one stored cover** at
submit/CMS create. Approval reuses bytes; merge may attach; rejection retains and
shows the cover for seven days. No other provider content rule is changed.
