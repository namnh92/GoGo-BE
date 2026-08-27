# GoGo Infrastructure — MVP cost-optimized plan (#21, #15, #36)

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

## 4. Key hand-off checklist (bàn giao private)

Kênh: gửi qua kênh riêng (không chat thường/không email plaintext — dùng
1Password share / age-encrypted file). **Không bao giờ commit.** Key vào đúng
một chỗ: `.env.prod` trên VPS (chmod 600) + GitHub Actions secrets nếu CI cần.

| #   | Key                 | Slot chờ (đã có trong `.env.example`)                                      | Ghi chú bảo mật                                                              |
| --- | ------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Google Maps API key | `GOOGLE_MAPS_API_KEY`                                                      | Restrict theo IP VPS; enable đúng "Places API (New)"; budget alert $10       |
| 2   | R2 S3 token         | `R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/R2_BUCKET/R2_BACKUP_BUCKET` | Token scope đúng 2 bucket; bucket backup riêng                               |
| 3   | Sentry DSN          | `SENTRY_DSN`                                                               | DSN không phải secret nghiêm ngặt nhưng vẫn để .env                          |
| 4   | FCM service account | `FCM_SERVICE_ACCOUNT_B64` (base64 1 dòng)                                  | Role tối thiểu: Firebase Cloud Messaging API                                 |
| 5   | APNs .p8            | `APNS_KEY_ID/TEAM_ID/BUNDLE_ID/PRIVATE_KEY_B64` + `APNS_ENV`               | .p8 không thu hồi từng phần được — giữ 1 bản duy nhất trong password manager |

Khi nhận key: tôi bật adapter thật tương ứng (place import/areas → #80,
media presign → #81/#70, push → #59 APNs/FCM adapter) + smoke test từng cái.

## 5. Những gì cố tình KHÔNG dùng ở MVP (tiết kiệm)

- Managed Postgres/Redis ngay từ đầu — chưa cần PITR khi chưa có user thật.
- Kubernetes/Fly/Railway — compose 1 máy đơn giản hơn, đủ SLO MVP.
- Grafana/OTel stack — Better Stack + Sentry + CMS KPIs đủ quan sát MVP;
  OTel endpoint đã chừa slot (`OTEL_EXPORTER_OTLP_ENDPOINT`) bật sau.
- Load balancer/multi-instance — Redis rate-limit store đã sẵn sàng cho ngày
  scale ngang, nhưng chưa trả tiền cho nó hôm nay.
