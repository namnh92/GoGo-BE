# REDESIGN-G03-DETAIL-AREA — Place Detail areaSummary

Refs GoGo-BE#784; quyết định owner 07/11/2026, GoGo-MobileApp#482 nhóm 03.
Yêu cầu liên quan: SRS FR-PLAN-004; ADR-0019 (mapping hành chính có version).

## Thiết kế

`GET /v1/places/{id}` thêm `areaSummary` tùy chọn, dùng chung schema
`PlaceAreaSummary` với search. Repository dùng chung SQL chọn mapping VERIFIED,
đúng dataset PUBLISHED, unit ACTIVE và còn hiệu lực: ưu tiên commune, fallback
province. Detail lấy nhãn tiếng Việt, khớp search mặc định `locale=vi`; không có
mapping hợp lệ thì bỏ field khỏi JSON. `communeCode` là null khi dùng province.

Đọc trong cùng statement detail để giữ snapshot với place. Không có migration,
ghi dữ liệu hay gọi provider. `addressText` vẫn là địa chỉ bưu chính độc lập;
client dùng dữ kiện hành chính để trình bày địa chỉ, không dùng `areaKey` thay
mapping. Không tự ghép chuỗi địa chỉ tại BFF.

OpenAPI tăng MINOR từ `6.2.0-alpha.1` lên `6.3.0-alpha.1`; đã sinh lại
`openapi/gogo.v1.d.ts`. Khi merge nhánh song song, Claude đối chiếu version mới
nhất và sinh lại client nếu cần. Telemetry dùng instrumentation DB hiện có;
không thêm log chứa địa chỉ hoặc mã place. Rollback code; client phải chịu được
field tùy chọn bị thiếu.

## Kiểm tra cục bộ

- `pnpm exec vitest run --project unit libs/modules/search/application/search.service.place-detail.spec.ts libs/modules/search/presentation/place-detail.contract.spec.ts`:
  **16/16 pass** (mapping, JSON omission, contract chung và regression rating).
- `pnpm api:types`: thành công.
- `pnpm exec vitest run --project integration apps/api/test/place-detail-area.int.spec.ts`:
  **BLOCKED**, 15 ca chưa chạy vì Testcontainers không tìm thấy runtime.
  `docker info` xác nhận `permission denied` tại Docker Desktop socket
  `unix:///Users/maxnguyen/.docker/run/docker.sock` trong sandbox.
- Bộ integration kiểm tra service thật + SQL trên PostGIS đã migrate: commune,
  province fallback, unit inactive/hết hạn/chưa hiệu lực, từng trạng thái mapping
  chưa VERIFIED, dataset cũ/không published, không còn unit và 404 draft/suspended.
  Với mỗi place đọc được, đối chiếu nguyên `areaSummary` detail với search.

## Bàn giao và acceptance

Claude chạy lại integration và full gates, rồi Astra review contract/design và
CODEOWNER approval trước merge. Phiên CODE này không commit, push hay gọi DEV.
AC DEV **chưa xác nhận**: trên build chứa thay đổi, chọn place published có
mapping VERIFIED, gọi detail và search `locale=vi` với cùng place, đối chiếu đủ
5 field của `areaSummary`; ghi SHA, môi trường và response đã che dữ liệu nhạy
cảm. Xác nhận omission/fallback trên dữ liệu phù hợp nếu có. Không đóng issue
chỉ dựa vào test cục bộ.
