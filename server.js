const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const { RedisStore } = require("connect-redis");
const { createClient: createRedisClient } = require("redis");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { createWorker } = require("tesseract.js");
const sharp = require("sharp");
const { parseEventsFromText, parseEventsFromOcrText } = require("./src/eventParser");
const { preloadSpellchecker, refineParsedEventsTitles, refineEventTitleSpelling } = require("./src/titleSpellfix");
const {
  addEventToAppleCalendar,
  getWritableAppleCalendars,
  verifyEventInAppleCalendar,
  openEventInAppleCalendar,
  findUpcomingAppleEventMatch,
  appendNoteToUpcomingAppleEvent,
} = require("./src/calendarService");
const {
  getLocalEvents,
  saveLocalEvent,
  removeLastLocalEvent,
  findUpcomingLocalEventForUpdateIntent,
  appendNoteToUpcomingLocalEvent,
} = require("./src/storage");
const { parseUpdateIntent } = require("./src/updateIntentParser");
const { createShareLinks, getSharedIcsByToken } = require("./src/shareService");
const {
  readQueueData,
  writeQueueData,
  mergeSuggestions,
  updateSuggestionStatus,
  getQueueSummary,
  suggestionKey,
} = require("./src/reviewQueueStore");
const {
  saveCredentials,
  createAuthUrl,
  handleOAuthCallback,
  fetchInboxSuggestions,
  fetchInboxEventCandidates,
  getStatus,
} = require("./src/gmailService");
const { listWritableGoogleCalendars, insertGoogleCalendarEvent } = require("./src/googleCalendarService");

const { ensureDataDir, dataDir } = require("./src/dataPaths");

/** Multer temp uploads; must be writable (use /tmp on Vercel — deploy bundle is read-only). */
const uploadRoot =
  process.env.CUE_UPLOADS_DIR != null && String(process.env.CUE_UPLOADS_DIR).trim() !== ""
    ? path.resolve(process.env.CUE_UPLOADS_DIR)
    : process.env.VERCEL
      ? path.join("/tmp", "cue-uploads")
      : path.join(__dirname, "uploads");
const { assertValidUserId, userBaseDir } = require("./src/userPaths");
const { register: cueRegister, login: cueLogin, getUsernameForCueId } = require("./src/cueAccounts");

const app = express();
const port = Number(process.env.PORT) || 3030;
if (process.env.TRUST_PROXY === "1" || process.env.VERCEL) {
  app.set("trust proxy", 1);
}

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  console.error("FATAL: Set SESSION_SECRET in production (long random string).");
  process.exit(1);
}
const sessionSecret =
  process.env.SESSION_SECRET || "DEV_ONLY_UNSAFE_SESSION_SECRET_CHANGE_FOR_PRODUCTION";

function needsRedisForStableSessionsHint() {
  const redisUrl = process.env.REDIS_URL && String(process.env.REDIS_URL).trim();
  return Boolean(process.env.VERCEL) && !redisUrl;
}

if (needsRedisForStableSessionsHint()) {
  console.warn(
    "[cue] WARNING: Running on Vercel without REDIS_URL. Accounts, events, the Gmail review queue, and OAuth tokens are written to /tmp and are LOST on every cold start / redeploy — this is why sign-in says \"account doesn't exist\" after creating one. Add Upstash Redis (rediss://...) as REDIS_URL in Vercel project settings to make data durable.",
  );
}

const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === "1" || Boolean(process.env.VERCEL),
  sameSite: "lax",
  maxAge: 14 * 24 * 60 * 60 * 1000,
};

/** Redis (e.g. Upstash) survives Vercel cold starts; file store is fine on Fly with /data volume. */
const sessionMiddlewarePromise = (async () => {
  await ensureDataDir();
  const redisUrl = process.env.REDIS_URL && String(process.env.REDIS_URL).trim();
  if (redisUrl) {
    const client = createRedisClient({ url: redisUrl });
    client.on("error", (err) => console.error("[cue] Redis session:", err.message));
    await client.connect();
    console.log("[cue] Session store: Redis");
    return session({
      store: new RedisStore({ client, prefix: "cue:sess:" }),
      name: "cue.sid",
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: sessionCookieOptions,
    });
  }
  if (process.env.VERCEL) {
    console.warn(
      "[cue] No REDIS_URL — sessions are file-backed under /tmp and are lost when the function cold-starts. Add Upstash Redis and set REDIS_URL for stable sign-in on Vercel.",
    );
  }
  console.log("[cue] Session store: file (" + path.join(dataDir, "sessions") + ")");
  return session({
    store: new FileStore({
      path: path.join(dataDir, "sessions"),
      logFn: () => {},
    }),
    name: "cue.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: sessionCookieOptions,
  });
})();

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
  }),
);

