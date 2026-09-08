# GoGo Infrastructure — MVP cost-optimized plan (#21, #15, #36)

> **Phạm vi.** File này mô tả stack **triển khai** trên VPS. Nó không mô tả cách phát triển
> hằng ngày: máy developer là workstation, không phải một môi trường. DEV chạy từ xa —
> PostgreSQL ở Neon, Redis ở Upstash, object storage ở R2 — và Mobile/CMS trỏ vào dev API được
> host. Xem `GoGo-Remote-First-Multi-Environment-Infrastructure-Spec.md` và README.
>
> **Topology DEV đổi 2026-09-04** (GoGo-Infra ADR-0007 / INF-064, INF-065). DEV BE không còn
> chạy trên VPS cloud: nó chạy trên một máy riêng tại `192.168.68.68` trong LAN, và stack
> observability nằm trên máy thứ hai tại `192.168.68.168`.
>
> Nguyên tắc bên trên **không** bị bãi bỏ. ADR-0004 nói _DEV không phải máy của lập trình
> viên_, và một máy LAN chuyên dụng thoả mãn điều đó y như một host cloud. Cái đã cũ chỉ là
> giả định ngầm rằng "từ xa" phải nghĩa là "cloud". Neon, Upstash và R2 không đổi.
>
> Hai hệ quả thực tế: developer ngoài LAN vẫn tới API qua Cloudflare Tunnel (họ chưa bao giờ
> có địa chỉ của host), còn CI thì không tới được — runner do GitHub host không route được tới
> địa chỉ RFC1918, nên deploy đi qua chính tunnel đó với Cloudflare Access đứng trước
> (GoGo-Infra INF-068).
>
> Chữ "VPS" còn lại trong file này vì đổi tên một workflow là đổi tên lịch sử của nó. Đọc là
> "host DEV".
>
> **Postgres và Redis trong compose là chuyển tiếp**, không phải kiến trúc mục tiêu. Chúng nằm
> ở `docker/docker-compose.self-hosted.yml`. Edge cũng tách: `docker-compose.edge-caddy.yml` cho
> host mở được cổng, `docker-compose.edge-tunnel.yml` cho host không (DEV). Host nào thuộc loại
> nào là sự thật về host, mà ADR-0004 của GoGo-Infra nói host là chi tiết triển khai — nên không
> nướng nó vào stack dùng chung. Đều là file riêng chứ không phải profile: Compose nội suy
> toàn bộ file **trước** khi lọc profile, nên `${POSTGRES_PASSWORD:?}` trong một service bị profile
> che vẫn làm hỏng lần deploy không hề định chạy PostgreSQL. Tách file khiến stack mặc định không
> thể nhắc tới database local. Bảng "Beta gate" bên dưới
> là đường thoát; `pg_dump` hằng đêm với RPO 24h **không** đáp ứng yêu cầu ở `GOGO_SRS.md` §10.1
> và không được coi là đã đáp ứng.

Nguyên tắc: **một VPS + docker compose**, mọi thứ khác dùng free tier. Đơn
giản nhất vận hành được, có đường nâng cấp rõ ràng tại beta gate. Toàn bộ
config đã nằm trong repo (`docker/`), chỉ chờ credentials.

## 1. Stack & chi phí

| Thành phần                      | Chọn                               | Gói                                                                         | Chi phí/tháng                                       |
| ------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| VPS (api+worker+PG+Redis+Caddy) | Vultr / DigitalOcean **Singapore** | 2 vCPU / 4GB (khuyến nghị)                                                  | ~$18–24 (bản 1vCPU/2GB ~$10–12 chạy được nhưng sát) |
| TLS + reverse proxy             | Caddy (trong compose)              | —                                                                           | $0                                                  |
| Offsite backup + media          | Cloudflare **R2**                  | free 10GB, không phí egress                                                 | $0                                                  |
| Uptime monitoring               | **Better Stack Uptime** free       | 10 monitors, 3-min check, status page, email/telegram alert                 | $0                                                  |
| Worker/backup heartbeat         | **healthchecks.io** free           | 20 checks, dead-man switch                                                  | $0                                                  |
| Error monitoring                | **Sentry** free                    | 5k errors/th                                                                | $0                                                  |
| Push (Android/Web)              | FCM                                | —                                                                           | $0                                                  |
| Push (iOS)                      | APNs                               | cần Apple Developer (đã có kế hoạch cung cấp key)                           | ($99/năm — đã tính riêng)                           |
| Google Places API               | pay-as-you-go                      | $200 credit free/tháng thường đủ MVP (autocomplete session + details cache) | ~$0                                                 |
| **Tổng MVP**                    |                                    |                                                                             | **≈ $18–24/tháng**                                  |

### Beta gate (khi có user thật) — nâng cấp duy nhất cần thiết

| Đổi gì                                                | Vì sao                             | Chi phí mới        |
| ----------------------------------------------------- | ---------------------------------- | ------------------ |
| Postgres trong compose → **Supabase Pro (SG)** + PITR | RPO 24h (pg_dump) → RPO ≤15p (SRS) | +$25–35            |
| (giữ nguyên phần còn lại)                             |                                    | **≈ $45–60/tháng** |

Migration path: `pg_dump` → restore vào Supabase → đổi `DATABASE_URL` → xóa
service postgres khỏi compose. Nửa ngày công, đã tả trong runbooks §4.

