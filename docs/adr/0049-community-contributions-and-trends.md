# ADR-0049: Đóng góp cộng đồng, xu hướng và promote tại địa điểm

- **Status:** proposed — chờ owner chốt tham số và Astra review trước khi code
- **Date:** 2026-11-07
- **Deciders:** Product Owner, Astra (review kiến trúc), CODEOWNER BE/CMS/Mobile

## Context

GoGo-BE#804 ghi nhận hai chỉ đạo owner ngày 2026-11-07: mọi ảnh và phần bổ sung
của người dùng thuộc mục đánh giá/đóng góp của chính họ; nhiều người cùng đề xuất
có thể tạo xu hướng cộng đồng. Chỉ Editor hoặc Moderator được promote ảnh người
dùng vào gallery chính/ảnh bìa, hoặc promote thủ công thuộc tính thành xu hướng.
Hệ thống có thể promote xu hướng theo quy tắc owner bên dưới. Duyệt nội dung
không đồng nghĩa xác minh place facts hoặc promote.

Hiện trạng tại base `re-design` `45d9d082`:

- [ADR-0046](0046-place-submission-photos.md), #793/PR #794 đã merge: approve/merge
  chọn ảnh rồi tạo `place_media` approved, `source=community`. Mapper
  `libs/modules/search/domain/place-dto.ts` đưa các ảnh này vào `photos`, cùng
  gallery chính. Cần thay hành vi và phân loại lại dữ liệu đã ghi, nếu có.
- Module `libs/modules/reviews` chỉ công khai review `published`; rating 1–5 bắt
  buộc, text tùy chọn, edit quay về pending. Public author chỉ có display name;
  không có avatar/user ID. [ADR-0028](0028-gogo-community-rating-on-place-detail.md)
  tính GoGo rating trên review published, ngưỡng 5 review; đây là số review,
  không phải số người. Không dùng lại công thức đó cho xu hướng.
- [ADR-0043 provider photo](0043-approved-submission-provider-photo.md) cho phép
  một ảnh Google được duyệt/backfill, có attribution; đây là luồng provider
  riêng. Quyết định promote ở đây áp dụng cho ảnh người dùng, không xóa hoặc
  đổi nguồn của ảnh editorial/provider hợp lệ hiện hữu.
- [ADR-0045](0045-my-place-submissions.md) giữ attribution nhiều contributor cho
  một submission dedupe. Attribution không chứng minh mọi người đồng ý với cùng
  enrichment và không được biến thành nhiều phiếu.
