# ADR-0043: Số phòng đã check-in tại địa điểm

Ngày: 2026-11-07. Trạng thái: đề xuất cho GoGo-BE#785, chờ Astra và
CODEOWNER @namnh92 review. Cơ sở: owner duyệt nhóm 03 của
GoGo-MobileApp#482 ngày 07/11; SRS FR-PLAN-008/009. Lệnh triển khai #785
trong worktree này là phạm vi được owner giao cho Sol; Claude chạy full gates
và commit sau bàn giao.

## Dữ kiện và quyền riêng tư

`PlaceDetail.checkedInGroupCount` là số `plans.room_id` khác nhau có ít nhất
một `stop_checkins` thông qua `plan_stops.place_id`. Tính mọi thời gian, cả plan
cũ/archived, cả phòng couple và group; nhiều thành viên, stop hay phiên bản plan
của một phòng vẫn tính một. Không suy diễn lượt đi từ save, vote, review, plan
hoặc stop completed. Đây là dữ kiện check-in GoGo, không phải nội dung Google
và không phải chứng nhận GPS hay cơ chế chống gian lận.

Giả định DEV theo issue, chưa nâng thành quyết định owner: dưới năm phòng trả
`null`, bao gồm zero; từ năm trở lên trả integer. Client ẩn dòng khi null.
Không trả danh sách hoặc danh tính phòng/thành viên, không trả số nhỏ trong
metadata hay telemetry. Moderation áp cho nội dung check-in (ảnh/bill/note),
không phủ nhận sự tồn tại của lượt check-in; pending/rejected/hidden vẫn tính.
Nếu owner muốn chỉ tính approved thì cần đổi rõ định nghĩa và test trước phát hành.

Đếm từ bản ghi hiện còn trong DB. Xoá check-in hoặc cascade xoá dữ liệu có thể
giảm số; không lưu thêm lịch sử phòng đã bị xoá. Merge chuyển `place_id` trên
stop sẽ đưa lượt đi về canonical, vẫn deduplicate theo room. Dữ kiện này độc lập
với `gogoRatingCount` và rating provider.

## Cách đọc và consistency

Mỗi request đọc trực tiếp `COUNT(DISTINCT room_id)` với `EXISTS` check-in từ
DB; không lấy danh tính vào application. Chỉ chạy sau khi query PlaceDetail
đã xác nhận place đang public; 404 không đọc aggregate.

Astra r1 F-01: bỏ cache process 60 giây và cả việc dùng chung promise đang chạy.
Một process khác có thể commit xoá check-in, cascade hoặc merge làm số phòng
5→4. Request bắt đầu đọc aggregate sau commit phải thấy `null` ngay, không
đợi TTL hay thông báo invalidate. Query đang chạy trước commit dùng statement
snapshot của chính nó; kết quả cũ đó không được giữ lại hoặc cấp cho request
sau commit. Không thêm registry cache hoặc hook cho mọi đường ghi/xoá/merge.
Không có exception privacy cho số dưới năm.

Đổi lại mỗi detail request có một aggregate query, kể cả request đồng thời.
Không thêm bảng aggregate, trigger, worker/outbox hoặc bản sao quan hệ phòng/place.
DB/query hoặc aggregate lỗi thì request 5xx, không serve stale và không giả thành
null/zero. Response vẫn `no-store`; community rating giữ quy tắc phản ánh
moderation ở request kế tiếp.

Không migration/index mới: đã có `plan_stops_place_idx(place_id)`,
`plans_pkey(id)` và prefix `stop_checkins_stop_member_unique(plan_stop_id,
member_id)`. Integration test EXPLAIN chính statement production trên population
20.000 stop cạnh tranh để kiểm tra không scan toàn bộ stops/check-ins. Mỗi
read tại place có rất nhiều stop phải aggregate lịch sử của riêng place đó;
nếu read latency vượt SLO, cần đo trước khi chuyển sang aggregate lưu sẵn có
consistency tương đương. Query/index hiện tại không thay đổi trong bản sửa F-01.

## Telemetry, kiểm chứng và rollback

`place_checkin_group_count_total{outcome=available|suppressed|error}` đếm mỗi
lần đọc. Bỏ metric cache vì không còn cache. Không label place, room, member hoặc
số đếm. Dùng request latency/error telemetry hiện có để đánh giá tác động.
Không thêm log payload.

Unit: boundary 0/1/4/5/8, đọc mới mỗi request, lỗi DB, aggregate malformed và
labels. F-01: immediate 5→4 trên hai instance khi đồng hồ chưa đổi; request mới
không dùng promise cũ đang chạy; kết quả query cũ hoàn tất sau commit không
được giữ lại cho request sau. Contract: nullable integer, minimum 5, trường
required, ví dụ null/public và consistency. Integration: HTTP qua PostGIS thật,
distinct room qua member/plan versions, stop completed không check-in, check-in
place khác, moderation độc lập, ngưỡng privacy, 404, DB error, EXPLAIN. F-01:
hai API instance có DB pool riêng cùng đọc 5, sau commit xoá check-in/cascade
phòng/merge reference trả null ngay khi đồng hồ vẫn đứng yên.

Contract MINOR 6.3.0-alpha.1 → 6.4.0-alpha.1, CHANGELOG và types được cập nhật
cùng code. Claude reconcile version với branch song song khi merge. Rollback:
rollback API sẽ khôi phục lỗi cache F-01 nên phải cân nhắc privacy. Không thay đổi schema hay
dữ liệu cần phục hồi. Client regenerate types, chịu được field absent khi chạy
với API cũ và ẩn dòng khi absent/null.

Claude cần chạy full lint/typecheck/unit/integration/contract gates, lấy Astra
và CODEOWNER review. Không claim DEV acceptance từ test local.
