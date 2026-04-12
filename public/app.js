/* ── DOM refs ─────────────────────────────── */

const $ = (id) => document.getElementById(id);

const textInput = $("textInput");
const parseTextBtn = $("parseTextBtn");
const imageInput = $("imageInput");
const photoDropzone = $("photoDropzone");
const photoCard = $("photoCard");
const calendarNameInput = $("calendarNameInput");
const sessionBar = $("sessionBar");
const appHero = $("appHero");
const openCueAuthBtn = $("openCueAuthBtn");
const signOutBtn = $("signOutBtn");
const cueAuthModal = $("cueAuthModal");
const closeCueAuthBtn = $("closeCueAuthBtn");
const cueAuthUsername = $("cueAuthUsername");
const cueAuthPassword = $("cueAuthPassword");
const cueAuthSubmitBtn = $("cueAuthSubmitBtn");
const cueAuthRegisterBtn = $("cueAuthRegisterBtn");
const cueAuthError = $("cueAuthError");
const inboxSignInHint = $("inboxSignInHint");
const inboxGoogleConnectRow = $("inboxGoogleConnectRow");
const connectGmailBtn = $("connectGmailBtn");
const quickLockedOverlay = $("quickLockedOverlay");
const activityLockedOverlay = $("activityLockedOverlay");
const quickLockedSignInBtn = $("quickLockedSignInBtn");
const activityLockedSignInBtn = $("activityLockedSignInBtn");
const localEvents = $("localEvents");
const refreshLocalBtn = $("refreshLocalBtn");
const activitySearch = $("activitySearch");
const activitySort = $("activitySort");
const activitySource = $("activitySource");
const activityFilteredEmpty = $("activityFilteredEmpty");
const activityFilteredEmptyMsg = $("activityFilteredEmptyMsg");
const scanGmailBtn = $("scanGmailBtn");
const bulkApproveBtn = $("bulkApproveBtn");
const gmailStatusText = $("gmailStatusText");
const gmailCandidates = $("gmailCandidates");
const strictDateTimeAdv = $("strictDateTimeAdv");
const strictIntentAdv = $("strictIntentAdv");
const gmailAdvanced = $("gmailAdvanced");
const shareModal = $("shareModal");
const shareModalTitle = $("shareModalTitle");
const shareMessagePreview = $("shareMessagePreview");
const googleShareInput = $("googleShareInput");
const icsShareInput = $("icsShareInput");
const shareCopyStatus = $("shareCopyStatus");
const openGoogleBtn = $("openGoogleBtn");
const downloadIcsBtn = $("downloadIcsBtn");
const shareWhatsAppBtn = $("shareWhatsAppBtn");
const shareCopyMsgBtn = $("shareCopyMsgBtn");
const shareNativeBtn = $("shareNativeBtn");
const closeShareModalBtn = $("closeShareModalBtn");
const toastRoot = $("toastRoot");
const panelQuick = $("panelQuick");
const panelGmail = $("panelGmail");
const panelActivity = $("panelActivity");
const quickUpdateInput = $("quickUpdateInput");
const quickUpdateBtn = $("quickUpdateBtn");
const quickUpdatePreview = $("quickUpdatePreview");
const quickUpdatePreviewText = $("quickUpdatePreviewText");
const quickUpdateConfirm = $("quickUpdateConfirm");
const quickUpdateCancel = $("quickUpdateCancel");
const monthCalGrid = $("monthCalGrid");
const monthCalTitle = $("monthCalTitle");
const monthCalPrev = $("monthCalPrev");
const monthCalNext = $("monthCalNext");
const monthCalToday = $("monthCalToday");
const monthCalDayDetail = $("monthCalDayDetail");
const dayDetailTitle = $("dayDetailTitle");
const dayDetailEvents = $("dayDetailEvents");
const dayDetailClose = $("dayDetailClose");
const confirmModal = $("confirmModal");
const confirmTitle = $("confirmTitle");
const confirmParseHint = $("confirmParseHint");
const confirmEvents = $("confirmEvents");
const closeConfirmBtn = $("closeConfirmBtn");
const eventPhotoLightbox = $("eventPhotoLightbox");
const eventPhotoLightboxImg = $("eventPhotoLightboxImg");
const eventPhotoLightboxClose = $("eventPhotoLightboxClose");

/* ── State ────────────────────────────────── */

let queueState = { suggestions: [], senderRules: { blocked: [], allowed: [] }, settings: {} };
let currentSharePayload = null;
let quickUpdatePreviewData = null;
let localEventsCache = [];
let calViewYear = new Date().getFullYear();
let calViewMonth = new Date().getMonth();
let calSelectedDay = null;

/** @type {{ authenticated: boolean, username?: string|null, email?: string|null, configured?: boolean, gmailConnected?: boolean }} */
let sessionInfo = { authenticated: false };

const TAB_KEY = "cueTab";

const EMPTY_STATE_MARKUP =
  '<img class="empty-state-illustration" src="/illustration-empty.png" alt="" width="132" height="132" loading="lazy" />';

/* ── Helpers ──────────────────────────────── */

