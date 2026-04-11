# Deploy Cue with a public URL

Cue is a **Node.js web app**. **Google Calendar** and **Gmail** work on any host. **Apple Calendar** (Calendar.app) only works when the server runs on **your Mac**; on Linux/Docker use **Google Calendar** in the header dropdown.

## 1. Google Cloud

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → enable **Gmail API** and **Google Calendar API**.
2. OAuth client type **Web application**.
3. **Authorized redirect URIs** (add both if you use local + production):
   - `https://YOUR_DOMAIN/api/gmail/oauth/callback`
   - `http://localhost:3030/api/gmail/oauth/callback` (optional, for local testing)
4. Put `clientId` (and `clientSecret` if you use confidential client) in `data/gmail_credentials.json` on the server, or use `POST /api/gmail/config` once.

After changing OAuth scopes, users must **Connect Gmail** again to grant Calendar access.

## 2. Environment variables

| Variable | When |
|----------|------|
| `PORT` | Listen port (default `3030`). |
| `PUBLIC_BASE_URL` | **Required** on a public host: `https://YOUR_DOMAIN` (no trailing slash). Used for Gmail token refresh and Google Calendar API auth. |
| `CUE_DATA_DIR` | Persistent disk path for per-user data under `users/`, sessions, credentials (default `./data`). |
| `TRUST_PROXY` | Set to `1` when behind HTTPS reverse proxy (Fly, Railway, Render) so OAuth redirect URLs use `https`. |
| `SESSION_SECRET` | **Required in production** — long random string for signing session cookies. |
| `COOKIE_SECURE` | Set to `1` when the app is only served over HTTPS (recommended in production). |
| `ADMIN_SETUP_SECRET` | Protects `POST /api/gmail/config` in production; send header `x-cue-admin-secret`. |
| `TOKEN_ENCRYPTION_KEY` | Optional: base64-encoded **32-byte** key; encrypts per-user OAuth token files at rest (prefix `cue1:`). |
| `API_RATE_LIMIT_MAX` | Max API requests per IP per 15 minutes (default `300`). |

## 3. Example: Fly.io

Sessions and per-user files must share the **same persistent directory** (`CUE_DATA_DIR`, e.g. `/data` on the volume). Otherwise each deploy gets a new session store on ephemeral disk and you appear “logged out” with empty data even though JSON under `/data/users/` still exists.

```bash
fly launch --no-deploy   # create app
fly volumes create cue_data --size 1
# Mount volume at /data in fly.toml [[mounts]] destination = "/data"
fly secrets set PUBLIC_BASE_URL=https://your-app.fly.dev TRUST_PROXY=1 CUE_DATA_DIR=/data SESSION_SECRET="$(openssl rand -hex 32)" COOKIE_SECURE=1
fly deploy
```

`PUBLIC_BASE_URL` must be the **same https origin** users open in the browser (no `http://`, no trailing slash). If it is wrong, **Google Connect and Calendar work locally but fail on the public site** (redirect / token refresh).

**Fly.io trial:** machines may **stop after a few minutes** until you add a payment method; the site then looks “broken” until Fly starts it again on the next request. For always-on, attach a card or upgrade the plan.

Copy `gmail_credentials.json` onto the volume or set credentials via your deploy process.

## 4. Example: Railway / Render

- Build: `npm ci && npm start` (or use the included `Dockerfile`).
- Set **root directory** to the repo, **start command** `node server.js`.
- Add persistent disk mounted at `/data`, set `CUE_DATA_DIR=/data`.
- Set `PUBLIC_BASE_URL` to the service URL Railway/Render gives you, and `TRUST_PROXY=1`.

## 5. Share the app

Your public URL is whatever you configured (e.g. `https://cue.example.com`). Each visitor **signs in with their own Google account** (Connect Gmail). OAuth tokens, inbox queue, and saved events are stored **per Google user** under `data/users/<googleSub>/` on the server. You still operate the host: protect the disk, use HTTPS, and set the secrets above. See the main README **Security** section.