app.use((req, res, next) => {
  sessionMiddlewarePromise.then((mw) => mw(req, res, next)).catch(next);
});

const upload = multer({ dest: uploadRoot });
const monitorState = {
  timer: null,
  lastRunAt: null,
  lastError: null,
};

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const authUrlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
});

const cueAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function attachLedgerUser(req, res, next) {
  if (req.session?.cueUserId) {
    try {
      req.userId = assertValidUserId(req.session.cueUserId);
      req.ledgerSource = "cue";
    } catch {
      req.session.destroy(() => {});
      res.status(401).json({ error: "Invalid session. Please sign in again.", code: "AUTH_INVALID" });
      return;
    }
    next();
    return;
  }
  const legacyGoogle = req.session?.userId != null ? String(req.session.userId) : "";
  if (legacyGoogle && /^[0-9]{1,128}$/.test(legacyGoogle)) {
    try {
      req.userId = assertValidUserId(legacyGoogle);
      req.ledgerSource = "google";
    } catch {
      req.session.destroy(() => {});
      res.status(401).json({ error: "Invalid session. Please connect again.", code: "AUTH_INVALID" });
      return;
    }
    next();
    return;
  }
  req.userId = null;
  req.ledgerSource = "none";
  next();
}

function gmailPathRequiresGoogleAccount(reqPath) {
  if (!reqPath.startsWith("/api/gmail/")) {
    return false;
  }
  if (
    reqPath === "/api/gmail/auth-url" ||
    reqPath === "/api/gmail/oauth/callback" ||
    reqPath === "/api/gmail/config" ||
    reqPath === "/api/gmail/status"
  ) {
    return false;
  }
  return true;
}

/** Inbox and Gmail OAuth require a signed-in Cue account or a legacy Google-only session. */
function requireLedgerAccount(req, res, next) {
  if (req.ledgerSource !== "cue" && req.ledgerSource !== "google") {
    res.status(401).json({
      error: "Sign in with your Cue username and password to use Inbox. You can connect Google from this tab for Gmail and Google Calendar.",
      code: "AUTH_REQUIRED",
    });
    return;
  }
  next();
}

function gateApi(req, res, next) {
  if (!req.path.startsWith("/api")) {
    next();
    return;
  }
  if (
    req.path === "/api/me" ||
    req.path === "/api/gmail/oauth/callback" ||
    req.path === "/api/health" ||
    (req.path === "/api/auth/logout" && req.method === "POST") ||
    (req.path === "/api/auth/register" && req.method === "POST") ||
    (req.path === "/api/auth/login" && req.method === "POST")
  ) {
    next();
    return;
  }
  if (req.path === "/api/gmail/config" && req.method === "POST") {
    adminSetupGuard(req, res, next);
    return;
  }
  if (req.path.startsWith("/api/events/share-ics/")) {
    next();
    return;
  }
  apiLimiter(req, res, () =>
    attachLedgerUser(req, res, () => {
      if (req.ledgerSource === "none") {
        res.status(401).json({
          error: "Sign in to Cue to add events, use your activity log, or use Inbox.",
          code: "SIGN_IN_REQUIRED",
        });
        return;
      }
      if (gmailPathRequiresGoogleAccount(req.path)) {
        requireLedgerAccount(req, res, next);
        return;
      }
      next();
    }),
  );
}

function adminSetupGuard(req, res, next) {
  const need = process.env.NODE_ENV === "production" || process.env.ADMIN_SETUP_SECRET;
  if (need && !process.env.ADMIN_SETUP_SECRET) {
    res.status(403).json({
      error: "Set ADMIN_SETUP_SECRET in the environment to change OAuth client settings on this server.",
    });
    return;
  }
  if (process.env.ADMIN_SETUP_SECRET && req.headers["x-cue-admin-secret"] !== process.env.ADMIN_SETUP_SECRET) {
    res.status(403).json({ error: "Invalid admin secret." });
    return;
  }
  next();
}

