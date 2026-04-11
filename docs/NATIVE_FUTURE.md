# Native app directions (Phase D — future)

The web app at `http://localhost:3030` now supports **drag-and-drop** and **clipboard paste** for images on the **Quick add** tab. That covers the “drag-in” workflow without installing anything extra.

If you want a more Mac-native experience later, these are the usual next steps:

## Menu bar or minimal window

- **Electron** or **Tauri** wrapper around the same Express server (or bundled static build + local API).
- Pros: dock icon, always-available window. Cons: larger install, code signing, updates.

## Share extension (macOS)

- Requires an **Xcode** target (App Extension) that POSTs image/text to this app’s local server or uses App Groups + a tiny helper.
- Not available from a plain browser tab; needs a signed Mac app.

## Handoff from iPhone

- Today the server is bound to `localhost`. To capture photos from a phone you’d expose the server on the LAN (HTTPS + auth) or sync via iCloud/Dropbox into a watched folder — separate product decision.

Use this doc when scoping a v2 “desktop shell” without blocking current web UX improvements.