- Nhánh `be-796` (PR #802), `0048-place-contribution-wizard.md`: enrichment là
  proposal chưa xác minh; giá có đơn vị, purpose/vibe/amenities/tips, service/space
  rating, ảnh menu/bill. Bản working tree hiện tại trên HEAD `581c2749` ghi quyết
  định **FINAL của owner 2026-11-07**: không nhận `visibility`, mọi ảnh menu/bill
  được duyệt đều công khai trong `userPhotos`, không tự vào gallery/cover. Mỗi
  lần save/submit có bill phải có `enrichment.billPhotoPublicConsent=true`;
  không có lựa chọn bill chỉ GoGo xem, không DLP. Draft/pending ở private storage;
  bill bị reject/không được chọn được dọn, bill approved giữ bytes để phục vụ
  user photo. OpenAPI working tree của #802 định nghĩa `userPhotos: PlacePhoto[]`;
  ADR này giữ nguyên array và item contract đó, chỉ mở rộng additive.
- Nhánh `be-801` (PR #803), `0048-my-submission-display-detail.md`: display snapshot
  provider chỉ phục vụ lịch sử của tôi, không là facts canonical, input tác giả
  hay bằng chứng xu hướng. Cả hai ADR song song dùng 0048; ADR này dành số 0049.

Căn cứ: SRS FR-USER-002, FR-PLAN-008, FR-INGEST-010..015; core rules 8 (facts đã
xác minh), 13 (giá đi cùng đơn vị), 14 (rating có nguồn và cỡ mẫu), 15 (một
PlaceCard, thiếu dữ liệu thì bỏ field); `api-contract.md`, `security.md` tại
workspace GoGo. Đây chỉ là quyết định thiết kế, không chấp thuận triển khai,
không khẳng định các nhánh song song đã merge hay được acceptance.

## Options considered

1. Ghi mọi phần được duyệt vào place facts/media chính — ít bảng nhưng làm mất
   nguồn cộng đồng, nhầm duyệt với xác minh và trái chỉ đạo owner; loại.
2. Mở rộng trực tiếp `reviews` thành mọi loại đóng góp — ít lớp hơn nhưng phải
   bỏ ràng buộc rating bắt buộc và thay đổi contract/aggregate rating cũ; chưa chọn.
3. Entry cộng đồng chung liên kết review/ảnh/enrichment, aggregate và promotion
   riêng — thêm projection và đồng bộ nhưng giữ tương thích, truy được tác giả,
   gỡ được và phân biệt ba nguồn dữ liệu; chọn.

## Decision

### 1. Entry và quyền sở hữu

Các tên bảng/DTO/route dưới đây là đề xuất cho bước BE sau Astra review, chưa
phải OpenAPI đã phát hành. Reviews module sở hữu entry công khai; ingestion sở
hữu proposal và moderation đầu vào; dùng application port/outbox để nối hai bên.

| Thực thể đề xuất | Dữ liệu và bất biến |
| --- | --- |
| `community_entries` | id, place_id, author_user_id nullable sau ẩn danh, source_kind, source_id, created_at, updated_at, version, trạng thái; một tác giả thật cho mỗi entry |
| `community_entry_revisions` | snapshot input tác giả theo revision, text/tips, enrichment có schema version, moderation verdict/reason nội bộ; chỉ revision published được đọc công khai |
| Liên kết review | review_id unique nullable; rating tổng thể lấy từ review hiện hữu, không sao chép thành rating thứ hai; review về plan không tự xuất hiện ở place |
| `community_entry_photos` | entry/revision, photo_id ổn định, uploader thật, kind photo/menu/bill, moderation, derivative reference, consent record cho bill; không có visibility input/nhánh private cho menu/bill mới; legacy private evidence tách riêng, không vào projection public |
| `community_observations` | entry/revision, author, place, attribute key/value chuẩn hóa, observed_at; chỉ từ input có tác giả và đã duyệt, không từ provider snapshot |
| `community_trend_aggregates` | place/attribute/value, support_count, respondent_count, window_start/end, computed_at, policy_version, source_revision, dirty/required_revision, next_expiry_at; projection có thể dựng lại, không lưu quyết định chiếm slot bootstrap |
| `community_promotions` | đích photo hoặc attribute/value, trạng thái, version, actor CMS, reason, evidence revision, timestamps; quyết định và audit riêng |

Entry có thể chỉ có ảnh hoặc enrichment, không ép thêm sao giả. Service/space
ratings của wizard là chiều đánh giá riêng, không tự trở thành sao tổng thể.
Một entry có nhiều phần nhưng chỉ một danh tính tác giả; entry từ submission
được chia theo uploader/input thực tế, không gán ảnh của contributor B cho A.
Unique `(source_kind, source_id, author, source_component)` chống tạo trùng khi
retry/backfill; review liên kết chỉ render một lần trong feed.

Cho phép nhiều entry theo thời gian của một user tại một place; chủ sở hữu được
sửa/xóa entry của mình, không sửa người khác. API kiểm actor đang active và
ownership từ DB; guest không được tạo public entry mới. Input guest lịch sử chỉ
được chuyển nếu có attribution tin cậy, nếu không giữ không tên và không bỏ phiếu.
Không suy ra verifiedVisit từ việc duyệt entry, ảnh hay enrichment.

Trạng thái revision: `pending → published | rejected`; published có thể thành
`removed` (moderation), `hidden` (takedown), `deleted` (owner). Edit dùng version/
ETag, tạo revision pending và rút revision cũ khỏi public ngay, tương thích hành
vi edit review hiện có. Chỉ publish lại sau duyệt; không tự fallback revision cũ
để cộng phiếu. Phần ảnh còn có quyết định từng ảnh: entry published không đủ để
đọc ảnh pending/rejected hoặc legacy private evidence. Reject có reason key an
toàn cho owner; moderator notes không ra public. Sửa/xóa review liên kết phải cập nhật entry,
vô hiệu observations/promotions phụ thuộc trong cùng transaction.

### 2. Quy tắc promote xu hướng

Xu hướng mô tả nhận xét cộng đồng, không ghi đè hours, availability, price hay
taxonomy facts đã xác minh. Chỉ taxonomy key active, kiểu dữ liệu và đơn vị được
allowlist bởi API; không dùng AI/free text để tự tạo thuộc tính. Tips vẫn là text
được duyệt. Nhãn dịch ở client, không persist câu chữ để làm khóa aggregate.

Quyết định **FINAL của owner ngày 2026-11-07**:

| # | Case | Condition | Trigger | Default (config) |
| --- | --- | --- | --- | --- |
| 1 | Manual promote | editor/moderator promotes an attribute | editor/moderator, audited, reversible | none |
| 2 | Auto, any place | distinct users proposing the attribute > x | system recompute | x = 1000 |
| 3 | Bootstrap (few trends) | place has < 5 trends (counting rows 1 and 2) AND attribute has ≥3 proposals from 3 distinct users | system fills empty slots up to 5 | 3 users |
| 4 | Place already has 5 trends | row 3 no longer applies; only rows 1 or 2 | — | — |

Mỗi người chỉ được tính một lần cho mỗi thuộc tính tại một place; chỉ đóng góp
đã duyệt mới được tính. `support_count` là số người dùng khác nhau đề xuất cùng
thuộc tính/giá trị. Hàng 2 dùng `support_count > x`, mặc định cần ít nhất 1001
người; hàng 3 dùng ngưỡng bootstrap riêng, mặc định ít nhất 3 người. Khi chọn tại
read, đếm các trend duy nhất từ hàng 1 và 2 trước, rồi chọn ứng viên bootstrap theo
`support_count` giảm dần để lấp tối đa 5 trend; hòa dùng key/value ổn định.
Khi đã có ít nhất 5 trend từ hàng 1 và 2, hàng 3 không còn áp dụng.

Guard tùy chọn cho auto và bootstrap, cấu hình được, **mặc định bật**:

- Chỉ tính đề xuất trong **12 tháng lịch gần nhất UTC**.
- Thuộc tính/giá trị phải chiếm đa số (**>50%**) trong các đóng góp đề cập đến
  thuộc tính đó: `support_count / respondent_count > 0.5`, sau dedupe theo user.

Ngưỡng `x`, ngưỡng bootstrap và các guard là **cấu hình server có version,
không hard-code**; client không chọn ngưỡng. Khi tắt guard thời gian, không giới
hạn đề xuất theo cửa sổ 12 tháng; khi tắt guard majority, không yêu cầu quá bán.

Hiển thị **TOP 5 theo số người đề xuất** (`support_count` giảm dần; hòa dùng
key/value ổn định). Trend được editor/moderator promote còn hiệu lực **luôn
hiển thị với nhãn “đã duyệt”**, kể cả ngoài TOP 5. Hợp nhất và dedupe TOP 5 với
các trend promote thủ công; tổng hiển thị có thể lớn hơn 5. **Mọi trend luôn có
số nguồn “N người dùng”**, lấy từ count thực theo policy, không nâng count để
đạt ngưỡng. Quy tắc hiển thị tuân thủ safety/privacy gate và suppression ở mục 3.

- Population: account active, entry/revision published, observation trong cửa sổ nếu guard thời gian bật;
  loại pending/rejected/removed/hidden/deleted, account bị ban/suspend/deleted
  hoặc evidence bị quarantine. Không đếm submissionCount, helpful votes, số ảnh
  hay số entry làm số người. Một account chỉ một phiếu/place/attribute.
- Chọn phát biểu **mới nhất còn hiệu lực** của mỗi người theo `(observed_at, id)`;
  edit không làm mới observed_at để kéo dài cửa sổ. Xóa phát biểu mới nhất không
  tự hồi sinh phát biểu cũ đã bị thay thế; cần khai báo mới để đổi ý.
- Boolean: true là ủng hộ, false là phản đối, absent là chưa trả lời. Mẫu số chỉ
  gồm người đã trả lời thuộc tính ấy. Với cấu hình mặc định, 1001 true/0 false
  đạt hàng 2; 3 true/0 false chỉ đủ bootstrap khi place còn slot; 3 true/3 false
  không qua guard majority; 2 true/0 false chưa đủ bootstrap.
  Multi-select tính riêng mỗi key; không chọn không mặc nhiên là false.
- Enum: mỗi giá trị có support riêng trên cùng mẫu người trả lời; cần quá bán
  để qua guard majority khi guard bật; hòa thì không có giá trị quá bán. Mỗi user
  chỉ có một giá trị còn hiệu lực cho cùng thuộc tính.
- Giá: integer minor units + currency + unit luôn đi cùng nhau; không đổi
  per_group thành per_person. Đề xuất taxonomy các khoảng giá có version riêng
  từng currency/unit; mỗi user một khoảng, chỉ công bố khoảng đủ điều kiện theo bảng và các guard đã cấu hình.
  Không tự suy đoán bucket khi thiếu đơn vị; chưa có bucket được owner duyệt thì
  chỉ hiển thị giá tại entry, chưa tạo xu hướng giá. Miễn phí là giá trị riêng.
- Không có đủ mẫu thì bỏ trend, không trả giá 0/sao 0/câu placeholder. Không
  đánh đồng ngưỡng xu hướng x với ngưỡng GoGo rating 5 của ADR-0028.

Mutation publish/edit/delete/takedown/account state/promotion ghi outbox cùng
transaction; worker idempotent recompute theo place/attribute từ dữ liệu nguồn,
không tăng/giảm counter mù. Serialize theo aggregate key, kiểm source revision
trước swap để job cũ không ghi đè job mới. Serialization này chỉ bảo vệ count,
không quyết định eligibility/ranking/slot bootstrap của cả place. Sweep hằng ngày
xử lý hết cửa sổ dù không có mutation; reconciliation dựng lại toàn bộ theo batch có checkpoint.
Đề xuất SLO cập nhật thông thường ≤5 phút, chờ owner/ops duyệt.

**Chọn xu hướng tại read từ snapshot nhất quán của cả place:** dùng một SQL
statement hoặc read-only transaction `REPEATABLE READ`, cùng mốc thời gian UTC,
đọc toàn bộ aggregate rows của place cùng policy active, required revisions,
taxonomy, manual promotions và suppression. Chỉ dùng aggregate sạch, đủ source
revision, đúng policy version và chưa tới `next_expiry_at` (null nghĩa không có
expiry theo policy hiện tại); áp safety/privacy
gate và suppression trước, manual override cùng attribute trước auto. Đếm tập
duy nhất hàng 1/2 còn hợp lệ, rồi xếp các aggregate bootstrap đủ ngưỡng/guard theo
`support_count DESC, key/value` để chọn tối đa `max(0, 5 - count(hàng 1/2))` ứng viên.
Từ tập đó chọn TOP 5 và hợp nhất manual theo mục 3. Rank aggregate rows, không
quét lại observations ở mỗi read; không phân trang/cắt candidate pool trước khi
chọn. Hai attribute tranh slot cuối được so trong cùng snapshot, chỉ một được
chọn; không persist bootstrap selection riêng ở từng aggregate.

Mỗi lần đọc chọn lại toàn place: aggregate swap/count thay đổi, promote/unpromote,
suppression/clear, evidence bị rút, taxonomy/policy đổi đều làm selection cũ hết
giá trị sau commit. Mutation nguồn đánh dấu các aggregate liên quan dirty và
tăng required revision trong cùng transaction; worker chỉ clear khi swap đúng
revision. Expiry vô hiệu row ngay khi tới `next_expiry_at`, kể cả chưa có event
hay sweep. Bỏ row không hợp lệ rồi chọn lại slot/TOP 5 từ snapshot còn lại;
không giữ bootstrap winner cũ hoặc count cũ để lấp slot. Không cache selection
qua request; thiếu aggregate hợp lệ thì trả freshness/status degraded.

Thu hồi vì privacy/moderation phải có hiệu lực ở lần đọc kế tiếp: transaction
đánh dấu aggregate bẩn và promotion phụ thuộc không hợp lệ; read bỏ aggregate
bẩn cho tới recompute, không phục vụ count cũ. Tại read kiểm `next_expiry_at`:
aggregate quá thời điểm hết hạn gần nhất cũng bị bỏ nếu worker trễ. Không tạo
xu hướng từ job đang lỗi; expose degraded status có cấu trúc, không giả count 0.

Chống abuse: rate limit theo account/device/IP, quota input/ảnh, idempotency,
moderation và report/quarantine; account khác nhau không bảo đảm là người thật
khác nhau. Chỉ tín hiệu abuse server mới loại phiếu, có audit và khả năng review;
không công khai thiết bị/IP hoặc danh sách voter, không coi vượt x là chứng nhận.

### 3. Promote/unpromote và thứ tự ưu tiên

API policy chỉ cho vai trò CMS `editor`/`moderator` theo role registry; không cấp
quyền chỉ vì UI hiện nút. Proposed mutations:
`PUT/DELETE /v1/cms/places/{id}/community-photo-promotions/{photoId}` và
`PUT/DELETE /v1/cms/places/{id}/community-trend-promotions/{attributeKey}`.
PUT attribute chứa value chuẩn hóa và evidence entry revision; PUT photo chứa
`placement=gallery|cover`. Retry dùng Idempotency-Key; expectedVersion/ETag chống
lost update, conflict trả 409 theo error envelope hiện hữu.

Ảnh phải published, public, đã sanitize, place đang readable và có quyền sử dụng;
pending/rejected và legacy private evidence không thể promote. Menu/bill approved
đã là public user photo theo #802; promote là quyết định gallery/cover riêng.
Promote chỉ tạo tham chiếu gallery, không copy bytes hay đổi ownership/source
thành editorial. Gallery và cover giữ credit gốc;
chọn cover là hành động rõ ràng có audit, không tự lấy ảnh user đầu tiên. Unpromote
cover xóa cover reference nguyên tử, không tự chọn ảnh user khác. Ảnh vẫn nằm ở
mục đóng góp nếu còn hợp lệ. Mọi đường CMS đặt cover/reorder/attach phải kiểm
promotion; không cho đường chỉnh media cũ vượt qua invariant.

Thuộc tính promote thủ công có thể dưới ngưỡng nhưng vẫn là community trend,
`selection=manual`, không thành verified fact. Manual override ưu tiên hơn auto
cho cùng attribute; count là số thực, không ép count vượt x. Có evidence nhưng không
có người đề xuất đủ điều kiện thì vẫn trả count thực bằng 0 và hiển thị
“0 người dùng”; luôn có nhãn “đã duyệt” qua i18n.
Manual không vượt privacy, visibility, inactive taxonomy hoặc moderation gate.
Evidence bị rút làm promotion mất hiệu lực, cần chọn evidence mới và duyệt lại.

Quyết định owner **2026-11-07**: place hiển thị **TOP 5 xu hướng**, xếp giảm dần
theo số người dùng đề xuất (`support_count`, đếm distinct user theo policy ở mục
2); hòa thì dùng key/value ổn định. Xu hướng được promote còn hiệu lực **luôn
hiển thị và có nhãn “đã duyệt”**, kể cả ngoài TOP 5 hoặc dưới ngưỡng auto. Hợp nhất
TOP 5 với các xu hướng promote, không render trùng cùng attribute/value; do đó
tổng số xu hướng hiển thị có thể lớn hơn 5. Quy tắc luôn hiển thị vẫn tuân thủ
safety/privacy gate và suppression bên dưới.

Unpromote thuộc tính chỉ gỡ manual override; nếu auto còn đạt thì nó vẫn đủ
điều kiện với `selection=automatic` (hàng 2 hoặc bootstrap hàng 3), hiển thị tại place nếu
nằm trong TOP 5. CMS
phải preview kết quả này. Cần ẩn cả auto thì
dùng trạng thái `suppressed` riêng, cùng quyền, reason và audit; clear suppression
mới cho auto quay lại. Thứ tự: safety/privacy gate → suppression → manual → auto.
Ảnh không có auto promotion; unpromote luôn gỡ khỏi gallery/cover.

Audit append-only ghi actor CMS, action, target, before/after version, evidence
IDs, reason key, request/correlation ID, UTC time. Không lưu bytes, bill/text thô,
PII hoặc storage URL trong audit. Promotion write, audit và outbox commit nguyên
tử; lỗi audit thì mutation rollback. Nội dung audit cũ không sửa khi unpromote.

### 4. Public DTO và tương thích

Giữ các fields place detail hiện hữu cho facts canonical và provider attribution;
thêm projection có namespace, không nhét trend vào `prices/hours/taxonomies`.
Place facts có provenance/verifiedAt; không gắn nhãn verified cho field cũ thiếu
bằng chứng. Mâu thuẫn giữa fact và trend được giữ nguồn riêng, không âm thầm hợp nhất.

| Projection đề xuất | Facts trả về |
| --- | --- |
| `communityEntries` | page `items/nextCursor`; entryId, version, timestamps, sourceKind, author.displayName nullable, optional overallRating, text/tips, enrichment, photo preview |
| `communityTrends` | key/value, source=community, selection, supportCount bắt buộc, respondentCount khi có, windowStart/end, computedAt, policyVersion, freshness/status |
| `userPhotos` | giữ array `PlacePhoto[]` trên place detail theo #802; required `id`, `url`, `source`; optional `width`, `height`, `contributor.displayName`, `attribution`, `authorAttributions`, `googleMapsUri` giữ nguyên tên/kiểu/semantics |
| `userPhotosPagination` (optional, mới) | metadata sibling của array detail: `nextCursor` nullable để đọc tiếp tại `/v1/places/{id}/user-photos`; không bọc/đổi kiểu `userPhotos` |
| Page `/v1/places/{id}/user-photos` (mới) | `{items: PlacePhoto[], nextCursor: string \| null}`; cùng item contract/ID/URL/credit với detail; metadata entry/kind/timestamps/promotion nếu thêm vào item đều optional |
| `photos` và cover hiện hữu | editorial/provider hiện hữu và ảnh user có promotion còn hiệu lực; mỗi ảnh giữ source/credit riêng |

Giữ nguyên `PlacePhoto`: không đổi `id` thành `photoId`, `width/height` thành
`dimensions`, hoặc `contributor` thành `author`. `contributor` khi có vẫn bắt buộc
`displayName: string`; bỏ cả object cho guest/erased account, không trả null thay
string. Giữ enum `source=google|community|manual`, user photo vẫn `community` sau
promote. Các metadata mới như `entryId`, `kind`, `contributedAt`, `publishedAt`,
`promotion` chỉ là field optional bổ sung; không thay field hiện hữu hoặc bắt
client cũ đọc chúng. Quy tắc nullable author của entry không áp sang PlacePhoto.

Place detail giữ nội dung/ordering array theo #802; thêm metadata đọc tiếp mà
không tự cắt ngắn array cũ trong lần tiến hóa MINOR này. Với array đã trả hết,
`userPhotosPagination.nextCursor=null`. Preview của projection mới có thể giới
hạn; endpoint user-photo mới cung cấp phân trang độc lập. Proposed GET
`/v1/places/{id}/community-entries`, `/community-trends`, `/user-photos` cho các
trang độc lập; không tái định nghĩa response `/reviews` cũ để nhận rating optional.
Endpoint entry/photo mới mặc định keyset `(created_at, id)` giảm dần, limit mặc
định 20/max 50, cursor có place/filter và timestamp microseconds; timestamp sort không đổi khi
edit. Cursor không mang quyền; kiểm visibility/ownership mỗi request. Không hứa
snapshot giữa các trang khi có moderation. Preview trend tại place áp dụng TOP 5
và bổ sung mọi trend promote còn hiệu lực theo mục 3; DTO dùng `selection=manual`
để client hiển thị nhãn “đã duyệt”; mọi trend luôn hiển thị “N người dùng”. Trend list xếp `supportCount` giảm dần, key/value
ổn định khi hòa; phân trang nếu taxonomy lớn. GET public no-store và rate limit
riêng; private `/me` và CMS
không dùng chung cache. URL content BFF kiểm lại quyền/trạng thái mỗi lần đọc.

Public credit chỉ có entry `author.displayName` hoặc photo `contributor.displayName`
theo contract tương ứng, không public user ID/avatar, reviewer,
room, danh sách người vote, notes hoặc private evidence. DTO trả source/count/key,
không trả câu “12 người dùng”; client dịch từ facts. Unknown bỏ field, không sinh
placeholder. GoGo/provider rating và cỡ mẫu giữ riêng theo core 14. Card vẫn dùng
PlaceCard hiện hữu theo core 15; không tạo biến thể card tự bịa facts từ trend.

OpenAPI thêm field optional và route mới theo MINOR; kiểm compatibility trên
OpenAPI working tree mới nhất của #802 trước khi publish, kể cả #802 merge trước.
Không thay array/item contract dưới nhãn additive. Generated TS client phát
hành từ BE, CMS/Mobile regenerate. Loại ảnh user chưa promote khỏi `photos` là
thay đổi hành vi có chủ đích theo owner, phải ghi release note/consumer acceptance;
additive schema không có nghĩa client cũ giữ gallery như trước. Không cần tạo
promotion giả để giữ ảnh cũ. BFF là cổng duy nhất, không gọi DB/provider từ client.

### 5. Privacy và vòng đời

Tái dùng sanitize/claim/cleanup ADR-0046 và quyết định FINAL của #802 trên #796:
không nhận visibility input; mọi menu/bill approved đều public trong `userPhotos`.
Mỗi save/submit có bill bắt buộc `enrichment.billPhotoPublicConsent=true`; thiếu
hoặc false trả 400 `VALIDATION_FAILED`, field error tại field đó. User xác nhận
đồng ý công khai sau duyệt và đã tự xóa/che PII; menu không cần consent bổ sung.
Không DLP hay provider xử lý PII bên ngoài; re-encode/strip metadata không che
nội dung ảnh. Moderator được bỏ ảnh còn PII. Draft/pending ở private storage,
chỉ owner/CMS có quyền tương ứng; public BFF recheck approval/place mỗi lần đọc.
Bill rejected/không được chọn enqueue cleanup bytes/derivatives trong transaction
decision, thử dọn sau commit và worker retry; bill approved giữ bytes cho userPhotos.
Menu rejected giữ retention #794 (7 ngày); draft hết hạn/bỏ ref/delete/erasure
đi qua cleanup queue. Không lấy giá từ ảnh bằng AI; consent public user photo
không tự cấp gallery/cover promotion. Export owner gồm entry/revision đang giữ,
input, consent và promotion của ảnh mình; không gồm moderator notes hay người khác.

Chỉ dữ liệu lịch sử có bằng chứng policy/consent private từ trước quyết định FINAL
mới là **legacy private evidence**: không backfill thành user photo, không promote,
cleanup theo retention/decision cũ. Đây không phải lựa chọn cho upload mới và
không suy ra production đang có dữ liệu loại này.

Owner xóa entry/photo: chặn public read ngay, vô hiệu promotion/cover và observation
trong transaction, enqueue cleanup khi không còn tham chiếu sống. Tham chiếu
promotion không được ngăn erasure. Cleanup original/derivative theo pipeline
hiện hữu, có retry/dead letter; không đổi private object thành public bucket.

Account deletion hiện theo [ADR-0023](0023-account-deletion-policy.md): review
và ảnh đóng góp có thể được giữ nhưng bỏ tên. Không tự đổi chính sách đó trong
#804. Với entry mới, đề xuất giữ public contribution đã duyệt dưới credit null,
xóa draft/legacy private evidence và loại account deleted khỏi population xu hướng;
entry/ảnh đã promote còn giữ chỉ nếu policy retention cho phép và không có yêu
cầu xóa nội dung. Owner phải chốt extension này trước triển khai. Yêu cầu erasure
nội dung rõ ràng áp dụng đường thu hồi ở trên, kể cả bản đã promote. Dùng account
lock + kiểm active cho writer, serialize với deletion để không tái tạo dữ liệu.
Audit giữ chứng cứ tối thiểu, pseudonymize actor liên quan theo privacy policy;
retention/backup purge phải theo chính sách được duyệt, không hứa xóa bytes tức thì.

## Consequences

BE thêm entry projection, worker aggregate và policy promotion; CMS có mục đóng
góp/ảnh/xu hướng riêng, preview nguồn/count và thao tác theo quyền. Mobile gom
ảnh + bổ sung vào mục Đánh giá, ảnh user tách gallery chính; giữ nguồn xu hướng
khác facts. Cần làm rõ khác biệt giữa duyệt, promote và xác minh cho CMS operator.

Metric đề xuất: `community_entry_transition_total{outcome}`,
`community_trend_recompute_total{outcome}`, recompute duration/lag, dirty aggregate
age, `community_promotion_total{target,action,outcome}`, backfill counters theo
outcome và cleanup failures. Labels hữu hạn; không user/place/photo IDs, URL,
text/tips/bill hay exact location. Alert worker lag, outbox retry/dead letter,
unpromoted community media/cover lọt gallery, projection lệch source và erasure
pending quá retention. Audit phục vụ truy trách nhiệm; metrics không thay audit.

Gate cho triển khai sau ADR: Astra review mô hình/quyền/retention, owner chốt
các câu hỏi còn mở bên dưới, CODEOWNER review contract/migration. Kiểm chứng phải có: dedupe nhiều
uploader, retry approve/backfill, sửa/xóa trong khi worker chạy, x và majority
boundary, false/absent/ties, recency expiry không có event, giá khác unit, account
abuse/deletion, promotion race và audit failure, bill thiếu/false consent bị từ
chối, không có visibility input/DLP, menu/bill approved giữ bytes và public trong
userPhotos, bill rejected/không chọn được dọn, pending/legacy private không đọc
public/promote, credit sau unpromote, TOP 5 theo số người đề xuất, promote ngoài TOP 5 vẫn hiện
và có nhãn “đã duyệt”, bootstrap lấp slot tới 5 và dừng khi hàng 1/2 đủ 5,
hai attribute tranh slot cuối, chọn lại toàn place khi count/promotion/suppression/
expiry đổi và khi worker swap trễ, không scan observations mỗi read,
count luôn hiện, dedupe trend auto/manual, cover invariant, cursor ties, client
#802 vẫn đọc array `userPhotos` và `PlacePhoto` cũ (kể cả contributor bị omit),
page mới dùng cùng item shape, không đổi rating cũ, rollback không phục hồi
gallery sai. Đây là acceptance plan, chưa phải test đã chạy.

Các câu hỏi cần owner chốt trước code:

1. SLO cập nhật ≤5 phút có phù hợp? Có cần override cấu hình theo attribute và
   điều kiện account age/trust không?
2. Taxonomy bucket giá/currency/unit và danh sách attribute được auto aggregate;
   service/space ratings có cần xu hướng riêng hay chỉ nằm tại entry?
3. Đồng ý unpromote manual có thể lộ lại auto, với suppression riêng? Manual
   promotion có hạn dùng hay cần nhắc review định kỳ?
4. Xác nhận retention cho enrichment/entry mới khi account deleted, thời hạn
   giữ revision/audit/backup và đường yêu cầu xóa nội dung đã promote.

## Migration & rollback

1. Sau Astra review mới lập migration/contract cụ thể; không chiếm số SQL tại
   ADR này. Reconcile hai nhánh #802/#803 (cùng đề xuất migration 0088/ADR 0048)
   theo thứ tự merge thực tế; lấy OpenAPI #802 mới nhất làm compatibility basis,
   giữ `userPhotos: PlacePhoto[]` và thêm metadata/endpoint như mục 4, không rename.
   Không lấy display_snapshot làm input cộng đồng.
2. Inventory read-only/dry-run: đối chiếu `place_submission_photos` approved,
   media upload/uploader, `place_media` community và mọi cover reference. Báo
   counts nguồn, orphan/ambiguous links và legacy private evidence theo bằng chứng
   consent/policy cũ; không giả định production đã có rows.
3. Deploy schema additive và writer mới: approve/merge #794 chỉ publish vào
   user entry/photo, không tạo gallery media/cover. Mọi menu/bill approved của
   #802 đi cùng luồng, giữ bytes/credit cho userPhotos; bill mới bắt buộc public
   consent, không nhận visibility và không DLP. Bill rejected/không được chọn
   enqueue dọn ngay, menu rejected theo retention #794; legacy private evidence
   giữ ngoài public projection và cleanup theo policy cũ. Không đổi
   credit ledger/bonus lịch sử hoặc tự replay thưởng khi tạo entry.
4. Backfill theo batch/checkpoint, unique source keys và transaction: liên kết
   ảnh #794 với đúng uploader/entry, giữ ID/URL content legacy qua resolver an
   toàn, credit và timestamp gốc. Gỡ membership gallery/cover cũ nếu không có
   **audit promote rõ ràng** của editor/moderator. Duyệt submission không phải
   promote. Nếu là cover thì clear cover nguyên tử. Không xóa derivative còn
   dùng bởi entry; không đụng ảnh Google/editorial. Nguồn mơ hồ thì quarantine
   khỏi gallery, vào báo cáo CMS để xác minh, không tự nhận promotion.
5. Backfill reviews place thành entry liên kết một-một, không nhân bản rating;
   enrichment #796 chỉ dùng input contributor gốc có tác giả/decision hợp lệ,
   không chia cho mọi attribution dedupe. Không có per-component approval lịch
   sử thì tạo pending để duyệt lại trước publish/aggregate. Không resurrect
   legacy private bill đã dọn hoặc publish legacy private evidence, không suy ra
   observed_at từ ngày backfill hoặc tự approve.
6. Shadow recompute, so count theo distinct-user SQL độc lập; kiểm bảo toàn
   credit/bytes, không orphan và không còn user cover/gallery thiếu promotion.
   Race writer cũ: fence version/feature flag và drain trước cutover, quét delta
   tới watermark; không để producer cũ attach media sau reconciliation.
7. Rollout BE writer + read filter trước, CMS rồi Mobile cùng generated client.
   Các flag riêng cho feed/userPhotos, manual promotion, auto trends. Auto mặc
   định off tới khi hoàn tất các gate triển khai còn lại; policy ngưỡng đã được
   owner chốt ngày 2026-11-07, mở canary sau reconciliation. Không có
   flag nào được bypass consent/moderation gate hoặc đưa user media chưa promote
   về gallery; không tạo lại lựa chọn private/public cho bill.

Rollback ưu tiên tắt auto trends/manual mutations/feed mới và giữ schema, nguồn,
audit/credit. Writer approve và gallery read gate đúng theo chỉ đạo owner phải
được giữ; không rollback nguyên binary #794 vì sẽ tái tạo hành vi sai. Nếu binary
an toàn chưa sẵn sàng thì tạm dừng approve có ảnh và gallery cộng đồng, không đưa
ảnh trở lại gallery để chữa UI rỗng. Client cũ có thể chỉ thấy gallery ít ảnh hơn.
Backfill đảo bằng manifest đối chiếu khi cần sửa mapping, không replay promotion
đã revoke, không phục hồi cover chưa được phép, không phục hồi nội dung đã xóa.
Chỉ drop schema sau khi drain mọi reader/writer/job và có kế hoạch export/cleanup
được duyệt; ưu tiên roll-forward để giữ lịch sử đóng góp và audit.