app.use(gateApi);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  let userId = null;
  let authenticated = false;
  let username = null;
  if (req.session?.cueUserId) {
    try {
      userId = assertValidUserId(req.session.cueUserId);
      authenticated = true;
      username = req.session.cueUsername || null;
    } catch {
      req.session.destroy(() => {});
      res.status(401).json({
        authenticated: false,
        error: "Invalid session.",
        code: "AUTH_INVALID",
        needsRedisForStableSessions: needsRedisForStableSessionsHint(),
      });
      return;
    }
  } else if (req.session?.userId != null) {
    try {
      const raw = String(req.session.userId);
      if (!/^[0-9]{1,128}$/.test(raw)) {
        throw new Error("bad");
      }
      userId = assertValidUserId(raw);
      authenticated = true;
    } catch {
      req.session.destroy(() => {});
      res.status(401).json({
        authenticated: false,
        error: "Invalid session.",
        code: "AUTH_INVALID",
        needsRedisForStableSessions: needsRedisForStableSessionsHint(),
      });
      return;
    }
  }
  const status = await getStatus(userId);
  const email =
    req.session?.cueUserId != null
      ? req.session.googleEmail || null
      : authenticated && req.session?.userId != null
        ? req.session.userEmail || null
        : null;
  res.json({
    authenticated,
    username: username || undefined,
    userId: userId || undefined,
    email: email || undefined,
    configured: status.configured,
    gmailConnected: status.connected,
    /** True on Vercel when sessions use /tmp file store — different instances lose sign-in until REDIS_URL is set. */
    needsRedisForStableSessions: needsRedisForStableSessionsHint(),
  });
});

app.post("/api/auth/register", cueAuthLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { cueUserId, username: uname } = await cueRegister(username, password);
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.cueUserId = cueUserId;
    req.session.cueUsername = uname;
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
    res.json({ success: true, username: uname });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not register." });
  }
});

app.post("/api/auth/login", cueAuthLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { cueUserId, username: uname } = await cueLogin(username, password);
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.cueUserId = cueUserId;
    req.session.cueUsername = uname;
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
    res.json({ success: true, username: uname });
  } catch (error) {
    res.status(401).json({ error: error.message || "Could not sign in." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Could not end session." });
      return;
    }
    res.clearCookie("cue.sid");
    res.json({ success: true });
  });
});

function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function parseCalendarTarget(body) {
  if (body?.calendarTarget?.type === "google" && body.calendarTarget.calendarId) {
    return { type: "google", calendarId: String(body.calendarTarget.calendarId) };
  }
  if (body?.calendarTarget?.type === "cue") {
    return { type: "cue" };
  }
  if (body?.calendarTarget?.type === "apple") {
    return { type: "apple", name: body.calendarTarget.name || "" };
  }
  const keyRaw = body?.calendarKey ?? body?.calendarName ?? "";
  if (typeof keyRaw !== "string") {
    return { type: "cue" };
  }
  const key = keyRaw.trim();
  if (!key || key === "cue") {
    return { type: "cue" };
  }
  if (key.startsWith("google/")) {
    return { type: "google", calendarId: decodeURIComponent(key.slice(7)) };
  }
  if (key.startsWith("apple/")) {
    return { type: "apple", name: decodeURIComponent(key.slice(6)) };
  }
  return { type: "apple", name: key };
}

async function addEventToTarget(event, body, { source = "gmail", baseUrl, userId, ledgerIsGuest = false, photoId = null } = {}) {
  const target = parseCalendarTarget(body || {});
  let destination;
  let calendarRef = "";

  const saveCueOnly = async () => {
    const saved = await saveLocalEvent(userId, event, { source, destination: "cue", calendarRef: "", photoId });
    return { destination: "cue", calendarRef: "", event: saved };
  };

  if (target.type === "cue") {
    return saveCueOnly();
  }

  try {
    if (target.type === "google") {
      if (!baseUrl) {
        throw new Error("Missing base URL for Google Calendar (set PUBLIC_BASE_URL when not using a browser request).");
      }
      await insertGoogleCalendarEvent(baseUrl, target.calendarId, event, userId);
      destination = "google";
      calendarRef = target.calendarId;
    } else {
      await addEventToAppleCalendar(event, target.name || "");
      destination = "apple";
      calendarRef = target.name || "";
    }
  } catch (err) {
    if (ledgerIsGuest) {
      return saveCueOnly();
    }
    /* Hosted Linux (e.g. Fly): no Calendar.app — still save to the in-app Events log. */
    if (target.type === "apple" && process.platform !== "darwin") {
      return saveCueOnly();
    }
    throw err;
  }

  const saved = await saveLocalEvent(userId, event, { source, destination, calendarRef, photoId });
  return { destination, calendarRef, event: saved };
}