## 2. Deploy lần đầu (1 buổi)

```bash
# Trên VPS (Ubuntu 24.04, đã cài docker):
git clone git@github.com:namnh92/GoGo-BE.git && cd GoGo-BE
cp .env.example .env.prod   # điền: DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD,
                            # DATABASE_URL=postgres://gogo:<pw>@postgres:5432/gogo,
                            # REDIS_URL=redis://redis:6379, AUTH_JWT_SECRET, COOKIE_SECRET,
                            # COOKIE_SECURE=true, CORS_ORIGINS, + key slots khi có
docker compose -f docker/docker-compose.prod.yml --env-file .env.prod build
docker compose -f docker/docker-compose.prod.yml --env-file .env.prod run --rm migrate
docker compose -f docker/docker-compose.prod.yml --env-file .env.prod up -d
```

DNS: A record `api.<domain>` → VPS IP. Caddy tự lấy Let's Encrypt.
Deploy tiếp theo: `git pull && build && run --rm migrate && up -d` (theo thứ
tự runbooks §1). CI deploy tự động qua SSH action làm sau khi ổn định.

## 2b. Chạy thử stack prod trên máy local

Dùng project name riêng để không đụng volume của compose dev:

```bash
cp .env.example .env.prod   # DOMAIN=localhost, ACME_EMAIL bất kỳ,
                            # POSTGRES_PASSWORD/AUTH_JWT_SECRET/COOKIE_SECRET: openssl rand -base64 48
                            # DATABASE_URL=postgres://gogo:<pw>@postgres:5432/gogo
                            # REDIS_URL=redis://redis:6379   COOKIE_SECURE=true
chmod 600 .env.prod

P="docker compose -p gogo-prod -f docker/docker-compose.prod.yml --env-file .env.prod"
$P build
$P up -d postgres redis && sleep 12
$P run --rm migrate
$P up -d
# seed dữ liệu demo (tùy chọn) — không tạo tài khoản CMS nào
$P run --rm -e NODE_ENV=development --entrypoint sh api -c "node -r @swc-node/register libs/database/src/seed.ts"
# tài khoản CMS đầu tiên là lệnh riêng; credentials lấy từ SSM, không có mặc định trong repo
$P run --rm -e NODE_ENV=development -e SEED_ADMIN_EMAIL -e SEED_ADMIN_PASSWORD \
   --entrypoint sh api -c "node -r @swc-node/register libs/database/src/seed-admin.ts"

curl -sk https://localhost/v1/health/ready     # {"status":"ready","checks":{"db":"ok","redis":"ok"}}
curl -sk "https://localhost/v1/places/search?q=ca%20phe&limit=3"
$P logs -f worker                              # outbox poll 5s
$P down                                        # dừng ($P down -v để xóa cả dữ liệu)
```

`-k` vì Caddy cấp cert nội bộ cho `localhost`; trên domain thật cert Let's
Encrypt hợp lệ, không cần `-k`. Cảnh báo: nếu volume `pgdata` đã init bằng
mật khẩu khác, đổi `POSTGRES_PASSWORD` sẽ báo `28P01` — dùng project name
khác hoặc `down -v` để tạo volume mới.

## 3. Downtime monitoring — setup 20 phút

**Better Stack Uptime (free):** tạo 3 monitors + 1 status page:

| Monitor           | URL                                    | Bắt được gì                                           |
| ----------------- | -------------------------------------- | ----------------------------------------------------- |
| API liveness      | `https://api.<domain>/v1/health`       | process/Caddy/DNS/TLS chết                            |
| **API readiness** | `https://api.<domain>/v1/health/ready` | **DB/Redis chết** (endpoint trả 503 kèm check detail) |
| Docs (tùy chọn)   | `https://api.<domain>/v1/openapi.yaml` | serve tĩnh hỏng                                       |

Alert → email + Telegram. Status page public cho team.

**healthchecks.io (free) — dead-man switches** (ping ngừng = báo động, bắt
được worker chết im lặng mà HTTP monitor không thấy):

| Check             | Period / Grace   | Env var (đã wire sẵn)   |
| ----------------- | ---------------- | ----------------------- |
| outbox dispatcher | 5 phút / 10 phút | `HEARTBEAT_URL_OUTBOX`  |
| privacy daily     | 24h / 6h         | `HEARTBEAT_URL_PRIVACY` |
| pg_dump nightly   | 24h / 6h         | `HEARTBEAT_URL_BACKUP`  |

Tạo check → copy ping URL vào `.env.prod` → restart. Xong.

**Sentry:** tạo project Node → `SENTRY_DSN` vào `.env.prod`. Filter đã
capture mọi 5xx kèm request_id.

## 3b. Metrics & alert cho ingestion (PI-SRE-001)

MVP không chạy Prometheus/OTLP collector. Metric đi ra **theo log**, mỗi dòng
một shape cố định (`LogMetrics` trong `@gogo/observability`):

```json
{"metric":"place_import_rows_total","type":"counter","value":1,"status":"ready"}
{"metric":"place_resolve_duration_seconds","type":"histogram","value":0.128,"source":"cms_import","outcome":"ok"}
```

Aggregator nào cũng đếm và alert được trên shape này; đổi sang exporter thật
sau chỉ phải sửa một file, không phải sửa mọi call site.

