const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { userEventsPath, ensureUserDir } = require("./userPaths");

async function ensureEventsFile(userId) {
  await ensureUserDir(userId);
  const p = userEventsPath(userId);
  try {
    await fs.access(p);
  } catch {
    await fs.writeFile(p, JSON.stringify([], null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

async function getLocalEvents(userId) {
  await ensureEventsFile(userId);
  const raw = await fs.readFile(userEventsPath(userId), "utf8");
  return JSON.parse(raw);
}

async function saveLocalEvent(userId, event, meta = {}) {
  const events = await getLocalEvents(userId);
  const source = meta.source || event.source || "unknown";
  const { source: _drop, photoId: _ignoreClientPhoto, ...eventFields } = event;
  const newEvent = {
    id: crypto.randomUUID(),
    ...eventFields,
    source,
    destination: meta.destination || "apple",
    calendarRef: meta.calendarRef || "",
    createdAt: new Date().toISOString(),
  };
  if (meta.photoId && /^[a-f0-9]{32}$/.test(meta.photoId)) {
    newEvent.photoId = meta.photoId;
  }

  events.push(newEvent);
  await fs.writeFile(userEventsPath(userId), JSON.stringify(events, null, 2), { encoding: "utf8", mode: 0o600 });
  return newEvent;
}

async function removeLastLocalEvent(userId) {
  const events = await getLocalEvents(userId);
  if (!events.length) {
    return null;
  }
  const sorted = [...events].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const removeId = sorted[0].id;
  const next = events.filter((e) => e.id !== removeId);
  await fs.writeFile(userEventsPath(userId), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  return sorted[0];
}

function countMatchedTerms(title, searchTerms) {
  const lower = (title || "").toLowerCase();
  return searchTerms.filter((term) => lower.includes(term.toLowerCase())).length;
}

async function findUpcomingLocalEventForUpdateIntent(userId, { searchTerms, requiredMatches = 1 }) {
  const events = await getLocalEvents(userId);
  const now = new Date();
  const upcoming = events
    .filter((event) => new Date(event.start) >= now)
    .map((event) => ({
      event,
      matchCount: countMatchedTerms(event.title, searchTerms),
    }))
    .filter((entry) => entry.matchCount >= requiredMatches)
    .sort((a, b) => new Date(a.event.start) - new Date(b.event.start));

  if (!upcoming.length) {
    throw new Error("No upcoming event matched this request.");
  }

  const ev = upcoming[0].event;
  const startD = new Date(ev.start);
  return {
    matchedSummary: ev.title || "",
    matchedCalendar: "",
    matchedStart: startD.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  };
}

async function appendNoteToUpcomingLocalEvent(userId, { noteText, searchTerms, requiredMatches = 1 }) {
  const events = await getLocalEvents(userId);
  const now = new Date();
  const upcoming = events
    .filter((event) => new Date(event.start) >= now)
    .map((event) => ({
      event,
      matchCount: countMatchedTerms(event.title, searchTerms),
    }))
    .filter((entry) => entry.matchCount >= requiredMatches)
    .sort((a, b) => new Date(a.event.start) - new Date(b.event.start));

  if (!upcoming.length) {
    throw new Error("No upcoming local event matched this request.");
  }

  const target = upcoming[0].event;
  const updatedEvents = events.map((event) => {
    if (event.id !== target.id) {
      return event;
    }

    const existing = event.notes || "";
    const addition = `Checklist: ${noteText}`;
    const notes = existing.includes(addition) ? existing : (existing ? `${existing}\n${addition}` : addition);
    return {
      ...event,
      notes,
      updatedAt: new Date().toISOString(),
    };
  });

  await fs.writeFile(userEventsPath(userId), JSON.stringify(updatedEvents, null, 2), { encoding: "utf8", mode: 0o600 });

  return updatedEvents.find((event) => event.id === target.id);
}

module.exports = {
  getLocalEvents,
  saveLocalEvent,
  removeLastLocalEvent,
  findUpcomingLocalEventForUpdateIntent,
  appendNoteToUpcomingLocalEvent,
};
