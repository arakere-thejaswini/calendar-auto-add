const path = require("node:path");
const crypto = require("node:crypto");
const { dataDir } = require("./dataPaths");
const { ensureUserDir } = require("./userPaths");
const { getJson, setJson } = require("./kvStore");

const ACCOUNTS_PATH = path.join(dataDir, "cue_accounts.json");
const ACCOUNTS_KEY = "accounts";
const EMPTY_STORE = { users: {} };

async function readStore() {
  const j = await getJson(ACCOUNTS_KEY, {
    fileFallback: ACCOUNTS_PATH,
    defaultValue: EMPTY_STORE,
  });
  return j && typeof j === "object" && j.users && typeof j.users === "object"
    ? j
    : { users: {} };
}

async function writeStore(store) {
  await setJson(ACCOUNTS_KEY, store, { fileFallback: ACCOUNTS_PATH });
}

function normalizeUsername(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function assertUsernameShape(name) {
  const n = String(name || "").trim();
  if (n.length < 3 || n.length > 32) {
    throw new Error("Username must be 3–32 characters.");
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(n)) {
    throw new Error("Username may only use letters, numbers, underscore, hyphen, and period.");
  }
  return n;
}

function assertPasswordShape(password) {
  const p = String(password || "");
  if (p.length < 10 || p.length > 256) {
    throw new Error("Password must be at least 10 characters (max 256).");
  }
  return p;
}

function newCueUserId() {
  return `c${crypto.randomBytes(16).toString("hex")}`;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
  return {
    saltB64: salt.toString("base64"),
    hashB64: Buffer.from(hash).toString("base64"),
  };
}

async function verifyPassword(password, saltB64, hashB64) {
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(hash, expected);
}

async function register(usernameRaw, passwordRaw) {
  const username = assertUsernameShape(usernameRaw);
  const password = assertPasswordShape(passwordRaw);
  const key = normalizeUsername(username);
  const store = await readStore();
  if (store.users[key]) {
    throw new Error("That username is already taken.");
  }
  const id = newCueUserId();
  const { saltB64, hashB64 } = await hashPassword(password);
  store.users[key] = {
    id,
    username,
    saltB64,
    hashB64,
    createdAt: new Date().toISOString(),
  };
  await writeStore(store);
  await ensureUserDir(id);
  return { cueUserId: id, username };
}

const LOGIN_FAILED_HINT =
  "Couldn't sign in—check your username and password. New here? Use Create account below.";

async function login(usernameRaw, passwordRaw) {
  const username = assertUsernameShape(usernameRaw);
  const password = assertPasswordShape(passwordRaw);
  const key = normalizeUsername(username);
  const store = await readStore();
  const row = store.users[key];
  if (!row?.saltB64 || !row.hashB64 || !row.id) {
    throw new Error(LOGIN_FAILED_HINT);
  }
  const ok = await verifyPassword(password, row.saltB64, row.hashB64);
  if (!ok) {
    throw new Error(LOGIN_FAILED_HINT);
  }
  return { cueUserId: row.id, username: row.username || username };
}

async function getUsernameForCueId(cueUserId) {
  if (!cueUserId || typeof cueUserId !== "string") return null;
  const store = await readStore();
  for (const row of Object.values(store.users)) {
    if (row && row.id === cueUserId) {
      return row.username || null;
    }
  }
  return null;
}

module.exports = {
  register,
  login,
  getUsernameForCueId,
  assertUsernameShape,
  assertPasswordShape,
};