function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function assertSignedInOrOpenAuth() {
  if (sessionInfo.authenticated) return true;
  showToast("Sign in to use this.", "info");
  openCueAuthModal();
  return false;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function toLocalDatetimeInput(iso) {
  const d = new Date(iso), p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromLocalDatetimeInput(v) { return new Date(v).toISOString(); }

async function api(url, opts = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...opts });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : { error: await res.text() };
  if (res.status === 401 && (data.code === "AUTH_REQUIRED" || data.code === "SIGN_IN_REQUIRED")) {
    sessionInfo = {
      authenticated: false,
      gmailConnected: false,
      username: null,
      email: null,
      configured: sessionInfo.configured,
    };
    updateSessionUI();
    throw new Error(
      data.error ||
        (data.code === "SIGN_IN_REQUIRED"
          ? "Sign in to Cue to use this."
          : "Sign in to Cue first, then connect Google from the Inbox tab if you need Gmail."),
    );
  }
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function refreshSession() {
  const res = await fetch("/api/me", { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === "AUTH_INVALID") {
    sessionInfo = { authenticated: false, gmailConnected: false, username: null, email: null };
    updateSessionUI();
    return sessionInfo;
  }
  if (!res.ok) {
    throw new Error(data.error || "Could not verify session.");
  }
  sessionInfo = {
    authenticated: Boolean(data.authenticated),
    username: data.username || null,
    email: data.email || null,
    configured: data.configured,
    gmailConnected: data.gmailConnected,
  };
  updateSessionUI();
  return sessionInfo;
}

function updateSessionUI() {
  const authed = sessionInfo.authenticated;
  const inboxReady = authed && Boolean(sessionInfo.gmailConnected);
  if (appHero) appHero.classList.toggle("hidden", authed);
  if (scanGmailBtn && bulkApproveBtn) {
    scanGmailBtn.classList.toggle("hidden", !inboxReady);
    bulkApproveBtn.classList.toggle("hidden", !inboxReady);
  }
  if (gmailAdvanced) gmailAdvanced.classList.toggle("hidden", !authed);
  if (inboxSignInHint) inboxSignInHint.classList.toggle("hidden", authed);
  if (inboxGoogleConnectRow) inboxGoogleConnectRow.classList.toggle("hidden", !authed || Boolean(sessionInfo.gmailConnected));
  if (gmailStatusText) {
    if (!authed) {
      gmailStatusText.textContent = "";
      gmailStatusText.classList.add("hidden");
    }
  }
  if (quickLockedOverlay) quickLockedOverlay.classList.toggle("hidden", authed);
  if (activityLockedOverlay) activityLockedOverlay.classList.toggle("hidden", authed);

  if (!sessionBar || !signOutBtn) return;

  if (authed) {
    const label = sessionInfo.username || sessionInfo.email || "Signed in";
    sessionBar.textContent = label;
    sessionBar.classList.remove("hidden");
    signOutBtn.classList.remove("hidden");
    openCueAuthBtn?.classList.add("hidden");
    calendarNameInput?.classList.remove("hidden");
  } else {
    sessionBar.textContent = "";
    sessionBar.classList.add("hidden");
    signOutBtn.classList.add("hidden");
    openCueAuthBtn?.classList.remove("hidden");
    if (calendarNameInput) {
      calendarNameInput.classList.add("hidden");
      calendarNameInput.innerHTML = "";
    }
  }
}

async function signOut() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  sessionInfo = { authenticated: false, gmailConnected: false, username: null, email: null };
  updateSessionUI();
  queueState = { suggestions: [], senderRules: { blocked: [], allowed: [] }, settings: {} };
  localEventsCache = [];
  renderReviewQueue();
  renderActivityList();
  renderMonthCalendar();
  updateSessionUI();
  showToast("Signed out.", "info");
}

function showToast(msg, type = "info", ms = 3500) {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  if (type === "success") {
    el.classList.add("toast--with-art");
    const img = document.createElement("img");
    img.src = "/illustration-success.png";
    img.alt = "";
    img.className = "toast-illustration";
    img.width = 44;
    img.height = 44;
    el.appendChild(img);
  }
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = msg;
  el.appendChild(text);
  toastRoot.appendChild(el);
  const t = setTimeout(() => el.remove(), ms);
  el.addEventListener("click", () => { clearTimeout(t); el.remove(); });
}

/* ── Tabs ─────────────────────────────────── */

function setPanelVisible(p, show) { p.classList.toggle("hidden", !show); if (show) p.removeAttribute("hidden"); else p.setAttribute("hidden", "hidden"); }

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
  setPanelVisible(panelQuick, name === "quick");
  setPanelVisible(panelGmail, name === "gmail");
  setPanelVisible(panelActivity, name === "activity");
  try { sessionStorage.setItem(TAB_KEY, name); } catch {}
  if (name === "gmail") {
    syncAdvancedFromQueue();
    if (sessionInfo.authenticated) loadCalendars().catch(() => {});
  }
  if (name === "activity") loadLocalEvents().catch(() => {});
  if (name === "quick" && sessionInfo.authenticated) loadCalendars().catch(() => {});
}

function initTabs() {
  let initial = "quick";
  try { const s = sessionStorage.getItem(TAB_KEY); if (["quick", "gmail", "activity"].includes(s)) initial = s; } catch {}
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  switchTab(initial);
}

/* ── Calendars (Apple + Google) ───────────── */

function selectedAppleCalendarName() {
  const v = calendarNameInput.value || "";
  if (v.startsWith("apple/")) return decodeURIComponent(v.slice(6));
  if (v === "cue" || v.startsWith("google/")) return "";
  return v;
}

function calendarKeyPayload() {
  return { calendarKey: calendarNameInput.value || "" };
}

async function loadCalendars() {
  const data = await api("/api/calendars");
  calendarNameInput.classList.remove("hidden");
  calendarNameInput.innerHTML = "";
  const addGroup = (label, fill) => {
    const og = document.createElement("optgroup");
    og.label = label;
    fill(og);
    calendarNameInput.appendChild(og);
  };
  const cueOpt = document.createElement("option");
  cueOpt.value = "cue";
  cueOpt.textContent = "Cue";
  calendarNameInput.appendChild(cueOpt);
  if (data.apple?.length) {
    addGroup("Apple Calendar", (og) => {
      data.apple.forEach((name) => {
        const o = document.createElement("option");
        o.value = `apple/${encodeURIComponent(name)}`;
        o.textContent = name;
        og.appendChild(o);
      });
    });
  }
  if (data.google?.length) {
    addGroup("Google Calendar", (og) => {
      data.google.forEach((cal) => {
        const o = document.createElement("option");
        o.value = `google/${encodeURIComponent(cal.id)}`;
        o.textContent = cal.primary ? `${cal.summary} (primary)` : cal.summary;
        og.appendChild(o);
      });
    });
  }

  if (!calendarNameInput.options.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No calendars yet — Google: Inbox → Connect";
    o.disabled = true;
    calendarNameInput.appendChild(o);
    return;
  }
  const primaryG = data.google?.find((c) => c.primary);
  if (primaryG) {
    calendarNameInput.value = `google/${encodeURIComponent(primaryG.id)}`;
  } else if (data.apple?.length) {
    calendarNameInput.value = `apple/${encodeURIComponent(data.apple[0])}`;
  } else {
    calendarNameInput.value = "cue";
  }
}

/* ── Add event ────────────────────────────── */

