# Cue (Calendar Auto Add)

Web app that extracts events from **typed text**, **Gmail** (OAuth + review queue), and **event photos** (OCR), then saves them to **Apple Calendar** (macOS) or **Google Calendar** (anywhere), and keeps a **per-user Events** log on the server.

## Run

```bash
npm install
npm start
```

Open: `http://localhost:3030` (default port **3030**).

For development with auto-reload:

```bash
npm run dev
```

### Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port. `npm start` / `npm run dev` **pin `3030`** (macOS/Linux) so Google OAuth matches `http://localhost:3030/...`. Override only if you add that redirect in Google Cloud. |
| `CUE_DATA_DIR` | Folder for persisted data (default `./data`). Use a mounted volume on a server. |
| `PUBLIC_BASE_URL` | Full origin for Gmail + Google Calendar token refresh (e.g. `https://your.domain`). **Required** on a public host. |
| `TRUST_PROXY` | Set to `1` behind an HTTPS reverse proxy so OAuth uses `https://`. |
| `SESSION_SECRET` | **Required when `NODE_ENV=production`** — long random string for session cookies. |
| `COOKIE_SECURE` | Set to `1` when the site is HTTPS-only (sets the `Secure` cookie flag). |
| `ADMIN_SETUP_SECRET` | In production (or whenever set), required to call `POST /api/gmail/config` (header `x-cue-admin-secret`). |
| `TOKEN_ENCRYPTION_KEY` | Optional: base64, **32 raw bytes** after decoding — encrypts per-user OAuth token files at rest. |
| `API_RATE_LIMIT_MAX` | Requests per IP per 15 minutes for authenticated API routes (default `300`). |

## Who can see what (multi-user)

- **Cue sign-in**: each person picks a **username and password** (password stored as **scrypt** in `data/cue_accounts.json`). The **httpOnly session cookie** (`cue.sid`) maps to a stable id `c` + 32 hex; **Events** and inbox queue files live under `data/users/<that id>/`. There is **no anonymous “try before sign-in”** API: adding events, the activity API, and Inbox all require a signed-in session.
- **Google (Inbox tab only)**: **Connect Google** links Gmail + Calendar OAuth tokens to the **same** Cue user folder. There is **no shared app-wide Gmail**. Older installs may still have legacy sessions keyed only by Google’s numeric `sub` under `data/users/<sub>/`.

## Where data lives (persistence)

The app reads/writes through a tiny KV layer (`src/kvStore.js`). When `REDIS_URL` is set (required on Vercel — see below) every JSON blob below lives in Redis under the listed key. On Fly with a mounted disk, or local dev, the same data is stored as files under `CUE_DATA_DIR` (default `./data`).

| File path (disk fallback) | Redis key (when `REDIS_URL` is set) | What it stores |
|---|---|---|
| `data/cue_accounts.json` | `cue:kv:accounts` | Username → id + password hash. |
| `data/gmail_credentials.json` | `cue:kv:gmail:credentials` | OAuth **client** id/secret (one per deployment; not end-user tokens). |
| `data/gmail_oauth_state.json` | `cue:kv:gmail:oauth_state` | Short-lived PKCE OAuth state. |
| `data/sessions/` | `cue:sess:<sid>` | Express session blobs (session id only; no Gmail content). |
| `data/users/<userId>/gmail_tokens.json` | `cue:kv:user:<userId>:gmail_tokens` | That user’s Gmail/Calendar OAuth tokens (optional encryption — see below). |
| `data/users/<userId>/events.json` | `cue:kv:user:<userId>:events` | That user’s saved Events log. |
| `data/users/<userId>/review_queue.json` | `cue:kv:user:<userId>:review_queue` | That user’s Gmail suggestions, rules, polling settings. |

Your **events** and inbox queue follow your account: after you sign in from any browser or phone, the app loads that user’s data from Redis (Vercel) or the same disk (Fly/Docker).

> **Vercel users:** you **must** set `REDIS_URL` (Upstash works on the free tier). Without it, `/tmp` is the only writable path, and Vercel wipes `/tmp` on every cold start — meaning new accounts disappear and sign-in fails with “account doesn’t exist.” The app logs a loud warning at boot if it detects this misconfiguration. See `vercel-deploy-notes.txt`.

**Hosted deploy:** see **[docs/DEPLOY.md](docs/DEPLOY.md)**. On Linux hosts, use **Google Calendar** only; Apple Calendar requires the server on a Mac.

**Reconnect Gmail** after upgrades if OAuth scopes change (Gmail + Calendar).

## Security (operational)

- **HTTPS in production** — set `TRUST_PROXY=1` and `COOKIE_SECURE=1` behind TLS termination.
- **`SESSION_SECRET`** — rotate if leaked; invalidates existing sessions.
- **Disk access** — anyone with read access to `CUE_DATA_DIR` can read tokens (unless `TOKEN_ENCRYPTION_KEY` is set) and user JSON. Restrict filesystem permissions and backups.
- **`TOKEN_ENCRYPTION_KEY`** — protects token **files at rest** on disk; the running process can still decrypt to call Google (defense in depth, not a substitute for host security).
- **Admin endpoint** — `POST /api/gmail/config` is gated by `ADMIN_SETUP_SECRET` in production so strangers cannot replace your OAuth client.
- **Rate limits** — `express-rate-limit` on API routes; stricter limit on `GET /api/gmail/auth-url`.
- **Helmet** — security headers enabled (CSP left off for the simple static UI).

This app is **not** a Google security audit replacement: you are hosting sensitive mail-derived data; use a trusted host, monitoring, and least-privilege access.

## Features (short)

- Natural language and OCR event extraction
- Per-user Gmail connect, inbox scan, approve/reject with confidence and reasons
- Share: Google Calendar link, `.ics`, WhatsApp / copy / system share
- Quick updates: e.g. `need to buy shoes for p's bday` appends to a matching upcoming Apple event

## Google (Gmail + Calendar) setup

1. Google Cloud Console → enable **Gmail API** and **Google Calendar API**.
2. OAuth client (Web application). Redirect URIs:
   - Local: `http://localhost:3030/api/gmail/oauth/callback`
   - Production: `https://YOUR_DOMAIN/api/gmail/oauth/callback`
3. Register the client on the server: `data/gmail_credentials.json`, or **one-time** `POST /api/gmail/config` with `ADMIN_SETUP_SECRET` in production.
4. Users click **Connect Gmail** (grants inbox read, calendar list, create events). If scopes change, each user connects again.
5. Choose **Google Calendar** or **Apple Calendar** in the header dropdown for new events.

## Docs

- **[docs/DEPLOY.md](docs/DEPLOY.md)** — public URL, env vars, Docker.
- **[docs/SESSION_LOG.md](docs/SESSION_LOG.md)** — architecture, file map, and bug-fix history.
- **[docs/NATIVE_FUTURE.md](docs/NATIVE_FUTURE.md)** — optional menu bar / share-extension direction; web drag-and-paste for images is already in the Add tab.

## Notes

- First Apple Calendar write may prompt macOS for Calendar access for Terminal/Node.
- OCR quality depends on image clarity; see `SESSION_LOG` for poster-specific corrections.
- UI is styled in the spirit of the [Airtable Apps UI Kit](https://www.figma.com/community/file/862805330899066752/airtable-apps-ui-kit) (DM Sans, yellow primary actions, soft gray canvas). Not affiliated with Airtable.
