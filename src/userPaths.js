const path = require("node:path");
const fs = require("node:fs/promises");
const { dataDir, ensureDataDir } = require("./dataPaths");

/** Google OAuth `sub` is numeric; `g` + 32 hex = legacy guest id on disk only; `c` + 32 hex = Cue password account (path traversal safe). */
function assertValidUserId(userId) {
  if (!userId || typeof userId !== "string") {
    throw new Error("Invalid user.");
  }
  if (/^[0-9]{1,128}$/.test(userId)) {
    return userId;
  }
  if (/^g[0-9a-f]{32}$/.test(userId)) {
    return userId;
  }
  if (/^c[0-9a-f]{32}$/.test(userId)) {
    return userId;
  }
  throw new Error("Invalid user id format.");
}

async function ensureUserDir(userId) {
  const id = assertValidUserId(userId);
  await ensureDataDir();
  const dir = path.join(dataDir, "users", id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function userBaseDir(userId) {
  return path.join(dataDir, "users", assertValidUserId(userId));
}

function userTokensPath(userId) {
  return path.join(userBaseDir(userId), "gmail_tokens.json");
}

function userEventsPath(userId) {
  return path.join(userBaseDir(userId), "events.json");
}

function userQueuePath(userId) {
  return path.join(userBaseDir(userId), "review_queue.json");
}

module.exports = {
  assertValidUserId,
  ensureUserDir,
  userBaseDir,
  userTokensPath,
  userEventsPath,
  userQueuePath,
};
