const { spawn } = require("node:child_process");

/**
 * AppleScript's `date "Jan 1, 1970 12:00 AM"` is local midnight, but Unix timestamps
 * count from UTC midnight. Without correcting, events shift by the timezone offset (e.g. 11am → 6pm).
 */
function appleScriptEpochOffsetSeconds() {
  const utcMs = Date.UTC(1970, 0, 1, 0, 0, 0, 0);
  const localMs = new Date(1970, 0, 1, 0, 0, 0, 0).getTime();
  return Math.round((localMs - utcMs) / 1000);
}

function unixSecondsForAppleScript(isoOrDate) {
  const unix = Math.floor(new Date(isoOrDate).getTime() / 1000);
  return unix - appleScriptEpochOffsetSeconds();
}

function runAppleScript(script, args) {
  return new Promise((resolve, reject) => {
    const process = spawn("osascript", ["-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", (error) => {
      reject(error);
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || "AppleScript failed"));
      }
    });
  });
}

async function addEventToAppleCalendar(event, calendarName = "Home") {
  if (process.platform !== "darwin") {
    throw new Error("Apple Calendar is only available on macOS (Calendar.app). Choose a Google Calendar instead.");
  }
  const startEpochSeconds = unixSecondsForAppleScript(event.start);
  const endEpochSeconds = unixSecondsForAppleScript(event.end);

  const script = `
on run argv
  set eventTitle to item 1 of argv
  set startEpoch to item 2 of argv as integer
  set endEpoch to item 3 of argv as integer
  set calendarName to item 4 of argv
  set isAllDay to item 5 of argv
  set eventNotes to item 6 of argv
  set eventUrl to item 7 of argv

  set epochBase to date "Thursday, January 1, 1970 at 12:00:00 AM"
  set startDate to epochBase + startEpoch
  set endDate to epochBase + endEpoch
  set allDayFlag to (isAllDay is "true")

  tell application "Calendar"
    if calendarName is "" then
      set targetCalendar to first calendar whose writable is true
    else if (exists calendar calendarName) then
      set targetCalendar to calendar calendarName
    else
      set targetCalendar to first calendar whose writable is true
    end if

    set eventProps to {summary:eventTitle, start date:startDate, end date:endDate, allday event:allDayFlag, description:eventNotes}
    if eventUrl is not "" then
      set eventProps to eventProps & {url:eventUrl}
    end if

    tell targetCalendar
      make new event with properties eventProps
    end tell
  end tell

  return "ok"
end run
`;

  await runAppleScript(script, [
    event.title,
    String(startEpochSeconds),
    String(endEpochSeconds),
    calendarName || "",
    String(Boolean(event.allDay)),
    event.notes || "",
    event.url || "",
  ]);
}

async function verifyEventInAppleCalendar(event, calendarName = "") {
  const startEpochSeconds = unixSecondsForAppleScript(event.start);

  const script = `
on run argv
  set eventTitle to item 1 of argv
  set startEpoch to item 2 of argv as integer
  set calendarName to item 3 of argv
  set epochBase to date "Thursday, January 1, 1970 at 12:00:00 AM"
  set startDate to epochBase + startEpoch
  set dayStart to startDate
  set time of dayStart to 0
  set dayEnd to dayStart + (24 * hours)

  tell application "Calendar"
    if calendarName is "" then
      set targetCalendar to first calendar whose writable is true
    else if (exists calendar calendarName) then
      set targetCalendar to calendar calendarName
    else
      set targetCalendar to first calendar whose writable is true
    end if

    tell targetCalendar
      set matches to every event whose summary is eventTitle and start date ≥ dayStart and start date < dayEnd
      return (count of matches)
    end tell
  end tell
end run
`;

  const raw = await runAppleScript(script, [event.title, String(startEpochSeconds), calendarName || ""]);
  return Number(raw) > 0;
}

async function openEventInAppleCalendar(event, calendarName = "") {
  const script = `
on run argv
  tell application "Calendar"
    activate
  end tell

  return "ok"
end run
`;

  await runAppleScript(script, []);
}

async function getWritableAppleCalendars() {
  if (process.platform !== "darwin") {
    return [];
  }
  const script = `
tell application "Calendar"
  set namesList to name of every calendar whose writable is true
  set AppleScript's text item delimiters to "||"
  return namesList as text
end tell
`;

  const raw = await runAppleScript(script, []);
  if (!raw.trim()) {
    return [];
  }

  return raw.split("||").map((name) => name.trim()).filter(Boolean);
}

