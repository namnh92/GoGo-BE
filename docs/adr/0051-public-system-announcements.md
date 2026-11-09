# ADR-0051 — Thông báo hệ thống đọc được khi chưa đăng nhập

**Ngày:** 2026-11-09. **Trạng thái:** triển khai theo GoGo-BE#815, quyết định owner
ngày 2026-11-09; contract/migration vẫn cần CODEOWNER review.

## Bối cảnh

Hộp thư hiện tại chỉ có `/me/notifications*`; người chưa đăng nhập không thấy
thông báo bảo trì/cập nhật. Tái sử dụng inbox theo tài khoản không giải quyết
được audience này và tạo fan-out, unread state không cần thiết.

## Quyết định

Tạo `system_announcements` riêng bằng migration 0093; locale vi, kind text mở
rộng, draft/published/archived. CMS ops/super admin quản lý; mọi thay đổi thật có
audit append-only trong cùng transaction. POST tạo bắt buộc replay key transactional.
Publish/archive khóa hàng; archived cuối vòng đời; published có thể sửa copy.

Cung cấp `GET /v1/system-notifications` công khai, giới hạn 60/phút/IP, filter
publication/expiry tại DB, cursor `(published_at DESC,id DESC)` giữ microsecond.
DTO chỉ có bảy trường công khai; title/body là copy biên tập CMS, được phép trả
nguyên văn. Chỉ chấp nhận canonical gogo app link theo allowlist route.
Shared cache max-age 60 + ETag của page, 304 không body; chấp nhận độ trễ cache
tối đa 60 giây khi hết hạn/ẩn/sửa. Không thêm cache nội bộ hay purge pipeline.

Client signed-in hiển thị phần này trên inbox cá nhân. Không nhân bản hàng inbox,
không unread/read state hay push; ADR-0050 không đổi. OpenAPI **7.8.0-alpha.1** là
MINOR chỉ thêm paths/schemas; không thay đổi guarantee cũ.

## Hệ quả và rollback

Mọi người nhận cùng nội dung công khai, không phụ thuộc tài khoản/preferences.
Không hỗ trợ lịch publish, đa ngôn ngữ hay republish archived trong slice này.
0093 là DDL ngắn transactional, lock timeout 5 giây, không backfill. Rollback binary
giữ schema/audit; physical removal cần migration bảo trì riêng sau drain/export.
Chi tiết API, metrics, test và vận hành: [system-notifications.md](../system-notifications.md).
