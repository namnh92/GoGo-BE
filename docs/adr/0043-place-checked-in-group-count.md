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

Astra r2 F-02: mỗi request chỉ lookup PK `place_checkin_counts(place_id)` và
đọc một integer tính sẵn; place chưa có lượt đi đọc zero rồi suppress thành null.
Không aggregate lịch sử ở read path, không cache process hoặc dùng chung promise.
Chỉ chạy sau khi PlaceDetail đã xác nhận place đang public; 404 không đọc count.

Migration 0082 duy trì ba bảng trong **cùng transaction của source write**:

- `place_checkin_visits`: một association `(checkin_id, place_id, room_id)` trên
  mỗi check-in. FK check-in ON DELETE/UPDATE CASCADE giữ association đến lúc
  cascade xoá; không lookup parent đã bị xoá. Không lưu lịch sử sau erasure.
- `place_checkin_rooms`: PK `(place_id, room_id)` và số check-in hiện còn. Upsert
  / decrement khoá row, chỉ chuyển 0→1 / 1→0 mới đổi số phòng. Row zero bị xoá;
  nhiều member/stop/plan version của cùng room vẫn tính một.
- `place_checkin_counts`: PK place và tổng phòng. Update integer nguyên tử trên
  row serialize các room khác nhau; place chưa từng được đếm không cần row.
  Row zero có thể tồn tại nhưng không giữ room/member identity.

AFTER trigger của check-in insert / đổi `plan_stop_id` chụp association từ stop
và plan, dùng `FOR SHARE` để loại trừ parent reference move chưa commit. Check-in
DELETE, xoá member/user, stop/plan/room cascade đều xoá association theo FK và
trừ reference trong cùng transaction. Đổi stop place/plan hoặc plan room sẽ
update qua **source check-in rows** rồi tính lại association: row predicate được
PostgreSQL recheck sau khi chờ concurrent reparent/delete, tránh ghi association
từ join snapshot cũ. Moderation/note upsert không đổi participation. Truncate
source CASCADE có statement trigger reset các bảng derived vì không có row-delete
trigger. Đường merge không cần application cache invalidation hoặc counter call.

Các writer cạnh tranh dùng row locks; deadlock từ hai mutation ngược chiều có
thể bị PostgreSQL abort như các transaction khác. Không catch/serve count cũ;
caller xử lý lỗi/retry theo chính sách transaction hiện có. Không có worker,
TTL, eventual refresh hoặc exception privacy.

Astra r1 F-01 giữ nguyên: request bắt đầu đọc aggregate sau commit phải thấy
`null` ngay khi population 5→4 trên mọi API process. Query đang chạy trước commit
dùng statement snapshot của chính nó; kết quả đó không cấp cho request sau.
Source mutation rollback thì các association/reference/total cũng rollback.
DB/query lỗi trả 5xx, không stale fallback hoặc zero giả. Response giữ `no-store`;
community rating độc lập và tiếp tục phản ánh moderation ở request kế tiếp.

## Migration và vận hành

0082 backfill source đang có, group theo place/room một lần rồi đếm room theo
place. DDL, backfill và trigger installation cùng transaction; khoá
`SHARE ROW EXCLUSIVE` trên plans/stops/check-ins chặn writers trong giai đoạn này
nhưng cho phép đọc. `lock_timeout=5s`, `statement_timeout=120s`: nếu không đủ
maintenance budget thì migration fail/rollback, không publish aggregate dở.
Cần đo backfill trên snapshot gần production, chọn maintenance window, và
reconcile journal `when` với migration mới nhất trước deploy. Không claim đã
đo được thời gian production từ fixture local.

Deploy migration trước reader mới. Giữ triggers khi rollback application về
query uncached của `d097b37`; query đó tương thích cả hai schema nhưng tạm có
lại chi phí F-02. Không rollback về bản có TTL cache vì tái mở F-01.
`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback-0082-place-checkin-counts.sql`
chỉ chạy sau khi đã chuyển hết reader về query uncached. Script transactionally
bỏ triggers/functions/derived tables, không thay source; không sửa Drizzle journal.
Muốn roll-forward sau rollback phải apply SQL 0082 rõ ràng trong transaction
trước khi bật reader mới (migrator không tự chạy lại entry đã ghi).

## Telemetry, kiểm chứng và rollback

`place_checkin_group_count_total{outcome=available|suppressed|error}` đếm mỗi
lần đọc. Bỏ metric cache vì không còn cache. Không label place, room, member hoặc
số đếm. Dùng request latency/error telemetry hiện có để đánh giá tác động.
Không thêm log payload.

Unit: boundary 0/1/4/5/8, không giữ value/promise, lỗi DB, aggregate malformed,
labels và query chỉ đọc row precomputed. F-01 giữ ba regression về 5→4 giữa hai
instance, in-flight cũ và late completion. Contract nullable integer minimum 5,
required, ví dụ null/public và committed-read consistency không đổi.

Integration spec gồm HTTP qua PostGIS thật, distinct room qua member/plan versions,
moderation độc lập, privacy/404/error; 5→4 qua hai API instance sau check-in delete,
member/user erasure, stop/plan/room cascade, merge. Oracle riêng so sánh cả ba bảng
với source joins. F-02 fixture có **40.000 matching check-ins** thêm vào cùng
place/room, 10.000 aggregate rows; lặp EXPLAIN ANALYZE BUFFERS trên chính query
production, đòi PK index, một actual row, tối đa bốn shared buffers, không đọc
source hay bảng visits/rooms. Có concurrent insert/delete, stale parent snapshot,
pre/post-commit visibility, writer rollback, truncate cascade, forward-backfill /
rollback / reapply. Các assertion này cần PostGIS runtime để xác nhận; không coi
spec chưa chạy là evidence pass.

Contract MINOR 6.3.0-alpha.1 → 6.4.0-alpha.1, CHANGELOG và types được cập nhật
cùng code. Claude reconcile version với branch song song khi merge. Bản tối ưu
aggregate giữ nguyên shape và semantics của field mới; sửa mô tả consistency
để nói rõ database aggregate tính sẵn; types/artifacts và hashes cùng cập nhật.
Rollback theo quy trình migration ở trên, tránh bản cache tái mở F-01.
Client regenerate types, chịu được field absent khi chạy với API cũ và ẩn dòng
khi absent/null; không lộ room/member/count nhỏ trong response hoặc telemetry.

Claude cần chạy full lint/typecheck/unit/integration/contract gates, lấy Astra
và CODEOWNER review. Không claim DEV acceptance từ test local.
