/**
 * Title spelling: Hunspell (nspell + dictionary-en) for real dictionary coverage,
 * plus a small spell.add() list for domain words (HIIT, Pilates, …).
 * Short tokens are left alone; we only take a suggestion if it clearly wins (no distance tie).
 */

const nspell = require("nspell");

/** Words events often use that stock en_US marks wrong or suggests badly for. */
const DOMAIN_WORDS = [
  "HIIT",
  "hiit",
  "Pilates",
  "pilates",
  "Tabata",
  "tabata",
  "Peloton",
  "peloton",
  "Strava",
  "strava",
  "CalDAV",
  "caldav",
  "Gmail",
  "gmail",
  "iCal",
  "ical",
  "PST",
  "pst",
  "EST",
  "est",
  "CST",
  "cst",
  "MST",
  "mst",
  "UTC",
  "utc",
];

let spellLoadPromise = null;
let spellInstance = null;
let spellLoadFailed = false;

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

function matchCase(original, replacement) {
  if (original === original.toUpperCase() && /[A-Z]/.test(original)) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement.toLowerCase();
}

async function getSpell() {
  if (spellLoadFailed) return null;
  if (spellInstance) return spellInstance;
  if (!spellLoadPromise) {
    spellLoadPromise = new Promise((resolve, reject) => {
      try {
        require("dictionary-en")((err, dict) => {
          if (err) {
            reject(err);
            return;
          }
          try {
            const spell = nspell(dict);
            for (const w of DOMAIN_WORDS) {
              spell.add(w);
            }
            resolve(spell);
          } catch (e) {
            reject(e);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  try {
    spellInstance = await spellLoadPromise;
    return spellInstance;
  } catch {
    spellLoadFailed = true;
    spellInstance = null;
    spellLoadPromise = null;
    return null;
  }
}

async function preloadSpellchecker() {
  await getSpell();
}

function fixWordToken(raw, spell) {
  const m = raw.match(/^([^A-Za-z0-9]*)([A-Za-z][A-Za-z0-9'-]*)([^A-Za-z0-9]*)$/);
  if (!m) return raw;
  const [, pre, core, post] = m;
  if (/\d/.test(core)) return raw;
  if (/[^\x00-\x7F]/.test(core)) return raw;

  const lower = core.toLowerCase();
  if (spell.correct(lower)) return raw;

  if (lower.length < 4) return raw;

  const suggestions = spell.suggest(lower);
  if (!suggestions.length) return raw;

  const best = suggestions[0].toLowerCase();
  const d0 = levenshtein(lower, best);
  if (d0 > 2) return raw;

  if (suggestions.length > 1) {
    const d1 = levenshtein(lower, suggestions[1].toLowerCase());
    if (d1 === d0) return raw;
  }

  return pre + matchCase(core, best) + post;
}

function applyTitleSpell(title, spell) {
  return title
    .split(/(\s+)/)
    .map((segment) => {
      if (!segment.trim()) return segment;
      return segment
        .split(/([-–—])/)
        .map((part, i) => (i % 2 === 1 ? part : fixWordToken(part, spell)))
        .join("");
    })
    .join("");
}

async function refineEventTitleSpelling(title) {
  if (!title || typeof title !== "string") return title;
  const spell = await getSpell();
  if (!spell) return title;
  return applyTitleSpell(title, spell);
}

async function refineParsedEventsTitles(events) {
  if (!Array.isArray(events) || !events.length) return events;
  const spell = await getSpell();
  if (!spell) return events;
  return events.map((ev) => {
    if (!ev || typeof ev.title !== "string") return ev;
    const next = applyTitleSpell(ev.title, spell);
    return next === ev.title ? ev : { ...ev, title: next };
  });
}

module.exports = {
  preloadSpellchecker,
  refineEventTitleSpelling,
  refineParsedEventsTitles,
};
