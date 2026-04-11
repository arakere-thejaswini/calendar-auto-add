const { google } = require("googleapis");
const { getAuthorizedClient } = require("./gmailService");

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymdLocal(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

function addOneDayYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return ymdLocal(dt);
}

function toGoogleEventBody(event) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const body = {
    summary: event.title || "Event",
    description: event.notes || undefined,
  };
  if (event.url) {
    body.source = { url: event.url };
  }
  if (event.allDay) {
    const startDate = ymdLocal(event.start);
    let endDate = ymdLocal(event.end);
    if (endDate <= startDate) {
      endDate = addOneDayYmd(startDate);
    }
    body.start = { date: startDate };
    body.end = { date: endDate };
  } else {
    body.start = { dateTime: new Date(event.start).toISOString(), timeZone };
    body.end = { dateTime: new Date(event.end).toISOString(), timeZone };
  }
  return body;
}

async function listWritableGoogleCalendars(baseUrl, userId) {
  const auth = await getAuthorizedClient(baseUrl, userId);
  const cal = google.calendar({ version: "v3", auth });
  // Do not use minAccessRole — with some accounts/scopes it returns an empty list even when
  // calendar.events is granted. Filter client-side instead.
  const res = await cal.calendarList.list({
    maxResults: 250,
  });
  const items = res.data.items || [];
  const writableRoles = new Set(["owner", "writer"]);

  const mapped = [];
  const seen = new Set();
  for (const item of items) {
    const canWrite =
      item.primary === true || (item.accessRole && writableRoles.has(item.accessRole));
    if (!canWrite) continue;
    const id = item.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    mapped.push({
      id,
      summary: item.summary || id || "Calendar",
      primary: Boolean(item.primary),
    });
  }

  mapped.sort((a, b) => {
    if (a.primary) return -1;
    if (b.primary) return 1;
    return (a.summary || "").localeCompare(b.summary || "", undefined, { sensitivity: "base" });
  });

  // Guaranteed target for Google API (always valid for the signed-in account).
  if (!mapped.length) {
    mapped.push({ id: "primary", summary: "Primary calendar", primary: true });
  }

  return mapped;
}

async function insertGoogleCalendarEvent(baseUrl, calendarId, event, userId) {
  const auth = await getAuthorizedClient(baseUrl, userId);
  const cal = google.calendar({ version: "v3", auth });
  const requestBody = toGoogleEventBody(event);
  const res = await cal.events.insert({
    calendarId,
    requestBody,
  });
  return res.data;
}

module.exports = {
  listWritableGoogleCalendars,
  insertGoogleCalendarEvent,
};
