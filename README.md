# sendRetrieve

Share text and files temporarily with a short code. Shares delete themselves when they expire. Use it as a guest, or create an account to track and manage what you've shared.

A full-stack **MERN** application (**M**ongoDB, **E**xpress, **R**eact, **N**ode.js) with **Redis**, **S3-compatible object storage** (MinIO locally) and **Socket.IO** for live updates, in one repository with a `client/` (React) and a `server/` (Express API).

## Architecture

```
                      Browser (React SPA)
          │ /api (JSON)    │ files (signed URLs)   │ live updates (WebSocket)
          ▼                ▼                       ▼
   ┌─────────────┐   ┌───────────────┐   ┌──────────────────┐
   │ Express API │   │ Object storage│   │ Socket.IO server │  (same Node process
   │  (Node.js)  │──▶│ MinIO / R2 /  │   │                  │   as the API)
   └──────┬──────┘   │ S3 (S3 API)   │   └────────┬─────────┘
          │          └───────────────┘            │
     ┌────┴─────┐                          ┌──────┴──────┐
     ▼          ▼                          ▼             │
 MongoDB      Redis ◀────── pub/sub ───────┘             │
 metadata     rate limits, lockouts, verification codes, │
              events between API instances ◀─────────────┘
```

- **MongoDB** holds metadata: users, shares, file names and sizes, view and download counts. Never file contents.
- **Object storage** holds the files. Browsers upload to it and download from it **directly**, with short-lived signed URLs, so file bytes never pass through the API.
- **Redis** holds short-lived, fast-changing data: rate-limit counters, brute-force lockouts, one-time verification codes, and the pub/sub channel that relays live events between API instances.
- **Socket.IO** pushes events ("your share was opened", "a file was downloaded") to the sender's browser.

### Sending files

```
Browser                         API                          Storage
   │  POST /api/shares             │                              │
   │  {files: [name, size, type]}  │                              │
   │──────────────────────────────▶│ create share (uploading)     │
   │◀──────────────────────────────│ one signed PUT URL per file  │
   │  PUT file (with progress) ─────────────────────────────────▶│ size and type are part
   │◀───────────────────────────────────────────────────────── 200│ of the signature
   │  POST /api/shares/:code/complete                             │
   │──────────────────────────────▶│ check each file arrived ────▶│ HEAD
   │                               │ read its first bytes ───────▶│ range GET
   │                               │ detect the real type, refuse executables
   │◀──────────────────────────────│ share is live                │
```

Downloads go through the API (which checks the password, view limit and expiry), then **redirect** to a signed storage URL that expires with the download window.

## Features

**Sharing**
- **8-character share codes** (e.g. `7KX9-2PMQ`), share links (`/s/7KX92PMQ`) and **QR codes**. Codes skip look-alike characters (0/O, 1/I/L), giving ~850 billion combinations
- **Multiple files** per share, up to **500 MB each**, with drag and drop, upload progress and cancel
- **Configurable expiry**: 1 hour, 6 hours, 24 hours, 3 days or 7 days
- **View limits**: unlimited, once, 5 or 10 opens. A one-time share is used up the moment it's opened
- **Optional password**, hashed with bcrypt
- **Previews** for images, video and audio, shown only when the file's contents confirm its type
- **Live activity**: the sender sees each open and download as it happens. This works for guests too, through the share's private manage token
- **Automatic cleanup**: expired shares, abandoned uploads and orphaned files are removed from storage

**Accounts** (optional; guests can still share)
- Sign up, log in, log out, forgot/reset password by email
- **Email verification** with a 6-digit one-time code
- **My shares** dashboard with Active / Expired / Deleted tabs, views and downloads updated live, and toasts when shares are opened
- View your own share's content without using up a view; delete a share early
- Profile: change name or password, delete account and all its shares

**Administration** (role-based access)
- Site stats: users, active shares, storage used, activity
- Search users, grant or revoke the admin role, disable and re-enable accounts (disabling logs them out everywhere)
- Look up any share by code (metadata only, never content) and take it down; the owner sees "removed by an administrator"

## Security