async function runQueueScan(baseUrl, userId, maxResults = 25) {
  const status = await getStatus(userId);
  if (!status.connected) {
    return { newCount: 0, skipped: true, reason: "Gmail not connected yet." };
  }

  const data = await readQueueData(userId);
  const existingKeys = data.suggestions.map((item) => suggestionKey(item));
  const suggestions = await fetchInboxSuggestions(baseUrl, {
    maxResults,
    userId,
    requireExplicitDateTime: data.settings.requireExplicitDateTime,
    requireEventIntent: data.settings.requireEventIntent,
    blockedSenders: data.senderRules.blocked,
    allowedSenders: data.senderRules.allowed,
    existingKeys: [...existingKeys, ...data.processedKeys],
  });

  const merged = mergeSuggestions(data.suggestions, suggestions);
  const mergedKeys = merged.suggestions.map((item) => suggestionKey(item));
  const processed = [...new Set([...data.processedKeys, ...mergedKeys])].slice(-5000);

  const updated = {
    ...data,
    suggestions: merged.suggestions,
    processedKeys: processed,
    lastScanAt: new Date().toISOString(),
  };
  await writeQueueData(userId, updated);

  monitorState.lastRunAt = new Date().toISOString();
  monitorState.lastError = null;

  return {
    newCount: merged.newCount,
    totalPending: updated.suggestions.filter((item) => item.status === "pending").length,
    summary: getQueueSummary(updated.suggestions),
  };
}

async function refreshMonitorTimer(_baseUrl) {
  if (monitorState.timer) {
    clearInterval(monitorState.timer);
    monitorState.timer = null;
  }
}

/**
 * Why `tzOffsetMin`: chrono interprets bare times like "1pm" in the
 * timezone of its parsing reference. On Vercel/Fly the server runs in UTC,
 * so without a hint "1pm" becomes 1pm UTC and the user sees it shifted by
 * their offset (e.g. 6 AM PT). The browser sends its current offset so the
 * server parses in the user's timezone.
 */
function readTzOffsetMin(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  /* Sanity-cap at +/-14h. */
  if (n < -14 * 60 || n > 14 * 60) return undefined;
  return n;
}

