# Bổ sung một ảnh Google cho địa điểm đã xuất bản (#797)

Owner 2026-11-07 cho phép lấy một ảnh/địa điểm theo ADR-0043, dùng lại pipeline
#786/PR #792. Không đổi API, schema hoặc quyền sở hữu nội dung Google.

## Chuẩn bị

Chạy từ gốc GoGo-BE, với dependencies đã có. Inject biến môi trường bằng cơ chế
secret hiện có; không dán key/connection string vào command, log hoặc ticket.
Database cần migrations hiện tại, gồm 0083. Không có bước install/migrate trong CLI.

- Mọi mode: `DATABASE_URL`, `APP_ENV` (`dev`, `staging`, `prod`, `production`, mặc định `dev`).
- Flag `place_provider_photos.enabled` theo environment phải bật; khi không có
  override, dùng `FLAG_PLACE_PROVIDER_PHOTOS=true` (mặc định false). CLI không đổi flag.
- Probe/apply: `GOOGLE_PLACES_API_KEY`.
- Apply: budget `google.places.display` với đủ ba biến
  `PLACE_DISPLAY_DAILY_MAX_CALLS`, `PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD`,
  `PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA`. Thiếu budget thì adapter từ chối ảnh.
  Đây là budget ngày dùng chung với traffic, không phải budget riêng của script.
- Apply: `R2_ACCOUNT_ID` hoặc `R2_ENDPOINT`; `R2_PUBLIC_BUCKET`,
  `R2_PUBLIC_ACCESS_KEY_ID`, `R2_PUBLIC_SECRET_ACCESS_KEY`, `MEDIA_PUBLIC_BASE_URL`.
  Dùng public catalogue bucket và credential tương ứng; không dùng private bucket.
- `PROVENANCE_UNIFIED_READS` mặc định true, cùng rollback switch với Place Detail.

## Lệnh chính xác

Dry-run mặc định, tối đa 100 địa điểm, không Google call/DB write/storage write:

```bash
pnpm places:backfill-provider-photos --limit 100
pnpm places:backfill-provider-photos --dry-run --limit 100
```

Probe dry-run: gọi Places Details IDs Only để biết có ảnh, không mua/tải media,
không ghi DB/storage, kể cả usage ledger. Adapter chỉ phát metrics ra log:

```bash
pnpm places:backfill-provider-photos --dry-run --probe --limit 100
```

Apply lưu ảnh (bắt đầu một địa điểm, kiểm tra rồi tăng giới hạn):

```bash
pnpm places:backfill-provider-photos --apply --limit 1
pnpm places:backfill-provider-photos --apply --limit 100
```

`--limit` bắt buộc là số nguyên dương an toàn. Không chấp nhận mode lặp,
`--probe --apply`, hoặc argument lạ. `--dry-run` **không lấy/lưu bytes ảnh**;
muốn lưu ảnh phải dùng `--apply`. Chạy lại lệnh apply để tiếp tục; không có cursor
persist giữa các lần chạy. Mỗi địa điểm chỉ được reserve một lần cho apply;
chạy lại không tự mua lại ảnh cho các attempt trước, kể cả attempt lỗi/không có ảnh.

## Phạm vi và chi phí

Chỉ `published`, có Google Place ID hợp lệ theo provenance reader, không có bất
kỳ `place_media` pending/approved nào (kể cả ảnh editorial/community), không có
cover ở bất kỳ moderation state nào, và chưa có audit reservation
`place.provider_photo_backfill_attempt`. Rejected media không phải cover vẫn
được phép. Không xoá/hạ cover đang chờ duyệt. Canonical identity ưu tiên legacy; bỏ canonical moved.
Scan theo UUID, phân trang tối đa 100, dừng ở `--limit` hoặc flag tắt/signal.

Dry-run/probe in mỗi `candidateId` nội bộ và JSON cuối: `total`, `withPhoto`,
`withoutPhoto`, `errors`, `written`, `skipped`, `stopped`, `estimate`. Không in
Google ID, tên địa điểm, địa chỉ, photo name/URL, credit tác giả hay exception thô.
Dry-run thường chưa biết có ảnh: `withPhoto/withoutPhoto` bằng 0, không có nghĩa
Google không có ảnh. Probe phân biệt empty với lỗi/identity mismatch.

Ước tính dùng bảng giá **trong repo** tại ngày chạy (`listCostMicros`), USD micros,
chưa trừ free allowance/tier/discount, không phải số tiền invoice. Baseline tối đa
một Details IDs Only miễn phí và một media call/địa điểm; pipeline có thể refresh
ref hết hạn một lần, lên tối đa hai Details và hai media calls. Report có baseline
và trần retry; probe dùng số nơi xác nhận có ảnh cho baseline media, trần retry
vẫn tính toàn bộ candidate vì ảnh có thể thay đổi sau probe. Giá nội bộ hiện tại: 7.000 micros/ảnh ($0,007), 100 ảnh
baseline $0,70, trần retry $1,40. Đây không phải xác nhận bảng giá Google trực tiếp.
Estimate mô tả kế hoạch apply, không phải số call thực tế của dry-run/probe.
Apply meter calls thực tế vào durable usage ledger, flush trước khi đóng DB;
probe không ghi ledger để giữ nguyên cam kết chỉ đọc.

