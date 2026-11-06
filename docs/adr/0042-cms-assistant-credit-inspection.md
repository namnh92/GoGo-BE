# ADR-0042: CMS xem số dư và lịch sử credit AI

Ngày: 2026-11-06. Trạng thái: đề xuất triển khai GoGo-BE#778; chờ Astra và
CODEOWNER review trước khi phát hành. Cơ sở: owner duyệt D3 của
GoGo-MobileApp#482, ledger #774/#775, ADR-0040, SRS FR-CMS-001/008.

CMS cần dữ kiện để kiểm tra credit được thưởng khi duyệt đóng góp. Không có
nghiệp vụ cấp, sửa, hoàn hay thu hồi credit trong thay đổi này.

`GET /v1/cms/users/{id}/assistant-credits` trả `user: { id, displayName }`,
`balance`, `items`, `nextCursor`. Mỗi dòng có `id`, `createdAt`, `delta`,
`reason`, `submissionId`, `venueIdentity`, `placeId`. Không trả email, ghi chú
đóng góp, tin nhắn, usage ledger ID hoặc nội dung Google. Lý do là mã dữ kiện
`submission_approved` (+50) / `message_spent` (-1); CMS tự dịch nhãn. Response đặt `Cache-Control: no-store`.

Dùng account balance hiện có, không tự dựng lại balance từ một trang ledger.
Một câu SQL đọc user, account và trang ledger trong cùng MVCC snapshot; không
khóa account và không thay đổi đường grant/spend. Account chưa có trả balance 0.
User không tồn tại trả 404 `USER_NOT_FOUND`. User đã xóa vẫn có thể còn hàng
anonymized; chỉ trả tên hiện tại, balance 0, ledger rỗng theo cơ chế erasure hiện
có, không khôi phục liên kết user từ nguồn hoặc audit.

Trang mặc định 50, tối đa 100; lấy limit+1 theo `(created_at DESC, id DESC)`.
Cursor giữ đủ sáu chữ số microsecond, gắn user ID và được validate trước SQL.
Cursor sai định dạng hoặc khác user trả 400 `INVALID_CURSOR`; path/query sai trả
400 `VALIDATION_FAILED`. Cursor không phải credential. Mỗi request vẫn kiểm tra
quyền trên user được yêu cầu. Balance là hiện tại ở từng request; không hứa
snapshot cố định xuyên nhiều trang. Grant mới sau trang đầu không đẩy trùng dòng
vào trang sau. Trang hết dữ liệu vẫn trả user và balance.

Giữ `submissionId` và `venueIdentity` bất biến từ ledger dù nguồn đã xóa.
`placeId` lấy từ `place_submissions.result_place_id` nếu còn; null khi nguồn hoặc
place đã xóa, hoặc dòng debit. Không suy đoán canonical place từ provider ID.

Chọn `ops_admin` + `super_admin` theo phạm vi issue và precedent CMS users.
`ExactRoleRead` giữ phạm vi rõ ràng, không mở cho editor/moderator. AdminGuard
hiện có kiểm tra lại session, trạng thái và role staff ở mỗi request. Precedent
`CmsUsersService.exportData` audit việc staff đọc dữ liệu người khác; mỗi lần đọc
credit thành công ghi `user.assistant_credits_viewed`, resource user ID, actor,
request ID/IP và authorization path qua `writeAudit`. Không copy tên, balance,
ledger hoặc cursor vào audit. Audit lỗi thì request không trả dữ liệu. Telemetry
request/authorization dùng pipeline hiện có; không thêm metric label user ID.

Contract additive MINOR `6.1.0-alpha.1`, không migration. Claude chạy codegen,
format/typecheck/lint, contract/route/boundary gates và integration suite sau lượt
viết code; lượt này không chạy gate, container, migration hay dịch vụ ngoài.
Integration scenarios nằm trong `apps/api/test/cms.int.spec.ts`: role matrix gồm
anonymous/user/guest, live demotion/suspension, audit và PII tối thiểu, grant/spend
idempotent, tổng ledger = balance, tie UUID/microsecond, nguồn bị xóa, cursor sai
user, trang rỗng, user thiếu, erasure và grant xen giữa hai trang.

Rollback: gỡ route/service và contract mới ở lần phát hành thích hợp; không xóa
hay thay đổi account, ledger hoặc audit đã ghi. Không có owner decision mới cần
chặn viết code; Astra và CODEOWNER là gate phát hành còn chờ.