- **Sessions**: short-lived JWT access token (15 min) and a long-lived refresh token (30 days), both in `httpOnly`, `SameSite=Strict` cookies. Refresh tokens are stored hashed and rotated on every use. **Reuse detection** revokes the whole login if an old token is replayed
- Changing or resetting a password, or an admin disabling an account, logs out every session
- Password reset tokens and verification codes are random, stored hashed, short-lived and single-use; codes allow 5 wrong tries. The forgot-password endpoint never reveals whether an email has an account
- **Role-based access control**: admin endpoints check the role on every request; admins can't demote or disable themselves
- CSRF protection: `SameSite=Strict` cookies plus an `Origin` check on state-changing requests
- **CORS**: the real-time connection only accepts the app's own origin and configured frontend origins (checked on every WebSocket, which CORS alone doesn't cover)
- **Zod** validation on every request body
- **File validation**: each file's real type is detected from its first bytes. Executables (Windows, Linux, macOS binaries) are refused whatever their name. Files claiming to be images, video or audio that don't match are never shown inline. HTML, SVG and everything else are always downloaded, never rendered
- **Signed uploads**: storage itself rejects an upload with a different size or type than announced
- Files are stored under random IDs, never their names, and never served statically
- **Rate limiting** per IP and **brute-force lockouts** per target (10 wrong passwords lock a share, and 10 failed logins lock an account, for 15 minutes, from any IP), stored in Redis. If Redis goes down, limits fail open and the site keeps working
- Helmet security headers, including a strict Content-Security-Policy that allows only the storage origin for media

## Operations

- **Structured logging** (Pino): one JSON line per request (route, status, duration, user, request ID), plus event logs (`share.created`, `share.opened`, `auth.login_failed`, `admin.user_updated`, ...). Share codes, tokens, passwords, message text, file names and cookies are never logged
- **Request IDs** in the `X-Request-Id` header and in 500 responses
- **Health check** at `/healthz`: MongoDB, Redis and storage. `ok`, `degraded` (Redis or storage down), or `503` (MongoDB down or shutting down)
- **Graceful shutdown** on SIGTERM: close sockets, finish in-flight requests, close MongoDB and Redis
- **Docker Compose** for the full stack, including MinIO

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, React Hook Form, Zod, Socket.IO client |
| Backend | Node.js, Express 5, Socket.IO, JSON Web Tokens, Zod, AWS SDK v3 (S3 API) |
| Database | MongoDB (Mongoose) |
| Object storage | MinIO locally; any S3-compatible service in production (Cloudflare R2, AWS S3, self-hosted MinIO) |
| Cache & coordination | Redis: rate limits, lockouts, one-time codes, Socket.IO adapter |
| Email | Resend |
| Logging | Pino |
| Infrastructure | Docker, Docker Compose; Vercel (frontend) + Render (API, Redis) |
| Testing | Vitest + Testing Library (client); Jest + Supertest + mongodb-memory-server (server), with Redis and MinIO integration tests |

## Running locally

The repo is an npm workspace: one `npm install` at the root installs both `client/` and `server/`.

### With Docker (everything included)

```bash
docker compose up --build
```

| Service | URL |
| --- | --- |
| App | http://localhost:8080 |
| MinIO S3 API | http://localhost:9000 (browsers upload here directly) |
| MinIO console | http://localhost:9001 (user `sendretrieve`, password `sendretrieve-dev-secret`) |

MinIO no longer publishes free container images, so Compose builds it from source (`docker/minio/Dockerfile`, pinned commit). The first build takes a few minutes; after that it's cached. Data persists in Docker volumes; `docker compose down -v` wipes it. Emails (verification codes, reset links) appear in `docker compose logs app` unless `RESEND_API_KEY` is set.

### With Node (for development)

```bash
npm install
cp server/.env.example server/.env   # then edit as needed
npm run dev
```

`npm run dev` starts both halves with live reload:

- **React app** on http://localhost:5173 (Vite, hot module reloading). Open this one
- **API** on http://localhost:8080. Vite forwards `/api` and the Socket.IO connection to it, so the browser sees a single origin, as in production

The API needs MongoDB (`MONGODB_URI`). Redis is optional. Files are kept on disk by default; for MinIO, start it with `docker compose up -d minio` and set the `S3_*` variables shown in `server/.env.example`.

### The first admin

