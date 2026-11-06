# Lý do từ chối đóng góp địa điểm — GoGo-BE#787

Owner duyệt 07/11/2026, MobileApp#482 nhóm 03 màn 3.4.
Tham chiếu FR-INGEST-011/012 và Product/Data Architecture: chỉ lưu quyết định
của moderator, không thêm dữ liệu provider.

## Contract và lưu trữ

CMS gửi `POST /v1/cms/place-submissions/{id}/decide`, ví dụ:

```json
{ "decision": "rejected", "rejectionReason": "incorrect_location" }
```

| Key                   | Nhãn tiếng Việt do client i18n hiển thị |
| --------------------- | --------------------------------------- |
| duplicate_place       | Trùng địa điểm                          |
| incorrect_location    | Sai vị trí                              |
| permanently_closed    | Đã đóng cửa                             |
| not_public_place      | Không phải địa điểm công khai           |
| inappropriate_content | Nội dung không phù hợp                  |
| other                 | Khác                                    |

Key là bắt buộc khi reject; thiếu/sai kiểu/sai key trả 400 `VALIDATION_FAILED`,
`field_errors` chỉ tới `rejectionReason`. Không suy diễn key từ ghi chú.
`reason` giữ vai trò ghi chú nội bộ: tùy chọn khi reject, vẫn bắt buộc khi
approve/merge. Với `other`, không cần thêm nội dung công khai tự do.
Quyền moderator/editor, khóa submission, kiểm tra trạng thái pending và giao dịch
hiện có được giữ nguyên. Key lưu cùng status và audit `place_submission.decided`;
metrics hiện có `mobile_place_submissions_total{status}` tiếp tục ghi nhận quyết định.
Không đưa ghi chú nội bộ vào response công khai hoặc metric labels.

Người gửi (user/guest đã sở hữu submission) poll `GET /v1/place-submissions/{id}`:
`rejectionReason` chỉ có khi rejected và có key. Không trả `decisionReason`,
`reason`, history hoặc review draft. Key cũng xuất hiện trong CMS queue/detail.
Submission bị từ chối trước migration giữ null và response bỏ trường này;
client dùng nội dung từ chối chung, không tự đặt lý do. Dedupe/ownership hiện có
không thay đổi; việc trả kết quả cho người gửi phụ thứ hai không thuộc issue này.

OpenAPI **7.0.0-alpha.1 tăng MAJOR** từ 6.5.0-alpha.1 theo BE-BFF-012 và quyết
định owner/CODEOWNER ngày 07/11/2026; [ADR-0044](adr/0044-required-submission-rejection-reason.md)
ghi nhận giữ key bắt buộc tại API. Đây là breaking change: CMS cũ reject chỉ có
ghi chú, thiếu `rejectionReason`, nay nhận 400 `VALIDATION_FAILED`.
**CMS phải deploy cùng BE**, cập nhật action reject, đồng bộ contract và
regenerate client. Các consumer khác regenerate client và chấp nhận response
thiếu key ở bản ghi lịch sử. Xem `openapi/CHANGELOG.md`.

## Migration và đường lùi

0084 thêm cột text nullable, không default/backfill/rewrite dữ liệu cũ.
CHECK chỉ cho sáu key trên trạng thái rejected, cho phép null để giữ lịch sử và
hỗ trợ binary cũ khi rollback. App bắt buộc key cho mọi rejection mới.
0082 chỉ ADD COLUMN và ADD CHECK NOT VALID, không scan dữ liệu cũ. CHECK NOT VALID
vẫn kiểm tra mọi INSERT/UPDATE mới. Drizzle gom **mọi migration đang pending vào
một transaction**, giữ ACCESS EXCLUSIVE của ADD COLUMN tới COMMIT. Vì vậy tách
VALIDATE sang file migration khác vẫn giữ khóa mạnh suốt scan và không giải quyết
vấn đề. `lock_timeout = 5s` chỉ giới hạn thời gian chờ lấy khóa, không giới hạn
thời gian giữ khóa.

Rollout gồm hai invocation tuần tự trên cùng database (thử local trước, không
tự chạy DEV):

1. Chạy `pnpm db:migrate`; chỉ tiếp tục khi lệnh thành công và đã trả về, tức DDL
   đã COMMIT. Không bọc hai bước trong một transaction ngoài.
2. Chạy validation ngoài migration journal, trong transaction mới:

   ```sh
   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/ops/validate-submission-rejection-reason.sql
   ```

   Script dùng SET LOCAL lock_timeout 5s và COMMIT riêng. Scan dùng
   SHARE UPDATE EXCLUSIVE, cho phép SELECT/INSERT/UPDATE/DELETE tiếp tục; tránh
   chạy cùng DDL/maintenance có khóa xung đột. Không chuyển script vào `migrations/`.

3. Xác nhận `convalidated = true` trước khi chốt rollout:

   ```sql
   SELECT convalidated FROM pg_constraint
   WHERE conrelid = 'place_submissions'::regclass
     AND conname = 'place_submissions_rejection_reason_check';
   ```

Nếu validation lỗi/timeout, giữ schema additive và CHECK NOT VALID đang enforce
write mới; kiểm tra nguyên nhân rồi chạy lại bước 2. Script có thể chạy lại cả
sau thành công. Nếu 0082 đã được áp dụng từ bản cũ có VALIDATE, không sửa journal
hay chạy lại DDL; kiểm tra trạng thái constraint, bước 2 là an toàn khi chạy lại.

Ưu tiên rollback binary trước, **giữ cột additive** để không mất key đã ghi.
Nếu cần rollback schema: dừng writer, export cặp id/rejection_reason nếu cần giữ
lịch sử, rollback API/CMS, sau đó chạy trong transaction có lock timeout:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE place_submissions DROP CONSTRAINT place_submissions_rejection_reason_check;
ALTER TABLE place_submissions DROP COLUMN rejection_reason;
COMMIT;
```

Drop cột sẽ mất key, không mất quyết định hay ghi chú cũ. Nếu áp dụng lại migration
thì điều chỉnh migration journal theo quy trình vận hành; không tự chạy lại trên
môi trường thật. Astra design review và CODEOWNER OpenAPI/DB còn là gate trước merge;
full gates, commit và môi trường do Claude phụ trách.
