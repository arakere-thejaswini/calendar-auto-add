const path = require("node:path");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

/**
 * Image → OCR pipeline tuned for event flyers.
 *
 * Tesseract.js by itself is brittle on photos of posters: stylised fonts,
 * banner-on-background text, and shaky phone shots all hurt accuracy. We
 * counter that by:
 *
 *   1. Preprocessing the image into 2–3 variants (different contrast and
 *      thresholding strategies). Each variant favours different kinds of
 *      text — banners on dark backgrounds, low-contrast script fonts, etc.
 *   2. Running two page-segmentation modes per variant (single-block + sparse).
 *   3. Picking the pass whose output looks most "event-like": highest
 *      confidence + recognisable date/time tokens.
 *
 * The chosen pass returns line-level data including a font height (from the
 * bounding box). That's the signal we use for heading detection — the
 * biggest non-date / non-time line is the title, regardless of what words
 * happen to be in it.
 */

const TESS_LANG_PATH = path.resolve(__dirname, "..");
const TESS_CACHE_PATH = process.env.VERCEL
  ? path.join("/tmp", "tesseract-cache")
  : path.join(__dirname, "..", ".tesseract-cache");

const TARGET_WIDTH = 2600;

async function preprocessVariant(srcPath, variant) {
  let pipe = sharp(srcPath).rotate();
  switch (variant) {
    case "contrast":
      pipe = pipe
        .resize({ width: TARGET_WIDTH, fit: "inside", withoutEnlargement: false })
        .grayscale()
        .normalize()
        .linear(1.2, -10)
        .sharpen({ sigma: 1.0 });
      break;
    case "binary":
      /* High-contrast black/white: best on banner text and bold poster type;
       * destroys anti-aliased / script fonts so we never use it alone. */
      pipe = pipe
        .resize({ width: TARGET_WIDTH, fit: "inside", withoutEnlargement: false })
        .grayscale()
        .normalize()
        .threshold(150);
      break;
    case "default":
    default:
      pipe = pipe
        .resize({ width: TARGET_WIDTH, fit: "inside", withoutEnlargement: false })
        .grayscale()
        .normalize()
        .median(1)
        .sharpen({ sigma: 1.2 });
      break;
  }
  return pipe.png().toBuffer();
}

function flattenLines(blocks) {
  const lines = [];
  if (!Array.isArray(blocks)) return lines;
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = (line.text || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const bbox = line.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
        const height = Math.max(0, (bbox.y1 || 0) - (bbox.y0 || 0));
        const rowH = line.rowAttributes?.rowHeight;
        lines.push({
          text,
          confidence: typeof line.confidence === "number" ? line.confidence : 0,
          y0: bbox.y0 || 0,
          y1: bbox.y1 || 0,
          height: rowH && rowH > 0 ? rowH : height,
        });
      }
    }
  }
  return lines;
}

function scorePass(pass) {
  const text = (pass.text || "").trim();
  if (!text) return -1;
  const monthHits = (text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi) || []).length;
  const ampmHits = (text.match(/\d{1,2}(?::\d{2})?\s*[ap]m/gi) || []).length;
  const timeRangeHits = (text.match(/\d{1,2}(?::\d{2})?\s*[ap]m\s*[-–—]/gi) || []).length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  let score = pass.confidence || 0;
  score += monthHits * 12;
  score += ampmHits * 8;
  score += timeRangeHits * 8;
  score += Math.min(wordCount, 100) * 0.3;
  return score;
}

async function runOcrPasses(srcPath) {
  const variants = ["default", "contrast", "binary"];
  /* Tesseract page-segmentation modes:
   *   "6"  – single uniform block of text (default for flyers)
   *   "11" – sparse text, OSD off (better when the layout is non-uniform)
   *   "1"  – auto with orientation+script detection (handles rotated photos) */
  const psms = ["6", "11"];

  let worker;
  try {
    worker = await createWorker("eng", 1, {
      langPath: TESS_LANG_PATH,
      cachePath: TESS_CACHE_PATH,
      gzip: false,
    });
    await worker.setParameters({ preserve_interword_spaces: "1" });

    const passes = [];
    for (const variant of variants) {
      const buf = await preprocessVariant(srcPath, variant);
      for (const psm of psms) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        const result = await worker.recognize(buf, {}, { blocks: true, text: true });
        passes.push({
          variant,
          psm,
          text: result.data.text || "",
          confidence: result.data.confidence || 0,
          lines: flattenLines(result.data.blocks),
        });
      }
    }

    const scored = passes.map((p) => ({ ...p, _score: scorePass(p) }));
    scored.sort((a, b) => b._score - a._score);
    const best = scored[0];

    return {
      text: best.text,
      lines: best.lines,
      meta: {
        chosenVariant: best.variant,
        chosenPsm: best.psm,
        chosenConfidence: best.confidence,
        chosenScore: best._score,
        passSummaries: scored.map((p) => ({
          variant: p.variant,
          psm: p.psm,
          confidence: p.confidence,
          score: p._score,
        })),
      },
    };
  } finally {
    if (worker) {
      await worker.terminate().catch(() => {});
    }
  }
}

module.exports = {
  runOcrPasses,
  TESS_LANG_PATH,
  TESS_CACHE_PATH,
};
