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

## Cách đọc và giới hạn cache

Chọn cache nội bộ thay vì bảng aggregate + trigger hoặc worker/outbox mới:
không thêm bản sao quan hệ phòng/place, không cần backfill, rollback hay đồng bộ
mọi đường xoá/merge. Query fill dùng `COUNT(DISTINCT room_id)` với `EXISTS`
check-in; không lấy danh tính vào application. Chỉ chạy sau khi query PlaceDetail
đã xác nhận place đang public; 404 không fill cache.

Mỗi SearchRepository giữ tối đa 1.000 entry, cả promise đang chạy và kết quả,
evict entry cũ nhất khi đầy. Request đồng thời cho cùng entry dùng chung promise.
Cache cả null, chỉ giữ giá trị đã suppression. TTL 60 giây tính từ trước query;
không kéo dài theo hit hay thời gian query. Restart process xoá cache. Nhiều API
process có thể thấy số khác nhau trong cửa sổ này. Khi có áp lực eviction, một
query đang chạy bị evict có thể được chạy lại; cache không phải global rate limit.

Tăng/giảm số, moderation, xoá và merge không invalidate ngay: dữ kiện có thể
trễ tối đa 60 giây. Cụ thể 5→4 có thể còn trả 5 tới khi hết TTL; đây là đánh đổi
cần Astra/CODEOWNER duyệt cùng giả định privacy. Hết TTL mà DB lỗi thì request
5xx, không serve stale và không giả thành null/zero. Response vẫn `no-store`;
community rating giữ quy tắc phản ánh moderation ở request kế tiếp.

Không migration/index mới: đã có `plan_stops_place_idx(place_id)`,
`plans_pkey(id)` và prefix `stop_checkins_stop_member_unique(plan_stop_id,
member_id)`. Integration test EXPLAIN chính statement production trên population
20.000 stop cạnh tranh để kiểm tra không scan toàn bộ stops/check-ins. Cache
miss tại place có rất nhiều stop vẫn phải aggregate lịch sử của riêng place đó;
nếu miss latency vượt SLO, cần đo trước khi chuyển sang aggregate lưu sẵn.

## Telemetry, kiểm chứng và rollback

`place_checkin_group_cache_total{outcome=hit|miss|error}` đếm đường cache;
`place_checkin_group_count_total{outcome=available|suppressed}` đếm kết quả fill.
Không label place, room, member hoặc số đếm. Dùng request latency/error telemetry
hiện có để đánh giá tác động. Không thêm log payload.

Unit: boundary 0/1/4/5/8, cache null/public, TTL, gộp request, eviction, lỗi DB,
aggregate malformed và labels. Contract: nullable integer, minimum 5, trường
required, ví dụ null/public. Integration: HTTP qua PostGIS thật, distinct room
qua member/plan versions, stop completed không check-in, check-in place khác,
moderation độc lập, ngưỡng privacy, cache refresh và xoá, 404, DB error, EXPLAIN.

Contract MINOR 6.3.0-alpha.1 → 6.4.0-alpha.1, CHANGELOG và types được cập nhật
cùng code. Claude reconcile version với branch song song khi merge. Rollback:
rollback API; cache trong process cũ tự mất khi dừng. Không thay đổi schema hay
dữ liệu cần phục hồi. Client regenerate types, chịu được field absent khi chạy
với API cũ và ẩn dòng khi absent/null.

Claude cần chạy full lint/typecheck/unit/integration/contract gates, lấy Astra
và CODEOWNER review. Không claim DEV acceptance từ test local.
