# GoGo-BE

Backend của **GoGo** — nền tảng giúp cặp đôi và nhóm bạn thống nhất địa điểm, tạo lịch trình và sử dụng kế hoạch trong ngày đi chơi.

Repo này chứa API BFF, database schema, search, suggestion engine, background workers và CMS APIs. Tài liệu nguồn (workspace docs): `GOGO_SRS.md`, `GOGO_IMPLEMENTATION_WBS.md`, `GOGO_ENGINEERING_SKILLS_AND_PLANS.md`, `GOGO_MOCKUP_VERIFICATION_AND_TECHNICAL_APPLICATION.md`, `GOGO_FEATURE_IMPROVEMENT_SPEC.md`.

## Hệ sinh thái GoGo

| Repo                                                        | Phạm vi                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| **GoGo-BE** (repo này)                                      | API BFF, database, search, suggestion, workers, CMS APIs         |
| [GoGo-CMS](https://github.com/namnh92/GoGo-CMS)             | Back-office cho ops: catalog, kiểm duyệt, bulk import, dashboard |
| [GoGo-WebApp](https://github.com/namnh92/GoGo-WebApp)       | Responsive Web/PWA và Mini Web App                               |
| [GoGo-MobileApp](https://github.com/namnh92/GoGo-MobileApp) | React Native iOS/Android                                         |
| [GoGo-Mockup](https://github.com/namnh92/GoGo-Mockup)       | Prototype, UI/UX fixtures và design validation                   |

## Stack đã chốt

| Phần              | Công nghệ                                               |
| ----------------- | ------------------------------------------------------- |
| Runtime/framework | Node.js LTS, TypeScript, NestJS, Fastify adapter        |
| API               | REST + OpenAPI `/v1`                                    |
| Database          | PostgreSQL + PostGIS                                    |
| Data access       | Drizzle ORM + raw parameterized SQL cho geo/FTS/ranking |
| Cache/jobs        | Redis + BullMQ                                          |
| Realtime          | SSE trước; WebSocket chỉ khi thật sự cần bidirectional  |
| Storage/edge      | Cloudflare R2 + CDN/WAF                                 |
| Observability     | OpenTelemetry + Sentry                                  |
| Test              | Vitest/Jest + Supertest + Testcontainers                |
| Build/deploy      | Docker + GitHub Actions                                 |

Backend MVP là **modular monolith** gồm hai process dùng chung domain packages: `api` (REST, auth, orchestration) và `worker` (BullMQ consumers: suggestion, import, reindex, notification, privacy, AI refinement). Không chạy core backend trên Cloudflare Workers — cần PostgreSQL/PostGIS, Redis/BullMQ và long-running jobs.

## Cấu trúc thư mục

```text
GoGo-BE/
├── apps/
│   ├── api/                  # NestJS REST/OpenAPI process
│   └── worker/               # BullMQ consumers process
├── libs/
│   ├── modules/              # Domain modules, mỗi module 4 layer:
│   │   ├── identity/         #   domain/ application/ infrastructure/ presentation/
│   │   ├── rooms/
│   │   ├── preferences/
│   │   ├── places/
│   │   ├── search/
│   │   ├── suggestions/
│   │   ├── plans/
│   │   ├── reviews/
│   │   ├── notifications/
│   │   └── cms/
│   ├── database/             # Drizzle schema, connection, seed
│   ├── providers/            # Adapter cho Maps/Places/AI/Notification
│   └── observability/        # Logging, tracing, metrics
├── migrations/
├── openapi/                  # OpenAPI spec — contract nguồn cho mọi client
├── docker/
└── docs/adr/                 # Architecture Decision Records
```

Quy tắc layer: `domain/` (entity, invariant) → `application/` (use cases) → `infrastructure/` (Drizzle repos, outbox) → `presentation/` (controllers, DTOs, authorization policies). **Controller không chứa business logic; Drizzle model không bao giờ là public DTO.**

## API

- Base path `/v1`; OpenAPI là contract nguồn — TypeScript clients được generate, không copy tay.
- Thời gian ISO-8601 UTC; tiền là integer minor unit; mutation retryable dùng `Idempotency-Key`; cursor pagination; ETag/version cho optimistic concurrency.
- Error envelope: `{ code, message, field_errors, request_id, retryable }`.
- DTO trả **facts, không trả câu chữ đã ghép** — audience copy do client tự ghép từ `type`, `participantCount`, `budgetMode`…

Nhóm endpoint ưu tiên:

```text
POST /v1/sessions/guest
POST /v1/rooms · GET /v1/rooms/{id} · PATCH /v1/rooms/{id}/constraints
POST /v1/rooms/{id}/join · GET /v1/rooms/{id}/members
PUT  /v1/rooms/{id}/preferences/me · POST /v1/rooms/{id}/preferences/complete
POST /v1/rooms/{id}/suggestions · GET /v1/rooms/{id}/suggestions/current
PUT  /v1/rooms/{id}/votes/{candidateId}
POST /v1/rooms/{id}/plans · PATCH /v1/plans/{id} · POST /v1/plans/{id}/regenerate
POST /v1/plans/{id}/stops/{stopId}/complete
GET  /v1/places/search · GET /v1/places/{id} · POST /v1/places/{id}/reports
```

## Nguyên tắc cốt lõi

- Room hỗ trợ **N thành viên** — không viết logic cứng cho hai người.
- Hard constraint (trạng thái, khu vực, thời gian, ngân sách, dietary, accessibility, stop đã lock) **AI không được override**; AI chỉ refinement trên candidate đã xác minh, có schema validation và deterministic fallback.
- Search MVP: `unaccent` + FTS + trigram + PostGIS; tách engine ngoài chỉ khi có số liệu.
- Outbox + idempotent consumers; không distributed transaction; không giữ DB transaction khi gọi provider ngoài.
- Audit log append-only cho mọi write nhạy cảm.

## Chạy backend trên máy

Máy developer là **workstation, không phải một môi trường**. DEV chạy từ xa: PostgreSQL ở Neon,
Redis ở Upstash, object storage ở R2. Developer làm Mobile hoặc CMS không cần repo này chút nào —
họ trỏ vào dev API được host.

Phần dưới dành cho người **làm backend**. Nó vẫn dùng dịch vụ DEV từ xa, không dựng chúng lên máy.

Yêu cầu: Node.js ≥22, pnpm (corepack). Docker chỉ cần cho integration test.

```bash
pnpm install
export AWS_PROFILE=gogo-bootstrap        # không có default profile
aws sso login --profile gogo-bootstrap
pnpm secrets:pull                        # ghi .env.runtime (0600) từ AWS SSM
pnpm dev                                 # api tại http://localhost:3000/v1
```

`secrets:pull` lấy `DATABASE_URL`, `REDIS_URL`, credential R2 và key của provider từ SSM, nên
những gì chạy trên máy chỉ là code — không PostgreSQL, không Redis, không MinIO.

Migration và seed chạy trên đúng database DEV đó:

```bash
pnpm db:migrate
pnpm db:seed
```

Lệnh chuẩn: `pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm test` (unit) ·
`pnpm test:integration` (Testcontainers, cần Docker) · `pnpm build`.
Worker: `pnpm --filter @gogo/worker dev`.

### Stack cục bộ đầy đủ — tuỳ chọn

Cho làm offline, gỡ lỗi hạ tầng, hoặc khi cần một database dùng một lần:

```bash
docker compose -f docker/docker-compose.yml --profile full-local up -d   # postgis :5433, redis :6380
DATABASE_URL=postgres://gogo:gogo@localhost:5433/gogo pnpm db:migrate
```

Đây là chế độ gỡ lỗi, không phải cách phát triển mặc định. Chạy nó nghĩa là bạn đang làm việc
trên một database khác với cả team, và không có gì nhắc bạn điều đó.

Dev CMS login (seed): `admin@gogo.local` / `gogo-dev-admin-password`.

## Git

Git Flow: `master` (production, tag `vX.Y.Z`) · `develop` (integration) · `feature|bugfix/GOGO-<ticket>-<name>` · `hotfix/GOGO-<ticket>-<name>` · `release/x.y.z`. PR bắt buộc, CI xanh, ≥1 approval. Thay đổi OpenAPI/migration/auth/ranking cần CODEOWNER duyệt.

## Backlog

Backlog theo `GOGO_IMPLEMENTATION_WBS.md`, task ID ổn định, quản lý bằng GitHub issues (label `wbs`):

| Nhóm        | Task IDs          | Phạm vi                                                                                  |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------- |
| Foundation  | `FND-001..009`    | ADR, workspace, packages, OpenAPI, CI, env, observability, fixtures, tokens              |
| Database    | `DB-001..011`     | ERD, schema theo domain, geo/FTS indexes, retention, backup/restore                      |
| Search      | `SE-001..009`     | Normalization, FTS/trigram, filters, ranking, evaluation, indexing                       |
| Suggestion  | `SG-001..010`     | Scoring, fairness, optimizer, lock/regenerate, AI guarded                                |
| API BFF     | `BE-BFF-001..012` | Runtime, auth/guest, room, preference, search, suggestion, plan, providers               |
| CMS         | `CMS-001..010`    | APIs/schema ở repo này; UI back-office ở [GoGo-CMS](https://github.com/namnh92/GoGo-CMS) |
| QA/Platform | `QP-001..008`     | Test harness, E2E, golden datasets, load, threat model, runbooks                         |

Sprint plan: S0 foundation → S1 identity/room → S2 preference/place → S3 search → S4 suggestion → S5 plan → S6 Mini+Mobile core → S7 active date/ops → S8 AI → S9 hardening/beta.

## Trạng thái

**Core backend đã hiện thực** (PR chain #85–#92): foundation + config/observability, schema 42 bảng + migrations + geo/FTS indexes, auth/guest/session hardened (ADR-0003), rooms/invites/preferences, search tiếng Việt (golden set CI), deterministic suggestion engine + vote/match + plan lock/regenerate, place import pipeline, saved/review/privacy, notifications worker, retention jobs, CMS APIs (RBAC/moderation/ranking console). 74 integration + 33 unit tests.

Còn blocked (xem issue comments): cloud provisioning (#21), preview env (#15), AI refinement provider+DPA (#48), load test env (#76), dashboard observability (#36), E2E FE (#74).

## Shared contract artifacts (FND-003)

`pnpm artifacts` builds `artifacts/`, which CI uploads as `gogo-contract`.
Every other repo generates from these rather than hand-copying types, so a
break here surfaces in a consumer's build instead of at runtime.

| File                                         | What it is for                                          |
| -------------------------------------------- | ------------------------------------------------------- |
| `openapi/gogo.v1.yaml` \| `.json` \| `.d.ts` | the API contract and its generated client               |
| `events/domain-event.schema.json`            | the envelope every domain event carries                 |
| `events/room-event.schema.json`              | the SSE stream's event types                            |
| `design-tokens/tokens.json`                  | semantic colour and accessibility tokens                |
| `analytics/taxonomy.json`                    | metric names and event types, extracted from call sites |
| `fixtures/golden-scenarios.json`             | the minimum E2E flows, as data                          |
| `manifest.json`                              | contract version, commit, and a sha256 per file         |

The manifest version is the **contract** version (`info.version` in the spec),
not a repo version — repos do not share one. The checksums are there because a
version string alone cannot answer "is this the spec I think it is" after a
hand-edit.

`pnpm check:boundaries` enforces the direction: `libs/**` never imports from
`apps/**`, and the leaf packages (`database`, `observability`, `providers`)
never import `modules`. A package that reaches back into an app is not
publishable — consumers would get a module graph that only resolves in this
repo.
