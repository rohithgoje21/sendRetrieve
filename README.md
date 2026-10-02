# sendRetrieve

Share text and files temporarily with a short code. Shares delete themselves when they expire. Use it as a guest, or create an account to track and manage what you've shared.

A full-stack **MERN** application: **M**ongoDB, **E**xpress, **R**eact and **N**ode.js, with Redis for rate limiting, in one repository with a `client/` (React) and a `server/` (Express API).

## Features

**Sharing**
- **8-character share codes** (e.g. `7KX9-2PMQ`) and share links (`/s/7KX92PMQ`). Codes skip look-alike characters (0/O, 1/I/L), giving ~850 billion combinations
- **Multiple files** per share, with drag and drop, upload progress and size limits
- **Configurable expiry**: 1 hour, 6 hours, 24 hours, 3 days or 7 days
- **View limits**: unlimited, once, 5 or 10 opens. A one-time share is used up the moment it's opened
- **Optional password**, hashed with bcrypt
- **Previews** for images, video and audio
- **Private downloads**: files are only reachable through signed links that expire after 10 minutes, handed out when someone opens the share
- **Automatic cleanup**: a background job removes expired shares' content and files

**Accounts** (optional; guests can still share)
- Sign up, log in, log out, forgot/reset password by email
- **My shares** dashboard with Active / Expired / Deleted tabs: views, download counts, expiry, and whether a share was used up
- View your own share's content without using up a view; delete a share early
- Expired and deleted shares stay listed (without content or files) for 30 days
- Profile: change name or password, delete account and all its shares

**Frontend**
- React single-page app: client-side routing, code-split pages, light/dark theme
- Server data cached and kept in sync with TanStack Query; expired sessions are refreshed and the request retried
- Forms validated with Zod before they're sent; server errors shown on the field they belong to
- Upload progress with cancel, inline previews, accessible dialogs and keyboard-friendly controls
- Limits and options (file size, expiry choices) come from the server's `/api/config`, so they're defined once

## Security

