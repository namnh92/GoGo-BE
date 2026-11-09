# Thông báo hệ thống công khai — GoGo-BE#815

Contract **7.8.0-alpha.1**, migration **0093**, [ADR-0051](adr/0051-public-system-announcements.md).
Yêu cầu owner ngày 2026-11-09 bổ sung kênh đọc công khai, liên quan FR-USER-011,
FR-CMS-001/008 và FR-LINK-004 của SRS. `title`/`body` là nội dung biên tập do CMS
soạn, được trả nguyên văn; đây là ngoại lệ nội dung biên tập, không phải câu ghép
từ dữ kiện nghiệp vụ hay dữ liệu provider.

## Đọc công khai

`GET /v1/system-notifications?limit=20&cursor=...` không cần token. Chỉ trả hàng
`published`, `published_at <= statement_timestamp()` và `expires_at IS NULL`
hoặc `expires_at > statement_timestamp()`; đúng thời điểm hết hạn là ẩn.
`kind` là chuỗi mở rộng, hiện có `maintenance`, `update`, `general`; client phải
chịu được khóa mới. `locale` lưu `vi`; chưa có chọn ngôn ngữ.

Mỗi item chỉ gồm `id`, `kind`, `title`, `body`, `deepLink`, `publishedAt`,
`expiresAt`. Không lộ actor quản trị, trạng thái draft, audit hay dữ kiện tài khoản.
Thời gian ISO-8601 UTC. `deepLink`/`expiresAt` có thể null.

Thứ tự `(published_at DESC, id DESC)`. Cursor giữ đủ microsecond PostgreSQL và
UUID, gắn mục đích public/CMS. `limit` từ 1–100, mặc định 20; `nextCursor` null
khi hết. Cursor sai → `400 INVALID_CURSOR`; query sai → `400 VALIDATION_FAILED`.
Keyset không giữ snapshot: bản tin mới phía trước cursor xuất hiện khi tải lại
trang đầu; thay đổi nội dung, ẩn hoặc hết hạn có hiệu lực trên mỗi lần đọc.

Giới hạn **60 request/phút/IP**, gồm cả conditional GET, qua RateLimitGuard và
store hiện có (Redis ở môi trường triển khai; fallback memory khi Redis lỗi).
IP lấy từ Fastify với TRUST_PROXY cấu hình tin cậy; không tự đọc X-Forwarded-For.
Vượt hạn trả `429 RATE_LIMITED` và Retry-After theo envelope hiện có.

`200` và `304` đều có `Cache-Control: public, max-age=60` và ETag SHA-256 của
**toàn bộ page DTO**, kể cả cursor. `If-None-Match` hỗ trợ danh sách, weak tag và
`*`; khớp → `304` không body. Tag ổn định khi dữ liệu không đổi; sửa nội dung,
publish, archive hoặc expiry làm thay đổi tag khi page đổi. Kiểm tra filter
trước so tag, không cache kết quả trong process. Shared cache có thể giữ nội dung
cũ tối đa 60 giây sau khi hết hạn/sửa/ẩn; không có purge CDN trong PR này.

**Client sau đăng nhập hiển thị phần công khai phía trên hộp thư cá nhân. Không
nhân bản vào inbox, không gửi push, không cộng unread count và không có API đánh
đã đọc cho thông báo công khai.** ADR-0050 và các tùy chọn push không đổi.

## CMS và vòng đời

Tất cả endpoint dưới `/v1/cms/system-notifications` chỉ cho `ops_admin` và
`super_admin`; `editor`/`moderator` nhận 403 kể cả GET. Dùng AdminGuard hiện có,
kiểm tra session và vai trò trong DB mỗi request.

| Thao tác           | Hành vi                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| GET                | `items`, `nextCursor`, sắp `(created_at DESC,id DESC)`, query `status`, `limit`, `cursor`; private/no-store |
| POST               | Tạo draft, kind/title/body bắt buộc; locale vi mặc định; deepLink/expiresAt tùy chọn/null; 201              |
| PATCH /{id}        | Sửa draft hoặc published; không nhận status/publishedAt/actor; ít nhất một trường; 200                      |
| POST /{id}/publish | Draft → published ngay, publishedAt do DB đặt; expiry phải còn hiệu lực; 200                                |
| POST /{id}/archive | Draft/published → archived; giữ dữ liệu và publishedAt; 200                                                 |