async function checkDuplicate(event) {
  return api("/api/events/check-duplicate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }) });
}

async function addEvent(event, source, opts = {}) {
  if (!assertSignedInOrOpenAuth()) return false;
  const dup = await checkDuplicate(event);
  if (dup.duplicate && dup.match) {
    const ok = window.confirm(`Similar event exists ("${dup.match.title}" at ${formatDate(dup.match.start)}). Add anyway?`);
    if (!ok) return false;
  }
  const payload = { event, ...calendarKeyPayload(), source };
  if (opts.photoId) payload.photoId = opts.photoId;
  const data = await api("/api/events/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const titleForMsg = event.title || "Event";
  const msg =
    data.destination === "cue"
      ? `"${titleForMsg}" saved to My Events`
      : `"${titleForMsg}" added to calendar`;
  showToast(msg, "success");
  await loadLocalEvents();
  return true;
}

function readConfirmRowTitle(row, fallbackTitle) {
  const input = row.querySelector(".confirm-title-input");
  const t = (input?.value || "").trim();
  return t || fallbackTitle;
}

/* ── Confirm modal ────────────────────────── */

function showConfirmModal(events, source, options = {}) {
  const attachedPhotoId = options.photoId || null;
  confirmTitle.textContent = "Does this look right?";
  confirmEvents.innerHTML = "";
  let addedCount = 0;

  if (confirmParseHint) {
    confirmParseHint.classList.remove("hidden");
    confirmParseHint.textContent =
      source === "photo"
        ? "Here is what we pulled from your image—edit the title or time if needed, then confirm."
        : "Check the title and time, then confirm to add to your chosen calendar.";
  }

  const isSingleEvent = events.length === 1;

  events.forEach((ev, i) => {
    const row = document.createElement("div");
    row.className = "confirm-event";
    row.style.animationDelay = `${i * 0.05}s`;
    const info = document.createElement("div");
    info.className = "confirm-info";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "confirm-title-input";
    titleInput.value = ev.title || "";
    titleInput.setAttribute("aria-label", "Event title");
    titleInput.autocomplete = "off";
    const timeEl = document.createElement("div");
    timeEl.className = "confirm-time";
    timeEl.textContent = formatDate(ev.start);
    info.appendChild(titleInput);
    info.appendChild(timeEl);

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    if (isSingleEvent) {
      const cancelB = document.createElement("button");
      cancelB.type = "button";
      cancelB.className = "btn-ghost btn-sm cf-cancel-row";
      cancelB.textContent = "Cancel";
      actions.appendChild(cancelB);
    }
    const addB = document.createElement("button");
    addB.type = "button";
    addB.className = "btn btn-sm cf-add";
    addB.dataset.idx = String(i);
    addB.textContent = "Confirm";
    actions.appendChild(addB);

    row.appendChild(info);
    row.appendChild(actions);
    confirmEvents.appendChild(row);

    addB.addEventListener("click", async function () {
      this.textContent = "Adding…";
      this.disabled = true;
      try {
        const title = readConfirmRowTitle(row, ev.title);
        const evToSend = { ...ev, title };
        const ok = await addEvent(evToSend, source, { photoId: attachedPhotoId });
        if (ok === false) { this.textContent = "Confirm"; this.disabled = false; return; }
        row.classList.add("added");
        this.textContent = "✓ Added";
        addedCount++;
        if (addedCount === events.length) setTimeout(closeConfirmModal, 500);
      } catch (err) { showToast(err.message, "error"); this.textContent = "Confirm"; this.disabled = false; }
    });
  });

  if (isSingleEvent) {
    confirmEvents.querySelector(".cf-cancel-row")?.addEventListener("click", closeConfirmModal);
  } else {
    const footer = document.createElement("div");
    footer.className = "confirm-footer";
    footer.innerHTML = `<button type="button" class="btn-ghost cf-cancel">Cancel</button><button type="button" class="btn cf-all">Add all</button>`;
    footer.querySelector(".cf-cancel").addEventListener("click", closeConfirmModal);
    footer.querySelector(".cf-all").addEventListener("click", () => {
      confirmEvents.querySelectorAll(".cf-add:not(:disabled)").forEach((b) => b.click());
    });
    confirmEvents.appendChild(footer);
  }

  confirmModal.classList.remove("hidden");
}

function closeConfirmModal() {
  confirmModal.classList.add("hidden");
  textInput.value = "";
  confirmParseHint?.classList.add("hidden");
}

/* ── Text parsing → confirm ───────────────── */

async function parseText() {
  if (!assertSignedInOrOpenAuth()) return;
  const text = textInput.value.trim();
  if (!text) { showToast("Describe an event first.", "error"); return; }
  parseTextBtn.textContent = "Reading…";
  parseTextBtn.disabled = true;
  try {
    const data = await api("/api/parse/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (data.events.length) showConfirmModal(data.events, "text");
    else showToast("No date or time in that text yet. Try something like “dinner Friday 7pm”.", "info");
  } catch (e) { showToast(e.message, "error"); }
  finally { parseTextBtn.textContent = "Add it"; parseTextBtn.disabled = false; }
}

/* ── Image parsing → confirm ──────────────── */

function setPhotoDropzoneBusy(busy) {
  if (!photoDropzone) return;
  const wide = photoDropzone.querySelector(".dropzone-line--wide");
  const narrow = photoDropzone.querySelector(".dropzone-line--narrow");
  let loadEl = photoDropzone.querySelector(".dropzone-loading");
  if (busy) {
    wide?.classList.add("hidden");
    narrow?.classList.add("hidden");
    if (!loadEl) {
      loadEl = document.createElement("span");
      loadEl.className = "dropzone-loading";
      loadEl.textContent = "Reading image…";
      photoDropzone.appendChild(loadEl);
    }
    photoDropzone.style.pointerEvents = "none";
  } else {
    loadEl?.remove();
    wide?.classList.remove("hidden");
    narrow?.classList.remove("hidden");
    photoDropzone.style.pointerEvents = "";
  }
}

async function parseImageFromFile(file) {
  if (!assertSignedInOrOpenAuth()) return;
  if (!file || !file.type.startsWith("image/")) { showToast("Please use an image file.", "error"); return; }
  const fd = new FormData();
  fd.append("image", file);
  setPhotoDropzoneBusy(true);
  try {
    const res = await fetch("/api/parse/image", { method: "POST", credentials: "same-origin", body: fd });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && (data.code === "AUTH_REQUIRED" || data.code === "SIGN_IN_REQUIRED")) {
      sessionInfo = {
        authenticated: false,
        gmailConnected: false,
        username: null,
        email: null,
        configured: sessionInfo.configured,
      };
      updateSessionUI();
      openCueAuthModal();
      throw new Error(data.error || "Sign in to Cue first.");
    }
    if (!res.ok) throw new Error(data.error || "Failed");
    if (data.events.length) {
      let photoId = null;
      const upFd = new FormData();
      upFd.append("image", file, file.name || "photo.jpg");
      const upRes = await fetch("/api/event-photos", { method: "POST", credentials: "same-origin", body: upFd });
      if (upRes.ok) {
        const upData = await upRes.json().catch(() => ({}));
        if (upData.photoId) photoId = upData.photoId;
      }
      showConfirmModal(data.events, "photo", { photoId });
    } else showToast("No events found — try a clearer image.", "info");
  } catch (e) { showToast(e.message, "error"); }
  finally { setPhotoDropzoneBusy(false); }
}

function wirePhotoDropzone() {
  ["dragenter", "dragover"].forEach((ev) => photoDropzone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); photoDropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => photoDropzone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); photoDropzone.classList.remove("dragover"); }));
  photoDropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files?.[0]; if (f) { const dt = new DataTransfer(); dt.items.add(f); imageInput.files = dt.files; parseImageFromFile(f).catch((err) => showToast(err.message, "error")); } });
  photoDropzone.addEventListener("click", () => imageInput.click());
  photoDropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); imageInput.click(); } });
  imageInput.addEventListener("change", () => { const f = imageInput.files?.[0]; if (f) parseImageFromFile(f).catch((err) => showToast(err.message, "error")); });
  document.addEventListener("paste", (e) => {
    if (panelQuick.classList.contains("hidden")) return;
    const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith("image/"));
    if (file) { e.preventDefault(); const dt = new DataTransfer(); dt.items.add(file); imageInput.files = dt.files; parseImageFromFile(file).catch((err) => showToast(err.message, "error")); }
  });
}

