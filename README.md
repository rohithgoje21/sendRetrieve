# sendRetrieve

Share text and files temporarily with a short code. Shares delete themselves when they expire.

## Features

- **8-character share codes** (e.g. `7KX9-2PMQ`) and share links (`/s/7KX92PMQ`). Codes skip look-alike characters (0/O, 1/I/L), giving ~850 billion combinations
- **Multiple files** per share, with drag and drop, upload progress and size limits
- **Configurable expiry**: 1 hour, 6 hours, 24 hours, 3 days or 7 days
- **View limits**: unlimited, once, 5 or 10 opens. A one-time share is used up the moment it's opened
- **Optional password**, hashed with bcrypt
- **Previews** for images, video and audio
- **Private downloads**: files are only reachable through signed links that expire after 10 minutes, handed out when someone opens the share
- **Automatic cleanup**: a background job deletes expired shares and their files from disk

## Security

- Rate limiting on creating, opening and downloading shares
- Helmet security headers, including a strict Content-Security-Policy
- Files are stored under random names and never served statically
- Only known media types are served inline; HTML, SVG and everything else are forced to download, so an uploaded file can't run script on the site
- Wrong passwords don't count against a share's view limit; concurrent opens of a one-time share can't both succeed

## Tech stack

- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js, Express 5, Multer
- **Database:** MongoDB (Mongoose)
- **Testing:** Jest, Supertest, mongodb-memory-server

## Running locally

```bash
npm install
cp .env.example .env   # then edit as needed
npm run dev            # or: npm start
```

The app runs on http://localhost:8080 and needs a MongoDB instance (`MONGODB_URI`).

```bash
npm test               # runs against an in-memory MongoDB, no setup needed
```

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/shares` | Create a share (multipart: `text`, `files[]`, `expiresIn`, `maxViews`, `password`) |
| `POST` | `/api/shares/:code/open` | Open a share (JSON: `{ password }`). Counts as one view. Returns text and signed file links |
| `GET` | `/api/files/:token` | Download a file. Add `?inline=1` to preview images, video and audio |

## Project structure

```
server.js              Startup: connects to MongoDB, starts the cleanup job and the server
src/
  app.js               Express app (middleware, routes, error handling)
  config.js            Settings and limits
  models/Share.js      Share schema
  routes/shares.js     API endpoints
  lib/                 Share codes, signed download tokens, file storage, cleanup
public/                Frontend
test/                  API tests
```
