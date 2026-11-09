# ADR-0052: Lưu một ảnh Google khi gửi đề xuất địa điểm

- **Status:** accepted product decision, owner 2026-11-09, GoGo-BE#822; exact-head CODEOWNER review for migration/OpenAPI remains pending
- **Date:** 2026-11-09
- **Basis:** sa-shape-be-822.fable.rev2.md rev 2.2, §0/§0b/§16

## Context

FR-INGEST-010/012 cần một ảnh để nhận ra đề xuất. Lazy proxy trên mỗi lần xem
mua lại ảnh Google. ADR-0030 chỉ cho phép ảnh tạm thời; ADR-0043 chỉ lưu ở lúc
duyệt; ADR-0020 #440 cấm provider I/O trên cửa CMS create. Owner cho phép ngoại
lệ một cover, vẫn mang nguồn Google và credit từng tác giả. Sao chép không biến
ảnh thành dữ liệu GoGo-owned.

## Options

1. Giữ proxy mỗi lần xem: tiếp tục chi phí theo lượt xem.
2. Lưu photo name / retrieval URL để tải sau: loại; không được giữ reference.
3. Lưu một ảnh bounded, trả CDN URL và dùng lại khi duyệt: chọn.

## Decision

Amends ADR-0030 (transient-only, written-nowhere và cấm client cache cho cover đã
lưu), ADR-0043 (thời điểm mua, reuse, merge, header và lifecycle), ADR-0048 về
submission display/cost (zero Details ở submit không đổi; photoRefs/media nay
được phép) và ADR-0020 #440 (photo-only amendment #2 cho CMS create).

- Submit commit đề xuất trước; acquisition sau đó là best effort. Bất kỳ lỗi
  claim/provider/storage/completion nào cũng không làm submit thất bại.
- Một UPDATE chung cho submit/approve/backfill lấy UUID claim 15 phút, yêu cầu
  pending, chưa có ảnh, attempts < 2. Tăng attempts trong transaction riêng,
  commit **trước** provider I/O. Claim hết hạn hay purchase lỗi vẫn tiêu lượt.
  Compensation chỉ xoá claim của chính mình, không giảm attempts.
- Completion lock submission FOR UPDATE rồi fence claim của mình, pending,
  chưa có ảnh. Mất fence thì discard bên ngoài transaction. Không giữ transaction
  qua I/O. Approve kiểm identity như cũ, claim transaction riêng trước prepare;
  provider/storage failure vẫn 503, release claim, attempt giữ nguyên. Rollback
  approval cũng discard và release. Đủ hai attempts thì duyệt không mua nữa.
  Trigger submission_revision bỏ qua thay đổi chỉ ở bốn cột provider_photo/claim/
  attempts; claim, completion và compensation dùng UUID fence riêng, không làm
  snapshot review cũ đi. Thay đổi nội dung/ownership/quyết định vẫn tăng revision.
- Approve gắn đúng storage key đã lưu, không mua lại ảnh. Merge chỉ gắn khi
  target thoả predicate #797 (published, không pending/approved media và không
  cover ở bất kỳ moderation nào); nếu không thì retire ngay.
- Reject mọi lý do: marker retiredAt/deleteAfter và schedule cùng transaction,
  deleteAfter = decidedAt + 7 ngày. Không gọi attemptNow cho lịch tương lai.
  Card hiện ảnh **iff updateDeadline > now()**. Metadata marker không ra API.
- CMS POST /cms/places với googlePlaceId tự acquisition khi flag bật, không
  thêm request field. Chạy sau create commit, chỉ lần đầu, không đụng replay
  record khi photo lỗi. CMS và #797 dùng cùng audit action
  place.provider_photo_reservation, diff.source = cms_create | backfill_797;
  legacy place.provider_photo_backfill_attempt vẫn chặn mua lại. Reserve dưới
  places row lock trước I/O, re-lock/recheck eligibility + identity khi attach.
  #797 vẫn published-only; CMS thiếu ảnh thì editor upload.