Metric đang phát — danh sách đầy đủ, đối chiếu với `METRIC_LABELS`
(`@gogo/observability`) bằng test (#319):

| Metric                                               | Label                                        | Phát ở                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `place_import_jobs_total`                            | `status`, `source_type`                      | tạo job, pause quota, kết thúc job                                                                                                                                                       |
| `place_import_rows_total`                            | `status`, `error_code`                       | mỗi dòng khi resolve xong                                                                                                                                                                |
| `place_resolve_duration_seconds`                     | `source`, `outcome`                          | mỗi lần resolve                                                                                                                                                                          |
| `place_resolve_confidence_bucket`                    | `source`, `bucket`                           | mỗi lần resolve                                                                                                                                                                          |
| `place_duplicate_candidates_total`                   | `kind`                                       | provider id trùng / trùng theo tên + khoảng cách                                                                                                                                         |
| `place_import_legacy_mapping_total`                  | `from`, `to`                                 | client còn gửi cách viết cũ                                                                                                                                                              |
| `place_import_unknown_mapping_total`                 | `code`                                       | operator map một cột `/v1` không biết                                                                                                                                                    |
| `place_import_category_derived_total`                | `source`, `category`                         | suy ra category cho một dòng                                                                                                                                                             |
| `place_import_category_underivable_total`            | `google_type`                                | Google type chưa có category tương ứng                                                                                                                                                   |
| `place_identity_change_total`                        | `reason`                                     | re-import trỏ place sang provider id khác                                                                                                                                                |
| `place_provider_id_mismatch_total`                   | `provider`, `path`                           | Google trả place id khác id đã hỏi (#334) — place đã moved/merged                                                                                                                        |
| `place_identity_conflict_blocked_total`              | `path`                                       | từ chối vì một Google Place ID đang trỏ hai place, conflict chưa xử lý                                                                                                                   |
| `place_dbfirst_hit_total`                            | `path`                                       | trả lời từ catalogue, không gọi Google (#337); `path` = cửa vào DB-first                                                                                                                 |
| `place_dbfirst_miss_total`                           | `reason`                                     | vì sao phải hỏi Google: `absent`/`stale`/`legacy`/`indeterminate`/`closure_unverified` (#337)                                                                                            |
| `place_resolution_attestation_total`                 | `result`                                     | vòng đời proof resolve ngắn hạn (#337); `unconfigured` tăng = mất secret, trả tiền lại                                                                                                   |
| `places_provider_requests_total`                     | `method`, `status`                           | mọi call Google Places / Routes / Sheets                                                                                                                                                 |
| `place_provider_request_duration_seconds`            | `method`, `status`                           | histogram, mọi call Places / Routes / Sheets                                                                                                                                             |
| `places_provider_failures_total`                     | `method`, `status`, `reason`                 | call Google thất bại (#273), `reason` bounded (#321)                                                                                                                                     |
| `places_provider_rejected_total`                     | `method`, `canonical_status`                 | Google từ chối request của ta (#314); sheet/tab sai vào đây                                                                                                                              |
| `places_provider_business_status_unmapped_total`     | `method`                                     | Google trả `businessStatus` adapter chưa map (#339); giá trị **không** vào label                                                                                                         |
| `place_relocation_invalidated_total`                 | `source`                                     | place dời > 50 m → xoá `travel_legs` hai chiều, plan đang sống thành stale (#339)                                                                                                        |
| `places_provider_cost_units`                         | `sku`                                        | call Places/Routes thành công (Routes cộng elements). Không có Sheets                                                                                                                    |
| `provider_requests_total`                            | `provider`, `service`, `operation`, `status` | mỗi lần gọi hạ tầng trong process (#414): Redis rate-limit/revocation/room-events, mọi statement Postgres; id lấy từ registry, `status` = `ok\|error`. **Không** phải meter chi phí (§8) |
| `provider_request_duration_seconds`                  | `provider`, `service`, `operation`, `status` | histogram, thời lượng một lần gọi ở trên (#414); chỉ vào registry Prometheus, không ra log                                                                                               |
| `provider_usage_ledger_flush_total`                  | `outcome`                                    | mỗi lần ghi `provider_usage_daily` (#335); `outcome=error` = sổ chi phí đang tụt lại                                                                                                     |
| `place_refresh_total`                                | `outcome`                                    | mỗi tick/row của `gogo:worker:place-refresh` (#340); 10 giá trị đóng, không có id nào                                                                                                    |
| `provider_usage_ledger_flush_duration_seconds`       | —                                            | histogram, thời lượng một lần flush ledger (#369) — số ADR-0012 chưa đo được                                                                                                             |
| `cost_collector_runs_total`                          | `collector`, `outcome`                       | mỗi collector mỗi tick `gogo:worker:cost-collectors` (#369); `collector` là id literal                                                                                                   |
| `cost_collector_duration_seconds`                    | `collector`                                  | histogram, thời lượng một lần collect (#369)                                                                                                                                             |
| `cost_monitoring_over_budget_total`                  | —                                            | mỗi tick phải tạm dừng collector trả phí vì vượt ngân sách cost-of-cost (#369, epic §20)                                                                                                 |
| `worker_periodic_runs_total`                         | `job`, `result`                              | mỗi tick của worker (#340); `result` = `ok`/`failed`/`lock_skipped`                                                                                                                      |
| `worker_periodic_duration_seconds`                   | `job`                                        | histogram, thời lượng mỗi tick worker (#340)                                                                                                                                             |
| `mobile_place_submissions_total`                     | `status`                                     | submit / dedupe / decide                                                                                                                                                                 |
| `place_submission_publish_latency_hours`             | `decision`                                   | khi editor quyết định                                                                                                                                                                    |
| `cms_emergency_takedown_total`                       | `resource_type`, `role`                      | break-glass gỡ nội dung                                                                                                                                                                  |
| `cms_super_admin_bypass_total`                       | `action`, `resource_type`                    | ghi mà chỉ super_admin mới qua được (SEC-002)                                                                                                                                            |
| `experiment_assignment_total`                        | `experiment`, `variant`                      | gán subject vào variant                                                                                                                                                                  |
| `ai_feedback_runs_total`                             | `outcome`                                    | mỗi lần chạy refinement                                                                                                                                                                  |
| `suggestion_run_latency_seconds`                     | `variant`, `weights_version`                 | mỗi suggestion run (SG-010)                                                                                                                                                              |
| `suggestion_run_over_budget_total`                   | `variant`                                    | run vượt ngân sách latency                                                                                                                                                               |
| `share_link_created_total`                           | `type`                                       | share link canonical được tạo (#205)                                                                                                                                                     |
| `share_link_resolved_total`                          | `type`, `result`                             | edge resolve slug: `ok` / `not_found` / `gone` (revoke/expired)                                                                                                                          |
| `share_link_attribution_total`                       | `result`                                     | attribution khi tạo link (#206): `attached` / `none` / `fallback` (vendor lỗi, link vẫn tạo)                                                                                             |
| `campaign_dispatched_total`                          | `result`                                     | gửi campaign push                                                                                                                                                                        |
| `push_delivery_sent_total`                           | `kind`                                       | message provider đã tạo cho một event (#193); tăng theo số message, không theo số lần gọi                                                                                                |
| `push_delivery_no_target_total`                      | `kind`                                       | provider trả 200 nhưng không có subscription nào trong request — không phải gửi, không phải lỗi                                                                                          |
| `push_delivery_unknown_user_total`                   | `kind`                                       | user id provider không biết (chưa từng login/đã logout) — không phải lỗi gửi                                                                                                             |
| `push_delivery_failed_total`                         | `kind`                                       | provider từ chối vĩnh viễn (credential/payload); lỗi tạm thời đi qua outbox retry                                                                                                        |
| `push_provider_requests_total`                       | `status`                                     | mỗi request tới OneSignal; `status` là HTTP code hoặc `network`                                                                                                                          |
| `push_provider_request_duration_seconds`             | `status`                                     | độ trễ request OneSignal                                                                                                                                                                 |
| `push_identity_tokens_total`                         | `result`                                     | identity JWT cấp cho SDK (#199): `issued` / `unavailable` (môi trường chưa có khóa ký)                                                                                                   |
| `push_identity_logout_confirm_total`                 | `result`                                     | xác nhận thiết bị đã huỷ đăng ký khi đăng xuất (#160): `confirmed` / `still_enabled` / `unreachable` / `error`. `still_enabled` nghĩa là client phải giữ phiên, chưa được xoá            |
| `administrative_resolver_runs_total`                 | `status`, `method`                           | mỗi lần resolver chạy cho một place (#459); `status` = trạng thái mapping, `method` = bằng chứng quyết định                                                                              |
| `administrative_resolver_duration_seconds`           | `status`                                     | histogram, mỗi lần resolve                                                                                                                                                               |
| `administrative_resolver_unresolved_total`           | `reason`                                     | vì sao không resolve được (#459): `EVIDENCE_CONFLICT`, `BOUNDARY_EDGE`, `DIVIDED_CHANGE`, …                                                                                              |
| `administrative_boundary_matches_total`              | `outcome`                                    | kết quả point-in-polygon: `unique`/`province_only`/`multiple`/`edge`/`none`/`invalid`/`skipped`                                                                                          |
| `administrative_mapping_writes_total`                | `outcome`                                    | ghi mapping: `written`/`noop`/`conflict`/`blocked`; `blocked` tăng = chạm hàng do người duyệt sở hữu                                                                                     |
| `administrative_stale_evaluations_total`             | `reason`                                     | đánh giá stale so với dataset đang hoạt động; `REVALIDATED` là trạng thái lành                                                                                                           |
| `administrative_backfill_batches_total`              | `outcome`                                    | mỗi batch enrichment đã commit (#461): `dry_run`/`executed`; số liệu theo place nằm trên run row                                                                                         |
| `administrative_dataset_operations_total`            | `operation`, `result`                        | vòng đời dataset (#463): import/validate/diff/publish/rollback × succeeded/rejected/failed — từ chối là chính sách hoạt động đúng, thất bại thì không                                    |
| `administrative_dataset_operation_duration_seconds`  | `operation`                                  | histogram, mỗi thao tác vòng đời dataset                                                                                                                                                 |
| `administrative_validation_findings_total`           | `gate`, `severity`                           | mỗi gate ADM-004 khi fire; `gate` thuộc danh sách đóng 20 giá trị                                                                                                                        |
| `administrative_override_queue_reads_total`          | `view`                                       | hàng đợi phân xử nguồn ánh xạ (#484): `list`/`detail`                                                                                                                                    |
| `administrative_override_decisions_total`            | `decision`, `result`                         | quyết định của người duyệt (#484): `accept`/`reject` × `succeeded`                                                                                                                       |
| `administrative_override_conflicts_total`            | `operation`                                  | quyết định hoặc materialize bị từ chối (#484): `decision`/`materialize` — hai người duyệt cùng một dòng là trường hợp chính                                                              |
| `administrative_override_materializations_total`     | `result`                                     | vật chất hoá bộ nháp thành dataset STAGED (#484): `succeeded`/`rejected`                                                                                                                 |
| `administrative_override_operation_duration_seconds` | `operation`                                  | histogram, `decision`/`materialize`                                                                                                                                                      |
| `administrative_cache_refresh_total`                 | `result`                                     | làm ấm con trỏ sau commit; `failed` không phải publish hỏng — PostgreSQL mới là nguồn sự thật                                                                                            |
| `administrative_boundary_loads_total`                | `result`                                     | nạp ranh giới: `loaded`/`unchanged`/`rejected`/`failed`                                                                                                                                  |
| `administrative_boundary_load_duration_seconds`      | —                                            | histogram, thời lượng nạp một bản phát hành ranh giới                                                                                                                                    |
| `administrative_boundary_archive_bytes`              | —                                            | kích thước kho lưu trữ đã ghim khi nạp                                                                                                                                                   |
| `administrative_boundary_findings_total`             | `gate`, `severity`                           | gate kiểm tra ranh giới; ERROR chặn nạp, WARNING không                                                                                                                                   |
| `administrative_pip_duration_seconds`                | —                                            | histogram, một truy vấn point-in-polygon                                                                                                                                                 |
| `administrative_resolver_confidence_total`           | `class`                                      | `definitional` (1.00) hoặc `unnumbered` (NULL) — không bao giờ là một con số trung bình                                                                                                  |
| `administrative_backfill_runs_total`                 | `outcome`, `mode`                            | kết thúc một lần chạy enrichment; `mode` = `dry_run`/`execute`                                                                                                                           |
| `administrative_backfill_places_total`               | `outcome`, `mode`                            | kết quả theo từng place trong một lần chạy                                                                                                                                               |
| `administrative_backfill_run_duration_seconds`       | `mode`                                       | histogram, toàn bộ một lần chạy                                                                                                                                                          |
| `administrative_backfill_batch_duration_seconds`     | `mode`                                       | histogram, một batch đã commit                                                                                                                                                           |
| `administrative_backfill_version_stops_total`        | `mode`                                       | lần chạy dừng vì phiên bản đang hoạt động đổi giữa chừng                                                                                                                                 |
| `administrative_moderation_actions_total`            | `action`, `result`                           | hành động của người duyệt; **không** gắn nhãn danh tính người duyệt                                                                                                                      |
| `place_approval_checks_total`                        | `result`, `reason`                           | mọi lần kiểm tra invariant duyệt place; `reason` là enum `ApprovalBlockCode` đóng                                                                                                        |
| `place_publication_deferred_total`                   | `source`, `reason`                           | publish bị hoãn: `cms_import`/`link_import` × lý do hoãn                                                                                                                                 |
| `administrative_dataset_active`                      | —                                            | gauge 0/1: có dataset đang PUBLISHED hay không                                                                                                                                           |
| `administrative_dataset_age_seconds`                 | —                                            | gauge: tuổi của dataset đang hoạt động, đọc tại thời điểm scrape                                                                                                                         |
| `administrative_datasets`                            | `state`                                      | gauge: số dataset theo trạng thái vòng đời                                                                                                                                               |
| `administrative_quarantined_changes`                 | —                                            | gauge: dòng mapping còn trong quarantine của dataset đang hoạt động                                                                                                                      |
| `administrative_unresolved_changes`                  | —                                            | gauge: thay đổi chưa giải quyết của dataset đang hoạt động                                                                                                                               |
| `administrative_boundary_active`                     | —                                            | gauge 0/1: bản ranh giới của dataset đang hoạt động đã nạp chưa                                                                                                                          |
| `administrative_boundary_age_seconds`                | —                                            | gauge: tuổi bản ranh giới đã nạp                                                                                                                                                         |
| `administrative_boundary_units`                      | `level`                                      | gauge: số đa giác theo cấp (PROVINCE/COMMUNE)                                                                                                                                            |
| `administrative_mappings`                            | `status`                                     | gauge: số place theo trạng thái mapping — hàng đợi duyệt đọc ở đây                                                                                                                       |
| `administrative_remediation`                         | `category`                                   | gauge: place đã publish theo nhóm cần khắc phục                                                                                                                                          |
| `administrative_publication_enabled`                 | —                                            | gauge 0/1: môi trường này có thể duyệt place hay không                                                                                                                                   |

Alert đề xuất (ngưỡng chỉnh sau khi có baseline thật):

| Alert            | Điều kiện                                                                 | Vì sao                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Ingestion quota  | có `place_import_jobs_total{status="paused_provider_quota"}`              | job đang đứng, cần người vào resume                                                                                                |
| Provider lỗi     | tỉ lệ `places_provider_requests_total{status!~"2.."}` > 10% trong 15 phút | key sai, hết hạn, hoặc Google có sự cố                                                                                             |
| Resolve chậm     | p95 `place_resolve_duration_seconds` > 3s trong 15 phút                   | job 5.000 dòng sẽ không kịp                                                                                                        |
| Google chậm      | p95 `place_provider_request_duration_seconds` > 1s trong 15 phút          | tách phần chậm của Google khỏi phần chậm của ta — `place_resolve_duration_seconds` đo cả hai                                       |
| Chi phí          | `places_provider_cost_units` vượt ngân sách ngày                          | chặn hoá đơn bất ngờ — **đặt cả budget alert bên Google Cloud Billing**, đừng chỉ dựa vào cái này                                  |
| Chất lượng match | tỉ lệ bucket `0-0.5` > 30% trong một job                                  | dữ liệu nguồn kém hoặc mapping sai, không phải lỗi resolver                                                                        |
| Submission tồn   | p95 `place_submission_publish_latency_hours` > 72h                        | hàng chờ moderation bị bỏ quên                                                                                                     |
| Break-glass      | **bất kỳ** `cms_emergency_takedown_total`                                 | gỡ nội dung khẩn cấp phải **page ngay**, không để tới kỳ audit sau. Nhiều lần liên tiếp từ một actor = dấu hiệu tài khoản bị chiếm |

**Nhãn phải hữu hạn (#313).** `duration_ms` từng là _nhãn_ của
`places_provider_requests_total`: mỗi mili-giây khác nhau sinh một series mới,
nên 10 request cho 10 series mỗi cái đứng ở `1` — không `rate()` được, và không
có percentile. Thời lượng giờ nằm ở histogram
`place_provider_request_duration_seconds`.

**Đơn vị là giây (#320).** Đơn vị cơ bản của Prometheus. Trước đây là mili-giây,
với lý do ghi trong repo là "cho khớp `place_resolve_duration_ms` đã có" — một
lý do tự tham chiếu: metric kia cũng của ta, cũng đổi được trong cùng commit.
Đổi trước khi Grafana Cloud ingest để không tạo hai chuỗi lịch sử song song.
`MetricsPort.observe()` và `time()` nhận giây; `secondsSince()` là chỗ duy nhất
quy đổi.

Ngoại lệ có chủ ý: `place_submission_publish_latency_hours` ở lại đơn vị giờ.
SLA người ta thật sự bàn là "72 giờ"; đọc thành 259.200 giây thì không ai hiểu.
Quy ước repo giữ là **ghi đơn vị vào hậu tố** — base unit thắng ở chỗ nó giúp
ích, và ở đây thì không.

**Mép bucket phải trùng ngưỡng alert.** p95 là phát biểu về mép bucket trước
khi là phát biểu về hệ thống: nếu ngưỡng rơi giữa hai mép thì alert đang so với
một giá trị nội suy, và con số đổi khi bộ bucket đổi chứ không phải khi dịch vụ
đổi. Bốn bộ trong `BUCKETS_BY_METRIC` (`libs/observability/src/registry.ts`):

| Histogram                                 | Mép đáng chú ý       | Vì sao                                                              |
| ----------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `place_provider_request_duration_seconds` | 0,025–0,3 dày, rồi 1 | mọi call DEV rơi vào 64–306ms (#313); mép 1s là alert "Google chậm" |
| `place_resolve_duration_seconds`          | 3                    | alert "Resolve chậm"                                                |
| `suggestion_run_latency_seconds`          | 3                    | `SUGGESTION_LATENCY_BUDGET_MS`                                      |
| `place_submission_publish_latency_hours`  | 72                   | SLA moderation                                                      |

Bộ mặc định (0,001s → 30s) dành cho histogram nào không khai báo riêng.

**Sheets không có dòng chi phí (#321).** Adapter Google Sheets giờ phát
`places_provider_requests_total`, `places_provider_failures_total`,
`places_provider_rejected_total` và histogram thời lượng như hai adapter kia —
trước đó nó không phát gì, nên hàng "Sheets" trên dashboard CMS chỉ có thể là
số 0, đọc thành "không ai dùng" thay vì "không ai đo".

Nhưng **không** có `places_provider_cost_units`. Sheets API giới hạn bằng quota
chứ không tính tiền theo lượt gọi, nên một dòng SKU cho nó là một con số không
đối chiếu được với hoá đơn nào.

Không bao giờ đưa vào nhãn: thời lượng thô, URL, place id, chuỗi truy vấn,
message lỗi, job id, request id, timestamp, spreadsheet id, hay bất cứ thứ gì
người dùng/operator gõ vào.

**Audit cardinality (#319).** `place_import_unknown_mapping_total` từng mang
nhãn `field` = giá trị mapping operator tự gõ, cắt còn 64 ký tự. Cắt độ dài
chặn _độ dài_ của nhãn, không chặn _số giá trị phân biệt_ — mỗi lỗi chính tả
vẫn là một series, giữ mãi. Cùng lớp lỗi với `duration_ms` ở #313. Nhãn đã bỏ;
cột không map được vẫn báo cho operator qua `unmappedHeaders` trên chính job.

Kết quả rà toàn bộ registry:

| Nhãn                                                   | Nguồn giá trị                 | Đánh giá                                                             |
| ------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------- |
| `place_import_unknown_mapping_total{field}`            | text operator gõ              | **Không trần** — đã bỏ (#319)                                        |
| `places_provider_failures_total{reason}`               | `ErrorInfo.reason` của Google | **Đã đóng (#321)** — `boundedReason()`, ngoài tập đã biết là `other` |
| `suggestion_run_latency_ms{weights_version}`           | ranking config đã activate    | Tăng đơn điệu theo deploy, không giảm lại                            |
| `place_import_category_underivable_total{google_type}` | từ vựng place type của Google | Hữu hạn lớn (~200), Google kiểm soát — nhận                          |
| `cms_super_admin_bypass_total{action,resource_type}`   | route _template_ của Fastify  | Hữu hạn theo bảng route — đúng thiết kế                              |
| Mọi nhãn còn lại                                       | enum trong source             | Hữu hạn                                                              |

`METRIC_LABELS` (`@gogo/observability`) là hợp đồng: nó liệt kê **key nhãn nào
mỗi metric được phép mang**, và `metric-labels.spec.ts` quét source, đối chiếu,
đỏ khi có key mới. Test không kiểm được _giá trị_ có hữu hạn hay không — chỉ
người đọc file đó trả lời được. Việc nó làm là bắt mọi lần thêm nhãn phải mở
file đó ra, tức là phải trả lời câu hỏi.

**Hai scrape target, không phải một (#318).** API và worker là hai tiến trình,
mỗi tiến trình một registry trong bộ nhớ. Collector phải đọc cả hai.

| Target | Đường dẫn                                       | Phát ra                                                                                              |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| api    | `GET /v1/metrics` (public, sau Caddy)           | provider từ đường mobile resolve, submission, CMS, suggestion                                        |
| worker | `GET :9101/metrics` (chỉ trong compose network) | toàn bộ `place_import_*`, `place_resolve_*`, outbox/campaign, **và provider + cost của bulk import** |

Trước #318 worker chỉ có `LogMetrics`. Bulk import chạy ở worker, nên phần
`places_provider_cost_units` lớn nhất — chi tiêu Google của import hàng loạt —
không tới được scraper nào. Một dashboard chi phí dựng trên scrape của API sẽ
báo thiếu đúng cấu phần lớn nhất, và đó tệ hơn không hiển thị gì vì nó trông
giống một câu trả lời.

Cổng của worker **không bao giờ** nằm trong `ports:` của compose, chỉ `expose:`.
Publish nó là đưa mọi series nội bộ ra cách một lệnh `curl`; bearer token là
lớp khoá thứ hai, không phải thứ nhất.

Cả hai chắn bằng `METRICS_TOKEN`. Không cấu hình token thì trả **404** chứ
không phải 401 — endpoint chưa cấu hình không nên quảng cáo rằng nó tồn tại và
chỉ đang khoá.

Endpoint của worker không bao giờ làm dừng job: không bind được cổng thì ghi
log rồi chạy tiếp không có metric. Một worker chết vì không mở được cổng metric
là sự cố gây ra bởi chính thứ lẽ ra để quan sát sự cố.

**Collector: Grafana Alloy (#326 / GoGo-Infra#95).**

```
api    /v1/metrics      ─┐
                          ├─▶ Alloy ──remote_write──▶ Prometheus tự host
worker :9101/metrics     ─┘   (compose overlay, stateless)     192.168.68.168:9090
```

`docker/docker-compose.observability.yml` + `docker/alloy/config.alloy`. Là
**overlay**, không nằm trong `docker-compose.prod.yml`: sự có mặt của nó là một
quyết định chứ không phải thuộc tính của host. Chưa có endpoint để ghi thì
không có chỗ để ghi, và một container restart-loop vào endpoint rỗng là tiếng
ồn đọc như sự cố. GoGo-Infra chỉ thêm `-f` khi `PROMETHEUS_REMOTE_WRITE_URL` có
trong env đã render — container và endpoint đến cùng nhau hoặc không cái nào đến.

> **Đổi 2026-09-04** (ADR-0007 §E1/§E7, BE-SRE-P8 #404). Kho mẫu của DEV chuyển từ Grafana
> Cloud sang Prometheus tự host tại `192.168.68.168`. Cổng gate đổi từ `GRAFANA_PROM_URL` sang
> `PROMETHEUS_REMOTE_WRITE_URL`, ở **cả hai** chỗ GoGo-Infra kiểm tra.
>
> Đường ghi và đường đọc cắt sang **cùng lúc**. Alloy ghi vào `.168` trong khi API vẫn đọc
> Grafana Cloud là trạng thái bị cấm: màn monitoring của CMS báo khoẻ mà không có số — đúng
> kiểu hỏng mà `unknown != zero` sinh ra để chặn. `resolveMetricsQueryConfig` cưỡng chế điều
> đó: API đọc ở nơi collector ghi, trừ khi `METRICS_QUERY_URL` cố ý ghi đè.
>
> Prometheus tự host **có basic auth**: PROD sẽ từ chối một remote-write receiver không xác
> thực, và §E8 nói "chỉ là DEV" không phải lý do được chấp nhận. Một credential dùng cho cả
> đọc lẫn ghi — basic auth của Prometheus không phân quyền theo user được — ghi lại là khác
> biệt DEV có chủ ý (GoGo-Infra INF-066/INF-067).
>
> Credential Grafana Cloud **còn hiệu lực** suốt cửa sổ rollback và chỉ thu hồi sau cùng.

- Không credential nào trong file cấu hình; tất cả qua biến môi trường.
- Alloy không publish cổng nào; UI nội bộ bind loopback trong container.
- WAL của `remote_write` là **buffer gửi**, không phải kho lưu. Prometheus giữ
  dữ liệu; mất container mất vài phút mẫu chưa gửi, không có gì để backup.
  Trên host `.168` thì ngược lại: TSDB ở đó là **state DEV bền**, có backup, và
  `docker compose down -v` là thao tác phá huỷ (ADR-0007 §E8).
- Nhãn ngoài `env` là bắt buộc: một stack chứa mọi môi trường, thiếu nhãn này
  là traffic dev cộng âm thầm vào biểu đồ production.

Điều này gỡ nút thắt "chưa chốt nơi nhận metric": scraper nào đọc được format
chuẩn cũng dùng được, nên chọn đích đến không còn là điều kiện tiên quyết để
**có** alert. Metric vẫn đồng thời đi ra theo log, nên mất một đường không mất
đường kia.

Tên metric mà các rule ở trên dựa vào nằm trong `ALERTED_METRICS`
(`@gogo/observability`), và có test đỏ khi đổi tên: một alert trỏ vào series
không ai phát nữa **trông y hệt** một alert đang im vì mọi thứ đều ổn.

Runbook cho từng alert: `docs/runbooks.md` §7. Chưa có: dashboard.

## 3c. CORS cho browser client (BE-IMP-003)

CMS và Web chạy ở origin khác API, gửi kèm cookie session, nên CORS phải là
**allowlist tường minh**:

```env
# dev
CORS_ORIGINS=http://localhost:5173,http://localhost:5174
# production
CORS_ORIGINS=https://app.gogo.id.vn,https://cms.gogo.id.vn
```

Không bao giờ dùng `*` hoặc `origin: true`. Cookie có `credentials` cộng
wildcard origin = giao session cho bất kỳ trang nào người dùng mở.

Header được phép: `content-type`, `authorization`, `idempotency-key`,
`x-request-id`, `x-gogo-csrf`. Header lộ ra client: `x-request-id` (để client
đính vào báo lỗi).

Rỗng = chặn toàn bộ cross-origin. Đây là mặc định an toàn, nhưng cũng nghĩa là
**CMS không gọi được API nào, kể cả login** — nếu CMS báo lỗi mạng ở màn đăng
nhập, kiểm biến này trước.

## 4. Key hand-off checklist (bàn giao private)

Kênh: gửi qua kênh riêng (không chat thường/không email plaintext — dùng
1Password share / age-encrypted file). **Không bao giờ commit.** Key vào đúng
một chỗ: `.env.prod` trên VPS (chmod 600) + GitHub Actions secrets nếu CI cần.

| #   | Key                              | Slot chờ (đã có trong `.env.example`)                                               | Ghi chú bảo mật                                                                                                 |
| --- | -------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Google API keys, một key mỗi API | `GOOGLE_PLACES_API_KEY` / `GOOGLE_ROUTES_API_KEY` / `GOOGLE_SHEETS_API_KEY`         | Mỗi key restrict đúng một API + IP VPS; budget alert riêng từng key. Không key nào fallback cho key nào         |
| 2   | R2 S3 token                      | `R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/R2_BUCKET/R2_BACKUP_BUCKET`          | Token scope đúng 2 bucket; bucket backup riêng                                                                  |
| 3   | Sentry DSN                       | `SENTRY_DSN`                                                                        | DSN không phải secret nghiêm ngặt nhưng vẫn để .env                                                             |
| 4   | OneSignal                        | `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`, `ONESIGNAL_IDENTITY_VERIFICATION_KEY` | REST key chỉ worker dùng. APNs `.p8` và FCM V1 nằm **trong OneSignal app**, không đi qua BE — xem GoGo-Infra#13 |

Khi nhận key: tôi bật adapter thật tương ứng (place import/areas → #80,
media presign → #81/#70, push → #193 OneSignal adapter) + smoke test từng cái.

## 5. Những gì cố tình KHÔNG dùng ở MVP (tiết kiệm)

- Managed Postgres/Redis ngay từ đầu — chưa cần PITR khi chưa có user thật.
- Kubernetes/Fly/Railway — compose 1 máy đơn giản hơn, đủ SLO MVP.
- Grafana/OTel stack **làm câu chuyện alerting** — Better Stack + Sentry + CMS
  KPIs đủ quan sát MVP; OTel endpoint đã chừa slot
  (`OTEL_EXPORTER_OTLP_ENDPOINT`) bật sau. Vẫn đúng sau ADR-0007: có một
  Prometheus/Grafana tự host để _chứa mẫu và xem biểu đồ_, nhưng **không có
  alert rule nào** — cái gì gọi người vẫn là Better Stack + healthchecks.io +
  Sentry (ADR-0006 §D3, ADR-0007 giữ nguyên).
- Load balancer/multi-instance — Redis rate-limit store đã sẵn sàng cho ngày
  scale ngang, nhưng chưa trả tiền cho nó hôm nay.
