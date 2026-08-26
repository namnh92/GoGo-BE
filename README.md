# GoGo-BE

Backend của **GoGo** — nền tảng giúp cặp đôi và nhóm bạn thống nhất địa điểm, tạo lịch trình và sử dụng kế hoạch trong ngày đi chơi.

Repo này chứa API BFF, database schema, search, suggestion engine, background workers và CMS APIs. Tài liệu nguồn (workspace docs): `GOGO_SRS.md`, `GOGO_IMPLEMENTATION_WBS.md`, `GOGO_ENGINEERING_SKILLS_AND_PLANS.md`, `GOGO_MOCKUP_VERIFICATION_AND_TECHNICAL_APPLICATION.md`, `GOGO_FEATURE_IMPROVEMENT_SPEC.md`.

## Hệ sinh thái GoGo

| Repo | Phạm vi |
| --- | --- |
| **GoGo-BE** (repo này) | API BFF, database, search, suggestion, workers, CMS APIs |
| [GoGo-WebApp](https://github.com/namnh92/GoGo-WebApp) | Responsive Web/PWA và Mini Web App |
| [GoGo-MobileApp](https://github.com/namnh92/GoGo-MobileApp) | React Native iOS/Android |
| [GoGo-Mockup](https://github.com/namnh92/GoGo-Mockup) | Prototype, UI/UX fixtures và design validation |

## Stack đã chốt

| Phần | Công nghệ |
| --- | --- |
| Runtime/framework | Node.js LTS, TypeScript, NestJS, Fastify adapter |
| API | REST + OpenAPI `/v1` |
| Database | PostgreSQL + PostGIS |
| Data access | Drizzle ORM + raw parameterized SQL cho geo/FTS/ranking |
| Cache/jobs | Redis + BullMQ |
| Realtime | SSE trước; WebSocket chỉ khi thật sự cần bidirectional |
| Storage/edge | Cloudflare R2 + CDN/WAF |
| Observability | OpenTelemetry + Sentry |
| Test | Vitest/Jest + Supertest + Testcontainers |
| Build/deploy | Docker + GitHub Actions |

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

## Local development (dự kiến — chốt tại Sprint 0)

Yêu cầu: Node.js LTS, pnpm, Docker (hoặc PostgreSQL + PostGIS local).

```bash
pnpm install
cp .env.example .env.local
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Lệnh chuẩn mục tiêu: `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm test:integration` · `pnpm build`.

> Script sẽ được chốt khi Sprint 0 hoàn thành; README này không phải bằng chứng command đã tồn tại.

## Git

Git Flow: `master` (production, tag `vX.Y.Z`) · `develop` (integration) · `feature|bugfix/GOGO-<ticket>-<name>` · `hotfix/GOGO-<ticket>-<name>` · `release/x.y.z`. PR bắt buộc, CI xanh, ≥1 approval. Thay đổi OpenAPI/migration/auth/ranking cần CODEOWNER duyệt.

## Backlog

Backlog theo `GOGO_IMPLEMENTATION_WBS.md`, task ID ổn định, quản lý bằng GitHub issues (label `wbs`):

| Nhóm | Task IDs | Phạm vi |
| --- | --- | --- |
| Foundation | `FND-001..009` | ADR, workspace, packages, OpenAPI, CI, env, observability, fixtures, tokens |
| Database | `DB-001..011` | ERD, schema theo domain, geo/FTS indexes, retention, backup/restore |
| Search | `SE-001..009` | Normalization, FTS/trigram, filters, ranking, evaluation, indexing |
| Suggestion | `SG-001..010` | Scoring, fairness, optimizer, lock/regenerate, AI guarded |
| API BFF | `BE-BFF-001..012` | Runtime, auth/guest, room, preference, search, suggestion, plan, providers |
| CMS | `CMS-001..010` | APIs/schema thuộc repo này; frontend CMS repo sẽ chốt sau |
| QA/Platform | `QP-001..008` | Test harness, E2E, golden datasets, load, threat model, runbooks |

Sprint plan: S0 foundation → S1 identity/room → S2 preference/place → S3 search → S4 suggestion → S5 plan → S6 Mini+Mobile core → S7 active date/ops → S8 AI → S9 hardening/beta.

## Trạng thái

**Sprint 0 — skeleton.** Cấu trúc thư mục đã dựng theo tài liệu kiến trúc; code bắt đầu theo backlog WBS ở trên.