- **Sessions**: short-lived JWT access token (15 min) and a long-lived refresh token (30 days), both in `httpOnly`, `SameSite=Strict` cookies. Refresh tokens are stored hashed, rotated on every use, and **reuse detection** revokes the whole login if an old token is replayed
- Changing or resetting a password logs out every other session
- Password reset tokens are random, stored hashed, single-use and expire after 30 minutes; the forgot-password endpoint never reveals whether an email has an account
- Login takes the same time for unknown emails as for wrong passwords
- CSRF protection: `SameSite=Strict` cookies plus an `Origin` check on state-changing requests
- **Zod** validation on every request body
- Owners can only see and manage their own shares (other people's return 404)
- **Rate limiting** per IP on sign-up, login, password reset, and creating, opening and downloading shares. Stored in **Redis** when configured, so limits are shared between instances and survive restarts
- **Brute-force lockouts** per target: 10 wrong passwords lock a share, and 10 failed logins lock an account, for 15 minutes, whichever IPs the attempts come from. Unknown emails are counted too, so a lockout doesn't reveal which accounts exist. Keys are hashed, so Redis holds no emails or share IDs
- If Redis goes down, limits fail open and the site keeps working (`/healthz` reports `degraded`)
- Helmet security headers, including a strict Content-Security-Policy
- Files are stored under random names and never served statically. Only known media types are served inline; HTML, SVG and everything else are forced to download

## Operations

- **Structured logging** (Pino): one JSON line per request with method, route, status, duration, user ID and a request ID, plus event logs (`share.created`, `share.opened`, `auth.login_failed`, `auth.refresh_token_reuse`, `rate_limit.exceeded`, ...) tagged with the same request ID. Share codes, tokens, passwords, message text, file names and cookies are never logged
- **Request IDs** in the `X-Request-Id` header and in 500 responses, so a user can quote one and the matching log line can be found
- **Health check** at `/healthz`: `ok`, `degraded` (Redis down), or `503` (MongoDB down or shutting down)
- **Graceful shutdown** on SIGTERM: stop taking new connections, finish in-flight requests, close MongoDB and Redis
- **Docker**: production image (non-root, health check) and a Compose file for the full stack

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, React Hook Form, Zod |
| Backend | Node.js, Express 5, Multer, JSON Web Tokens, Zod |
| Database | MongoDB (Mongoose) |
| Rate limits & lockouts | Redis |
| Logging | Pino |
| Email | Resend |
| Infrastructure | Docker, Docker Compose, Railway |
| Testing | Vitest + Testing Library (client), Jest + Supertest + mongodb-memory-server (server) |

## Running locally

The repo is an npm workspace: one `npm install` at the root installs both `client/` and `server/`.

### With Docker (everything included)

```bash
docker compose up --build
```

Builds the React app and starts it with the API, MongoDB and Redis on http://localhost:8080. Data persists in Docker volumes; `docker compose down -v` wipes it. Settings such as `APP_PORT`, `TOKEN_SECRET` or `RESEND_API_KEY` can go in a `.env` file next to `docker-compose.yml`.

### With Node (for development)

```bash
npm install
cp server/.env.example server/.env   # then edit as needed
npm run dev
```

`npm run dev` starts both halves with live reload:

- **React app** on http://localhost:5173 (Vite, hot module reloading). Open this one
- **API** on http://localhost:8080. Vite forwards `/api` requests to it, so the browser sees a single origin, as in production

The API needs a MongoDB instance (`MONGODB_URI`, default `mongodb://127.0.0.1:27017/sendretrieve`); Redis is optional. Without `RESEND_API_KEY`, password reset emails are written to the log.

### Production build

```bash
npm run build   # builds the React app into client/dist
npm start       # Express serves the API and the built app on :8080
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
npm test   # both suites; the server's runs against an in-memory MongoDB, no setup needed
```

The server's Redis tests run when a Redis is available:

```bash
docker run -d --rm -p 6390:6379 redis:8-alpine
TEST_REDIS_URL=redis://localhost:6390 npm test -w server
```

### Environment variables

Set in `server/.env` (see `server/.env.example`) or the environment.

| Variable | Description |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string |
| `TOKEN_SECRET` | Long random string. Signs sessions and download links; **required in production** |
| `APP_URL` | Public URL, used in emailed links; **required in production** |
| `REDIS_URL` | Optional. Rate limits and lockouts in Redis instead of memory |
| `TRUST_PROXY` | Number of proxies in front of the app (default `1`) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email delivery for password resets |
| `LOG_LEVEL`, `LOG_FORMAT` | Optional. Log level (default `info`); `LOG_FORMAT=json` turns off pretty-printing in a terminal |
| `MAX_FILE_SIZE_MB`, `UPLOAD_DIR`, `CLIENT_DIR`, `PORT` | Optional |

## API

**Health**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | `{ status, mongo, redis, uptimeSeconds }` |
| `GET` | `/api/config` | Limits and options for the frontend (file size, expiry choices, password rules) |

**Shares**

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/shares` | Create a share (multipart: `text`, `files[]`, `expiresIn`, `maxViews`, `password`). Owned by you if logged in |
| `POST` | `/api/shares/:code/open` | Open a share (`{ password }`). Counts as one view. Returns text and signed file links |
| `GET` | `/api/files/:token` | Download a file. Add `?inline=1` to preview images, video and audio |

**Auth**

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | `{ name, email, password }`; starts a session |
| `POST` | `/api/auth/login` | `{ email, password }` |
| `POST` | `/api/auth/refresh` | Rotate the refresh token, issue a new access token |
| `POST` | `/api/auth/logout` | End the session |
| `GET` | `/api/auth/me` | Current user |
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

Errors are JSON: `{ "error": "message", "field"?: "name" }`. An expired session returns `401` with `"code": "token_expired"`; refresh and retry. `429` responses include `Retry-After`; `500` responses include `requestId`.

## Project structure

```
package.json             npm workspaces + scripts to run both halves
Dockerfile               One production image: builds the React app, runs the API that serves it
docker-compose.yml       App + MongoDB + Redis
railway.json             Railway build and health check settings

client/                  React app (Vite + TypeScript)
  index.html
  public/                favicon, theme.js (applies the saved theme before first paint)
  src/
    main.tsx             Entry: providers (theme, TanStack Query) and the router
    routes.tsx           Route table; pages other than home are lazy-loaded
    pages/               Send, Retrieve, Login, Sign up, Forgot/Reset password, My shares, Account, 404
    components/          Layout (header, user menu), route guards, file dropzone, shared content
      ui/                Button, inputs, Field, Card, Alert, Badge, ConfirmDialog, SegmentedControl...
    hooks/               useSession, useConfig, useTheme
    lib/                 API client (session refresh), upload with progress, formatting, types
    test/                Test setup and helpers (fetch mock, app renderer)

server/                  Express API (Node.js + MongoDB)
  server.js              Startup and graceful shutdown: MongoDB, Redis, indexes, cleanup job, HTTP server
  src/
    app.js               Express app: middleware, routers, CSRF check, serving the React build
    config.js            Settings and limits
    models/              Share, User, RefreshToken (Mongoose)
    routes/              shares, auth, me, config, health
    lib/
      auth.js            Sessions: JWT access tokens, rotating refresh tokens, auth middleware
      shares.js          Share lifecycle: serializing, ending, status
      schemas.js         Zod request schemas
      codes.js           Share codes
      tokens.js          Signed download links
      storage.js         File storage
      cleanup.js         Expiry and orphan-file cleanup
      mailer.js          Email (Resend)
      logger.js          Pino logger
      requestLogging.js  Request logs, request IDs, URL redaction
      redis.js           Redis connection
      rateLimit.js       Per-IP rate limits (Redis or memory)
      attempts.js        Per-target brute-force lockouts (Redis or memory)
      ...                validate, errors, urls
  test/                  API tests
```

## Roadmap

- **v3:** object storage with MinIO (S3-compatible): direct browser uploads via presigned URLs, larger files, and files that survive redeploys