## Persistence và kiểm chứng

Apply dùng `SubmissionPhotoService.prepare/attach/discard`, cùng
`ProviderPhotosService.firstForProvider` như duyệt submission: ảnh đầu hiện tại,
800px, tối đa 400KiB, provider deadline 6 giây, ref-expiry retry một lần và budget
reserve trước từng media call. Không có provider/storage I/O trong DB transaction.

Ảnh vào `places/provider/` với `private, no-store`; `place_media` approved,
`source_type=google_derived`, attribution Google Maps, metadata gồm Google Place
ID, fetchedAt, author credits và Maps attribution URI. Không persist Google photo
name hoặc media retrieval URL. Moderation actor null (system), reason
`Provider photo backfill #797`; audit `place.provider_photo_backfill`.

Trước upload có cleanup intent delay một giờ; attach và xoá intent cùng transaction.
Trước provider/storage I/O, recheck dưới row lock: published, cùng identity,
không có pending/approved media hoặc cover bất kỳ state nào và chưa reserve.
Ghi audit `place.provider_photo_backfill_attempt` trong transaction riêng, commit
trước `prepare()`. Audit append-only này là durable reservation, không chứa
provider ID/credit. Hai run đồng thời chỉ một run được reserve/mua ảnh; run thua
skip trước provider I/O. Attach recheck lại status/identity/media dưới row lock.
Nếu status/identity/media đổi trước attach thì skip và discard. Lỗi DB/storage
hoặc crash giữ intent cho cleanup worker. Reservation vẫn giữ khi upload/DB/audit
completion/discard lỗi, bị kill, mất eligibility hoặc không có ảnh. Đây là
at-most-once attempt, không phải tự retry đến khi attach thành công: crash sau
reservation nhưng trước purchase cũng không tự thử lại. Cleanup worker không
xoá reservation. Không xoá audit để retry; attempt chưa hoàn tất cần ops kiểm tra
và owner cho phép chi phí mới bằng quy trình riêng, CLI này không có reset/retry.
Khi kiểm tra sau apply, đối chiếu audit attempt với audit completion
`place.provider_photo_backfill`; dry-run `total=0` có thể còn attempt chưa attach.
Xem media có
attribution/author credits, object đúng prefix, audit và không còn intent cho ảnh
đã commit. Kiểm tra UI attribution riêng từng ảnh theo ADR-0043.

## Dừng, lỗi và rollback

Tắt `place_provider_photos.enabled` để dừng các lượt kế tiếp. Flag được đọc trước
mỗi địa điểm và trước attach; request provider/upload đang chạy có thể hoàn thành,
nhưng ảnh chưa attach sẽ được discard khi thấy flag tắt. SIGINT/SIGTERM dừng giữa
các stage, flush ledger và đóng pool; exit 130/143. Deadline/storage timeout vẫn
áp dụng cho stage đang chạy. Lỗi candidate tăng `errors` rồi tiếp tục; budget hết
không bypass, sẽ báo lỗi candidate. Lỗi scan dừng với `stopped=error`.

Exit 1 khi có lỗi candidate/config/ledger; lỗi flush định kỳ dừng scan, final flush
thử lại trước khi đóng pool. `stopped=disabled` là dừng chủ động, có thể exit 0.
Không coi total/exit 0 là tất cả catalogue đã có ảnh; đối chiếu `written`,
`withoutPhoto`, `errors`, `skipped`, `stopped` và chạy dry-run lại.

Rollback: tắt flag để ngăn ảnh mới. Ảnh đã commit vẫn hiển thị với attribution.
Nếu phải xoá, detach qua quy trình CMS hiện có để enqueue cleanup public trong
transaction; không xoá metadata/credit trực tiếp trước khi cleanup bytes. Theo dõi
media cleanup worker/queue cho orphan intents do lỗi/crash, không xoá bucket hàng loạt.

## Kiểm thử

```bash
pnpm exec vitest run --project unit scripts/place-provider-photo-backfill-args.spec.ts scripts/backfill-place-provider-photos.spec.ts libs/modules/places/application/place-provider-photo-backfill.spec.ts libs/modules/ingestion/application/submission-photo.service.spec.ts libs/modules/search/application/provider-photos.service.spec.ts
pnpm exec vitest run --project integration apps/api/test/place-provider-photo-backfill.int.spec.ts
pnpm --filter @gogo/scripts typecheck
pnpm --filter @gogo/modules typecheck
```

Integration dùng Testcontainers PostGIS và storage/provider giả lập; không gọi
Google/R2 thật. Cần Docker socket truy cập được. Chưa có chạy apply thật chỉ từ
việc unit/integration tests pass.
