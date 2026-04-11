# Session log — reference for later

This file summarizes work done across the Calendar Auto Add project (including the conversation that led to the current UI and behavior). Use it to remember **what changed** and **where it lives in code**.

---

## What the app does

- **Parse events** from typed text (`chrono-node`), Gmail (Google APIs + review queue), and images (`tesseract.js` + `sharp` preprocessing + OCR-specific parser).
- **Add events** to **Apple Calendar** (via `osascript` / AppleScript).
- **Mirror every added event** into **local JSON storage** so the **“Events Added”** section is a history of everything the app saved (not a separate “local-only” destination).
- **Gmail**: OAuth (PKCE when no client secret), inbox scan, suggestions with confidence/reasons, approve/reject/block sender, background polling (preset interval; no monitor UI).
- **Share**: Google Calendar template URL (short `details`), `.ics` via token, modal with WhatsApp / copy message / native share.
- **Quick update**: natural language to append notes to an upcoming Apple Calendar event (`updateIntentParser.js`).

---

## Important files

| Area | Path |
|------|------|
| Server / routes | `server.js` |
| Text + OCR parsing | `src/eventParser.js` |
| Apple Calendar | `src/calendarService.js` |
| Local event JSON | `src/storage.js` |
| Gmail + OAuth | `src/gmailService.js` |
| Review queue persistence | `src/reviewQueueStore.js`, `data/review_queue.json` |
| Share links / ICS | `src/shareService.js` |
| NL “update event” | `src/updateIntentParser.js` |
| Web UI | `public/index.html`, `public/styles.css`, `public/app.js` |
| Gmail OAuth config | `data/gmail_credentials.json` |

---

## UI / UX changes (organized app)

- **Header**: single **Apple Calendar** dropdown (which writable calendar to use). Removed “Save to Apple vs local” — everything goes to Apple + local log.
- **Layout**: two-column **Type** / **Photo** → **Extracted Events** → **Update existing event** → **Gmail Inbox** → **Events Added**.
- **Gmail**: removed poll interval, polling toggle, and “strict parsing” checkboxes from the UI; defaults stay in `reviewQueueStore` (`pollingEnabled`, `pollIntervalSec`, etc.).
- **Gmail processed visibility**: pending under **“Needs your review”** with **Action needed** pill; **“Already processed”** is always visible (not collapsed), human-readable statuses (**Added to calendar**, **Rejected**, **Could not add**), subject/from/email link, color bars, sort by `updatedAt`.
- **Share modal**: preview message, WhatsApp, copy, system share, Google / ICS; raw links in `<details>`.

---

## Bug fixes worth remembering

### Apple Calendar time wrong (e.g. 11 AM → 6 PM)

- **Cause**: AppleScript used **local midnight Jan 1, 1970** as epoch base while Node passed **Unix seconds from UTC midnight**.
- **Fix**: `appleScriptEpochOffsetSeconds()` + `unixSecondsForAppleScript()` in `src/calendarService.js`; used for **add** and **verify**.

### OCR title “Runny” vs “Bunny”

- **Fix**: `correctOcrFlyerTypos()` in `src/eventParser.js` (runs at start of `parseEventsFromOcrText`): therapeutic runny → therapeutic bunny, runny experience → bunny experience, and runny → bunny when bunny/bunnies appears in text.

### Google share URL too long

- **Fix**: `createConciseDetails()` in `src/shareService.js` — only ref + URL in `details`; `shareMessage` includes title + formatted date + link.

### Other historical fixes (from earlier iterations)

- ISO strings in AppleScript → switched to Unix timestamps.
- Gmail OAuth: PKCE, callback in same tab, token exchange consolidated.
- Gmail parsing: HTML strip, scoring, explicit date/time heuristics, link cleanup.

---

## Server behavior highlights

- **`addEventToTarget`** (in `server.js`): adds to Apple Calendar, then **`saveLocalEvent`** — returns `{ destination: "apple", event: saved }`.
- **`POST /api/events/add`**: same dual save; no `target` body field.
- **`POST /api/events/update-note-from-text`**: Apple Calendar only (no local-only branch in API).
- **OAuth callback**: after success, **`refreshMonitorTimer`** + **`runQueueScan`** so inbox fills quickly.

---

## How to run

```bash
cd calendar-auto-add
npm install
npm run dev   # or npm start
```

Open `http://localhost:3030`. Gmail redirect URI: `http://localhost:3030/api/gmail/oauth/callback`.

---

## If you continue development

- Re-read **`src/calendarService.js`** whenever changing Apple event times (epoch offset must stay consistent with AppleScript base date).
- OCR improvements: **`src/eventParser.js`** (`parseEventsFromOcrText`, `correctOcrFlyerTypos`, poster heading / date-range logic).
- Gmail strictness: **`data/review_queue.json`** / **`reviewQueueStore`** defaults (`requireExplicitDateTime`, `requireEventIntent`) — still enforced server-side even though UI toggles were removed.

---

*Last updated from chat session (April 2026).*
