const crypto = require("node:crypto");

const shareMap = new Map();
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toGoogleDateTime(isoString) {
  const d = new Date(isoString);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const min = pad2(d.getUTCMinutes());
  const sec = pad2(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${min}${sec}Z`;
}

function toGoogleAllDayDate(isoString) {
  const d = new Date(isoString);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  return `${yyyy}${mm}${dd}`;
}

function escapeIcsValue(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function toIcsDateTime(isoString) {
  const d = new Date(isoString);
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const min = pad2(d.getUTCMinutes());
  const sec = pad2(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${min}${sec}Z`;
}

function cleanExpiredShareLinks() {
  const now = Date.now();
  for (const [token, value] of shareMap.entries()) {
    if (value.expiresAt <= now) {
      shareMap.delete(token);
    }
  }
}

function createConciseDetails(event) {
  const parts = [];
  if (event.notes) {
    const refMatch = event.notes.match(
      /(?:Confirmation|Booking|Reference|Order|Reservation)\s*(?:#|number|no\.?)?\s*:?\s*([A-Z0-9-]{4,})/i
    );
    if (refMatch) parts.push(`Ref: ${refMatch[1]}`);
  }
  if (event.url) parts.push(event.url);
  return parts.join("\n");
}

function formatEventDate(isoString, allDay) {
  const d = new Date(isoString);
  const opts = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  const dateStr = d.toLocaleDateString("en-US", opts);
  if (allDay) return dateStr;
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${dateStr} at ${timeStr}`;
}

function createGoogleCalendarLink(event) {
  const title = event.title || "Event";
  const details = createConciseDetails(event);
  const location = event.location || "";
  let dates = "";

  if (event.allDay) {
    const start = toGoogleAllDayDate(event.start);
    const end = toGoogleAllDayDate(event.end);
    dates = `${start}/${end}`;
  } else {
    const start = toGoogleDateTime(event.start);
    const end = toGoogleDateTime(event.end);
    dates = `${start}/${end}`;
  }

  const params = new URLSearchParams({ action: "TEMPLATE", text: title, dates });
  if (details) params.set("details", details);
  if (location) params.set("location", location);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildIcsContent(event) {
  const uid = `${crypto.randomUUID()}@calendar-auto-add`;
  const dtstamp = toIcsDateTime(new Date().toISOString());
  const summary = escapeIcsValue(event.title || "Event");
  const description = escapeIcsValue(event.notes || "");
  const url = escapeIcsValue(event.url || "");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calendar Auto Add//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
  ];

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toGoogleAllDayDate(event.start)}`);
    lines.push(`DTEND;VALUE=DATE:${toGoogleAllDayDate(event.end)}`);
  } else {
    lines.push(`DTSTART:${toIcsDateTime(event.start)}`);
    lines.push(`DTEND:${toIcsDateTime(event.end)}`);
  }

  lines.push(`SUMMARY:${summary}`);
  if (description) {
    lines.push(`DESCRIPTION:${description}`);
  }
  if (url) {
    lines.push(`URL:${url}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR", "");

  return lines.join("\r\n");
}

function createShareLinks(event, baseUrl) {
  cleanExpiredShareLinks();
  const token = crypto.randomUUID();
  const icsContent = buildIcsContent(event);
  shareMap.set(token, {
    icsContent,
    fileName: `${(event.title || "event").replace(/[^\w-]+/g, "_") || "event"}.ics`,
    createdAt: Date.now(),
    expiresAt: Date.now() + SHARE_TTL_MS,
  });

  const googleCalendarLink = createGoogleCalendarLink(event);
  const icsDownloadLink = `${baseUrl}/api/events/share-ics/${token}`;
  const title = event.title || "Event";
  const when = formatEventDate(event.start, event.allDay);
  const shareMessage = `${title}\n${when}\n\nAdd to calendar: ${googleCalendarLink}`;

  return { googleCalendarLink, icsDownloadLink, shareMessage, token };
}

function getSharedIcsByToken(token) {
  cleanExpiredShareLinks();
  const entry = shareMap.get(token);
  if (!entry) {
    return null;
  }
  return entry;
}

module.exports = {
  createShareLinks,
  getSharedIcsByToken,
};