- Chỉ một cover, 800px, tối đa 400KiB, jpeg/png/webp, deadline 6s và một lần
  expired-ref retry theo pipeline hiện có. R2 PUT deadline 10s, cleanup intent
  một giờ trước PUT. Object mới dùng public, max-age=31536000, immutable,
  places/provider/<uuid>.<ext>. Không lưu Google photo name/media URL/key.
  Kích thước gốc không giả thành kích thước bytes resize: width/height null.
- Stored provider_photo chứa key R2, content type, thời điểm, Place ID, Google
  Maps attribution, authorAttributions và googleMapsUri. Place ID là identity;
  author URI/avatar URI và Maps URI là credits, không phải retrieval URL.
- Marker là nghĩa vụ; queue là lịch tái tạo được. scheduleRetirement upsert
  reason/next_attempt_at/attempts trên open key, thay thế maintenance intent.
  Worker kiểm users + place_media + submission: live không marker thì drop
  referenced; chỉ có marker tương lai thì reschedule deferred; hết hạn thì
  delete origin, purge edge, bỏ metadata ảnh đã retire và job. Hourly reconciler
  tạo lại lịch thiếu cho marker quá hạn, không có live reference, limit 100.
  CMS final detach cũng retire submission references trong transaction detach.
- Pending không TTL: giữ ảnh đến khi có quyết định. Account erasure ADR-0023
  xoá enrichment/owner nhưng giữ submission, nên giữ ảnh với submission.
- Submission list/detail không emit providerDisplay.photo; refresh dùng
  display.get(..., {photos:false}). ADR-0048 >30 ngày Details refresh vẫn giữ.
  Zero Google **photo** calls khi xem lại, không tuyên bố zero Details.
- Flags: place_provider_photo_acquire.enabled default off cho submit/CMS;
  place_provider_photos.enabled cho preview/approve fallback/#797. Không gallery
  flag: xoá GET /places/{id}/provider-photos và method photos(). Preview còn.
- Contract một MAJOR 9.0.0-alpha.1 cho path removal và rút no-provider guarantee
  của CMS. photo / providerPhoto giữ credit; photoUrl editorial/community không
  đổi. updateDeadline chỉ rejected. Schema providerDisplay.photo giữ optional,
  deprecated, không emit. Mobile/CMS regenerate và deploy cùng cửa sổ DEV.

## Consequences and security

Chi phí theo địa điểm thay vì lượt xem: tối đa hai acquisition attempts/submission,
mỗi attempt tối đa hai media calls; CMS một lifetime reservation, không tự retry
qua #797 kể cả purchase lỗi. Approve trong claim submit đang chạy có thể không
cover; late completion discard, editor upload là remedy. Budget DEV giữ nguyên.

Random URL trước moderation là **public-unlisted**, không phải authorization.
CDN và cache thiết bị có thể sống sau deletion. Owner chấp nhận Google-terms risk
ngày 2026-11-09; ADR không xác nhận compliance. R2 custom-domain header/HIT phải
đo trên DEV. Không log name, URL, credit hay raw provider exception.

#824 sở hữu inheritance khi resubmit, information purge/sweep, informationRemoved,
information_purged_at và refresh exclusion. #822 không phụ thuộc #824. Backfill
pending và rewrite header objects cũ thuộc S3; các retirement primitives của S1
bảo toàn nghĩa vụ nếu maintenance intent va chạm hoặc crash.

## Migration and rollback

0095_submission-provider-photo thêm bốn cột và partial storage-key index; không
backfill provider content trong migration. Forward test bằng Postgres integration.

1. Tắt place_provider_photo_acquire.enabled, dừng purchase mới submit/CMS.
2. Giữ credits. Submission-only keys chưa có place_media được marker + schedule
   theo retention 7 ngày; không drop cột để che phần cleanup chưa xong.
3. Chờ queue rỗng cho từng key, StoragePort.exists() false và purge hoàn tất;
   ghi evidence. Live place_media keys giữ metadata và credits của place.
4. Chỉ sau đó drop bốn cột trong migration riêng. Optional contract facts có thể
   giữ. Code revert đơn lẻ giữ objects/credits là trạng thái tạm chấp nhận được.