/* ── Share ─────────────────────────────────── */

async function shareEvent(event) {
  const data = await api("/api/events/share-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }) });
  currentSharePayload = { eventTitle: event.title || "Event", googleCalendarLink: data.googleCalendarLink, icsDownloadLink: data.icsDownloadLink, shareMessage: data.shareMessage || `${event.title}\n${data.googleCalendarLink}` };
  shareModalTitle.textContent = currentSharePayload.eventTitle;
  shareMessagePreview.textContent = currentSharePayload.shareMessage;
  googleShareInput.value = currentSharePayload.googleCalendarLink;
  icsShareInput.value = currentSharePayload.icsDownloadLink;
  shareCopyStatus.textContent = "";
  shareNativeBtn.classList.toggle("hidden", !navigator.share);
  shareModal.classList.remove("hidden");
}

async function tryCopyText(text) {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return true; } catch {} }
  const el = document.createElement("textarea"); el.value = text; el.setAttribute("readonly", "true"); el.style.position = "fixed"; el.style.left = "-9999px";
  document.body.appendChild(el); el.select(); let ok = false; try { ok = document.execCommand("copy"); } catch {} document.body.removeChild(el); return ok;
}

function closeShareModal() { shareModal.classList.add("hidden"); currentSharePayload = null; shareCopyStatus.textContent = ""; }

function attachShareHandlers() {
  shareWhatsAppBtn.addEventListener("click", () => { if (currentSharePayload) window.open(`https://wa.me/?text=${encodeURIComponent(currentSharePayload.shareMessage)}`, "_blank"); });
  shareCopyMsgBtn.addEventListener("click", async () => { if (!currentSharePayload) return; const ok = await tryCopyText(currentSharePayload.shareMessage); shareCopyStatus.textContent = ok ? "Copied to clipboard." : "Couldn't copy — select text manually."; });
  shareNativeBtn.addEventListener("click", async () => { if (!currentSharePayload || !navigator.share) return; try { await navigator.share({ title: currentSharePayload.eventTitle, text: currentSharePayload.shareMessage, url: currentSharePayload.googleCalendarLink }); } catch {} });
  openGoogleBtn.addEventListener("click", () => { if (currentSharePayload) window.open(currentSharePayload.googleCalendarLink, "_blank"); });
  downloadIcsBtn.addEventListener("click", () => { if (currentSharePayload) window.open(currentSharePayload.icsDownloadLink, "_blank"); });
  closeShareModalBtn.addEventListener("click", closeShareModal);
  shareModal.addEventListener("click", (e) => { if (e.target === shareModal) closeShareModal(); });
}

/* ── Quick update ─────────────────────────── */

function resetQuickUpdatePreview() { quickUpdatePreview.classList.add("hidden"); quickUpdatePreviewData = null; }