Archived là trạng thái cuối: không sửa/republish (409). Gọi lại publish/archive
ở đúng trạng thái trả 200, không thay publishedAt hay tạo audit mới. Thiếu ID → 404. Expiry sau publish phải lớn hơn publishedAt (400 nếu vi phạm); null gỡ expiry.
Đổi copy của published giữ vị trí publishedAt và làm đổi ETag.

POST tạo bắt buộc `Idempotency-Key` 8–128 ký tự `[A-Za-z0-9_-]`.
Claim + insert + audit + response replay commit trong **cùng transaction**. Retry
cùng actor/route/key/body trong 24 giờ trả 201 với DTO gốc, kể cả sau khi sửa
bản tin; đổi body → 422. Không có cửa sổ tạo bản tin mà mất replay record.
Các thao tác đổi trạng thái khóa hàng trước khi quyết định; retry cùng trạng
thái là no-op. PATCH khóa hàng để diff audit phản ánh đúng before/after.

Mỗi mutation thực sự ghi thêm `audit_logs` với action
`system_announcement.created|updated|published|archived`, actor admin, resource ID,
request ID và diff before/after. Audit và mutation commit hoặc rollback cùng nhau;
không có endpoint sửa/xóa audit. Copy là nội dung công khai; không nhập token/PII.

Đích `deepLink` chỉ nhận canonical `gogo://place/{uuid}`, `room/{uuid}`,
`plan/{uuid}`, `invite/{code}`, `l/{slug}`, `saved`, `notifications`, `profile`.
UUID chữ thường; code 6–64, slug 4–32 ký tự URL-safe. Không query/fragment,
credentials, alias, encoded path, URL ngoài hay route tùy ý. Link không trao quyền
truy cập resource: client/BFF vẫn kiểm tra quyền khi mở. Null nghĩa không có đích.

## Migration, vận hành và kiểm chứng

Chạy `pnpm db:migrate` trước binary mới. 0093 chỉ tạo bảng mới, constraints, hai
index nhỏ và FK admin; không backfill, không quét bảng inbox. Runner transactional,
`lock_timeout=5s`: timeout rollback toàn bộ migration; xử lý blocker rồi chạy lại,
không tăng timeout để ép khóa. Kind dùng text key hợp lệ thay PostgreSQL enum để
mở rộng loại về sau; API authoring hiện nhận ba loại đã định nghĩa.

Rollback binary giữ nguyên bảng/index/audit; binary cũ bỏ qua phần bổ sung.
Dừng client gọi API mới trước rollback. Nếu phải gỡ schema, dùng migration bảo trì
riêng sau khi drain traffic và xuất dữ liệu biên tập; giữ audit lịch sử. Không job
retention, backfill, inbox fan-out hay provider integration nào được thêm.

Metrics hữu hạn: `system_notifications_reads_total{status=200|304}` và
`system_notifications_writes_total{action=created|updated|published|archived}`
(chỉ sau commit, không đếm replay). HTTP/request/error telemetry hiện có theo dõi
latency, 429 và lỗi DB. Không nhãn ID, IP, cursor hay nội dung copy.

Unit kiểm tra validation/link/cursor/ETag và DTO không lộ thông tin quản trị.
`apps/api/test/system-notifications.int.spec.ts` dùng Testcontainers PostGIS:
upgrade 0092→0093 giữ staff data; filter/expiry/keyset microsecond/ETag;
CMS RBAC; audit và rollback khi audit lỗi; create replay/concurrency;
publish đồng thời; rate limit và forwarding spoof. Chạy spec mới serial:

```sh
pnpm exec vitest run --project integration apps/api/test/system-notifications.int.spec.ts --fileParallelism=false --maxWorkers=1
```

Kết quả chạy gate là bằng chứng riêng; có test source không đồng nghĩa đã pass
integration hoặc được CODEOWNER duyệt migration/contract.
