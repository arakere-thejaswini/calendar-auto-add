const path = require("node:path");
const fs = require("node:fs/promises");

const dataDir =
  process.env.CUE_DATA_DIR != null && String(process.env.CUE_DATA_DIR).trim() !== ""
    ? path.resolve(process.env.CUE_DATA_DIR)
    : process.env.VERCEL
      ? path.join("/tmp", "cue-data")
      : path.join(__dirname, "..", "data");

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, "sessions"), { recursive: true });
}

const paths = {
  dataDir,
  eventsJson: path.join(dataDir, "events.json"),
  reviewQueueJson: path.join(dataDir, "review_queue.json"),
  gmailCredentials: path.join(dataDir, "gmail_credentials.json"),
  gmailTokens: path.join(dataDir, "gmail_tokens.json"),
  gmailOAuthState: path.join(dataDir, "gmail_oauth_state.json"),
};

module.exports = { ...paths, ensureDataDir };
