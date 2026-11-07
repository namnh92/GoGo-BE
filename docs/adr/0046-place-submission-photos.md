# ADR-0046 — Ảnh người dùng trong đóng góp địa điểm

Ngày: 2026-11-07. Trạng thái: đề xuất triển khai, chờ Astra và CODEOWNER.
Refs #793; FR-INGEST-010..012, FR-CMS-003; bài học GoGo-BE#771.

Ảnh là nội dung do cộng đồng GoGo cung cấp theo
`GOGO_PRODUCT_DATA_ARCHITECTURE.md`, không phải nội dung Google chuyển quyền.
Luồng upload và claim vẫn là `POST /uploads`, purpose `place_photo`, với
`UploadsService.verifyUploaded/attach`. Check-in đã dùng claim này; đánh giá
hiện chưa nhận ảnh (#771). Xử lý metadata tái dùng cách của avatar (ADR-0022):
đọc có giới hạn, kiểm tra định dạng thật, áp dụng orientation rồi tái mã hoá
WebP, không gọi `withMetadata`. Không dùng ảnh check-in/review gốc để phát ảnh.

## Quyết định

- `mediaIds` không bắt buộc: 0–5 UUID khác nhau từ chính actor. JPEG/PNG/WebP,
  tối đa 10 MiB và 16 triệu pixel. Client chuyển HEIC trước upload. Bytes thực
  phải khớp loại và kích thước khai báo; xử lý tối đa hai request đồng thời,
  từng ảnh tuần tự, timeout sharp 3 giây, cạnh dài đầu ra tối đa 2048 pixel.
- Bản xử lý mang key ngẫu nhiên trong **bucket private**, không nằm ở host CDN.
  `place_submission_photos` lưu tham chiếu upload, submission và uploader.
  Không lưu bản sao tên người dùng hoặc thông tin Google.
- Mọi I/O storage diễn ra ngoài transaction. Transaction khoá submission và
  upload để giới hạn tổng năm ảnh, claim độc quyền và ghi ảnh nguyên tử.
  Dedupe giữ nguyên chủ đóng góp ban đầu nhưng mỗi ảnh ghi uploader thật.
  Mutex riêng chỉ cho submit tránh đảo thứ tự khoá submission → identity của
  approve. Thêm/bỏ ảnh tăng revision, làm lần duyệt đã chuẩn bị trước đó lỗi.
- CMS detail trả URL tương đối `/v1/cms/.../content`. Client resolve URL theo
  origin API và fetch với CMS bearer token. BFF kiểm tra quyền CMS và trạng
  thái pending trên mỗi lần đọc; không trả key hoặc bytes gốc.
- Approve/merge có ảnh pending bắt buộc `approvedPhotoIds`. CMS cũ không gửi
  trường này nhận `409 PHOTO_REVIEW_REQUIRED`. `[]` loại hết; chỉ ảnh được chọn
  mới thành `place_media` approved, source `community`, uploader thật được giữ.
  Moderator có thể DELETE từng ảnh kèm lý do trước quyết định. Audit ghi cả
  lựa chọn ảnh và quyết định.
- Detail và search nhận URL `/v1/places/{id}/photos/{mediaId}/content` cho bản
  xử lý. Mỗi lần đọc đòi media approved và place `published` hoặc
  `community_submitted` (khớp eligibility detail hiện tại). Ảnh có credit
  `contributor.displayName` từ tài khoản đang active; không lộ ID nội bộ,
  không gắn Google attribution. Guest/erased account không có credit tên.
- Endpoint ảnh trả `image/webp`, `private, no-store`, `nosniff`. Không dùng
  presigned GET: StoragePort hiện chưa có chức năng đó, và endpoint BFF cho
  phép thu hồi quyền đọc ngay khi ảnh/place đổi trạng thái. Đổi lại BFF chịu
  lưu lượng ảnh; URL không cần được lưu lâu hoặc refresh token riêng.

## Contract compatibility exception (2026-11-07)

Owner/CODEOWNER quyết định ngày 2026-11-07 trên PR #794 (Refs #793):
**"Ghi exception, giữ MINOR"**. Giữ OpenAPI `7.2.0-alpha.1`.
`approvedPhotoIds` là trường optional được thêm vào cả hai nhánh inline
`oneOf` của `POST /cms/place-submissions/{id}/decide`; không xoá nhánh nào.
oasdiff so khớp inline subschema bằng exact equality nên sửa nhánh thành
remove + add và báo `request-body-one-of-removed` cho `subschema #1, subschema #2`.
Đây là false positive của phép so khớp schema; bọc bằng `allOf` cũng bị báo.

Exception `BE-793-submission-photos-decide-oneof` trong
[oasdiff-exceptions.json](../../.github/oasdiff-exceptions.json) chỉ nhận đúng
finding này và đúng cặp SHA-256 của raw YAML: base `origin/re-design`
`facd5cedb91f9b93b86bedffc79da906ff2dd425`, revision YAML trong
working tree sau rebase, xác định bằng `revisionSha256`. Replay report đã lưu bằng
`scripts/check-contract-compat.ts` với
`--expect=BE-793-submission-photos-decide-oneof` phải nhận đúng một lần.
Đổi bytes ở một trong hai contract hoặc thêm finding khác vẫn làm gate fail.

Hệ quả runtime vẫn cần rollout phối hợp: CMS cũ approve/merge submission có
ảnh pending mà không gửi `approvedPhotoIds` nhận `409 PHOTO_REVIEW_REQUIRED`.
**Deploy BE cùng [GoGo-CMS#283](https://github.com/namnh92/GoGo-CMS/pull/283)**:
CMS sync contract, regenerate client và gửi lựa chọn ảnh rõ ràng (`[]` bỏ hết).
Quyết định giữ MINOR và exception không thay thế yêu cầu deploy cùng nhau;
consumer note nằm trong [CHANGELOG](../../openapi/CHANGELOG.md#720-alpha1--optional-submission-photos-gogo-be793).

## Retention và lỗi

Job cleanup được ghi **trước** PUT derivative, hạn một ngày; attach thành
công huỷ job đó trong transaction. PUT không chắc chắn hoặc DB rollback vẫn
có đường dọn. Upload gốc mới nằm trong `tmp/place-photos/`, thuộc lifecycle
`tmp/` một ngày sẵn có (GoGo-Infra `terraform/modules/cloudflare-r2/variables.tf`),
nên file chưa submit cũng có hạn lưu. Original chỉ được đọc server-side; attach lập job xoá sau ít
nhất 15 phút và sau expiry của PUT URL, tránh xoá rồi bị upload lại bằng URL
còn hiệu lực. Ảnh bị bỏ hoặc submission bị từ chối không đọc được ngay, bản
xử lý bị dọn sau bảy ngày qua `MediaCleanupService` và retry/dead letter sẵn có.
Khi CMS gỡ ảnh đã duyệt, transaction gỡ tham chiếu cuối trong `place_media`
đồng thời lập job cleanup bucket private cho derivative. Khoá theo storage key
tuần tự hoá các lần gỡ đồng thời; còn tham chiếu từ place khác thì chưa dọn.

`submission_photo_processing_total{outcome}` và
`submission_photo_processing_duration_ms` đo xử lý; metric quyết định submission
và cleanup hiện hữu đo các bước còn lại. Không log payload ảnh, URL hay GPS.

## Migration / rollback / kiểm chứng

Migration `0086_place-submission-photos` chỉ thêm bảng và index, không sửa
bảng lớn. Số 0082–0084 đã được upstream dùng. OpenAPI
MINOR `7.2.0-alpha.1`, generated types được tạo bằng `pnpm api:types`.

Ưu tiên rollback application và giữ schema additive. Code cũ bỏ qua ảnh mới;
không phục hồi ảnh gốc hoặc đổi bucket public để làm ảnh xuất hiện. Nếu buộc
xoá schema, dừng writer trước rồi chạy
`docs/rollback/0086_place-submission-photos.sql`: giữ approved `place_media`,
đưa derivative không còn dùng vào cleanup, xoá bảng. Reapply migration sau khi
điều chỉnh journal theo quy trình vận hành; ảnh pending đã bị dọn không khôi phục.

Unit test dùng JPEG có GPS EXIF thật, orientation, kích thước, type mismatch và
pixel cap; unit kiểm tra publication gate và uploader. Integration test gồm
HTTP/RBAC, 0/5/6 ảnh, dedupe đồng thời, chọn/bỏ/merge, credit, thu hồi và retention.
Chạy integration cần Docker/PostGIS. Chỉ khi migration + integration qua mới
có bằng chứng vòng đời DB/HTTP; unit không thay thế kiểm chứng này.
