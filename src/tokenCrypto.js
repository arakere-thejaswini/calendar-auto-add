const crypto = require("node:crypto");

const PREFIX = "cue1:";
const KEY_B64 = process.env.TOKEN_ENCRYPTION_KEY || "";
let keyBuf = null;

if (KEY_B64) {
  keyBuf = Buffer.from(KEY_B64, "base64");
  if (keyBuf.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be base64 encoding of exactly 32 bytes.");
  }
}

function seal(plainText) {
  if (!keyBuf) {
    return plainText;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function open(sealed) {
  if (!keyBuf) {
    return sealed;
  }
  if (!sealed.startsWith(PREFIX)) {
    return sealed;
  }
  const rest = sealed.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = rest.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

module.exports = { seal, open };