async function findUpcomingAppleEventMatch({ searchTerms, requiredMatches = 1, calendarName = "" }) {
  const script = `
on run argv
  set termsRaw to item 1 of argv
  set requiredMatches to item 2 of argv as integer
  set calendarName to item 3 of argv
  set nowDate to current date
  set bestStart to date "Friday, January 1, 2999 at 12:00:00 AM"
  set foundAny to false
  set matchedSummary to ""
  set matchedCalendar to ""
  set matchedStartText to ""

  set AppleScript's text item delimiters to "||"
  set termList to text items of termsRaw
  set AppleScript's text item delimiters to ""

  tell application "Calendar"
    if calendarName is "" then
      set candidateCalendars to every calendar whose writable is true
    else if (exists calendar calendarName) then
      set candidateCalendars to {calendar calendarName}
    else
      set candidateCalendars to every calendar whose writable is true
    end if

    repeat with cal in candidateCalendars
      tell cal
        set upcomingEvents to every event whose start date ≥ nowDate
        repeat with ev in upcomingEvents
          set evSummary to summary of ev as text
          set matchCount to 0

          ignoring case
            repeat with termValue in termList
              set termText to termValue as text
              if termText is not "" then
                if evSummary contains termText then
                  set matchCount to matchCount + 1
                end if
              end if
            end repeat
          end ignoring

          if matchCount ≥ requiredMatches then
            set evStart to start date of ev
            if evStart < bestStart then
              set bestStart to evStart
              set foundAny to true
              set matchedSummary to evSummary
              set matchedCalendar to name of cal
              set matchedStartText to (evStart as text)
            end if
          end if
        end repeat
      end tell
    end repeat
  end tell

  if foundAny is false then
    error "No upcoming event matched this request."
  end if

  return matchedCalendar & "||" & matchedSummary & "||" & matchedStartText
end run
`;

  const raw = await runAppleScript(script, [(searchTerms || []).join("||"), String(requiredMatches), calendarName || ""]);
  const [matchedCalendar, matchedSummary, matchedStart] = raw.split("||");
  return {
    matchedCalendar: matchedCalendar || "",
    matchedSummary: matchedSummary || "",
    matchedStart: matchedStart || "",
  };
}

async function appendNoteToUpcomingAppleEvent({ noteText, searchTerms, requiredMatches = 1, calendarName = "" }) {
  const script = `
on run argv
  set noteText to item 1 of argv
  set termsRaw to item 2 of argv
  set requiredMatches to item 3 of argv as integer
  set calendarName to item 4 of argv
  set nowDate to current date
  set bestStart to date "Friday, January 1, 2999 at 12:00:00 AM"
  set foundAny to false
  set matchedSummary to ""
  set matchedCalendar to ""
  set matchedStartText to ""

  set AppleScript's text item delimiters to "||"
  set searchTerms to text items of termsRaw
  set AppleScript's text item delimiters to ""

  tell application "Calendar"
    if calendarName is "" then
      set candidateCalendars to every calendar whose writable is true
    else if (exists calendar calendarName) then
      set candidateCalendars to {calendar calendarName}
    else
      set candidateCalendars to every calendar whose writable is true
    end if

    repeat with cal in candidateCalendars
      tell cal
        set upcomingEvents to every event whose start date ≥ nowDate
        repeat with ev in upcomingEvents
          set evSummary to summary of ev as text
          set matchCount to 0

          ignoring case
            repeat with termValue in searchTerms
              set termText to termValue as text
              if termText is not "" then
                if evSummary contains termText then
                  set matchCount to matchCount + 1
                end if
              end if
            end repeat
          end ignoring

          if matchCount ≥ requiredMatches then
            set evStart to start date of ev
            if evStart < bestStart then
              set bestStart to evStart
              set foundAny to true
              set matchedSummary to evSummary
              set matchedCalendar to name of cal
              set matchedStartText to (evStart as text)

              set oldDescription to description of ev
              if oldDescription is missing value then
                set oldDescription to ""
              end if
              if oldDescription is "" then
                set description of ev to ("Checklist: " & noteText)
              else
                if oldDescription does not contain noteText then
                  set description of ev to (oldDescription & return & "Checklist: " & noteText)
                end if
              end if
            end if
          end if
        end repeat
      end tell
    end repeat
  end tell

  if foundAny is false then
    error "No upcoming event matched this request."
  end if

  return matchedCalendar & "||" & matchedSummary & "||" & matchedStartText
end run
`;

  const raw = await runAppleScript(script, [noteText, (searchTerms || []).join("||"), String(requiredMatches), calendarName || ""]);
  const [matchedCalendar, matchedSummary, matchedStart] = raw.split("||");
  return {
    matchedCalendar: matchedCalendar || "",
    matchedSummary: matchedSummary || "",
    matchedStart: matchedStart || "",
  };
}

module.exports = {
  addEventToAppleCalendar,
  getWritableAppleCalendars,
  verifyEventInAppleCalendar,
  openEventInAppleCalendar,
  findUpcomingAppleEventMatch,
  appendNoteToUpcomingAppleEvent,
};
