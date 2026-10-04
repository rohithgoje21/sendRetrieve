# sendRetrieve

[![CI](https://github.com/rohithgoje21/sendRetrieve/actions/workflows/ci.yml/badge.svg)](https://github.com/rohithgoje21/sendRetrieve/actions/workflows/ci.yml)
[![CodeQL](https://github.com/rohithgoje21/sendRetrieve/actions/workflows/codeql.yml/badge.svg)](https://github.com/rohithgoje21/sendRetrieve/actions/workflows/codeql.yml)

Share text and files temporarily with a short code. Shares delete themselves when they expire. Use it as a guest, or create an account to track your shares, see who's opening them, and get notified.

A full-stack **MERN** application (**M**ongoDB, **E**xpress, **R**eact, **N**ode.js) built as a **modular monolith** with **background workers**: an Express API and a worker process from one codebase, connected by **RabbitMQ**, with **Redis**, **S3-compatible object storage** (MinIO locally), **ClamAV** malware scanning, **Socket.IO** live updates, and **Prometheus + Grafana** monitoring.

## Architecture

```
                               Browser (React SPA)
        │ /api (JSON)            │ files: signed URLs (multipart)    │ live updates (WebSocket)
        ▼                        ▼                                   ▼
 ┌──────────────────┐     ┌──────────────────┐               ┌──────────────────┐
 │   Express API    │────▶│  Object storage  │◀───┐          │ Socket.IO server │
 │ (modules: auth,  │     │  MinIO / R2 / S3 │    │          │ (in the API)     │
 │ shares, files,   │     └──────────────────┘    │          └────────▲─────────┘
 │ notifications,   │                             │                   │ Redis adapter /
 │ analytics, ...)  │── publish events ──┐        │                   │ emitter
 └──┬──────┬────────┘                    ▼        │                   │
    │      │                     ┌────────────────┴──┐   ┌────────────┴───────────┐
    │      │                     │     RabbitMQ      │──▶│        Worker          │──▶ ClamAV (clamd)
    │      │                     │ topic exchange,   │   │ processing, cleanup,   │──▶ email (Resend)
    │      │                     │ retry queues, DLQ │   │ notifications,         │──▶ Web Push
    │      │                     └───────────────────┘   │ analytics, scheduler   │
    ▼      ▼                                             └──┬──────────┬──────────┘
 MongoDB  Redis ◀───────────────────────────────────────────┘          ▼
 metadata rate limits, lockouts, codes, locks, idempotency,          MongoDB
          live-event relay, circuit-breaker states

 Prometheus ── scrapes /metrics (internal ports) of the API, every worker, RabbitMQ ──▶ Grafana, Alertmanager
```

- **API** (`server/server.js`): HTTP and Socket.IO. Requests never wait on slow work: they write to MongoDB, then **publish an event** (`share.uploaded`, `file.downloaded`, `share.ended`, `auth.login`...).
- **RabbitMQ** routes each event to the queues that care (a topic exchange). Failed jobs go to **delayed retry queues** (1 s, 5 s, 30 s), then to a **dead-letter queue** an admin can inspect and replay.
- **Worker** (`server/worker.js`, scale it horizontally): consumes the queues.
  - **processing**: ClamAV scan of every uploaded file, image thumbnails;
  - **cleanup**: deletes stored files when a share ends;
  - **notifications**: in-app, email, browser push;
  - **analytics**: daily statistics;
  - **scheduler**: expiry, abandoned uploads, orphaned files, stuck jobs, weekly summaries. Each sweep runs on one worker at a time, coordinated by a Redis lock.
- **Without RabbitMQ** an in-process queue with the same retry and dead-letter behavior is used, and the API runs the workers itself: fine for a single server and for tests.
- **MongoDB** holds metadata, never file contents. **Object storage** holds files; browsers upload to and download from it **directly** with short-lived signed URLs.

### Sending files

```
Browser                              API                               Storage          Worker
  │ POST /api/shares {files}          │                                    │                │
  │──────────────────────────────────▶│ create share (uploading)           │                │
  │◀──────────────────────────────────│ per file: a signed URL, or (>8 MB) │                │
  │                                   │ a multipart upload: part layout    │                │
  │ POST .../uploads/:file/parts ────▶│ signed URLs for a batch of parts   │                │
  │ PUT each part, 4 in parallel, retried with backoff ───────────────────▶│                │
  │   (paused / offline / reloaded? POST .../resume says what's stored)    │                │
  │ POST /api/shares/:code/complete ─▶│ join the parts, check sizes ──────▶│                │
  │                                   │ read the first bytes, detect the real type,         │
  │                                   │ refuse executables                 │                │
  │◀── "processing" ──────────────────│ publish share.uploaded ────────────────────────────▶│ scan (ClamAV),
  │◀── share:ready / share:blocked (live) ─────────────────────────────────────────────────│ thumbnails
```

## Features

**Sharing**
- **8-character codes** (e.g. `7KX9-2PMQ`), share links and **QR codes**; look-alike characters skipped (~850 billion codes)
- Up to 10 files per share, **500 MB each**, drag and drop
- **Resumable uploads**: big files go up in parts; failed parts are retried with exponential backoff, the upload waits out lost connections, can be **paused**, and **resumes after a reload** (pick the same files; only missing parts are sent). Speed and time left are shown
- Expiry (1 hour to 7 days), view limits (once, 5, 10, unlimited), optional password
- **Malware scanning** (ClamAV) before a share goes live; infected shares are blocked and their files deleted. Programs and scripts are refused by extension and by content
- Image **thumbnails**; previews for images, video and audio
- **Live activity** for the sender (opens, downloads, scan results), guests included

**Accounts**
- Sign up, email verification (6-digit code), password reset
- **My shares**: search (names, messages, codes), filters (file type, text only, password), sort, live counts
- **Devices**: every login with browser, OS and network; log out one device, all others, or everywhere; email and in-app alert on a **login from a new device**

**Notifications**
- Downloads, expired / used-up / removed shares, malware blocks, new-device logins, a **weekly summary**
- Per-event choice of channels: **in-app** (bell with live unread count), **email** (one-click unsubscribe), **browser push** (Web Push, works with the site closed)

**Analytics** (without tracking anyone)
- Views, **unique visitors**, downloads and bandwidth per day; 7 / 30 / 90 days vs the period before; file types; most active shares; per-share activity; site-wide analytics for admins
- Unique visitors are counted with a **HyperLogLog** sketch from a daily-rotating keyed hash: no IP address is stored, nothing identifies anyone

**Administration** (role-based: user / admin / superadmin)
- Site stats and analytics; user search; disable accounts; log a user out everywhere
- Share moderation by code (metadata only, never content)
- **Background jobs**: queue depths, dead letters with their errors, replay or delete, circuit breaker states
- Admins manage regular users; only superadmins change roles and manage admins; superadmins are changed only from the command line

## Security

- **Sessions**: 15-minute JWT access token + rotating 30-day refresh token, `httpOnly` and `SameSite=Strict`. Each login is a **session record checked on every request**, so logging a device out takes effect immediately. Refresh-token reuse logs that session out
- **Passwords** hashed with **scrypt** (OWASP-equivalent parameters) on Node's thread pool, with bounded concurrency; older bcrypt hashes are upgraded on login
- **RBAC**: routes ask for permissions (`authorize("users.disable")`), roles map to permissions in one place
- **CSRF**: `SameSite=Strict` plus an `Origin` check; **CORS** checked on every WebSocket too
- **Validation**: Zod on every request body; uploads are size- and type-signed, re-checked after upload, and detected from their contents
- **Files**: random storage keys; executables and scripts refused; ClamAV scan (fail closed: while the scanner is down, shares wait); HTML/SVG/etc. never rendered; strict CSP
- **Rate limits** per IP and **brute-force lockouts** per account and per share, in Redis
- Signed, expiring tokens for downloads, uploads, realtime and unsubscribe links; secrets and personal data redacted from logs
- CI: **CodeQL**, **npm audit**, **Trivy** image scan, Dependabot

## Reliability and operations

- **At-least-once delivery, idempotent consumers**: each job runs once per message ID; delivery steps (in-app, email, push) are individually idempotent
- **Retries with backoff and dead-lettering**; **circuit breakers** (with timeouts) around email, ClamAV and Web Push; breaker states shared across processes
- **Self-healing sweeps**: lost deletions and scans are re-queued; orphaned files and abandoned multipart uploads removed
- **Lifecycle**: `active → ended → files pending deletion → deleted`, with soft-deleted history kept 30 days
- **Metrics** (Prometheus): request rate, error rate and latency per route pattern; queue depth (ready, retrying, dead); job outcomes and durations; breaker states; Redis hit rate; realtime connections; Node.js runtime. Served on internal ports only
- **Grafana dashboard** and **10 alert rules** (target down, error rate, p95 latency, dead letters, backlog, job failures, open circuits, broker or Redis down, event loop lag), validated in CI
- **Structured logs** (Pino) with request IDs; `/healthz` reports MongoDB, Redis, storage, queue, scanner and the running commit
- **Graceful shutdown** of the API and workers

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, React Hook Form, Zod, Socket.IO client, service worker (Web Push) |
| Backend | Node.js 24, Express 5, Socket.IO, Zod, JWT, AWS SDK v3 (S3), amqplib, sharp, web-push, prom-client |
| Data | MongoDB (Mongoose); Redis |
| Messaging | RabbitMQ (topic exchange, TTL retry queues, DLQs); in-process fallback |
| Storage | MinIO locally; any S3-compatible service in production |
| Security scanning | ClamAV (clamd) |
| Observability | Pino, Prometheus, Alertmanager, Grafana |
| Testing | Jest, Supertest, mongodb-memory-server; Vitest, Testing Library; Playwright, axe-core; k6 |
| CI/CD | GitHub Actions, GHCR, Trivy, CodeQL, Dependabot; Render (API, worker, Key Value) + Vercel (frontend) |

## Running locally

One `npm install` at the root installs both workspaces (`client/`, `server/`).

### With Docker (everything)

```bash
docker compose up --build                          # app, worker, MongoDB, Redis, RabbitMQ, MinIO, ClamAV
docker compose --profile monitoring up --build     # ... plus Prometheus, Alertmanager, Grafana
docker compose up --scale worker=3                 # more workers
```

| Service | URL |
| --- | --- |
| App | http://localhost:8080 |
| MinIO S3 API / console | http://localhost:9000 / http://localhost:9001 (`sendretrieve` / `sendretrieve-dev-secret`) |
| RabbitMQ console | http://localhost:15672 (same credentials) |
| Grafana / Prometheus / Alertmanager | http://localhost:3000 (`admin` / `sendretrieve-dev-secret`) / :9090 / :9093 |

ClamAV needs ~1.5 GB of RAM and a few minutes to download signatures on first start; file shares wait in "processing" until it's ready. MinIO is built from source (no free images anymore). Emails are written to `docker compose logs worker` unless `RESEND_API_KEY` is set. For browser notifications, generate keys with `npm run vapid-keys -w server` and put them in a `.env` next to `docker-compose.yml`.

### With Node (development)

```bash
npm install
cp server/.env.example server/.env   # then edit
npm run dev                          # React on :5173 (open this), API on :8080
```

The API needs MongoDB. Everything else is optional: without Redis, state is in memory; without RabbitMQ, jobs run in-process; without ClamAV, files aren't scanned; files are on disk unless the `S3_*` variables are set.

### The first superadmin

```bash
npm run set-role -w server -- you@example.com superadmin
docker compose exec app node scripts/set-role.js you@example.com superadmin
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and React dev servers |
| `npm run build` / `npm start` | Build the React app / start the API (serving it) |
| `npm run worker -w server` | The background worker (with RabbitMQ) |
| `npm test` | Server and client test suites |
| `npm run test:e2e` | Playwright end-to-end tests (after `npm run build`) |
| `npm run lint` / `npm run typecheck` | ESLint for both workspaces / TypeScript |
| `npm run vapid-keys -w server` | A key pair for browser notifications |

## Testing

| Suite | What it covers |
| --- | --- |
| Server (Jest, ~290 tests) | API, storage drivers, queues and workers (retries, DLQ, idempotency), sessions, RBAC, notifications, analytics (incl. HyperLogLog accuracy), metrics; in-memory MongoDB. Integration suites against real Redis, MinIO, RabbitMQ and ClamAV run when `TEST_REDIS_URL`, `TEST_S3_ENDPOINT`, `TEST_AMQP_URL`, `TEST_CLAMAV_HOST` are set |
| Client (Vitest, ~90 tests) | Pages and flows with a mocked API and socket: uploads (resume, retry, offline), notifications, devices, analytics charts, admin |
| End-to-end (Playwright, 28 tests) | Real browsers against the real app (in-memory MongoDB, no Docker): sharing, passwords, a resumable upload paused and reloaded mid-way, devices, live notifications, analytics, admin, and **axe-core accessibility scans** of every page in both themes |
| Load (k6) | Browse / open / create / login at fixed arrival rates; p50/p95/p99, throughput, error rate. See **[docs/load-testing.md](docs/load-testing.md)**: the first run found password hashing blocking the event loop; after the fix, p95 went from 5.6 s to 24 ms |

```bash
npm test
npm run build && npm run test:e2e                     # PW_CHANNEL=msedge to use an installed browser
docker run --rm --network sendretrieve_default -v "$PWD/load:/scripts" \
  -e BASE_URL=http://app:8080 grafana/k6:0.57.0 run /scripts/sendretrieve.js   # with RATE_LIMITS=off
```

## CI/CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every push and PR | lint + typecheck; server tests with Redis and RabbitMQ service containers; client tests; Playwright E2E and a k6 smoke run; Docker build, Trivy scan, image smoke test, push to GHCR from the main branch; npm audit; Prometheus/Alertmanager config checks |
| `deploy.yml` | after CI passes | `develop` → **dev**, `master` → **staging**, a published release → **production** (or manual). Triggers Render deploy hooks for the API and worker (and Vercel's, if set), waits until `/healthz` reports the new commit, then smoke-tests the live site |
| `codeql.yml` | pushes, PRs, weekly | CodeQL security analysis |

Each GitHub **environment** (`dev`, `staging`, `production`) has its own `RENDER_API_DEPLOY_HOOK`, `RENDER_WORKER_DEPLOY_HOOK`, optional `VERCEL_DEPLOY_HOOK` secrets and an `APP_URL` variable. Protect `production` with required reviewers.

## Deploying

```
Vercel    React app; rewrites /api/* to Render (same-origin cookies)
Render    API (web) + worker (background worker) from the same image, Key Value (Redis)
MongoDB   e.g. MongoDB Atlas          Storage   Cloudflare R2, AWS S3 or MinIO
RabbitMQ  e.g. CloudAMQP              ClamAV    optional Render private service
```

1. **MongoDB** (e.g. Atlas): copy the connection string.
2. **Object storage** (e.g. R2): a bucket, an API token, and CORS allowing `PUT`, `GET`, `HEAD` from your Vercel URL. Add a lifecycle rule to abort incomplete multipart uploads after a day or two.
3. **RabbitMQ** (e.g. CloudAMQP): copy the AMQP URL. Optional: without it, leave out the worker and the API runs the jobs.
4. **Render**: New → Blueprint → this repository. `render.yaml` creates the API, the worker and Key Value; fill in the `sync: false` values (shared ones are in the `sendretrieve-shared` env group). Copy each service's deploy hook into the GitHub environments.
5. **Vercel**: import the repo with Root Directory `client`; set `VITE_REALTIME_URL` to the Render API URL (and update `client/vercel.json`'s rewrites if its URL differs).
6. Make the first superadmin from the Render shell: `node scripts/set-role.js you@example.com superadmin`.

A **single service** also works (the API image serves the React app): Render or Railway (`railway.json`), no Vercel.

### Environment variables

Server: `server/.env` (see [`server/.env.example`](server/.env.example)) or the host's settings.

| Variable | Description |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string |
| `TOKEN_SECRET` | Long random string: signs sessions and links. **Required in production**; the same for the API and workers |
| `APP_URL`, `CORS_ORIGINS` | The public URL (frontend's, if separate); extra allowed origins |
| `STORAGE_DRIVER`, `S3_*` | Object storage (`s3` or `disk`); endpoint, region, bucket, keys, public endpoint |
| `UPLOAD_PART_SIZE_MB`, `MAX_FILE_SIZE_MB` | Multipart part size (default 8) and file size limit (default 500 with S3) |
| `REDIS_URL` | Rate limits, lockouts, codes, locks, live-event relay (else memory) |
| `AMQP_URL`, `RUN_WORKERS`, `QUEUE_RETRY_DELAYS_MS` | RabbitMQ; run workers in the API anyway; retry delays |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | Malware scanning (off without a host) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email delivery |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Browser notifications (off without keys) |
| `METRICS_PORT` | Internal Prometheus port (API 9091, worker 9092; `0` = off). Never expose it |
| `TRUST_PROXY` | Proxies in front: 2 behind Vercel + Render, 1 for a single service |
| `RATE_LIMITS=off` | Load and end-to-end tests only |
| `LOG_LEVEL`, `LOG_FORMAT`, `BLOCK_EXECUTABLES`, `UPLOAD_DIR`, `CLIENT_DIR`, `PORT` | Optional |

Client (build time): `VITE_REALTIME_URL`, the API origin for live updates when the frontend is hosted separately.

## API

Errors are JSON: `{ "error": "message", "field"?: "..." }`. An expired session returns `401` with `"code": "token_expired"` (refresh and retry); `429` includes `Retry-After`; `500` includes `requestId`.

**Service**: `GET /healthz` (status of each dependency, running commit) · `GET /api/config` (limits for the frontend)

**Shares**

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/shares` | `{ text?, expiresIn, maxViews, password?, files: [{ name, size, type }] }` → code, `manageToken`, per file a signed URL or a multipart part layout |
| `POST` | `/api/shares/:code/uploads/:fileId/parts` | `{ manageToken, partNumbers }` → signed URLs for those parts |
| `POST` | `/api/shares/:code/resume` | `{ manageToken }` → what's stored, fresh URLs for the rest |
| `POST` | `/api/shares/:code/complete` | `{ manageToken }` → `ready` or `processing` (being scanned). Idempotent |
| `POST` | `/api/shares/:code/cancel` | `{ manageToken }`: abandon an upload |
| `POST` | `/api/shares/:code/open` | `{ password? }`: one view; text and signed file links |
| `GET` | `/api/files/:token` | Download (redirect to storage); `?inline=1` preview, `?thumb=1` thumbnail |

**Auth**: `POST /api/auth/register` · `login` · `refresh` · `logout` · `GET /api/auth/me` (role, permissions) · `POST /api/auth/verify-email/send` · `verify-email` · `forgot-password` · `reset-password` · `GET /api/auth/realtime-token`

**Account** (signed in)

| Method | Path | Description |
| --- | --- | --- |
| `PATCH` / `DELETE` | `/api/me` | Update name / delete the account and everything in it |
| `POST` | `/api/me/password` | Change password (other devices are logged out) |
| `GET` | `/api/me/shares?status=&q=&kind=&fileType=&protected=&sort=&page=` | Your shares: search, filters, sort; counts per tab |
| `GET` / `DELETE` | `/api/me/shares/:code` | One share's content (no view used) / delete it |
| `GET` | `/api/me/sessions` | Where you're logged in |
| `DELETE` | `/api/me/sessions/:id` | Log one device out |
| `POST` | `/api/me/sessions/revoke-others` / `revoke-all` | Log out other devices / everywhere |
| `GET` | `/api/me/analytics?days=7\|30\|90` | Totals vs previous period, daily series, file types, top shares |
| `GET` | `/api/me/analytics/shares/:code?days=` | One share's activity |
| `GET` / `POST` | `/api/notifications` / `/api/notifications/read` | In-app notifications / mark read (`{ ids }` or `{ all: true }`) |
| `GET` / `PUT` | `/api/notifications/preferences` | Channels per event |
| `POST` / `DELETE` | `/api/notifications/push-subscriptions` | Turn browser notifications on / off for this browser |
| `POST` | `/api/notifications/unsubscribe` | `{ token }` from an email (no login; also RFC 8058 one-click) |

**Admin** (by permission)

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/admin/stats`, `/api/admin/analytics?days=` | `admin.access` |
| `GET` | `/api/admin/users?search=&page=` | `users.read` |
| `PATCH` | `/api/admin/users/:id` `{ role?, disabled? }` | `users.disable` (roles: `users.roles`) |
| `POST` | `/api/admin/users/:id/logout` | `users.logout` |
| `GET` / `DELETE` | `/api/admin/shares/:code` | `shares.moderate` |
| `GET` | `/api/admin/queues`, `/api/admin/queues/:queue/dead-letters` | `queues.read` |
| `POST` | `/api/admin/queues/:queue/dead-letters/replay` | `queues.replay` |
| `DELETE` | `/api/admin/queues/:queue/dead-letters` | `queues.purge` |

**Live events** (Socket.IO): signed-in users connect with `auth: { token }` from `/api/auth/realtime-token`; anyone can `share:watch` `{ code, manageToken }` (the ack includes the share's current state). Events: `share:created`, `share:opened`, `file:downloaded`, `share:ended`, `share:ready`, `share:blocked`, `notification`, `notifications:read`.

## Project structure

```
package.json            npm workspaces; scripts for both halves, E2E, lint
Dockerfile              One image: builds the React app; runs the API (or `node worker.js`)
docker-compose.yml      App, worker, MongoDB, Redis, RabbitMQ, MinIO, ClamAV; monitoring profile
docker/                 MinIO (built from source), ClamAV config, Prometheus/Alertmanager/Grafana
render.yaml             Render: API, worker, Key Value          railway.json   single service
.github/                CI, deploy, CodeQL workflows; Dependabot
e2e/                    Playwright: test server (in-memory MongoDB) and specs
load/                   k6 load test                            docs/          load testing report

client/src/             React app
  pages/                Send, Retrieve, My shares, Analytics, Account, Admin, auth pages, Unsubscribe
  components/           Layout, upload panel, charts, notification bell & settings, background jobs, ui/
  hooks/                session, uploads, realtime, notifications
  lib/                  API client, upload engine (multipart, retries, resume), push, analytics, types
client/public/sw.js     Service worker for browser notifications

server/
  server.js, worker.js  API and worker processes (startup, graceful shutdown)
  scripts/              set-role, vapid-keys
  src/
    app.js, config.js
    modules/            Feature modules: routes, schemas, models, services
      auth/             sessions & devices, permissions (RBAC), OTP, tokens
      shares/ files/    shares, uploads (multipart), downloads, my shares (search)
      notifications/    preferences, delivery (in-app/email/push), weekly summary, unsubscribe
      analytics/        daily stats, visitor tokens, HyperLogLog queries
      users/ admin/ realtime/ system/
    workers/            processing, cleanup, notification, analytics workers; scheduler
    infrastructure/     queue (RabbitMQ + in-memory), storage (S3 + disk), Redis, locks, mailer,
                        ClamAV, Web Push, metrics, circuit-breaker status, logger
    shared/             errors, validation, rate limits, circuit breaker, HyperLogLog, passwords
  test/                 Jest suites (unit, API, integration)
```
