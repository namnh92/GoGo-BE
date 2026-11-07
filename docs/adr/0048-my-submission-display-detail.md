# ADR-0048: Facts hiển thị và chi tiết đóng góp của tôi

- Ngày: 2026-11-07
- Trạng thái: Đề xuất cho GoGo-BE#801; cần review kiến trúc và CODEOWNER contract.
- Cơ sở: owner 2026-11-07, FR-INGEST-010..015, ADR-0006, ADR-0030,
  ADR-0043 (provider photo), ADR-0045 (#788).

## Bối cảnh và lựa chọn

Card pending hiện không có tên/địa chỉ/ảnh vì submission chỉ giữ Google Place ID
và dữ liệu người góp khai. App cần dùng cùng card và màn chi tiết, dịch `pending`
thành “Đang chờ duyệt”; approved/merged chuyển qua place thật bằng `placeId`.

1. Snapshot tên/địa chỉ/rating/hours/photo ref lúc submit: loại; attribution không
   tự cấp quyền lưu nội dung Google, và cũng vi phạm ranh giới pending ADR-0043.
2. Chỉ trả catalogue/review draft: không đáp ứng card pending.
3. Lấy facts Google sống sau kiểm quyền, giới hạn chi phí và thời gian, chỉ hiển
   thị rồi bỏ: chọn. Đây là cập nhật có chủ đích đối với quyết định “không gọi
   provider khi đọc history” trong ADR-0045; quyền và keyset pagination giữ nguyên.

## Quyết định và contract

- MINOR `7.5.0-alpha.1`. `GET /v1/me/place-submissions` thêm `addressShort`,
  `categoryKey`, `providerStatus`, `providerDisplay`; `name` có fallback Google
  sống. Category đã submit cũng chỉ trả ở top-level khi key còn active.
  `providerDisplay` chứa tên, địa chỉ ngắn, category key đã đối chiếu taxonomy
  active, rating Google/count riêng, weekly hours, source/fetchedAt/attributions,
  Google Maps URI và tối đa một `photo` proxy reference của #786. Tên ưu tiên
  catalogue/review draft, địa chỉ ưu tiên catalogue; fallback Google phải hiển
  thị Google Maps attribution. Dùng `shortFormattedAddress` trong quality mask
  (cùng tier hiện hữu), fallback formatted address nếu Google không có bản ngắn.
- `GET /v1/me/place-submissions/{id}` trả cùng facts/trạng thái/rejectionReason và
  placeId cho approved/merged khi place còn tồn tại. Không suy đoán reason lịch sử.
  `contribution` là projection riêng, `verificationStatus=unverified`, chỉ có
  dữ liệu của chính người gửi gốc: category, price min/max + VND + unit, vibe keys,
  note và enrichment #796 khi có. Không nâng dữ kiện user khai thành place facts.
- Cả hai chỉ cho user đã đăng ký: SQL bắt buộc submitted_by_user_id hoặc EXISTS
  attribution của actor hiện tại; detail thêm id vào cùng query. Không nhận user
  ID từ client. Unknown/không có quyền cùng trả 404 trước provider/budget call;
  guest/admin 403. Không trả moderation description/note, reviewer, room, user
  identity hay input của người khác. Contributor được ghi nhận xem được facts
  chung, không xem note/enrichment của người gửi gốc; tránh lộ PII trong mẹo/hoá đơn.
- Reader #796 dùng `to_jsonb(s)->'enrichment'` với điều kiện người gửi trong SQL:
  trước cột tồn tại trả null, sau migration của #796 đọc được mà không phụ thuộc
  số migration. Runtime allowlist cả nested object, không serialize JSON thô;
  lỗi shape bỏ enrichment. Chỉ mediaId/kind của chính mình, không URL/private bytes.
  Schema đã đối chiếu với worktree be-796 ngày 2026-11-07; cần reconcile khi #796
  đổi model. Task này không triển khai writer/wizard/credit/ảnh hoá đơn của #796.
- Cache-Control no-store cho cả hai response. Proxy photo là GET JSON, không phải
  image src; proxy response author credit là authoritative. Không phát media call
  khi mở history/detail, không tải hoặc lưu Google image bytes trước duyệt.
  Flag/budget/no-photo lỗi thì bỏ reference; không làm hỏng quyết định/history.
- Mỗi Google identity tối đa một quality Details/request, chỉ trên page đã chọn
  (không trên dòng lấy dư cho cursor). Tối đa 4 lookup đồng thời, chung cửa sổ 6s;
  các dòng chưa bắt đầu khi hết thời gian có `providerStatus=deferred`. Có thể mở
  detail để retry. Adapter call đang chạy có thể kết thúc sau cửa sổ; không bắt
  đầu photo lookup sau deadline, không giữ kết quả. No transaction across provider.
- Trước mỗi Details phải reserve `google.details.quality` trong scope
  `google.places.display` với ceiling calls/cost/units. Unset/zero/refused không
  gọi Google; `providerStatus=budget_exhausted`. Ngân sách photo vẫn qua #786.
  Rate limit list 10/min/IP+actor, detail 30/min/IP+actor. Không thêm cron/prefetch.
  Provider not-found, đổi identity, outage/timeout chỉ trả trạng thái display riêng;
  không đổi submission status hay trình bày unknown hours thành đóng cửa.

## Lưu gì và giữ bao lâu

| Dữ liệu                                                                                               | Nơi và thời gian giữ                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Place ID                                                                                       | Bảng submission hiện hữu; định danh được phép giữ không giới hạn theo policy Google, vòng đời submission/account theo hệ thống hiện hữu. Không thêm bản sao.                                          |
| Google name/address/rating/count/hours/types/category suy ra, Maps URI, attribution, photo ref/credit | RAM trong request đang hiển thị, tối đa thời gian xử lý; không lưu DB, Redis, R2, job, event, log payload, snapshot hay cache client. HTTP no-store. Không có TTL 30 ngày cho các facts này.          |
| Google photo bytes/name/media URL trước duyệt                                                         | Không lưu; proxy #786 chỉ trả transient JSON no-store theo ADR-0043.                                                                                                                                  |
| Một Google photo sau admin duyệt                                                                      | Ngoại lệ ứng dụng hiện hữu ADR-0043; giữ media + provenance/credit đến khi detach/xoá place, cleanup worker xoá bytes. Không mở rộng ngoại lệ hoặc tuyên bố owner approval thay thế giấy phép Google. |
| User input/enrichment/attribution đóng góp                                                            | Không tạo dữ liệu lưu mới. Theo vòng đời submission và retention/delete/export của #788/#796; input không trở thành facts đã xác minh qua endpoint đọc.                                               |
| Budget/telemetry                                                                                      | Chỉ counters/reservations/latency theo chính sách vận hành hiện hữu; không facts Google, user/submission ID hoặc ghi chú trong labels.                                                                |

Theo [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies)
và [Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
(đọc 2026-11-07), Place ID có ngoại lệ lưu; không mặc định được cache tên/địa chỉ
hoặc nội dung Places chỉ vì kèm attribution. Chọn giữ facts 0 giây ngoài request.
Client hiển thị Google Maps attribution và third-party/photo author credits cùng
nội dung, không nhập vào catalogue/AI/search. Việc hiển thị không có Google Map
vẫn phải theo hướng dẫn Google Maps branding; API trả attribution, client chịu
trách nhiệm render đúng. Đây là quyết định kỹ thuật, không cấp ngoại lệ điều khoản.

## Hệ quả, vận hành và kiểm chứng

Có thêm Enterprise Details khi người dùng mở page/detail; số call tối đa theo
limit (25 mặc định, 100 tối đa), concurrency/deadline và budget. Default deny đến
khi cấu hình đủ `PLACE_DISPLAY_DAILY_MAX_CALLS`,
`PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD`,
`PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY`. Không tự bật ngân sách
DEV/prod. Thiếu budget/provider thì vẫn thấy history/decision và stored facts.

Metric mới `my_place_submission_display_total{outcome}` với closed outcomes
ok/budget_exhausted/not_found/identity_mismatch/unavailable; query duration hiện
hữu dùng chung cho list/detail, không ID labels. Adapter metering vẫn đếm call
thật. Deferred là tình trạng lịch xử lý page, không phải provider failure.

Unit: auth/cursor, projection, own enrichment allowlist, quota, identity mismatch,
provider failure, timeout, taxonomy active, photo reference, concurrency/dedupe.
Integration HTTP + Postgres: owner/contributor/stranger, pending facts, no-store,
no persistence/bytes, approved/merged navigation, rejected key trong outage,
reader trước/sau schema #796. Kết quả chạy cụ thể ghi trong báo cáo bàn giao.

## Migration, rollout và rollback

Không thêm cột/bảng/snapshot Google, không cần migration #801. Không chiếm 0086
của #794/#796. ADR dùng 0048 vì upstream #800 đã dùng 0047; contract được
reconcile thành 7.5.0-alpha.1. Không cherry-pick hoặc đổi PR song song.

Deploy API trước client, xác minh ngân sách và attribution ở client. Rollback
client ngừng dùng fields/route mới trước khi rollback API; xoá cấu hình units
quality để dừng live display ngay, photo flag/budget vẫn theo ADR-0043. Giữ
attribution/enrichment schema của PR khác. Không cần cleanup hoặc data rollback
vì #801 không ghi facts hay bytes.

## Owner decision — 2026-11-07

Astra r2 F-03 P1 found that persisting the Google name/address/category/rating/
hours/display snapshot at submit has no established storage right under
ADR-0006 §9.3: only Place ID may be retained indefinitely, and coordinates for
≤30 days. The owner accepted this risk and ordered to proceed and merge:
“Vẫn làm. Merged đi”. The 30-day refresh is an internal freshness rule, not a
Google permission. Follow-up: verify against the current Google Maps Platform
terms and adjust if needed.