async function quickUpdatePreviewStep() {
  if (!assertSignedInOrOpenAuth()) return;
  const text = quickUpdateInput.value.trim();
  if (!text) { showToast("Describe what you'd like to add.", "error"); return; }
  try {
    const data = await api("/api/events/preview-update-intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, calendarName: selectedAppleCalendarName() }) });
    quickUpdatePreviewData = data;
    quickUpdatePreviewText.textContent = `Note on "${data.matchedEvent.matchedSummary}": "${data.intent.noteText}"`;
    quickUpdatePreview.classList.remove("hidden");
  } catch (e) { showToast(e.message, "error"); resetQuickUpdatePreview(); }
}

async function quickUpdateConfirmAction() {
  if (!assertSignedInOrOpenAuth()) return;
  if (!quickUpdateInput.value.trim() || !quickUpdatePreviewData) return;
  try {
    const data = await api("/api/events/update-note-from-text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: quickUpdateInput.value.trim(), calendarName: selectedAppleCalendarName() }) });
    showToast(`"${data.matchedEvent.matchedSummary}" updated`, "success");
    resetQuickUpdatePreview(); quickUpdateInput.value = "";
  } catch (e) { showToast(e.message, "error"); }
}

/* ── Gmail ────────────────────────────────── */

async function connectGmail() {
  if (!sessionInfo.authenticated) {
    showToast("Sign in to Cue first, then connect Google from here.", "error");
    return;
  }
  const data = await api("/api/gmail/auth-url");
  if (!data.url?.startsWith("https://accounts.google.com/")) throw new Error("OAuth URL was not generated correctly.");
  window.location.assign(data.url);
}

function openCueAuthModal() {
  if (!cueAuthModal) return;
  cueAuthModal.classList.remove("hidden");
  if (cueAuthError) {
    cueAuthError.textContent = "";
    cueAuthError.classList.add("hidden");
  }
  cueAuthUsername?.focus();
}

function closeCueAuthModal() {
  cueAuthModal?.classList.add("hidden");
  if (cueAuthPassword) cueAuthPassword.value = "";
  if (cueAuthError) {
    cueAuthError.textContent = "";
    cueAuthError.classList.add("hidden");
  }
}

async function submitCueAuth(registerMode) {
  const username = (cueAuthUsername?.value || "").trim();
  const password = cueAuthPassword?.value || "";
  if (cueAuthError) {
    cueAuthError.textContent = "";
    cueAuthError.classList.add("hidden");
  }
  const path = registerMode ? "/api/auth/register" : "/api/auth/login";
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    closeCueAuthModal();
    if (cueAuthUsername) cueAuthUsername.value = "";
    await refreshSession();
    try {
      sessionStorage.setItem(TAB_KEY, "quick");
      sessionStorage.setItem("cueSignedInFlash", registerMode ? "created" : "in");
    } catch {}
    window.location.reload();
  } catch (e) {
    if (cueAuthError) {
      cueAuthError.textContent = e.message || "Something went wrong.";
      cueAuthError.classList.remove("hidden");
    }
  }
}

async function loadGmailStatus() {
  if (!sessionInfo.authenticated) {
    gmailStatusText.textContent = "";
    gmailStatusText.classList.add("hidden");
    return;
  }
  gmailStatusText.classList.remove("hidden");
  gmailStatusText.className = "muted status-text";
  const data = await api("/api/gmail/status");
  sessionInfo.gmailConnected = Boolean(data.connected);
  updateSessionUI();
  if (!data.configured) {
    gmailStatusText.classList.remove("hidden");
    gmailStatusText.textContent = "Server not configured for Google.";
    gmailStatusText.className = "muted status-text";
    return;
  }
  if (!data.connected) {
    gmailStatusText.textContent = "";
    gmailStatusText.classList.add("hidden");
    return;
  }
  const q = data.queueSummary || {};
  const parts = ["Connected"];
  if (q.pending) parts.push(`${q.pending} pending`);
  if (q.added) parts.push(`${q.added} event${q.added !== 1 ? "s" : ""} added`);
  gmailStatusText.classList.remove("hidden");
  gmailStatusText.textContent = parts.join(" · ");
  gmailStatusText.className = "status-text connected";
}

function confidenceLevel(pct) { return pct >= 80 ? "high" : pct >= 50 ? "medium" : "low"; }
function processedStatusLabel(s) { return { added: "Added", rejected: "Dismissed", failed: "Failed" }[s] || s || "Done"; }
function statusBadgeClass(s) { return { added: "badge-added", rejected: "badge-rejected", failed: "badge-failed" }[s] || "badge-pending"; }

async function approveSuggestion(id) {
  const t = $(`title-${id}`), s = $(`start-${id}`), e = $(`end-${id}`), u = $(`url-${id}`), n = $(`notes-${id}`);
  const ev = { title: t.value.trim(), start: fromLocalDatetimeInput(s.value), end: fromLocalDatetimeInput(e.value), url: u.value.trim(), notes: n.value.trim() };
  await api("/api/gmail/review-queue/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestionId: id, eventOverride: ev, ...calendarKeyPayload() }) });
  showToast(`"${ev.title}" added to calendar`, "success");
  await loadReviewQueue(); await loadLocalEvents();
}

async function rejectSuggestion(id) {
  const reason = window.prompt("Reason (optional):", "") || "";
  await api("/api/gmail/review-queue/reject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestionId: id, reason }) });
  showToast("Dismissed.", "info"); await loadReviewQueue();
}

async function setSenderRule(email, action) {
  await api("/api/gmail/review-queue/sender-rule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ senderEmail: email, action }) });
  await loadReviewQueue();
}

function renderReviewQueue() {
  if (!sessionInfo.authenticated) {
    gmailCandidates.innerHTML = "";
    return;
  }
  if (!sessionInfo.gmailConnected) {
    gmailCandidates.innerHTML = "";
    return;
  }
  const all = queueState.suggestions || [];
  gmailCandidates.innerHTML = "";
  const pending = all.filter((s) => s.status === "pending");
  const processed = all.filter((s) => s.status !== "pending").sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  if (!pending.length && !processed.length) {
    gmailCandidates.innerHTML = `<div class="inbox-empty-hint muted"><img class="empty-state-illustration empty-state-illustration--compact" src="/illustration-empty.png" alt="" width="96" height="96" loading="lazy" /><p style="padding:10px 0;margin:0">Queue empty — try <strong>Scan my inbox</strong>.</p></div>`;
    return;
  }
  const root = document.createElement("div");
  root.className = "gmail-queue";
  if (!pending.length && processed.length) { const b = document.createElement("div"); b.className = "caught-up"; b.textContent = "All caught up."; root.appendChild(b); }
  if (pending.length) { const h = document.createElement("div"); h.className = "subsection-label"; h.textContent = `To review (${pending.length})`; root.appendChild(h); }
  pending.forEach((item) => {
    const ev = item.event || {}, conf = item.confidence || 0;
    const card = document.createElement("div"); card.className = "review-item";
    card.innerHTML = `
      <div class="review-head"><strong>${escapeHtml(ev.title || "(Untitled)")}</strong><span class="badge badge-pending">New</span><span class="confidence confidence-${confidenceLevel(conf)}">${conf}%</span></div>
      <div class="muted" style="margin-bottom:8px">From: ${escapeHtml(item.from || "Unknown")} · <a href="${escapeHtml(item.messageUrl || "#")}" target="_blank" rel="noreferrer">Open email</a></div>
      <div class="inline-grid">
        <label class="field-label">Title<input type="text" id="title-${item.id}" value="${escapeHtml(ev.title || "")}" /></label>
        <label class="field-label">Start<input type="datetime-local" id="start-${item.id}" value="${toLocalDatetimeInput(ev.start)}" /></label>
        <label class="field-label">End<input type="datetime-local" id="end-${item.id}" value="${toLocalDatetimeInput(ev.end)}" /></label>
        <label class="field-label">Link<input type="text" id="url-${item.id}" value="${escapeHtml(ev.url || "")}" /></label>
      </div>
      <label class="field-label">Notes<textarea id="notes-${item.id}" rows="2">${escapeHtml(ev.notes || "")}</textarea></label>
      <div class="actions">
        <button class="btn btn-sm approve-btn" data-id="${item.id}">Add</button>
        <button class="btn-outline btn-sm reject-btn" data-id="${item.id}">Dismiss</button>
        <button class="btn-ghost btn-sm share-gmail-btn" data-id="${item.id}">Share</button>
        <button class="btn-danger-text btn-sm block-btn" data-sender="${item.senderEmail || ""}">Block sender</button>
      </div>`;
    root.appendChild(card);
  });
  if (processed.length) {
    const block = document.createElement("div"); block.className = "processed-block";
    const h = document.createElement("div"); h.className = "subsection-label"; h.textContent = `History (${processed.length})`; block.appendChild(h);
    processed.forEach((item) => {
      const ev = item.event || {};
      const row = document.createElement("div"); row.className = "processed-row";
      row.innerHTML = `<div class="processed-main"><span class="badge ${statusBadgeClass(item.status)}">${escapeHtml(processedStatusLabel(item.status))}</span><strong>${escapeHtml(ev.title || "Untitled")}</strong></div><div class="processed-meta">${ev.start ? formatDate(ev.start) : "—"}${item.from ? ` · ${escapeHtml(item.from)}` : ""}${item.messageUrl ? ` · <a href="${escapeHtml(item.messageUrl)}" target="_blank" rel="noreferrer">Email</a>` : ""}</div>`;
      block.appendChild(row);
    });
    root.appendChild(block);
  }
  gmailCandidates.appendChild(root);
  root.querySelectorAll(".approve-btn").forEach((b) => b.addEventListener("click", () => approveSuggestion(b.dataset.id).catch((e) => showToast(e.message, "error"))));
  root.querySelectorAll(".reject-btn").forEach((b) => b.addEventListener("click", () => rejectSuggestion(b.dataset.id).catch((e) => showToast(e.message, "error"))));
  root.querySelectorAll(".share-gmail-btn").forEach((b) => b.addEventListener("click", () => { const m = (queueState.suggestions || []).find((s) => s.id === b.dataset.id); if (m) shareEvent(m.event).catch((e) => showToast(e.message, "error")); }));
  root.querySelectorAll(".block-btn").forEach((b) => b.addEventListener("click", () => { if (b.dataset.sender) setSenderRule(b.dataset.sender, "block").catch((e) => showToast(e.message, "error")); }));
}

function syncAdvancedFromQueue() { strictDateTimeAdv.checked = Boolean(queueState.settings?.requireExplicitDateTime); strictIntentAdv.checked = Boolean(queueState.settings?.requireEventIntent); }
async function loadReviewQueue() { const data = await api("/api/gmail/review-queue"); queueState = data; renderReviewQueue(); syncAdvancedFromQueue(); }
async function saveAdvRules() { await api("/api/gmail/review-queue/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requireExplicitDateTime: strictDateTimeAdv.checked, requireEventIntent: strictIntentAdv.checked }) }); }

async function scanNow() {
  scanGmailBtn.textContent = "Checking…"; scanGmailBtn.disabled = true;
  try { await api("/api/gmail/review-queue/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxResults: 30 }) }); await loadReviewQueue(); showToast("Inbox checked.", "success"); }
  catch (e) { showToast(e.message, "error"); }
  finally { scanGmailBtn.textContent = "Scan my inbox"; scanGmailBtn.disabled = false; }
}

async function bulkApprove() {
  const data = await api("/api/gmail/review-queue/bulk-approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minConfidence: 85, ...calendarKeyPayload() }) });
  showToast(`${data.successCount ?? 0} added${data.failureCount ? `, ${data.failureCount} failed` : ""}`, "success");
  await loadReviewQueue(); await loadLocalEvents();
}

/* ── Activity list ────────────────────────── */

function sourceLabel(src) { return { gmail: "gmail", photo: "photo", text: "typed" }[src] || ""; }

function filterAndSort(events) {
  const q = (activitySearch?.value || "").trim().toLowerCase();
  const src = activitySource?.value || "all";
  let list = events.filter((ev) => { if (src !== "all" && (ev.source || "unknown") !== src) return false; if (q && !(ev.title || "").toLowerCase().includes(q)) return false; return true; });
  const sort = activitySort?.value || "newest";
  if (sort === "newest") list.sort((a, b) => new Date(b.start) - new Date(a.start));
  else if (sort === "oldest") list.sort((a, b) => new Date(a.start) - new Date(b.start));
  else list.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  return list;
}

function eventDedupeKey(ev) {
  return `${ev.start || ""}\t${(ev.title || "").trim().toLowerCase()}`;
}

function validEventPhotoId(ev) {
  const p = ev.photoId != null && String(ev.photoId);
  if (!p || !/^[a-f0-9]{32}$/i.test(p)) return "";
  return p;
}

function pickBetterDedupeEvent(a, b) {
  const aPid = !!validEventPhotoId(a);
  const bPid = !!validEventPhotoId(b);
  if (bPid && !aPid) return b;
  if (aPid && !bPid) return a;
  const ta = new Date(a.createdAt || 0).getTime();
  const tb = new Date(b.createdAt || 0).getTime();
  return tb >= ta ? b : a;
}

/** Same calendar row saved twice (e.g. once without photoId) — keep one, prefer the row linked to the upload. */
function dedupeEventsPreferPhotoId(sortedList) {
  const winners = new Map();
  for (const ev of sortedList) {
    const k = eventDedupeKey(ev);
    const w = winners.get(k);
    winners.set(k, w ? pickBetterDedupeEvent(w, ev) : ev);
  }
  const seen = new Set();
  const out = [];
  for (const ev of sortedList) {
    const k = eventDedupeKey(ev);
    if (seen.has(k)) continue;
    if (winners.get(k) !== ev) continue;
    out.push(ev);
    seen.add(k);
  }
  return out;
}

function sortEventsInPlace(list) {
  const sort = activitySort?.value || "newest";
  if (sort === "newest") list.sort((a, b) => new Date(b.start) - new Date(a.start));
  else if (sort === "oldest") list.sort((a, b) => new Date(a.start) - new Date(b.start));
  else list.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  return list;
}

function photoThumbHtml(pid) {
  const src = `/api/event-photos/${encodeURIComponent(pid)}`;
  /* Photo as a div background (not <img>) avoids WebKit not painting images inside <button>. */
  return `<button type="button" class="event-photo-thumb" data-photo-id="${escapeHtml(pid)}" aria-label="View source photo"><span class="event-photo-thumb-tilt"><span class="event-photo-thumb-stamp" aria-hidden="true"></span><span class="event-photo-thumb-photo" aria-hidden="true" style="background-image:url('${src}')"></span></span></button>`;
}

function eventLineHtml(ev) {
  const label = sourceLabel(ev.source);
  const dest = { google: "Google Calendar", apple: "Apple Calendar", cue: "Cue" }[ev.destination] || "";
  return `<div class="event-group-line"><div class="event-title">${escapeHtml(ev.title)}${label ? ` <span class="source-tag">${label}</span>` : ""}</div><div class="event-meta">${formatDate(ev.start)}${dest ? ` · ${dest}` : ""}</div></div>`;
}

function renderActivityList() {
  if (!sessionInfo.authenticated) {
    localEvents.innerHTML = `<div class="empty-coach empty-coach--with-art">
      ${EMPTY_STATE_MARKUP}
      <p class="empty-coach-title">Sign in to view your events</p>
      <p class="muted" style="font-size:13px;line-height:1.55;margin:0">Use <strong>Sign in</strong> in the header (or create an account). Your month grid and list stay on your account.</p>
    </div>`;
    if (activityFilteredEmpty) activityFilteredEmpty.classList.add("hidden");
    return;
  }
  const list = filterAndSort(localEventsCache);
  const deduped = dedupeEventsPreferPhotoId(list);
  localEvents.innerHTML = "";
  if (activityFilteredEmpty && activityFilteredEmptyMsg) {
    activityFilteredEmptyMsg.textContent = "Nothing here yet 🌱";
    activityFilteredEmpty.classList.toggle("hidden", list.length > 0 || !localEventsCache.length);
  }
  if (!localEventsCache.length) {
    localEvents.innerHTML = `<div class="empty-coach empty-coach--with-art">
      ${EMPTY_STATE_MARKUP}
      <p class="empty-coach-title">No events here yet</p>
      <ul>
        <li>On <strong>Jot</strong>, describe an event or upload a flyer, confirm it, and it is saved to this list and the month grid.</li>
        <li>On <strong>Inbox</strong>, connect Google if you want Cue to list emails that might be events; when you approve one, it is saved here the same way.</li>
      </ul>
    </div>`;
    return;
  }
  if (!deduped.length) return;

  const byPhoto = new Map();
  for (const ev of deduped) {
    const pid = validEventPhotoId(ev);
    if (!pid) continue;
    if (!byPhoto.has(pid)) byPhoto.set(pid, []);
    byPhoto.get(pid).push(ev);
  }
  for (const [, g] of byPhoto) sortEventsInPlace(g);

  const groupRendered = new Set();
  let anim = 0;
  for (const ev of deduped) {
    const pid = validEventPhotoId(ev);
    const group = pid ? byPhoto.get(pid) : null;
    const multi = group && group.length > 1;
    if (multi) {
      if (groupRendered.has(pid)) continue;
      groupRendered.add(pid);
      const row = document.createElement("div");
      row.className = "event-row event-row-photo-group";
      row.style.animationDelay = `${anim * 0.03}s`;
      anim += 1;
      const lines = group.map((e) => eventLineHtml(e)).join("");
      row.innerHTML = `${photoThumbHtml(pid)}<div class="event-photo-group-stack">${lines}</div>`;
      localEvents.appendChild(row);
      continue;
    }
    const row = document.createElement("div");
    row.className = "event-row";
    row.style.animationDelay = `${anim * 0.03}s`;
    anim += 1;
    const label = sourceLabel(ev.source);
    const dest = { google: "Google Calendar", apple: "Apple Calendar", cue: "Cue" }[ev.destination] || "";
    const showThumb = ev.source === "photo" && pid;
    const thumb = showThumb ? photoThumbHtml(pid) : "";
    row.innerHTML = `${thumb}<div class="event-info"><div class="event-title">${escapeHtml(ev.title)}${label ? ` <span class="source-tag">${label}</span>` : ""}</div><div class="event-meta">${formatDate(ev.start)}${dest ? ` · ${dest}` : ""}</div></div>`;
    localEvents.appendChild(row);
  }
}

async function loadLocalEvents() {
  if (!sessionInfo.authenticated) {
    localEventsCache = [];
    renderActivityList();
    renderMonthCalendar();
    return;
  }
  const data = await api("/api/events/local");
  localEventsCache = data.events || [];
  renderActivityList();
  renderMonthCalendar();
}

/* ── Month calendar ───────────────────────── */

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function getEventsForDate(ds) { return localEventsCache.filter((ev) => ev.start && ev.start.slice(0, 10) === ds); }
function dotClass(src) { return { text: "dot-text", photo: "dot-photo", gmail: "dot-gmail" }[src] || ""; }

function renderMonthCalendar() {
  monthCalTitle.textContent = `${MONTHS[calViewMonth]} ${calViewYear}`;
  const startDow = new Date(calViewYear, calViewMonth, 1).getDay();
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
  const prevLast = new Date(calViewYear, calViewMonth, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");
  monthCalGrid.innerHTML = "";
  for (let i = 0; i < startDow; i++) { const d = prevLast - startDow + 1 + i; const pm = calViewMonth === 0 ? 11 : calViewMonth - 1; const py = calViewMonth === 0 ? calViewYear - 1 : calViewYear; monthCalGrid.appendChild(makeDay(d, `${py}-${pad(pm + 1)}-${pad(d)}`, true, todayStr)); }
  for (let d = 1; d <= daysInMonth; d++) monthCalGrid.appendChild(makeDay(d, `${calViewYear}-${pad(calViewMonth + 1)}-${pad(d)}`, false, todayStr));
  const total = startDow + daysInMonth, rem = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let i = 1; i <= rem; i++) { const nm = calViewMonth === 11 ? 0 : calViewMonth + 1; const ny = calViewMonth === 11 ? calViewYear + 1 : calViewYear; monthCalGrid.appendChild(makeDay(i, `${ny}-${pad(nm + 1)}-${pad(i)}`, true, todayStr)); }
  if (calSelectedDay) { const sel = monthCalGrid.querySelector(`[data-date="${calSelectedDay}"]`); if (sel) { sel.classList.add("selected"); showDayDetail(calSelectedDay); } else closeDayDetail(); }
}

function makeDay(num, dateStr, other, todayStr) {
  const cell = document.createElement("div"); cell.className = "cal-day"; cell.dataset.date = dateStr;
  if (other) cell.classList.add("other-month"); if (dateStr === todayStr) cell.classList.add("today"); if (dateStr === calSelectedDay) cell.classList.add("selected");
  const n = document.createElement("span"); n.className = "day-num"; n.textContent = num; cell.appendChild(n);
  const events = getEventsForDate(dateStr);
  if (events.length) { const dots = document.createElement("div"); dots.className = "day-dots"; events.slice(0, 4).forEach((ev) => { const d = document.createElement("span"); d.className = `day-dot ${dotClass(ev.source)}`; dots.appendChild(d); }); cell.appendChild(dots); }
  cell.addEventListener("click", () => {
    const prev = monthCalGrid.querySelector(".cal-day.selected"); if (prev) prev.classList.remove("selected");
    if (calSelectedDay === dateStr) { closeDayDetail(); return; }
    calSelectedDay = dateStr; cell.classList.add("selected"); showDayDetail(dateStr);
  });
  return cell;
}

function showDayDetail(dateStr) {
  calSelectedDay = dateStr;
  dayDetailTitle.textContent = new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const events = getEventsForDate(dateStr);
  dayDetailEvents.innerHTML = "";
  if (!events.length) {
    dayDetailEvents.innerHTML = `<div class="detail-empty"><img class="empty-state-illustration empty-state-illustration--tiny" src="/illustration-empty.png" alt="" width="72" height="72" loading="lazy" />No events</div>`;
  }
  else events.sort((a, b) => new Date(a.start) - new Date(b.start)).forEach((ev, i) => {
    const time = new Date(ev.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const row = document.createElement("div"); row.className = "detail-event"; row.style.animationDelay = `${i * 0.04}s`;
    row.innerHTML = `<span class="detail-dot ${dotClass(ev.source)}"></span><div><div class="detail-name">${escapeHtml(ev.title)}</div><div class="detail-time">${time}</div></div>`;
    dayDetailEvents.appendChild(row);
  });
  monthCalDayDetail.classList.remove("hidden");
}

function closeDayDetail() { calSelectedDay = null; monthCalDayDetail.classList.add("hidden"); const p = monthCalGrid.querySelector(".cal-day.selected"); if (p) p.classList.remove("selected"); }
function navigateMonth(d) { calViewMonth += d; if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; } else if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; } closeDayDetail(); renderMonthCalendar(); }

/* ── Daisy ────────────────────────────────── */

const daisyQuips = [
  "You're doing great, one event at a time.",
  "Life's too short for missed plans.",
  "Go touch grass. I'll handle the calendar.",
  "You remembered! I'm so proud of you.",
  "Petal power activated.",
  "Did someone say brunch?",
  "Your future self says thanks.",
  "I bloom every time you add an event.",
  "Calendar karma: +10 points.",
  "Stop doomscrolling. Go live your plans.",
  "Plot twist: you're actually organized.",
  "Another day, another well-planned adventure.",
  "I'm rooting for you. Get it? Rooting?",
  "Time flies, but at least yours is scheduled.",
  "That's a petal-perfect plan.",
  "Consider this a tiny high-five from a flower.",
  "If plans were seeds, you'd have a garden by now.",
  "Sun's out, calendar's out.",
  "You + a saved event = unstoppable duo.",
  "I'd RSVP yes to your energy.",
  "Chaos who? Never heard of her.",
  "Soft reminder: you're allowed to enjoy the empty slots too.",
  "One tap closer to the good kind of busy.",
  "Your calendar called. It said thank you.",
  "Keep going — even daisies grow one layer at a time.",
  "Main character moment: you actually wrote it down.",
  "Cute behavior: remembering your own plans.",
  "If this were a group chat, I'd react with a flower emoji.",
  "Tiny win, huge mood boost. That's the rule.",
  "You're giving organized, but make it effortless.",
  "Pollen in the air, plans in the air — poetic, honestly.",
  "I'm just here hyping you until the weekend hits.",
  "Bookmark this feeling for the next time you doubt yourself.",
  "Hydrate, then dominate that to-do list.",
  "Your past self is relieved. Your future self is smug.",
  "We love a person who shows up for themselves.",
  "Calendar: tidy. You: thriving. Me: cheering.",
  "That's enough productivity for one petal press.",
];
let lastDaisyIdx = -1;

function daisyClick() {
  const daisyBtn = $("daisyBtn");
  const daisyIcon = daisyBtn?.querySelector?.(".logo-icon");
  if (daisyIcon) {
    daisyBtn.classList.remove("daisy-spinning");
    void daisyIcon.offsetWidth;
    daisyBtn.classList.add("daisy-spinning");
    daisyIcon.addEventListener(
      "animationend",
      () => daisyBtn.classList.remove("daisy-spinning"),
      { once: true }
    );
  }

  let idx;
  do { idx = Math.floor(Math.random() * daisyQuips.length); } while (idx === lastDaisyIdx && daisyQuips.length > 1);
  lastDaisyIdx = idx;

  const el = document.createElement("div");
  el.className = "daisy-toast";
  el.textContent = daisyQuips[idx];
  document.body.appendChild(el);
  el.addEventListener("animationend", () => el.remove());

  switchTab("quick");
}

/* ── Init ─────────────────────────────────── */

function attachHandlers() {
  $("daisyBtn").addEventListener("click", daisyClick);
  parseTextBtn.addEventListener("click", () => parseText());
  textInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); parseText(); } });
  quickUpdateBtn.addEventListener("click", () => quickUpdatePreviewStep().catch((e) => showToast(e.message, "error")));
  quickUpdateConfirm.addEventListener("click", () => quickUpdateConfirmAction().catch((e) => showToast(e.message, "error")));
  quickUpdateCancel.addEventListener("click", resetQuickUpdatePreview);
  refreshLocalBtn.addEventListener("click", () => loadLocalEvents().catch((e) => showToast(e.message, "error")));
  activitySearch.addEventListener("input", renderActivityList);
  activitySort.addEventListener("change", renderActivityList);
  openCueAuthBtn?.addEventListener("click", () => openCueAuthModal());
  closeCueAuthBtn?.addEventListener("click", closeCueAuthModal);
  cueAuthModal?.addEventListener("click", (e) => { if (e.target === cueAuthModal) closeCueAuthModal(); });
  cueAuthSubmitBtn?.addEventListener("click", () => submitCueAuth(false).catch((e) => showToast(e.message, "error")));
  cueAuthRegisterBtn?.addEventListener("click", () => submitCueAuth(true).catch((e) => showToast(e.message, "error")));
  connectGmailBtn?.addEventListener("click", () => connectGmail().catch((e) => showToast(e.message, "error")));
  quickLockedSignInBtn?.addEventListener("click", () => openCueAuthModal());
  activityLockedSignInBtn?.addEventListener("click", () => openCueAuthModal());
  signOutBtn.addEventListener("click", () => signOut().catch((e) => showToast(e.message, "error")));
  scanGmailBtn.addEventListener("click", () => scanNow());
  bulkApproveBtn.addEventListener("click", () => bulkApprove().catch((e) => showToast(e.message, "error")));
  strictDateTimeAdv.addEventListener("change", () => saveAdvRules().catch((e) => showToast(e.message, "error")));
  strictIntentAdv.addEventListener("change", () => saveAdvRules().catch((e) => showToast(e.message, "error")));
  monthCalPrev.addEventListener("click", () => navigateMonth(-1));
  monthCalNext.addEventListener("click", () => navigateMonth(1));
  monthCalToday.addEventListener("click", () => { const now = new Date(); calViewYear = now.getFullYear(); calViewMonth = now.getMonth(); calSelectedDay = now.toISOString().slice(0, 10); renderMonthCalendar(); showDayDetail(calSelectedDay); });
  dayDetailClose.addEventListener("click", closeDayDetail);
  closeConfirmBtn.addEventListener("click", closeConfirmModal);
  confirmModal.addEventListener("click", (e) => { if (e.target === confirmModal) closeConfirmModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (eventPhotoLightbox && !eventPhotoLightbox.classList.contains("hidden")) {
      closeEventPhotoLightbox();
      return;
    }
    if (cueAuthModal && !cueAuthModal.classList.contains("hidden")) closeCueAuthModal();
    else if (!confirmModal.classList.contains("hidden")) closeConfirmModal();
    else if (!shareModal.classList.contains("hidden")) closeShareModal();
  });

  function openEventPhotoLightbox(photoId) {
    if (!eventPhotoLightbox || !eventPhotoLightboxImg || !photoId) return;
    eventPhotoLightboxImg.src = `/api/event-photos/${encodeURIComponent(photoId)}`;
    eventPhotoLightbox.classList.remove("hidden");
  }
  function closeEventPhotoLightbox() {
    if (!eventPhotoLightbox || !eventPhotoLightboxImg) return;
    eventPhotoLightbox.classList.add("hidden");
    eventPhotoLightboxImg.src = "";
  }
  localEvents.addEventListener("click", (e) => {
    const btn = e.target.closest(".event-photo-thumb");
    if (!btn?.dataset?.photoId) return;
    e.preventDefault();
    openEventPhotoLightbox(btn.dataset.photoId);
  });
  eventPhotoLightboxClose?.addEventListener("click", closeEventPhotoLightbox);
  eventPhotoLightbox?.querySelector(".event-photo-lightbox-backdrop")?.addEventListener("click", closeEventPhotoLightbox);
}

initTabs();
attachHandlers();
attachShareHandlers();
wirePhotoDropzone();
renderMonthCalendar();

(async function boot() {
  try {
    await refreshSession();
  } catch (e) {
    showToast(e.message || "Could not reach server.", "error");
  }
  await loadLocalEvents().catch(() => {});
  if (sessionInfo.authenticated) {
    await loadCalendars().catch(() => {});
    await loadGmailStatus().catch(() => {});
    await loadReviewQueue().catch(() => {});
  } else {
    queueState = { suggestions: [], senderRules: { blocked: [], allowed: [] }, settings: {} };
    renderReviewQueue();
    syncAdvancedFromQueue();
  }
  updateSessionUI();
  try {
    const flash = sessionStorage.getItem("cueSignedInFlash");
    if (flash && sessionInfo.authenticated) {
      sessionStorage.removeItem("cueSignedInFlash");
      showToast(flash === "created" ? "Account created. You’re signed in." : "Signed in.", "success");
    }
  } catch {}
  if (!sessionInfo.authenticated) {
    openCueAuthModal();
  }
})();

setInterval(() => {
  if (!sessionInfo.authenticated) return;
  loadGmailStatus().catch(() => {});
  loadReviewQueue().catch(() => {});
}, 20000);

