# GoGo-BE #806 — Chọn giữ/bỏ thông tin wizard

Contract: `7.6.0-alpha.1`. Áp dụng FR-CMS-001/005/008, FR-INGEST-010..015,
ADR-0048 và quyết định owner 2026-11-07. Không thay provider rating, community
rating hay trạng thái xác minh hành chính. Không cài dependency, commit hoặc push.

## Request và tương thích

CMS mới gửi `enrichmentSelection` khi duyệt hoặc gộp submission có enrichment:

```json
{
  "decision": "approved",
  "reason": "Đã xác minh các mục được giữ",
  "enrichmentSelection": {
    "keptFactKeys": ["price", "amenities:car_parking", "visitTips"],
    "keptPhotoMediaIds": ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]
  }
}
```

Danh sách rỗng ở cả hai trường nghĩa là bỏ mọi mục wizard. Không có selection
nghĩa là đường #802 cũ: không áp dụng facts wizard, ảnh chọn qua
`approvedPhotoIds`, approve +50 cơ bản, merge chỉ bonus ảnh. Đây là lựa chọn
backward-compatible để giữ MINOR; API không bắt client cũ gửi thêm trường.
Yêu cầu selection bắt buộc cho mọi client sẽ là thay đổi hành vi và cần rollout
riêng. Không dùng thiếu trường để suy ra giữ hết facts.

Khi có selection, `approvedPhotoIds` chỉ dành cho ảnh thường ngoài proposal;
không được chọn lại ảnh wizard ở cả hai nơi. Ảnh wizard dùng `mediaId` của
proposal, khác `photos[].id` của hàng moderation. UUID chuẩn hóa lowercase.
Key/ảnh không thuộc proposal, ảnh không còn pending, hoặc selection có duplicate
bị từ chối trước provider request; transaction cũng kiểm tra revision hiện tại.
Rejected không nhận selection. Quyền `moderator`/`editor` theo guard CMS hiện có;
consumer không thể gọi API quyết định hoặc xem preview.

## Stable keys và áp dụng

GET CMS detail trả `enrichmentItems.factKeys` và `photoMediaIds` còn pending.
Không lấy index hoặc label làm identity. Price là một fact nguyên khối gồm
min/max/currency/unit; purpose/vibe/amenity/chip dùng key taxonomy:

| Key                                              | Giá trị được giữ và nơi áp dụng                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `price`                                          | Object nguyên gốc trong `places.contribution_facts`; thêm `place_prices` nguồn editor, confidence 0.70 nếu unit được bảng hiện có hỗ trợ |
| `purposeKeys:<key>`                              | Fact + liên kết taxonomy suitability                                                                                                     |
| `vibeKeys:<key>`                                 | Fact + liên kết taxonomy mood                                                                                                            |
| `amenities:<key>`                                | Boolean fact; true thêm taxonomy amenity, false xóa liên kết tương ứng; không có key nghĩa là chưa biết                                  |
| `recommendedDishes`, `visitTips`                 | Chuỗi fact riêng, không ghép vào description                                                                                             |
| `service.rating`, `space.rating`                 | Rating đóng góp riêng, không nhập vào aggregate/provider rating                                                                          |
| `service.chipKeys:<key>`, `space.chipKeys:<key>` | Fact riêng cho từng chip; kiểm taxonomy checkin_tag còn active                                                                           |

`place_prices` hiện chỉ nhận per_person/per_item/per_hour/per_night. Giá
per_group/free giữ đúng object và unit trong `contributionFacts` của PlaceDetail;
không tự chuyển sang per_person. Không mở rộng enum DB trong task này.
Facts không được giữ không làm thay đổi place. Facts cùng key được giữ ở lần
sau thay giá trị trước; key không xuất hiện giữ nguyên dữ liệu catalogue cũ.
Facts taxonomy được kiểm lại active khi quyết định, lỗi rollback cả transaction.
Review draft/legacy estimate độc lập với wizard, tiếp tục theo #528/#802;
selection không xóa dữ liệu catalogue hay bản nháp review đã được duyệt trước đó.
Canonical place merge giữ facts hai bên; canonical thắng khi cùng key. Sau khi
chuyển taxonomy, transaction đối chiếu lại amenity theo facts đã gộp: false xóa
liên kết, true bảo đảm liên kết taxonomy còn active, thiếu key giữ nguyên liên kết.

