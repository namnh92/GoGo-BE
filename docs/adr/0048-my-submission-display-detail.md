# ADR-0048: Snapshot hiển thị và chi tiết đóng góp của tôi

- Ngày: 2026-11-07
- Trạng thái: Owner chốt hướng snapshot ngày 2026-11-07 cho GoGo-BE#801;
  contract/migration cần review trên patch cuối.
- Cơ sở: owner “Lưu snapshot khi gửi”, FR-INGEST-010..015, ADR-0006,
  ADR-0030, ADR-0043 (provider photo), ADR-0045 (#788).

## Bối cảnh và lựa chọn

Card pending cần tên/địa chỉ/category/rating/hours. Bản r1 lấy quality Details
cho cả page: 25 identity × $0.02 = $0.50, hết ngân sách display DEV trước ảnh.
Giới hạn concurrency/rate không giới hạn chi phí một phiên. Ngoài ra photoRefs
chậm đã làm mất cả facts mà request vừa trả tiền.

1. Enrich cả page: loại vì chi phí mỗi lần mở/refresh history.
2. Chỉ fetch detail: rẻ hơn nhưng thiếu full card owner yêu cầu.
3. Lưu snapshot giới hạn lúc gửi từ candidate đã xác minh, list chỉ đọc DB,
   ảnh tải lười qua proxy hiện hữu: owner chọn. Không mở cache Google chung.

## Quyết định và contract

- MINOR `7.4.0-alpha.1`. `GET /v1/me/place-submissions` trả snapshot còn mới
  trong `providerDisplay`: name, short address (fallback full address), category
  key đã đối chiếu taxonomy lúc fetch, Google rating/count, attribution,
  weekly hours nếu có, googleMapsUri, source và fetchedAt. Unknown hours là
  array rỗng, không phải đóng cửa. Không trộn rating Google với GoGo.
- Resolve ký Place ID và UUID resolution vào `resolutionToken` hiện hữu, tối đa
  **1024 ký tự**, giữ nguyên contract ba endpoint resolve/preview. Allowlist
  snapshot từ candidate nằm trong Redis record `place-resolution:<uuid>`, TTL
  tuyệt đối bằng expiresAt của token (PLACE_RESOLUTION_TTL_S từ fetchedAt).
  Không cache theo Place ID, không ghi raw payload/coordinates/photo refs/bytes.
  Dùng connection Redis hiện hữu; test/dev một instance không Redis dùng memory
  giới hạn 1000 record, timer xoá đúng expiry; không fallback memory khi Redis lỗi.
  Client gửi lại token opaque, không gửi facts tự khai. HMAC/expiry/identity và
  fetchedAt/expiry của record được kiểm trước khi persist lúc submit. Record
  thiếu/hết hạn/lỗi trả retryable RESOLUTION_TOKEN_INVALID, không gọi provider;
  resolve không lưu được record trả retryable PLACE_PROVIDER_UNAVAILABLE (503),
  không phát token thiếu snapshot. Không consume record khi submit để hỗ trợ retry.
  Token identity-only cũ vẫn hợp lệ, tạo row thiếu snapshot; detail có thể hydrate.
  Snapshot fetchedAt giữ thời điểm đã fetch,
  không gán lại khi submit/list. Nếu không dùng token, submit giữ nguyên một
  core Details để xác minh và lưu snapshot từ dữ liệu đó: rating/count/hours
  chưa biết là null/0/array rỗng. Snapshot không thêm call hay nâng SKU của
  resolve/submit/approve; snapshot đầy đủ lấy từ resolution record đã fetch.
- Submission mới lưu snapshot cùng transaction/attribution/outbox. Dedup tăng
  count như trước; snapshot còn mới không bị ghi đè bởi submit lần nữa. Snapshot
  không thành canonical facts, không được dùng để approve, chấm credit hay xác
  minh closure. Approve vẫn xác minh provider độc lập theo luồng hiện hữu.
- **LIST: ZERO provider calls**, gồm Details, photoRefs và media; không reserve
  display budget, không hydrate background/prefetch và không fetch dòng dư cursor.
  Snapshot quá 30 × 24h bị bỏ khỏi response, `providerStatus=deferred`; không có
  snapshot cũng deferred. Không đổi fetchedAt để che tuổi dữ liệu.
- Approved/merged dùng canonical GoGo name/address/category/photo và placeId;
  không dùng snapshot hoặc gọi provider, cả list lẫn detail. Rejected có thể dùng
  snapshot còn mới mà không lookup khi đọc list. Không suy đoán rejection lịch sử.
- **DETAIL:** kiểm quyền trước mọi call. Pending/rejected thiếu snapshot hoặc
  snapshot quá 30 ngày mới được refresh quality Details trong budget display
  hiện hữu. Một atomic DB lease 60s chặn các request đồng thời cùng mua refresh;
  không giữ transaction/row lock qua provider call. Thành công lưu allowlist
  snapshot mới, không ghi photo, không đổi updatedAt/review concurrency token.
  Snapshot mới được tái dùng tối đa 30 ngày, không refresh sớm. Lỗi không phục vụ
  snapshot hết hạn; cho phép retry sau lease 60s, vẫn phải reserve budget.
- Cửa sổ refresh 6s. Facts đã nhận hợp lệ được giữ ngay trước taxonomy/photo
  optional; photoRefs nhận remaining deadline và AbortSignal. Hết hạn abort
  photo lookup, trả facts đã trả tiền với status ok, chỉ bỏ photo. Details chưa
  xong thì unavailable; kết quả đến muộn không bắt đầu photo hay persist snapshot.
- Snapshot list/detail kèm tối đa một photo reference BFF được dựng tại chỗ từ
  Place ID, không lookup/persist Google photo name/ref/URL. Lazy URL là GET JSON,
  không phải image src. Client chỉ resolve card đang nhìn thấy (hoặc detail);
  response proxy quyết định availability và credit authoritative, reference
  dựng tại chỗ có authorAttributions rỗng. Flag/budget giới hạn media như
  ADR-0043. Không lưu bytes trước approval; Google photo sau approve theo ngoại
  lệ ADR-0043, không mở rộng ngoại lệ đó.
- Name ưu tiên catalogue/review draft, address ưu tiên catalogue; fallback
  snapshot phải hiển thị Google Maps attribution. Category top-level ưu tiên
  taxonomy đã submit còn active rồi đến snapshot. Cả response no-store; client
  không được cache token/facts/photo ngoài flow. Rate list 10/min/IP+actor,
  detail 30/min/IP+actor. Không thêm scheduler.
- User đã đăng ký, submitted_by_user_id hoặc contributor EXISTS trong SQL;
  unknown/không có quyền cùng 404 trước budget/provider; guest/admin 403.
  `contribution.verificationStatus=unverified` chỉ chứa input người gửi gốc;
  contributor khác chỉ thấy facts chung. Không lộ reviewer/decision note/user/
  room/private bytes. Reader enrichment #796 dùng `to_jsonb(s)->'enrichment'`,
  allowlist nested; mediaId/kind của chính mình, không private URL. Không đổi
  writer/wizard/credit của #796.

## Số call dự kiến mỗi phiên

| Thao tác                                             | Details quality                              | photoRefs / media                                              |
| ---------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Resolve một link rồi submit token                    | 1 ở resolve, 0 ở submit                      | Resolve tối đa 1 refs theo flag; 0 media tự động               |
| Submit không token                                   | 0 (1 core Details ở submit)                  | 0 / 0                                                          |
| Mở/refresh list 25 rows bất kỳ                       | **0**                                        | **0 / 0**                                                      |
| Mở detail snapshot ≤30 ngày                          | 0                                            | 0 / 0 tự động                                                  |
| Detail pending/rejected thiếu hoặc snapshot >30 ngày | Tối đa 1, phải reserve; lease chặn đồng thời | Tối đa 1 refs trong remaining deadline, 0 media                |
| Client resolve một lazy card photo                   | 0                                            | 1 refs + tối đa 2 media (retry expired ref), mỗi media reserve |
| Detail approved/merged                               | 0                                            | 0 / 0 tự động                                                  |

Ví dụ xem 25 submissions rồi mở 3 detail còn mới: 0 Details display. Nếu client
chọn tải 3 ảnh đang nhìn thấy thì tối đa 3 media thường lệ, tối đa 6 khi ref hết
hạn và retry. Ngân sách shared display vẫn bảo vệ photo/detail; history không
còn tự tiêu cả $0.50. Không tuyên bố đây là estimate bill cố định của Google.

## Lưu gì và giới hạn policy

Place ID được giữ theo vòng đời hiện hữu (Google cho phép giữ ID không thời hạn).
Snapshot ứng dụng nằm trong `place_submissions.display_snapshot`; chỉ phục vụ khi
còn mới ≤30 ngày; row hết hạn không được trả facts, detail refresh theo budget.
Không lưu photo/raw payload vào snapshot, event, log, job hay resolution record.
Resolution record chỉ tồn tại tới expiry của token và tự xoá qua Redis TTL;
snapshot lâu dài chỉ nằm trên submission sau submit.

**30 ngày là quyết định freshness của owner, không phải khẳng định Google cấp
quyền cache mọi field trong 30 ngày.** [Places API policy](https://developers.google.com/maps/documentation/places/web-service/policies)
chỉ miễn hạn chế cho Place ID và dẫn các ngoại lệ field-specific; không xác nhận
blanket allowance cho name/address/rating/hours. Phạm vi snapshot này thay quyết
định transient-only của ADR-0006/0045 cho riêng đóng góp #801 theo owner; cần xác
nhận quyền sử dụng áp dụng trước rollout. Thay policy không đồng nghĩa tự có giấy
phép. Không coi freshness TTL là cơ chế purge retention tự động: snapshot hết hạn
vẫn nằm trên row cho tới refresh/xoá submission; nếu điều khoản áp dụng yêu cầu
purge vật lý thì phải có quyết định retention tương ứng trước rollout.

## Migration và rollback

`0088_submission-display-snapshot` dùng journal idx 88, sau upstream
`0086_place-submission-photos` và `0087_taxonomy-version`. ADR dùng 0048 vì
upstream #800 đã dùng 0047; contract reconcile thành `7.4.0-alpha.1`.
Hai cột nullable `display_snapshot` và `display_refresh_started_at`,
không backfill/Google call khi migrate. Legacy rows list thiếu facts cho tới khi
user mở detail. Chạy migration trước API; ảnh/attribution/input hiện hữu giữ nguyên.

Rollback API/client trước rồi drop hai cột bằng migration mới; không có bytes
snapshot cần cleanup. Token chỉ thêm resolution id trong payload v1 có chữ ký,
vẫn ≤1024 ký tự; verifier cũ bỏ qua field và chấp nhận identity proof. Redis
record tự hết hạn, không cần migration hay cleanup riêng khi rollback.
Không downgrade schema trước reader.
Tắt units quality dừng detail refresh, list fresh snapshot vẫn không gọi provider.
No-store/rate/auth/photo budget và moderation không phụ thuộc rollback snapshot.

## Owner decision 2026-11-07

Astra r2 F-03 P1 found that persisting the Google display snapshot (name,
address, category, rating/count, hours) at submit has no established storage
right under ADR-0006 §9.3: only Place ID may be retained indefinitely, and
coordinates for ≤30 consecutive days. The owner accepted this risk and ordered
to proceed and merge: “Vẫn làm. Merged đi”. The 30-day refresh is an internal
freshness rule, not a Google permission. Follow-up: verify against the current Google Maps Platform
terms and change the design if required.
