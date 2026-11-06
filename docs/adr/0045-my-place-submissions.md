# ADR-0045: Danh sách đóng góp địa điểm của tôi

- Ngày: 2026-11-07
- Trạng thái: Đề xuất; chờ Astra và CODEOWNER (@namnh92)
- Nguồn: GoGo-BE#788 / REDESIGN-G03-MY-SUBMISSIONS; owner duyệt nhóm 03 ngày 07/11; SRS FR-INGEST-010..012; ADR-0006 và Product/Data Architecture.

## Quyết định

Thêm `GET /v1/me/place-submissions` trong module ingestion. Controller chỉ
validate query, đặt `Cache-Control: no-store` rồi gọi application service.
AuthGuard hiện hữu xác thực session; service từ chối mọi actor không phải user.
Điều kiện người gửi đầu tiên hoặc attribution của `actor.id` nằm trong SQL của mọi trang, không
nhận user ID từ client và không trao quyền theo cursor.

Response dùng projection riêng, không dùng DTO moderation: id, status,
createdAt, updatedAt; name, photoUrl, decidedAt nếu có; placeId cho approved/merged.
Tên ưu tiên result place rồi review draft. Khi chưa có tên/ảnh, bỏ field để
client hiển thị trạng thái thiếu dữ liệu theo i18n, không gọi Google lấy nội dung.
Ảnh chỉ từ result place, đã duyệt, source editorial/community, public prefix
places; dùng helper URL catalogue chung, không trả URL khi host chưa cấu hình.

CMS lưu ghi chú quyết định dạng tự do và reason key theo ADR-0044 (#787).
Endpoint danh sách này không trả ghi chú vì có thể chứa thông tin người khác;
rejected nhận key chung `MODERATION_REJECTED` cho client dịch, kể cả dữ liệu
lịch sử thiếu reason key. Polling và CMS giữ taxonomy `SubmissionRejectionReason`
của #787; validation vẫn bắt buộc reason key khi từ chối. Không suy đoán lý do
cũ. Không trả note, reviewer, người gửi, room hoặc provider ID.

Phân trang keyset `(created_at, id)` giảm dần, lấy dư một dòng; cursor giữ
timestamp UTC với sáu số thập phân để không bỏ sót dòng cùng millisecond.
Tuple được validate datetime/UUID trước khi cast SQL. Limit 1–100, mặc định 25.
Mỗi lần mở lại bắt đầu trang đầu để nhận trạng thái hiện tại. Không đảm bảo
snapshot qua nhiều request; dòng mới hơn cursor xuất hiện khi refresh.

## Attribution khi dedupe (F-01, Astra r1)

FR-INGEST-012 dedupe nhiều người gửi cùng provider ID vào một proposal và tăng
submissionCount. Bảng bổ sung `place_submission_contributors` giữ cặp khóa chính
`(user_id, submission_id)` và thời điểm ghi nhận; không giữ note hay PII khác.
Người gửi đầu tiên vẫn ở proposal để giữ nghiệp vụ moderation/credit hiện hữu.
Mọi lần submit của user ghi attribution cùng transaction với upsert proposal;
partial unique index pending đảm bảo chỉ một draft cả khi submit đồng thời.
Submit lặp vẫn tăng counter nhưng không lặp attribution. Chỉ proposal mới phát
event `place.submission_created`, cùng transaction. Metric pending/deduped ghi
sau commit; không thêm label người gửi.

History và polling cho phép người gửi đầu tiên hoặc user có attribution; chỉ
trả projection an toàn hiện hữu, không trả note hay danh tính người góp khác.
Guest giữ nguyên quyền room-scoped và polling của người gửi đầu tiên; bảng này
chỉ ghi user đã đăng ký. Thứ tự/cursor vẫn theo proposal, không theo lần góp.

Migration 0085 backfill người gửi đầu tiên còn active. Không thể khôi phục danh
tính người từng dedupe mà trước đây không lưu. Điều kiện người gửi đầu tiên vẫn
được giữ để tương thích dữ liệu cũ và producer chưa nâng cấp trong rollout.
Tất cả writer phải nâng cấp trước khi coi attribution cho submit mới là đầy đủ.

Export thêm section `placeSubmissions` chỉ gồm id, status, createdAt, decidedAt
của account; đọc theo trang và tính vào giới hạn bytes hiện hữu. Account erasure
xóa attribution trong transaction chung, hard-delete user/proposal có cascade.
Submit lấy account lock rồi kiểm tra active giống luồng erasure, tránh tái tạo
attribution sau xóa account. Xóa một account không xóa proposal của người còn lại.

## Kiểm chứng và vận hành

Integration test HTTP + Postgres/Testcontainers: anonymous/guest/admin; cách ly
hai account và guest rows; trang rỗng; ties/microseconds; insert giữa hai trang;
cursor account khác; bốn trạng thái; key từ chối an toàn; ảnh đã duyệt; đọc lại
sau quyết định và đăng nhập mới; A/B submit cùng provider ID, submit lặp,
quyết định approved/rejected/merged, không lộ PII; query/cursor sai trả envelope 400.
Unit test kiểm tra từ chối actor/cursor trước DB và projection không lộ field.

Dùng request logs HTTP chung và histogram `my_place_submissions_query_duration_ms`
không label để quan sát thời gian query cả khi lỗi. Không thêm metric theo user/submission, không log payload hoặc
chuỗi lý do CMS; không có side effect, audit write hay provider call khi đọc.
Không thêm package hay loại event. Rollout: áp migration 0085 trước code;
backfill chỉ thêm bảng mới, không thay proposal cũ. Rollback: ngừng client gọi
endpoint history mới trước khi rollback API, giữ bảng attribution để không mất
lịch sử đã ghi. Writer cũ không ghi người góp sau; không khôi phục được attribution
thiếu trong thời gian rollout hỗn hợp hoặc rollback. Nếu cần gỡ schema, rollback
và drain mọi reader/writer dùng bảng, lưu bản sao attribution rồi roll-forward
bằng migration `DROP TABLE place_submission_contributors` đã kiểm tra trên snapshot
(mất attribution đã ghi). Quy trình chi tiết ở runbook GoGo-BE#788 trong
`docs/runbooks.md`. Claude chạy full gates; Astra review thiết
kế và CODEOWNER duyệt contract/quyền trước merge vào re-design.
