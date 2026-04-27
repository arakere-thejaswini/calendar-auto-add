const chrono = require("chrono-node");

const DEFAULT_EVENT_HOUR = 9;
const DEFAULT_EVENT_MINUTES = 0;
const DEFAULT_EVENT_DURATION_HOURS = 1;
const OCR_DEFAULT_EVENT_DURATION_HOURS = 2;

function splitIntoCandidateChunks(text) {
  return text
    .split(/\n|\.|;/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function toTitleCase(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (word.length === 1) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function normalizeTitleQuality(title) {
  const cleaned = (title || "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "Event";
  }

  const alphaCount = (cleaned.match(/[A-Za-z]/g) || []).length;
  const symbolCount = (cleaned.match(/[^A-Za-z0-9\s]/g) || []).length;
  if (alphaCount < 2 || symbolCount > alphaCount) {
    return "Event";
  }

  return cleaned;
}

function cleanName(name) {
  return name
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBirthdayName(rawChunk) {
  const patterns = [
    /\bis\s+(.+?)'?s?\s+(bday|birthday)\b/i,
    /\b(.+?)'?s?\s+(bday|birthday)\s+(is|on)\b/i,
    /\b(bday|birthday)\s+for\s+(.+?)(?:\s+(is|on)\b|$)/i,
  ];

  for (const pattern of patterns) {
    const match = rawChunk.match(pattern);
    if (!match) {
      continue;
    }

    const candidate = match[1].toLowerCase() === "bday" || match[1].toLowerCase() === "birthday" ? match[2] : match[1];
    const cleaned = cleanName(candidate);
    if (cleaned) {
      return toTitleCase(cleaned);
    }
  }

  return "";
}

function formalizeGenericTitle(text) {
  const cleaned = text
    .replace(/\b(is|on|at|for|from|to)\b\s*$/i, "")
    .replace(/^\b(is|on|at|for)\b\s+/i, "")
    .replace(/\bbday\b/gi, "Birthday")
    .replace(/[|_~`]+/g, " ")
    .replace(/\b(?:pst|est|cst|mst|utc)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "";
  }

  return toTitleCase(cleaned);
}

/**
 * Pull a trailing location out of a (post-time-stripped) title. Recognised
 * forms, in order:
 *   - "location: X", "venue: X", "place: X", "address: X"  (anywhere)
 *   - "@ X"                                                (anywhere)
 *   - "at X" or "in X"                                     (only at the end)
 *
 * "at"/"in" are intentionally conservative: we only treat them as location
 * cues when they sit at the *end* of the remaining title (after chrono has
 * removed the date/time), and the captured tail isn't a time-of-day word
 * like "noon" or "the morning" or a duration like "30 minutes".
 */
const LOCATION_LABEL_RE = /\b(location|venue|place|address)\s*[:\-]\s*(.+?)\s*$/i;
const LOCATION_AT_SIGN_RE = /(^|\s)@\s*([A-Za-z0-9][^@]+?)\s*$/;
const LOCATION_TRAILING_RE = /\b(at|in)\s+(.+?)\s*$/i;
const LOCATION_BLOCKLIST = new Set([
  "noon", "midnight", "morning", "afternoon", "evening", "night", "midday",
  "tonight", "today", "tomorrow", "yesterday", "person", "advance", "progress",
  "the morning", "the afternoon", "the evening", "the night",
]);
const TIMEY_TAIL_RE = /\d|\b(am|pm|hour|hours|min|mins|minute|minutes|second|seconds)\b/i;

function tidyLocation(raw) {
  return (raw || "")
    .replace(/[|_~`]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "")
    .trim();
}

function extractLocation(text) {
  const original = String(text || "");
  if (!original.trim()) {
    return { remaining: "", location: "" };
  }

  let working = original;

  const labelMatch = working.match(LOCATION_LABEL_RE);
  if (labelMatch) {
    const loc = tidyLocation(labelMatch[2]);
    if (loc) {
      working = working.slice(0, labelMatch.index).replace(/[\s,;:.-]+$/, "");
      return { remaining: working.trim(), location: toTitleCase(loc) };
    }
  }

  const atMatch = working.match(LOCATION_AT_SIGN_RE);
  if (atMatch) {
    /* "tomorrow @ Starbucks 10am" — peel a trailing time off the location */
    const loc = tidyLocation(
      atMatch[2].replace(/\s+\d{1,2}(?::\d{2})?\s*[ap]m\s*$/i, ""),
    );
    if (loc) {
      working = working.slice(0, atMatch.index).replace(/[\s,;:.-]+$/, "");
      return { remaining: working.trim(), location: toTitleCase(loc) };
    }
  }

  const trailing = working.match(LOCATION_TRAILING_RE);
  if (trailing) {
    const loc = tidyLocation(trailing[2]);
    const lcLoc = loc.toLowerCase();
    if (loc && !LOCATION_BLOCKLIST.has(lcLoc) && !TIMEY_TAIL_RE.test(loc)) {
      working = working.slice(0, trailing.index).replace(/[\s,;:.-]+$/, "");
      return { remaining: working.trim(), location: toTitleCase(loc) };
    }
  }

  return { remaining: original.trim(), location: "" };
}

function toPossessive(name) {
  if (name.endsWith("s")) {
    return `${name}'`;
  }
  return `${name}'s`;
}

function normalizeTitleAndLocation(rawChunk, parsedText) {
  if (/\bbday\b|\bbirthday\b/i.test(rawChunk)) {
    const birthdayName = extractBirthdayName(rawChunk);
    if (birthdayName) {
      return {
        title: normalizeTitleQuality(`${toPossessive(birthdayName)} Birthday`),
        location: "",
      };
    }
  }

  const cleaned = rawChunk.replace(parsedText, "").replace(/\s+/g, " ").trim();
  const { remaining, location } = extractLocation(cleaned);
  const withoutLeadingIs = remaining.replace(/^is\s+/i, "").trim();

  let title;
  if (withoutLeadingIs.length > 0) {
    title = normalizeTitleQuality(formalizeGenericTitle(withoutLeadingIs) || withoutLeadingIs);
  } else if (remaining.length > 0) {
    title = normalizeTitleQuality(formalizeGenericTitle(remaining) || remaining);
  } else if (rawChunk.length > 0) {
    title = normalizeTitleQuality(formalizeGenericTitle(rawChunk) || rawChunk);
  } else {
    title = "Event";
  }

  return { title, location };
}

function looksAllDay(rawChunk) {
  return /\bbday\b|\bbirthday\b|\banniversary\b/i.test(rawChunk);
}

function ensureTime(date, sourceText) {
  if (date.getHours() === 12 && date.getMinutes() === 0 && !/\d{1,2}:\d{2}|\b(am|pm)\b/i.test(sourceText)) {
    const adjusted = new Date(date);
    adjusted.setHours(DEFAULT_EVENT_HOUR, DEFAULT_EVENT_MINUTES, 0, 0);
    return adjusted;
  }

  return date;
}

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function nextLocalDay(date) {
  const d = startOfLocalDay(date);
  d.setDate(d.getDate() + 1);
  return d;
}

function hasExplicitYear(text) {
  return /\b(19|20)\d{2}\b/.test(text);
}

function normalizeParsedDate(date, result, now, sourceText) {
  const normalized = new Date(date);
  const hasYear = result.start.isCertain("year") || hasExplicitYear(sourceText);
  const hasMonth = result.start.isCertain("month");
  const hasDay = result.start.isCertain("day");

  if (!hasYear && hasMonth && hasDay) {
    normalized.setFullYear(now.getFullYear());
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    if (normalized < sixMonthsAgo) {
      normalized.setFullYear(now.getFullYear() + 1);
    }
  }

  return normalized;
}

/**
 * Build chrono's parsing reference. When `tzOffsetMin` is provided (minutes
 * east of UTC, ISO-style — e.g. `-420` for PDT), chrono interprets bare
 * times like "1pm" in that timezone instead of the server's local timezone.
 * Without this, a UTC-running server (Vercel, Fly, etc.) would treat "1pm"
 * as 1pm UTC and the user would see it shifted by their offset.
 */
function buildChronoRef(now, tzOffsetMin) {
  if (typeof tzOffsetMin === "number" && Number.isFinite(tzOffsetMin)) {
    return { instant: now, timezone: tzOffsetMin };
  }
  return now;
}

function parseEventsFromText(text, options = {}) {
  if (!text || !text.trim()) {
    return [];
  }

  const now = new Date();
  const ref = buildChronoRef(now, options.tzOffsetMin);
  const chunks = splitIntoCandidateChunks(text);
  const events = [];

  for (const chunk of chunks) {
    const results = chrono.parse(chunk, ref);
    for (const result of results) {
      const allDay = looksAllDay(chunk);
      const startNormalized = normalizeParsedDate(result.start.date(), result, now, chunk);
      const start = ensureTime(startNormalized, chunk);
      const end = result.end
        ? ensureTime(normalizeParsedDate(result.end.date(), result, now, chunk), chunk)
        : new Date(start.getTime() + DEFAULT_EVENT_DURATION_HOURS * 60 * 60 * 1000);
      const finalStart = allDay ? startOfLocalDay(start) : start;
      const finalEnd = allDay ? nextLocalDay(start) : end;
      const { title, location } = normalizeTitleAndLocation(chunk, result.text);
      events.push({
        title,
        location,
        sourceText: chunk,
        start: finalStart.toISOString(),
        end: finalEnd.toISOString(),
        allDay,
      });
    }
  }

  return dedupeAndNormalize(events);
}

function correctOcrFlyerTypos(text) {
  if (!text) return text;
  let t = text;
  // Common B/R confusion on posters (e.g. "Therapeutic Runny Experience")
  t = t.replace(/\btherapeutic\s+runny\b/gi, "Therapeutic Bunny");
  t = t.replace(/\brunny\s+experience\b/gi, "Bunny Experience");
  if (/\bbunnies\b|\bbunny\b/i.test(t) && /\brunny\b/i.test(t)) {
    t = t.replace(/\brunny\b/gi, "Bunny");
  }
  return t;
}

function cleanOcrLine(line) {
  return (line || "")
    .replace(/[|]{2,}/g, " ")
    .replace(/[^\w\s:,'&()\/.-]/g, " ")
    .replace(/\b[il]pm\b/gi, "1pm")
    .replace(/\b[il]am\b/gi, "1am")
    .replace(/\b0([1-9])([0-9])([ap]m)\b/gi, "$1:$2$3")
    .replace(/(\d{1,2}):(\d{3})(\s*[ap]m)/gi, (_m, h, mins, suffix) => `${h}:${mins.slice(0, 2)}${suffix}`)
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeTimeToken(token) {
  const match = token.match(/(\d{1,2})(?::(\d{1,3}))?\s*([ap]m)/i);
  if (!match) {
    return token;
  }
  const hour = match[1];
  let minutes = match[2] || "00";
  const suffix = match[3].toLowerCase();
  if (minutes.length === 1) minutes = `${minutes}0`;
  if (minutes.length > 2) minutes = minutes.slice(0, 2);
  return `${hour}:${minutes}${suffix}`;
}

function parseDateRangeLine(line, ref, optionalDatePrefix = "") {
  const normalized = `${optionalDatePrefix} ${line}`
    .replace(/\bfrom\b/i, "")
    .replace(/\bPST\b|\bEST\b|\bCST\b|\bMST\b|\bUTC\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const range = normalized.match(
    /((?:mon|tue|wed|thu|fri|sat|sun)\w*,?\s+)?([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?)\s+(\d{1,2}(?::\d{2})?\s?(?:am|pm))\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?\s?(?:am|pm))/i
  );
  if (!range) {
    return null;
  }

  const dayPrefix = range[1] || "";
  const datePart = range[2];
  const startPart = sanitizeTimeToken(range[3]);
  const endPart = sanitizeTimeToken(range[4]);
  const start = chrono.parseDate(`${dayPrefix}${datePart} ${startPart}`, ref);
  let end = chrono.parseDate(`${dayPrefix}${datePart} ${endPart}`, ref);
  if (!start || !end) {
    return null;
  }
  if (end <= start) {
    end = new Date(start.getTime() + OCR_DEFAULT_EVENT_DURATION_HOURS * 60 * 60 * 1000);
  }

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    sourceText: normalized,
    allDay: false,
  };
}

function extractDateOnlyFromLine(line) {
  const match = line.match(/((?:mon|tue|wed|thu|fri|sat|sun)\w*,?\s+)?([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?)/i);
  if (!match) {
    return "";
  }
  return `${match[1] || ""}${match[2]}`.trim();
}

function inferTitleFromNearbyLines(lines, index) {
  for (let i = index - 1; i >= 0 && i >= index - 8; i -= 1) {
    const line = cleanOcrLine(lines[i]);
    if (!line) continue;
    if (
      /\d{1,2}:\d{2}|\b(am|pm)\b|\bapril\b|\bmay\b|\bjune\b|\bjuly\b|\baug\b|\bsep\b|\boct\b|\bnov\b|\bdec\b|\blocation\b/i.test(line)
    ) {
      continue;
    }
    if (/\btake a moment|awareness month|please arrive|sign in|get settled|guided mindfulness\b/i.test(line.toLowerCase())) {
      continue;
    }

    if (line.includes(":")) {
      const fromColon = normalizeTitleQuality(toTitleCase(line.replace(/.*?\b([A-Za-z][A-Za-z\s&'-]{2,})\s*:.*/, "$1").trim()));
      if (!isWeakOcrTitle(fromColon)) {
        return fromColon;
      }
    }

    if (line.split(/\s+/).length > 6) {
      continue;
    }
  }

  const candidates = [];
  for (let i = index - 1; i >= 0 && i >= index - 8; i -= 1) {
    const line = cleanOcrLine(lines[i]);
    if (!line) continue;
    if (line.split(/\s+/).length <= 6 && !/\d{1,2}:\d{2}|\b(am|pm)\b/i.test(line)) {
      candidates.push(line);
    }
  }

  if (candidates.length === 0) {
    return "Event";
  }

  const scored = candidates.map((line) => {
    let score = 0;
    if (line.includes(":")) score += 3;
    if (line.split(/\s+/).length <= 4) score += 2;
    if (/class|yoga|pilates|massage|experience|show|session|workshop|therapy|hit|blast/i.test(line)) score += 3;
    return { line, score };
  });
  scored.sort((a, b) => b.score - a.score);

  return normalizeTitleQuality(toTitleCase(scored[0].line.replace(/:\s*.*$/, "")));
}

function isWeakOcrTitle(title) {
  const raw = title || "";
  const cleaned = raw.replace(/[^A-Za-z]/g, "");
  if (!cleaned) return true;
  const vowels = (cleaned.match(/[aeiou]/gi) || []).length;
  if (vowels < 1) return true;
  if (cleaned.length <= 2) return true;
  const words = raw.split(/\s+/).filter(Boolean);
  const hasKeyword = /\b(yoga|pilates|massage|class|experience|workshop|event|session|birthday|meeting|show|blast|hit|therapy|bunny)\b/i.test(raw);
  if (!hasKeyword && words.every((word) => word.length <= 3)) return true;
  return false;
}

function detectPosterHeading(lines) {
  const headerLines = [];
  for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
    const line = cleanOcrLine(lines[i]).replace(/\d+/g, "").trim();
    if (!line) continue;
    const lettersOnly = line.replace(/[^A-Za-z]/g, "");
    const vowelCount = (lettersOnly.match(/[aeiou]/gi) || []).length;
    if (lettersOnly.length < 4 || vowelCount < 1) {
      continue;
    }
    if (line.split(/\s+/).every((word) => word.length <= 2)) {
      continue;
    }
    const hasKeyword = /\b(experience|class|event|workshop|yoga|pilates|massage|bunny|therapy|wellness)\b/i.test(line);
    if ((/^[A-Z\s]{4,}$/.test(line.toUpperCase()) || hasKeyword) && line.split(/\s+/).length <= 4 && line.length >= 4) {
      headerLines.push(toTitleCase(line));
      if (headerLines.length === 2) break;
    }
  }
  if (headerLines.length === 0) return "";
  return normalizeTitleQuality(headerLines.join(" "));
}

function findLocationLineNearby(lines, index) {
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    const m = ln.match(/^\s*(location|venue|address|place)\s*[:\-]\s*(.+)$/i);
    if (m && Math.abs(i - index) <= 6) {
      const loc = tidyLocation(m[2]);
      if (loc) return toTitleCase(loc);
    }
  }
  return "";
}

function parseEventsFromOcrText(text, options = {}) {
  if (!text || !text.trim()) {
    return [];
  }

  const now = new Date();
  const ref = buildChronoRef(now, options.tzOffsetMin);
  const lines = correctOcrFlyerTypos(text)
    .split("\n")
    .map(cleanOcrLine)
    .filter(Boolean);
  const structured = [];
  const posterHeading = detectPosterHeading(lines);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let parsedRange = parseDateRangeLine(line, ref);
    if (!parsedRange) {
      const dateOnly = extractDateOnlyFromLine(line);
      if (dateOnly && i + 1 < lines.length) {
        parsedRange = parseDateRangeLine(lines[i + 1], ref, dateOnly);
      }
    }
    if (!parsedRange) {
      continue;
    }

    const inferredTitle = inferTitleFromNearbyLines(lines, i);
    const title = (inferredTitle === "Event" || isWeakOcrTitle(inferredTitle)) && posterHeading ? posterHeading : inferredTitle;
    const location = findLocationLineNearby(lines, i);
    structured.push({
      title,
      location,
      sourceText: parsedRange.sourceText,
      start: parsedRange.start,
      end: parsedRange.end,
      allDay: false,
    });
  }

  if (structured.length >= 1) {
    return dedupeAndNormalize(structured).filter((event) => event.title !== "Event");
  }

  const fallbackText = lines.join("\n");
  const fallback = parseEventsFromText(fallbackText, options).filter((event) =>
    /\d{1,2}:\d{2}|\b(am|pm)\b/i.test(event.sourceText || "")
  );
  return dedupeAndNormalize(fallback).filter((event) => event.title !== "Event");
}

function dedupeAndNormalize(events) {
  const deduped = [];
  const seen = new Set();
  for (const rawEvent of events) {
    const event = {
      ...rawEvent,
      title: normalizeTitleQuality(formalizeGenericTitle(rawEvent.title || "") || rawEvent.title || "Event"),
      location: rawEvent.location ? String(rawEvent.location).trim() : "",
    };
    const key = `${event.title}|${event.start}|${event.end}|${event.location}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(event);
    }
  }
  return deduped;
}

module.exports = {
  parseEventsFromText,
  parseEventsFromOcrText,
};
