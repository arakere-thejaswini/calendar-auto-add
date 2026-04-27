const fs = require("node:fs/promises");
const path = require("node:path");
const { createClient: createRedisClient } = require("redis");
const { ensureDataDir } = require("./dataPaths");

/**
 * Tiny key/value abstraction used by every "JSON blob on disk" store in this
 * app (accounts, per-user events, review queue, Gmail tokens/credentials).
 *
 * Why this exists: on Vercel the filesystem is read-only except for /tmp,
 * and /tmp is ephemeral + per-instance. Accounts created on one cold start
 * disappear on the next, so users see "account doesn't exist" when they sign
 * back in. With REDIS_URL set we transparently persist to Redis (Upstash on
 * Vercel) and the file paths only act as fallbacks for local dev / Fly with a
 * mounted volume.
 */

const REDIS_URL = process.env.REDIS_URL && String(process.env.REDIS_URL).trim();
const KEY_PREFIX = "cue:kv:";

let redisReadyPromise = null;

function isRedisEnabled() {
  return Boolean(REDIS_URL);
}

async function getRedisClient() {
  if (!REDIS_URL) {
    return null;
  }
  if (!redisReadyPromise) {
    const client = createRedisClient({ url: REDIS_URL });
    client.on("error", (err) => {
      console.error("[cue] Redis kv error:", err.message);
    });
    redisReadyPromise = client.connect().then(() => {
      console.log("[cue] KV store: Redis");
      return client;
    });
  }
  return redisReadyPromise;
}

async function readFileSafe(filePath) {
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function atomicWriteFile(filePath, contents) {
  await ensureDataDir();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/** Read a JSON value. Returns `defaultValue` (default `null`) if missing or unparseable. */
async function getJson(key, { fileFallback, defaultValue = null } = {}) {
  if (isRedisEnabled()) {
    const client = await getRedisClient();
    const raw = await client.get(KEY_PREFIX + key);
    if (raw == null) {
      return defaultValue;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return defaultValue;
    }
  }
  const raw = await readFileSafe(fileFallback);
  if (raw == null) {
    return defaultValue;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

/** Write a JSON value atomically. */
async function setJson(key, value, { fileFallback } = {}) {
  if (isRedisEnabled()) {
    const client = await getRedisClient();
    await client.set(KEY_PREFIX + key, JSON.stringify(value));
    return;
  }
  if (!fileFallback) {
    throw new Error("kvStore.setJson called without fileFallback and no REDIS_URL set.");
  }
  await atomicWriteFile(fileFallback, JSON.stringify(value, null, 2));
}

/** Read a raw string (used by sealed Gmail token blobs). */
async function getString(key, { fileFallback } = {}) {
  if (isRedisEnabled()) {
    const client = await getRedisClient();
    const raw = await client.get(KEY_PREFIX + key);
    return raw == null ? null : raw;
  }
  const raw = await readFileSafe(fileFallback);
  return raw == null ? null : raw.trim();
}

/** Write a raw string atomically. */
async function setString(key, value, { fileFallback } = {}) {
  if (isRedisEnabled()) {
    const client = await getRedisClient();
    await client.set(KEY_PREFIX + key, value);
    return;
  }
  if (!fileFallback) {
    throw new Error("kvStore.setString called without fileFallback and no REDIS_URL set.");
  }
  await atomicWriteFile(fileFallback, value);
}

/** Delete a value. Used during sign-out / token revocation flows if needed. */
async function del(key, { fileFallback } = {}) {
  if (isRedisEnabled()) {
    const client = await getRedisClient();
    await client.del(KEY_PREFIX + key);
    return;
  }
  if (fileFallback) {
    try {
      await fs.unlink(fileFallback);
    } catch {
      /* already gone */
    }
  }
}

module.exports = {
  isRedisEnabled,
  getJson,
  setJson,
  getString,
  setString,
  del,
};