```bash
npm run set-role -w server -- you@example.com admin                     # local
docker compose exec app node scripts/set-role.js you@example.com admin  # Docker
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and React dev servers together |
| `npm run dev:server` / `npm run dev:client` | Just one of them |
| `npm run build` | Production build of the React app |
| `npm start` | Start the API (serving the built app) |
| `npm test` | Server and client test suites |
| `npm run lint` | Lint the client |

### Tests

```bash
npm test   # both suites; the server's runs against an in-memory MongoDB and disk storage
```

The Redis and S3 integration tests run when those services are available:

```bash
docker compose up -d redis minio   # or any Redis / S3-compatible service
docker run -d --rm -p 6390:6379 redis:8-alpine
TEST_REDIS_URL=redis://localhost:6390 TEST_S3_ENDPOINT=http://localhost:9000 npm test -w server
```

## Deploying

The production setup splits the app across three services:

```
Vercel   React app; rewrites /api/* to Render (same-origin cookies, no CORS needed for the API)
Render   API (Docker) + Key Value (Redis); the browser opens the Socket.IO connection to it directly
Storage  Any S3-compatible service: Cloudflare R2 (free tier), AWS S3, or MinIO on Render
MongoDB  e.g. MongoDB Atlas (free tier)
```

1. **MongoDB**: create a database (e.g. MongoDB Atlas) and copy its connection string.
2. **Object storage**, e.g. Cloudflare R2:
   - Create a bucket and an API token with read/write access to it.
   - In the bucket's CORS settings, allow `PUT`, `GET` and `HEAD` from your Vercel URL, with any headers.
   - Note the endpoint, `https://<account-id>.r2.cloudflarestorage.com`; the region is `auto`.

   With AWS S3 or another service that supports the S3 CORS API, the server sets the CORS rule itself at startup.
3. **Render**: New → Blueprint → this repository. `render.yaml` creates the API (Docker) and a Key Value (Redis) instance. Enter the values marked "sync: false":
   - `MONGODB_URI`
   - `APP_URL`: your Vercel URL
   - `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
   - `RESEND_API_KEY` and `EMAIL_FROM`, optional

   `TOKEN_SECRET` is generated for you.
4. **Vercel**: import the repository and set the **Root Directory** to `client`.
   - Set `VITE_REALTIME_URL` to the Render URL, e.g. `https://sendretrieve-api.onrender.com`.
   - If your Render service has a different URL, update the two rewrites in `client/vercel.json`.
5. Create the first admin from the Render shell: `node scripts/set-role.js you@example.com admin`.

The API image also serves the React app, so a **single service** works as well (Render or Railway, using `railway.json`): no Vercel, and leave `VITE_REALTIME_URL` unset.

### Environment variables

Server: `server/.env` (see `server/.env.example`) or the host's settings.

| Variable | Description |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string |
| `TOKEN_SECRET` | Long random string. Signs sessions and links; **required in production** |
| `APP_URL` | The site's public URL (the frontend's, if hosted separately); **required in production** |
| `CORS_ORIGINS` | Extra frontend origins allowed to connect, comma-separated (e.g. preview deployments) |
| `STORAGE_DRIVER` | `s3` or `disk` (default: `s3` if `S3_BUCKET` is set) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Object storage. Leave out `S3_ENDPOINT` for AWS |
| `S3_PUBLIC_ENDPOINT` | Storage address for browsers, if it differs from the server's (Docker) |
| `S3_FORCE_PATH_STYLE`, `S3_CREATE_BUCKET` | Path-style URLs (default `true`); create the bucket if missing |
| `REDIS_URL` | Optional. Rate limits, lockouts, codes and live-event relay in Redis instead of memory |
| `TRUST_PROXY` | Proxies in front of the API: 2 behind Vercel + Render, 1 for a single service |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email delivery (reset links, verification codes) |
| `MAX_FILE_SIZE_MB`, `BLOCK_EXECUTABLES` | Upload limits and policy (defaults: 500 MB with S3, executables blocked) |
| `LOG_LEVEL`, `LOG_FORMAT`, `UPLOAD_DIR`, `CLIENT_DIR`, `PORT` | Optional |

Client (build time): `VITE_REALTIME_URL`, the API's origin for live updates when the frontend is hosted separately.

## API

**Service**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | `{ status, mongo, redis, storage, uptimeSeconds }` |
| `GET` | `/api/config` | Limits and options for the frontend |

**Shares**

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/shares` | `{ text?, expiresIn, maxViews, password?, files: [{ name, size, type }] }`. Returns the code, a `manageToken`, and a signed upload URL per file |
| `PUT` | *upload URL* | The file's bytes, straight to storage (or `/api/uploads/:token` with disk storage) |
| `POST` | `/api/shares/:code/complete` | `{ manageToken }`. Verifies the uploads and makes the share live |
| `POST` | `/api/shares/:code/cancel` | `{ manageToken }`. Abandons an upload and deletes its files |
| `POST` | `/api/shares/:code/open` | `{ password? }`. Counts as one view; returns text and signed file links |
| `GET` | `/api/files/:token` | Download (redirects to storage). Add `?inline=1` to preview media |

**Auth**

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | `{ name, email, password }`; starts a session and emails a verification code |
| `POST` | `/api/auth/login` | `{ email, password }` |
| `POST` | `/api/auth/refresh` | Rotate the refresh token, issue a new access token |
| `POST` | `/api/auth/logout` | End the session |
| `GET` | `/api/auth/me` | Current user (with `role` and `emailVerified`) |
| `POST` | `/api/auth/verify-email/send` | Email a new code (once a minute) |
| `POST` | `/api/auth/verify-email` | `{ code }` |
| `GET` | `/api/auth/realtime-token` | Short-lived token for the Socket.IO connection |
| `POST` | `/api/auth/forgot-password` | `{ email }`; emails a reset link |
| `POST` | `/api/auth/reset-password` | `{ token, password }` |

**Account** (logged in)

| Method | Path | Description |
| --- | --- | --- |
| `PATCH` | `/api/me` | `{ name }` |
| `POST` | `/api/me/password` | `{ currentPassword, newPassword }`; logs out other sessions |
| `DELETE` | `/api/me` | `{ password }`; deletes the account and all its shares |
| `GET` | `/api/me/shares?status=active\|expired\|deleted&page=1` | Your shares, with counts per status |
| `GET` | `/api/me/shares/:code` | One share, with content and download links; doesn't use a view |
| `DELETE` | `/api/me/shares/:code` | Active: stop it now. Ended: remove it from the list |

**Admin** (admin role)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/admin/stats` | Users, shares, storage and activity totals |
| `GET` | `/api/admin/users?search=&page=` | Users with their active share counts |
| `PATCH` | `/api/admin/users/:id` | `{ role?, disabled? }` |
| `GET` | `/api/admin/shares/:code` | A share's metadata and owner |
| `DELETE` | `/api/admin/shares/:code` | Take a share down |

**Live events** (Socket.IO). Signed-in users connect with `auth: { token }` from `/api/auth/realtime-token` and receive events for all their shares. Anyone can emit `share:watch` with `{ code, manageToken }` to follow one share. Events: `share:created`, `share:opened` (`views`, `maxViews`), `file:downloaded` (`fileName`, `downloads`), `share:ended` (`reason`).

Errors are JSON: `{ "error": "message", "field"?: "name" }`. An expired session returns `401` with `"code": "token_expired"`; refresh and retry. `429` responses include `Retry-After`; `500` responses include `requestId`.

## Project structure

```
package.json             npm workspaces + scripts to run both halves
Dockerfile               One production image: builds the React app, runs the API that serves it
docker-compose.yml       App + MongoDB + Redis + MinIO
docker/minio/            MinIO built from source
render.yaml              Render Blueprint: API + Key Value (Redis)
railway.json             Single-service deploy on Railway

client/                  React app (Vite + TypeScript)
  vercel.json            Vercel: /api rewrite to Render, security headers
  src/
    main.tsx, routes.tsx Entry and route table (pages other than home are lazy-loaded)
    pages/               Send, Retrieve, Login, Sign up, Verify email, Forgot/Reset password,
                         My shares, Account, Admin, 404
    components/          Layout, route guards, dropzone, QR code, live activity, shared content
      ui/                Button, inputs, Field, Card, Alert, Badge, Modal, ConfirmDialog...
    hooks/               useSession, useConfig, useTheme, useRealtime
    lib/                 API client, upload flow, Socket.IO client, formatting, types
    test/                Test setup and helpers (fetch mock, fake socket, app renderer)

server/                  Express API (Node.js + MongoDB)
  server.js              Startup and graceful shutdown
  scripts/set-role.js    Grant a role (e.g. the first admin)
  src/
    app.js               Express app: middleware, routers, CSRF check, CSP, serving the React build
    realtime.js          Socket.IO: rooms, share watching, Redis adapter
    config.js            Settings and limits
    models/              Share, User, RefreshToken (Mongoose)
    routes/              shares, uploads, auth, me, admin, config, health
    lib/
      storage/           Storage drivers: s3 (MinIO/R2/S3) and disk
      fileType.js        File type detection from contents
      auth.js            Sessions, roles, realtime and manage tokens
      otp.js, kv.js      One-time codes on a Redis (or memory) key-value store
      shares.js          Share lifecycle: serializing, ending, discarding
      cleanup.js         Expiry, abandoned uploads and orphaned files
      ...                tokens, schemas, rateLimit, attempts, logger, mailer, redis, errors
  test/                  API, storage, real-time, admin and verification tests
```