app.post("/api/parse/text", async (req, res) => {
  try {
    const { text, tzOffsetMin } = req.body || {};
    const events = await refineParsedEventsTitles(
      parseEventsFromText(text || "", { tzOffsetMin: readTzOffsetMin(tzOffsetMin) }),
    );
    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Tesseract on Vercel: ship eng.traineddata in the function bundle (see
 * vercel.json `includeFiles`) and point the worker at it, so we don't
 * re-download ~5MB from a CDN on every cold start. Cache must be writable —
 * /tmp on Vercel, a local folder otherwise.
 */
const TESS_LANG_PATH = __dirname;
const TESS_CACHE_PATH = process.env.VERCEL
  ? path.join("/tmp", "tesseract-cache")
  : path.join(__dirname, ".tesseract-cache");

app.post("/api/parse/image", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Please upload an image." });
    return;
  }

  let worker;
  const preprocessedPath = path.join(uploadRoot, `${req.file.filename}-prep.png`);
  try {
    await fs.mkdir(TESS_CACHE_PATH, { recursive: true });
    worker = await createWorker("eng", 1, {
      langPath: TESS_LANG_PATH,
      cachePath: TESS_CACHE_PATH,
      gzip: false,
    });
    await worker.setParameters({
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
    });

    await sharp(req.file.path)
      .rotate()
      .resize({ width: 2200, fit: "inside", withoutEnlargement: false })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toFile(preprocessedPath);

    const result = await worker.recognize(preprocessedPath);
    const extractedText = result.data.text || "";
    const events = await refineParsedEventsTitles(
      parseEventsFromOcrText(extractedText, {
        tzOffsetMin: readTzOffsetMin(req.body?.tzOffsetMin),
      }),
    );
    res.json({ extractedText, events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (worker) {
      await worker.terminate();
    }
    await fs.rm(req.file.path, { force: true });
    await fs.rm(preprocessedPath, { force: true });
  }
});

app.post("/api/event-photos", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Please upload an image." });
    return;
  }
  const photoId = crypto.randomBytes(16).toString("hex");
  const dir = path.join(userBaseDir(req.userId), "event-photos");
  const outPath = path.join(dir, `${photoId}.webp`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await sharp(req.file.path)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(outPath);
    res.json({ photoId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    await fs.rm(req.file.path, { force: true });
  }
});

app.get("/api/event-photos/:photoId", async (req, res) => {
  const id = String(req.params.photoId || "");
  if (!/^[a-f0-9]{32}$/.test(id)) {
    res.status(400).json({ error: "Invalid image id." });
    return;
  }
  const abs = path.resolve(path.join(userBaseDir(req.userId), "event-photos", `${id}.webp`));
  try {
    await fs.access(abs);
  } catch {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "private, max-age=604800");
  res.sendFile(abs);
});

app.get("/api/events/local", async (req, res) => {
  try {
    const events = await getLocalEvents(req.userId);
    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/apple-calendars", async (_req, res) => {
  try {
    const calendars = await getWritableAppleCalendars();
    res.json({ calendars });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/calendars", async (req, res) => {
  try {
    let apple = [];
    try {
      apple = await getWritableAppleCalendars();
    } catch {
      apple = [];
    }

    let google = [];
    let googleHint = null;
    const status = await getStatus(req.userId);

    if (!status.connected) {
      googleHint = null;
    } else {
      try {
        google = await listWritableGoogleCalendars(getBaseUrl(req), req.userId);
      } catch (err) {
        console.warn("[cue] Google calendarList failed:", err.message || err);
        const msg = String(err.message || err);
        if (/insufficient|403|Scope|scope/i.test(msg)) {
          googleHint = "Reconnect Google in Inbox (Calendar access).";
        } else {
          googleHint = "Google calendars unavailable.";
        }
      }
    }

    res.json({ apple, google, gmailConnected: status.connected, googleHint });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/gmail/status", async (req, res) => {
  try {
    const status = await getStatus(req.userId);
    const queueData = await readQueueData(req.userId);
    res.json({
      ...status,
      queueSummary: getQueueSummary(queueData.suggestions),
      monitor: {
        pollingEnabled: queueData.settings.pollingEnabled,
        pollIntervalSec: queueData.settings.pollIntervalSec,
        lastRunAt: monitorState.lastRunAt,
        lastError: monitorState.lastError,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/gmail/config", async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri } = req.body || {};
    if (!clientId) {
      res.status(400).json({ error: "clientId is required." });
      return;
    }

    await saveCredentials({
      clientId: clientId.trim(),
      clientSecret: clientSecret?.trim() || null,
      redirectUri: redirectUri?.trim() || null,
    });
    const status = await getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/gmail/auth-url", authUrlLimiter, async (req, res) => {
  try {
    const url = await createAuthUrl(getBaseUrl(req), req.userId);
    res.json({ url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/gmail/oauth/callback", async (req, res) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    if (error) {
      res.status(400).send(`Gmail connection failed: ${error}${errorDescription ? ` (${errorDescription})` : ""}`);
      return;
    }
    if (!code || !state) {
      res.status(400).send("Missing OAuth callback parameters.");
      return;
    }

    const { ledgerUserId, email } = await handleOAuthCallback({ baseUrl: getBaseUrl(req), code, state });
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    if (/^c[0-9a-f]{32}$/.test(ledgerUserId)) {
      req.session.cueUserId = ledgerUserId;
      req.session.cueUsername = (await getUsernameForCueId(ledgerUserId)) || "";
      req.session.googleEmail = email || null;
    } else {
      req.session.userId = ledgerUserId;
      req.session.userEmail = email || "";
    }
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });
    refreshMonitorTimer(getBaseUrl(req)).catch(() => {});
    runQueueScan(getBaseUrl(req), ledgerUserId, 25).catch(() => {});
    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Signed in</title>
<meta http-equiv="refresh" content="1;url=/"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:24px;">
<h2>Google connected</h2>
<p>Redirecting to Cue&hellip; <a href="/">Continue</a></p>
</body></html>`);
  } catch (error) {
    res.status(500).send(`Gmail connection failed: ${error.message}`);
  }
});

app.get("/api/gmail/inbox-candidates", async (req, res) => {
  try {
    const maxResults = Number(req.query.maxResults || 12);
    const candidates = await fetchInboxEventCandidates(getBaseUrl(req), maxResults, req.userId);
    res.json({ candidates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/gmail/review-queue", async (req, res) => {
  try {
    const data = await readQueueData(req.userId);
    res.json({
      suggestions: data.suggestions,
      senderRules: data.senderRules,
      settings: data.settings,
      summary: getQueueSummary(data.suggestions),
      monitor: {
        pollingEnabled: data.settings.pollingEnabled,
        pollIntervalSec: data.settings.pollIntervalSec,
        lastRunAt: monitorState.lastRunAt,
        lastError: monitorState.lastError,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/gmail/review-queue/scan", async (req, res) => {
  try {
    const maxResults = Number(req.body?.maxResults || 25);
    const result = await runQueueScan(getBaseUrl(req), req.userId, maxResults);
    const data = await readQueueData(req.userId);
    res.json({
      success: true,
      ...result,
      suggestions: data.suggestions,
      summary: getQueueSummary(data.suggestions),
    });
  } catch (error) {
    monitorState.lastError = error.message;
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/gmail/review-queue/settings", async (req, res) => {
  try {
    const data = await readQueueData(req.userId);
    const next = {
      ...data,
      settings: {
        ...data.settings,
        ...req.body,
      },
    };
    await writeQueueData(req.userId, next);
    await refreshMonitorTimer(getBaseUrl(req));
    res.json({ success: true, settings: next.settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/gmail/review-queue/sender-rule", async (req, res) => {
  try {
    const { senderEmail, action } = req.body || {};
    if (!senderEmail || !action) {
      res.status(400).json({ error: "senderEmail and action are required." });
      return;
    }

    const email = String(senderEmail).toLowerCase();
    const data = await readQueueData(req.userId);
    const blocked = new Set(data.senderRules.blocked);
    const allowed = new Set(data.senderRules.allowed);

    if (action === "block") blocked.add(email);
    if (action === "unblock") blocked.delete(email);
    if (action === "allow") allowed.add(email);
    if (action === "unallow") allowed.delete(email);

    const filteredSuggestions = data.suggestions.filter((item) => {
      if (action === "block") {
        return item.senderEmail !== email || item.status !== "pending";
      }
      return true;
    });

    const next = {
      ...data,
      suggestions: filteredSuggestions,
      senderRules: {
        blocked: Array.from(blocked),
        allowed: Array.from(allowed),
      },
    };
    await writeQueueData(req.userId, next);
    res.json({ success: true, senderRules: next.senderRules });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/gmail/review-queue/reject", async (req, res) => {
  try {
    const { suggestionId, reason } = req.body || {};
    if (!suggestionId) {
      res.status(400).json({ error: "suggestionId is required." });
      return;
    }
    const data = await readQueueData(req.userId);
    const updated = updateSuggestionStatus(data.suggestions, suggestionId, "rejected", {
      rejectionReason: reason || "",
    });
    await writeQueueData(req.userId, { ...data, suggestions: updated });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/gmail/review-queue/approve", async (req, res) => {
  try {
    const { suggestionId, eventOverride } = req.body || {};
    if (!suggestionId) {
      res.status(400).json({ error: "suggestionId is required." });
      return;
    }

    const data = await readQueueData(req.userId);
    const suggestion = data.suggestions.find((item) => item.id === suggestionId);
    if (!suggestion) {
      res.status(404).json({ error: "Suggestion not found." });
      return;
    }

    const finalEvent = {
      ...suggestion.event,
      ...(eventOverride || {}),
    };
    const addResult = await addEventToTarget(finalEvent, req.body, {
      source: "gmail",
      baseUrl: getBaseUrl(req),
      userId: req.userId,
    });
    const updated = updateSuggestionStatus(data.suggestions, suggestionId, "added", {
      approvedEvent: finalEvent,
      destination: addResult.destination,
      calendarName: addResult.calendarRef,
    });
    await writeQueueData(req.userId, { ...data, suggestions: updated });
    res.json({ success: true, destination: addResult.destination, event: addResult.event || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/gmail/review-queue/bulk-approve", async (req, res) => {
  try {
    const minConfidence = Number(req.body?.minConfidence || 85);
    const data = await readQueueData(req.userId);
    const pending = data.suggestions.filter((item) => item.status === "pending" && Number(item.confidence || 0) >= minConfidence);
    let successCount = 0;
    let failureCount = 0;
    let suggestions = data.suggestions;

    for (const item of pending) {
      try {
        const addResult = await addEventToTarget(item.event, req.body, {
          source: "gmail",
          baseUrl: getBaseUrl(req),
          userId: req.userId,
        });
        suggestions = updateSuggestionStatus(suggestions, item.id, "added", {
          approvedEvent: item.event,
          destination: addResult.destination,
          calendarName: addResult.calendarRef,
        });
        successCount += 1;
      } catch (error) {
        suggestions = updateSuggestionStatus(suggestions, item.id, "failed", {
          failureReason: error.message,
        });
        failureCount += 1;
      }
    }

    await writeQueueData(req.userId, { ...data, suggestions });
    res.json({ success: true, successCount, failureCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/gmail/monitor-status", async (req, res) => {
  try {
    const data = await readQueueData(req.userId);
    res.json({
      pollingEnabled: data.settings.pollingEnabled,
      pollIntervalSec: data.settings.pollIntervalSec,
      running: Boolean(monitorState.timer),
      lastRunAt: monitorState.lastRunAt,
      lastError: monitorState.lastError,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/gmail/monitor", async (req, res) => {
  try {
    const { enabled, pollIntervalSec } = req.body || {};
    const data = await readQueueData(req.userId);
    const next = {
      ...data,
      settings: {
        ...data.settings,
        pollingEnabled: typeof enabled === "boolean" ? enabled : data.settings.pollingEnabled,
        pollIntervalSec: pollIntervalSec ? Number(pollIntervalSec) : data.settings.pollIntervalSec,
      },
    };
    await writeQueueData(req.userId, next);
    await refreshMonitorTimer(getBaseUrl(req));
    res.json({ success: true, settings: next.settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/events/stats", async (req, res) => {
  try {
    const events = await getLocalEvents(req.userId);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const daySet = new Set();
    events.forEach((e) => {
      if (e.createdAt) daySet.add(e.createdAt.slice(0, 10));
    });

    let streak = 0;
    const d = new Date(now);
    while (true) {
      const ds = d.toISOString().slice(0, 10);
      if (daySet.has(ds)) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }

    let longestStreak = 0;
    let currentRun = 0;
    const sortedDays = [...daySet].sort();
    for (let i = 0; i < sortedDays.length; i++) {
      if (i === 0) {
        currentRun = 1;
      } else {
        const prev = new Date(sortedDays[i - 1]);
        const cur = new Date(sortedDays[i]);
        const diff = (cur - prev) / (1000 * 60 * 60 * 24);
        currentRun = diff === 1 ? currentRun + 1 : 1;
      }
      longestStreak = Math.max(longestStreak, currentRun);
    }

    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const wd = new Date(startOfWeek);
      wd.setDate(startOfWeek.getDate() + i);
      const ds = wd.toISOString().slice(0, 10);
      weekDays.push({ date: ds, active: daySet.has(ds), isToday: ds === todayStr });
    }

    const monthStr = todayStr.slice(0, 7);
    const thisMonth = events.filter((e) => e.createdAt && e.createdAt.startsWith(monthStr)).length;

    const weekStart = startOfWeek.toISOString();
    const thisWeek = events.filter((e) => e.createdAt && e.createdAt >= weekStart).length;

    const bySource = {};
    events.forEach((e) => {
      const src = e.source || "unknown";
      bySource[src] = (bySource[src] || 0) + 1;
    });

    const last30 = [];
    for (let i = 29; i >= 0; i--) {
      const dd = new Date(now);
      dd.setDate(now.getDate() - i);
      const ds = dd.toISOString().slice(0, 10);
      const count = events.filter((e) => e.createdAt && e.createdAt.startsWith(ds)).length;
      last30.push({ date: ds, count, isToday: ds === todayStr });
    }

    res.json({
      streak,
      longestStreak,
      thisWeek,
      thisMonth,
      total: events.length,
      bySource,
      weekDays,
      last30,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events/add", async (req, res) => {
  try {
    const { event, source } = req.body;
    if (!event || !event.title || !event.start || !event.end) {
      res.status(400).json({ error: "Invalid event payload." });
      return;
    }

    let photoId = req.body.photoId;
    if (!photoId || !/^[a-f0-9]{32}$/.test(String(photoId))) {
      photoId = null;
    } else {
      try {
        await fs.access(path.join(userBaseDir(req.userId), "event-photos", `${photoId}.webp`));
      } catch {
        photoId = null;
      }
    }

    const titleRefined = (await refineEventTitleSpelling(String(event.title || "").trim())) || event.title;
    const eventForSave = { ...event, title: titleRefined };

    const src = source === "photo" ? "photo" : source === "text" ? "text" : "text";
    const result = await addEventToTarget(eventForSave, req.body, {
      source: src,
      baseUrl: getBaseUrl(req),
      userId: req.userId,
      ledgerIsGuest: false,
      photoId: src === "photo" ? photoId : null,
    });
    res.json({ success: true, destination: result.destination, event: result.event });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events/check-duplicate", async (req, res) => {
  try {
    const { event } = req.body || {};
    if (!event || !event.title || !event.start) {
      res.status(400).json({ error: "Invalid event payload." });
      return;
    }
    const events = await getLocalEvents(req.userId);
    const startMs = new Date(event.start).getTime();
    const titleNorm = (event.title || "").trim().toLowerCase();
    const windowMs = 2 * 60 * 60 * 1000;
    const match = events.find((e) => {
      if ((e.title || "").trim().toLowerCase() !== titleNorm) return false;
      return Math.abs(new Date(e.start).getTime() - startMs) <= windowMs;
    });
    res.json({ duplicate: Boolean(match), match: match || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events/local/undo-last", async (req, res) => {
  try {
    const removed = await removeLastLocalEvent(req.userId);
    if (!removed) {
      res.status(400).json({ error: "Nothing to undo in the activity log." });
      return;
    }
    res.json({ success: true, removed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events/preview-update-intent", async (req, res) => {
  try {
    const { text, calendarName } = req.body || {};
    const intent = parseUpdateIntent(text || "");
    if (!intent) {
      res.status(400).json({
        error: "Could not understand request. Example: 'Need to buy shoes for P's bday'",
      });
      return;
    }
    let matchedEvent = null;
    if (req.ledgerSource === "cue") {
      try {
        matchedEvent = await findUpcomingLocalEventForUpdateIntent(req.userId, {
          searchTerms: intent.searchTerms,
          requiredMatches: intent.requiredMatches,
        });
      } catch {
        matchedEvent = null;
      }
    }
    if (!matchedEvent) {
      matchedEvent = await findUpcomingAppleEventMatch({
        searchTerms: intent.searchTerms,
        requiredMatches: intent.requiredMatches,
        calendarName: calendarName || "",
      });
    }
    res.json({ success: true, intent, matchedEvent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events/verify-apple", async (req, res) => {
  try {
    const { event, calendarName } = req.body;
    if (!event || !event.title || !event.start) {
      res.status(400).json({ error: "Invalid event payload." });
      return;
    }

    const exists = await verifyEventInAppleCalendar(event, calendarName || "");
    res.json({ exists });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events/open-apple", async (req, res) => {
  try {
    const { event, calendarName } = req.body;
    if (!event || !event.title || !event.start) {
      res.status(400).json({ error: "Invalid event payload." });
      return;
    }

    await openEventInAppleCalendar(event, calendarName || "");
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/events/share-links", async (req, res) => {
  try {
    const { event } = req.body || {};
    if (!event || !event.title || !event.start || !event.end) {
      res.status(400).json({ error: "Invalid event payload." });
      return;
    }

    const links = createShareLinks(event, getBaseUrl(req));
    res.json({ success: true, ...links });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/events/share-ics/:token", async (req, res) => {
  try {
    const entry = getSharedIcsByToken(req.params.token);
    if (!entry) {
      res.status(404).send("Share link expired or invalid.");
      return;
    }

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${entry.fileName}"`);
    res.send(entry.icsContent);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post("/api/events/update-note-from-text", async (req, res) => {
  try {
    const { text, calendarName } = req.body || {};
    const intent = parseUpdateIntent(text || "");
    if (!intent) {
      res
        .status(400)
        .json({ error: "Could not understand request. Example: 'Need to buy shoes for P's bday'" });
      return;
    }

    if (req.ledgerSource === "cue") {
      try {
        const updated = await appendNoteToUpcomingLocalEvent(req.userId, {
          noteText: intent.noteText,
          searchTerms: intent.searchTerms,
          requiredMatches: intent.requiredMatches,
        });
        const startD = new Date(updated.start);
        res.json({
          success: true,
          intent,
          destination: "cue",
          matchedEvent: {
            matchedSummary: updated.title || "",
            matchedCalendar: "",
            matchedStart: startD.toLocaleString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
          },
        });
        return;
      } catch {
        /* fall through to Apple Calendar */
      }
    }

    const result = await appendNoteToUpcomingAppleEvent({
      noteText: intent.noteText,
      searchTerms: intent.searchTerms,
      requiredMatches: intent.requiredMatches,
      calendarName: calendarName || "",
    });

    res.json({
      success: true,
      intent,
      destination: "apple",
      matchedEvent: result,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

(async () => {
  await ensureDataDir();
  await fs.mkdir(uploadRoot, { recursive: true });
  if (process.env.NODE_ENV === "production") {
    const pub = (process.env.PUBLIC_BASE_URL || "").trim();
    if (!pub.startsWith("https://")) {
      console.warn(
        "[cue] Set PUBLIC_BASE_URL to your real https URL (e.g. https://on-cue.fly.dev). Google OAuth and Calendar use it; wrong or http values break sign-in on the public site.",
        pub ? `(got: ${pub.slice(0, 48)})` : "(unset)",
      );
    }
  }
  const monitorBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
  /* Fly.io / Docker: bind 0.0.0.0. Listen before slow preload so deploy smoke checks see the port. */
  await new Promise((resolve) => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`Cue listening on 0.0.0.0:${port} (public URL: ${monitorBaseUrl})`);
      resolve();
    });
  });
  await preloadSpellchecker().catch((e) => console.warn("[cue] spellchecker:", e.message || e));
  refreshMonitorTimer(monitorBaseUrl).catch((error) => {
    monitorState.lastError = error.message;
  });
})();
