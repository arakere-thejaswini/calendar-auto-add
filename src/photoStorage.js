const path = require("node:path");
const fs = require("node:fs/promises");
const { put: blobPut, del: blobDel } = require("@vercel/blob");
const { userBaseDir, ensureUserDir, assertValidUserId } = require("./userPaths");

/**
 * Durable photo storage.
 *
 * On Vercel the local filesystem is /tmp (per-instance, ephemeral) so saving
 * event photos to disk loses them on every cold start. When BLOB_READ_WRITE_
 * TOKEN is present (auto-injected by Vercel when you connect a Blob store to
 * the project), photos go to Vercel Blob and the saved event records the
 * blob URL directly. Without the token we fall back to the existing local-
 * file behaviour, which is correct for local dev and Fly with a mounted
 * volume.
 */

const HAS_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

function isBlobEnabled() {
  return HAS_BLOB;
}

function blobKey(userId, photoId) {
  return `event-photos/${assertValidUserId(userId)}/${photoId}.webp`;
}

/**
 * Persist a photo (already encoded to webp Buffer) and return the
 * lookup info to store on the event.
 *   - HAS_BLOB:   { photoId, photoUrl: "<blob-url>" }
 *   - file mode:  { photoId, photoUrl: null }   (client falls back to
 *                 /api/event-photos/:photoId)
 */
async function savePhotoBuffer(userId, photoId, buffer) {
  if (HAS_BLOB) {
    const result = await blobPut(blobKey(userId, photoId), buffer, {
      access: "public",
      contentType: "image/webp",
      addRandomSuffix: false,
    });
    return { photoId, photoUrl: result.url };
  }

  await ensureUserDir(userId);
  const dir = path.join(userBaseDir(userId), "event-photos");
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${photoId}.webp`);
  await fs.writeFile(outPath, buffer);
  return { photoId, photoUrl: null };
}

async function getLocalPhotoPath(userId, photoId) {
  const abs = path.resolve(path.join(userBaseDir(userId), "event-photos", `${photoId}.webp`));
  try {
    await fs.access(abs);
    return abs;
  } catch {
    return null;
  }
}

async function deletePhoto(userId, photoId, photoUrl) {
  if (HAS_BLOB && photoUrl) {
    try {
      await blobDel(photoUrl);
    } catch {
      /* ignore — best effort */
    }
    return;
  }
  const abs = await getLocalPhotoPath(userId, photoId);
  if (abs) {
    try {
      await fs.unlink(abs);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  isBlobEnabled,
  savePhotoBuffer,
  getLocalPhotoPath,
  deletePhoto,
};