Menu/bill được giữ dùng pipeline #802: public userPhotos của mục đánh giá,
credit uploader gốc; không tạo official gallery/cover. Bill bỏ được enqueue
cleanup ngay, menu bỏ theo retention bảy ngày. Không DLP mới. Consent không phải
fact để chọn hoặc public. Proposal gốc giữ nguyên để đối chiếu.

## Credit, atomicity và audit

GET detail trả `expectedCredit {base, photoBonus, total}` cho giả định giữ mọi
ảnh bằng chứng gốc còn pending. Khi selection đổi, gọi read-only
`POST /cms/place-submissions/{id}/credit-preview` với `{enrichmentSelection}`;
không tính tiền thưởng ở client. Endpoint không gọi provider hoặc award credit.

Đường selection mới approve/merge có base +50; bonus +20 nếu ít nhất một ảnh
menu/bill của contributor gốc thực sự được duyệt. All-drop vẫn +50. Đường cũ
merge vẫn bonus-only để tương thích. `submissionCreditFacts` là công thức duy
nhất dùng cho preview và grant; grant đếm ảnh server-approved trong transaction,
không tin count client. Detail/preview trả zero nếu đã quyết định, contributor
không active/không còn hoặc venue/submission đã có ledger. Preview không reserve
credit; concurrent decision/account erasure có thể làm request phải tải lại.

Account lock, submission revision lock, place lock, photos, facts, ledger,
balance, audit và outbox cùng transaction. Ledger unique venue/submission chống
award lặp. Gửi `Idempotency-Key` để retry nhận lại response gốc; đổi payload
cùng key trả 422. Không key, submission đã quyết định trả ALREADY_DECIDED,
không lặp side effect. Replay cache TTL theo policy hiện có (24 giờ); lỗi giữa
commit và ghi replay có thể trả ALREADY_DECIDED khi retry, ledger vẫn không lặp.

Audit `place_submission.decided.diff.enrichmentSelection` ghi kept/dropped
fact keys và photo mediaIds, không ghi giá trị/free text/bytes. Đường legacy
đánh dấu mode legacy và droppedFactKeys; photo decisions vẫn theo approvedPhotoIds.
Giữ metric decision/latency hiện có; không đặt key/mediaId vào metric labels.

## Migration, rollback và kiểm chứng

Migration 0090 thêm nullable JSONB `places.contribution_facts`, không backfill,
không đổi enum. lock_timeout 5 giây; metadata-only ADD COLUMN, schema trước binary.
Rollback binary về #802 ngừng áp dụng selection mới; giữ cột/facts để rollout lại.
Không chạy client mới với binary cũ (Zod cũ bỏ trường chưa biết, có thể bỏ lựa
chọn facts hoặc trả PHOTO_REVIEW_REQUIRED). Rollback đầy đủ cần dừng CMS mới,
export facts trước rồi mới `ALTER TABLE places DROP COLUMN contribution_facts`
trong maintenance với lock_timeout 5s. Không sửa/xóa ledger/audit đã commit.
Facts đã xác minh là dữ liệu biên tập của place, không phải bản nháp cá nhân;
không có user id/ảnh/consent trong cột mới.

Unit: selection từng fact/photo, false/zero, stable ordering, all-drop,
foreign/duplicate selections, formula dùng khi award. Integration trong
`submission-photos.int.spec.ts`: partial approve/merge, all-drop, API denied,
invalid selection, keyed retry/payload mismatch, DB facts/prices/taxonomy,
public userPhotos, không gallery, ledger và audit một lần.
Claude cần chạy integration với Docker và migration trước khi đánh dấu PASS;
đồng thời chạy oasdiff thật với origin/re-design, không thêm breaking exception.
