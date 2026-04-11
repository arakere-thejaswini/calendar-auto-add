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

function toPossessive(name) {
  if (name.endsWith("s")) {
    return `${name}'`;
  }
  return `${name}'s`;
}

function normalizeTitle(rawChunk, parsedText) {
  if (/\bbday\b|\bbirthday\b/i.test(rawChunk)) {
    const birthdayName = extractBirthdayName(rawChunk);
    if (birthdayName) {
      return normalizeTitleQuality(`${toPossessive(birthdayName)} Birthday`);
    }
  }

  const cleaned = rawChunk.replace(parsedText, "").replace(/\s+/g, " ").trim();
  const withoutLeadingIs = cleaned.replace(/^is\s+/i, "").trim();

  if (withoutLeadingIs.length > 0) {
    return normalizeTitleQuality(formalizeGenericTitle(withoutLeadingIs) || withoutLeadingIs);
  }

  if (cleaned.length > 0) {
    return normalizeTitleQuality(formalizeGenericTitle(cleaned) || cleaned);
  }

  return rawChunk.length > 0 ? normalizeTitleQuality(formalizeGenericTitle(rawChunk) || rawChunk) : "Event";
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

function parseEventsFromText(text) {
  if (!text || !text.trim()) {
    return [];
  }

  const now = new Date();
  const chunks = splitIntoCandidateChunks(text);
  const events = [];

  for (const chunk of chunks) {
    const results = chrono.parse(chunk, now);
    for (const result of results) {
      const allDay = looksAllDay(chunk);
      const startNormalized = normalizeParsedDate(result.start.date(), result, now, chunk);
      const start = ensureTime(startNormalized, chunk);
      const end = result.end
        ? ensureTime(normalizeParsedDate(result.end.date(), result, now, chunk), chunk)
        : new Date(start.getTime() + DEFAULT_EVENT_DURATION_HOURS * 60 * 60 * 1000);
      const finalStart = allDay ? startOfLocalDay(start) : start;
      const finalEnd = allDay ? nextLocalDay(start) : end;
      const title = normalizeTitle(chunk, result.text);
      events.push({
        title,
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

function parseDateRangeLine(line, now, optionalDatePrefix = "") {
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
  const start = chrono.parseDate(`${dayPrefix}${datePart} ${startPart}`, now);
  let end = chrono.parseDate(`${dayPrefix}${datePart} ${endPart}`, now);
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

function parseEventsFromOcrText(text) {
  if (!text || !text.trim()) {
    return [];
  }

  const now = new Date();
  const lines = correctOcrFlyerTypos(text)
    .split("\n")
    .map(cleanOcrLine)
    .filter(Boolean);
  const structured = [];
  const posterHeading = detectPosterHeading(lines);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let parsedRange = parseDateRangeLine(line, now);
    if (!parsedRange) {
      const dateOnly = extractDateOnlyFromLine(line);
      if (dateOnly && i + 1 < lines.length) {
        parsedRange = parseDateRangeLine(lines[i + 1], now, dateOnly);
      }
    }
    if (!parsedRange) {
      continue;
    }

    const inferredTitle = inferTitleFromNearbyLines(lines, i);
    const title = (inferredTitle === "Event" || isWeakOcrTitle(inferredTitle)) && posterHeading ? posterHeading : inferredTitle;
    structured.push({
      title,
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
  const fallback = parseEventsFromText(fallbackText).filter((event) =>
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
    };
    const key = `${event.title}|${event.start}|${event.end}`;
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
