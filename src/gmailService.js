const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { google } = require("googleapis");
const chrono = require("chrono-node");
const { parseEventsFromText } = require("./eventParser");
const { gmailCredentials: CREDENTIALS_PATH, gmailOAuthState: STATES_PATH, ensureDataDir } = require("./dataPaths");
const { userTokensPath, ensureUserDir } = require("./userPaths");
const { seal: sealTokenPayload, open: openTokenPayload } = require("./tokenCrypto");

const REDIRECT_PATH = "/api/gmail/oauth/callback";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

function toBase64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildPkcePair() {
  const codeVerifier = toBase64Url(crypto.randomBytes(64));
  const codeChallenge = toBase64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

async function readJson(pathName, fallback) {
  try {
    const raw = await fs.readFile(pathName, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(pathName, value) {
  await ensureDataDir();
  await fs.writeFile(pathName, JSON.stringify(value, null, 2), "utf8");
}

function decodeBase64Url(value) {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function htmlToText(raw) {
  return (raw || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractPartsText(part) {
  if (!part) {
    return "";
  }

  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  if (part.parts?.length) {
    return part.parts.map(extractPartsText).filter(Boolean).join("\n");
  }

  return "";
}

function extractHeader(payload, name) {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function extractLinks(text) {
  const matches = text.match(/https?:\/\/[^\s)"'>]+/g) || [];
  const cleaned = matches
    .map((url) => url.trim().replace(/[>"'.,;]+$/g, ""))
    .filter((url) => !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(url));
  const unique = [...new Set(cleaned)];
  return unique.slice(0, 5);
}

function normalizeWhitespace(text) {
  return (text || "").replace(/\r/g, "").replace(/\t/g, " ").replace(/\s+/g, " ").trim();
}

function compactLines(text, maxLines = 120) {
  return (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

function scoreEmailIntent({ subject, snippet, bodyText, from }) {
  const joined = `${subject}\n${snippet}\n${bodyText}`.toLowerCase();
  const sender = (from || "").toLowerCase();
  const commitmentHints = [
    /purchase confirmation/,
    /\bpayment successful\b/,
    /\byou are registered\b/,
    /\bregistration confirmed\b/,
    /\byour ticket\b/,
    /\border\s*#\w+/,
    /\bbooking confirmed\b/,
    /\bappointment confirmed\b/,
  ];
  const eventHints = [
    /\bshow\b/,
    /\bevent\b/,
    /\bwebinar\b/,
    /\bmeeting\b/,
    /\bappointment\b/,
    /\breservation\b/,
    /\bticket\b/,
    /\badmission\b/,
    /\bconcert\b/,
    /\bcomedy\b/,
    /\bclass\b/,
    /\bsession\b/,
  ];
  const negative = [
    /\bunsubscribe\b/,
    /\bnewsletter\b/,
    /\bpromo\b/,
    /\bsale\b/,
    /\bdiscount\b/,
    /\boffer\b/,
    /\blineup(s)? can and may change\b/,
    /\bnew arrivals?\b/,
    /\breturn request confirmed\b/,
    /\brefund\b/,
    /\breturn label\b/,
    /\breturn summary\b/,
  ];

  const hasCommitment = commitmentHints.some((pattern) => pattern.test(joined));
  const hasEvent = eventHints.some((pattern) => pattern.test(joined));
  const isEventSeller = /(seatengine|eventbrite|ticketmaster|stubhub|evite|partiful|luma|meetup|zoom|webinar)/.test(sender);
  let score = hasCommitment ? 2 : 0;
  if (hasEvent) score += 2;
  if (isEventSeller) score += 2;
  for (const pattern of negative) {
    if (pattern.test(joined)) {
      score -= 1;
    }
  }

  const reasons = [];
  if (hasCommitment) reasons.push("Contains commitment signal");
  if (hasEvent) reasons.push("Contains event keyword");
  if (isEventSeller) reasons.push("Known event or travel sender");

  return {
    score,
    hasCommitment,
    hasEvent,
    reasons,
    isLikely: hasCommitment && score >= 2,
  };
}

function collectEventFocusedText(subject, snippet, bodyText) {
  const lines = compactLines(bodyText, 160);
  const relevant = lines.filter((line) => {
    const lower = line.toLowerCase();
    if (lower.length < 3 || lower.length > 180) {
      return false;
    }
    if (/unsubscribe|privacy policy|terms of service|manage preferences|view this summary in your browser/.test(lower)) {
      return false;
    }
    return (
      /\b(mon|tue|wed|thu|fri|sat|sun)\b/i.test(line) ||
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(line) ||
      /\b\d{1,2}:\d{2}\s?(am|pm)?\b/i.test(line) ||
      /\b\d{1,2}\s?(am|pm)\b/i.test(line) ||
      /\bto\b/i.test(line) ||
      /\bfrom\b/i.test(line) ||
      /\bstarts?\b/i.test(line) ||
      /\bends?\b/i.test(line) ||
      /\bdate\b/i.test(line) ||
      /\btime\b/i.test(line) ||
      /\bwhen\b/i.test(line)
    );
  });

  return normalizeWhitespace([subject, snippet, ...relevant.slice(0, 20)].join(". "));
}

function cleanSubject(subject) {
  return (subject || "")
    .replace(/^\s*(re|fw|fwd)\s*:\s*/i, "")
    .replace(/\border\s*#?[A-Z0-9-]+\s*[-:]\s*/i, "")
    .replace(/\b(purchase|order|booking|payment|registration|ticket)\s+confirmation\b/i, "")
    .replace(/\b(your|successfully)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSenderName(fromHeader) {
  const quoted = fromHeader.match(/"([^"]+)"/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  const beforeEmail = fromHeader.split("<")[0].trim();
  return beforeEmail || "Event";
}

function extractSenderEmail(fromHeader) {
  const bracket = fromHeader.match(/<([^>]+)>/);
  if (bracket?.[1]) {
    return bracket[1].trim().toLowerCase();
  }

  if (fromHeader.includes("@")) {
    return fromHeader.trim().toLowerCase();
  }

  return "";
}

function extractEventNameFromBody(bodyText) {
  const ticketMatch = bodyText.match(/tickets?\s+for\s+(.+?)\s+at\b/i);
  if (ticketMatch?.[1]) {
    return ticketMatch[1].trim();
  }
  const headingMatch = bodyText.match(/\n([A-Za-z0-9 '&.-]{3,80})\s*-\s*\d{1,2}(?::\d{2})?\s?(AM|PM)\b/i);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  return "";
}

function chooseEventTitle(subject, fromHeader, bodyText = "") {
  const bodyTitle = extractEventNameFromBody(bodyText);
  if (bodyTitle) {
    return bodyTitle;
  }
  const subjectTitle = cleanSubject(subject);
  if (subjectTitle && subjectTitle.length >= 4) {
    return subjectTitle;
  }
  return extractSenderName(fromHeader);
}

function pickBestEvent(parsedEvents) {
  if (!parsedEvents.length) {
    return null;
  }

  const scored = parsedEvents.map((event) => {
    let score = 0;
    const text = (event.sourceText || "").toLowerCase();
    if (!event.allDay) {
      score += 2;
    }
    if (/\b(am|pm)\b/.test(text) || /\d{1,2}:\d{2}/.test(text)) {
      score += 2;
    }
    if (/\bto\b/.test(text) && /\b(am|pm)\b/.test(text)) {
      score += 2;
    }
    if (/\b(apr|may|jun|jul|aug|sep|oct|nov|dec|jan|feb|mar)\b/.test(text)) {
      score += 1;
    }
    if (/thank you|lineup|as needed|strictly|purchase per person/.test(text)) {
      score -= 3;
    }
    if ((event.title || "").length > 80) {
      score -= 2;
    }
    if (new Date(event.start) < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      score -= 3;
    }

    return { event, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].event;
}

function pickRelevantLinks(allLinks, messageUrl) {
  const links = allLinks || [];
  const highSignal = links.filter((link) =>
    /(zoom\.us|meet\.google\.com|teams\.microsoft\.com|eventbrite|lu\.ma|calendly|webinar|ticket|tickets|join|register)/i.test(link)
  );
  const nonTracking = links.filter(
    (link) =>
      !/(tracking\.|\/ls\/click|utm_|mailchi\.mp|mandrillapp|doubleclick|click\.|amazon\.com\/gp\/r\.html|w3\.org\/|\/r\/\?id=)/i.test(link)
  );

  const preferred = highSignal[0] || messageUrl || nonTracking[0];
  const merged = [...new Set([...highSignal, ...nonTracking, messageUrl])].slice(0, 4);
  return { preferred, links: merged };
}

function extractExplicitDateRange(text) {
  const normalized = normalizeWhitespace(text);
  const rangeMatch =
    normalized.match(
      /\b(?:mon|tue|wed|thu|fri|sat|sun)\w*,?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\s+(\d{1,2}(?::\d{2})?\s?(?:AM|PM))\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?\s?(?:AM|PM))/i
    ) ||
    normalized.match(
      /\b([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\s+(\d{1,2}(?::\d{2})?\s?(?:AM|PM))\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?\s?(?:AM|PM))/i
    );

  if (!rangeMatch) {
    return null;
  }

  const startParsed = chrono.parseDate(`${rangeMatch[1]} ${rangeMatch[2]}`, new Date(), { forwardDate: true });
  const endParsed = chrono.parseDate(`${rangeMatch[1]} ${rangeMatch[3]}`, new Date(), { forwardDate: true });
  if (!startParsed || !endParsed) {
    return null;
  }

  return {
    title: "Event",
    sourceText: rangeMatch[0],
    start: startParsed.toISOString(),
    end: endParsed.toISOString(),
    allDay: false,
  };
}

function extractDateWithSingleTime(text) {
  const normalized = normalizeWhitespace(text);
  const dateMatch = normalized.match(/\b([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/i);
  if (!dateMatch || dateMatch.index === undefined) {
    return null;
  }

  const nearby = normalized.slice(dateMatch.index, dateMatch.index + 220);
  const timeMatch = nearby.match(/\b(\d{1,2}(?::\d{2})?\s?(?:AM|PM))\b/i);
  if (!timeMatch) {
    return null;
  }

  const startParsed = chrono.parseDate(`${dateMatch[1]} ${timeMatch[1]}`, new Date(), { forwardDate: true });
  if (!startParsed) {
    return null;
  }
  const endParsed = new Date(startParsed.getTime() + 2 * 60 * 60 * 1000);
  return {
    title: "Event",
    sourceText: `${dateMatch[1]} ${timeMatch[1]}`,
    start: startParsed.toISOString(),
    end: endParsed.toISOString(),
    allDay: false,
  };
}

function extractTravelDateFromSubject(subject) {
  if (!/\b(itinerary|flight|going to)\b/i.test(subject)) {
    return null;
  }

  const m = subject.match(/\bon\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i);
  if (!m) {
    return null;
  }

  const now = new Date();
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  if (year < 100) {
    year += 2000;
  }
  const month = Number(m[1]) - 1;
  const day = Number(m[2]);
  const start = new Date(year, month, day, 0, 0, 0, 0);
  const end = new Date(year, month, day + 1, 0, 0, 0, 0);
  return {
    title: "Trip",
    sourceText: m[0],
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: true,
  };
}

function hasExplicitDateTimeEvidence(text) {
  const normalized = normalizeWhitespace(text);
  const hasDate =
    /\b([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/i.test(normalized) || /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(normalized);
  const hasTime = /\b\d{1,2}:\d{2}\s?(am|pm)\b/i.test(normalized) || /\b\d{1,2}\s?(am|pm)\b/i.test(normalized);
  return hasDate && hasTime;
}

function computeConfidence({ explicitEvent, bestEvent, intentScore, links }) {
  let confidence = 40;
  if (explicitEvent) confidence += 35;
  if (bestEvent && !bestEvent.allDay) confidence += 10;
  confidence += Math.max(0, Math.min(15, intentScore * 4));
  if ((links || []).length > 0) confidence += 5;
  return Math.max(1, Math.min(99, confidence));
}

function buildImportantNotes({ from, subject, date, snippet, bodyText, messageUrl }) {
  const lines = compactLines(bodyText, 180);
  const important = lines.filter((line) => {
    const lower = line.toLowerCase();
    if (
      /ticket price|ticket tax|total|subtotal|service charges|view all ticket policies|bag policy|all sales are final|lineups are subject/.test(
        lower
      )
    ) {
      return false;
    }
    return /\b(location|venue|address|join|meeting|zoom|google meet|teams|confirmation|order|booking|door time|starts?|ends?|check[- ]?in|entry|show you are attending)\b/i.test(
      line
    );
  });
  const condensed = important.slice(0, 4).join("\n");

  return [
    `From: ${from || "Unknown"}`,
    `Subject: ${subject || "(No subject)"}`,
    date ? `Email Date: ${date}` : "",
    snippet ? `Summary: ${snippet}` : "",
    condensed ? `Important details:\n${condensed}` : "",
    `Message: ${messageUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function getCredentials() {
  return readJson(CREDENTIALS_PATH, null);
}

async function saveCredentials(credentials) {
  await writeJson(CREDENTIALS_PATH, credentials);
}

async function getTokens(userId) {
  await ensureUserDir(userId);
  const p = userTokensPath(userId);
  try {
    const raw = (await fs.readFile(p, "utf8")).trim();
    if (!raw) {
      return null;
    }
    const json = openTokenPayload(raw);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function saveTokens(userId, tokens) {
  await ensureUserDir(userId);
  const p = userTokensPath(userId);
  const payload = sealTokenPayload(JSON.stringify(tokens));
  await fs.writeFile(p, payload, { encoding: "utf8", mode: 0o600 });
}

async function getOAuthStates() {
  return readJson(STATES_PATH, {});
}

async function saveOAuthStates(states) {
  await writeJson(STATES_PATH, states);
}

function getRedirectUri(baseUrl, credentials) {
  return credentials.redirectUri || `${baseUrl}${REDIRECT_PATH}`;
}

function createOAuthClient(credentials, baseUrl) {
  const redirectUri = getRedirectUri(baseUrl, credentials);
  if (credentials.clientSecret) {
    return new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, redirectUri);
  }

  // PKCE public-client mode: do not send an empty client secret.
  return new google.auth.OAuth2(credentials.clientId, undefined, redirectUri);
}

async function getAuthorizedClient(baseUrl, userId) {
  const credentials = await getCredentials();
  if (!credentials?.clientId) {
    throw new Error("Gmail not configured. Save Google OAuth client ID first.");
  }

  const tokens = await getTokens(userId);
  if (!tokens?.access_token && !tokens?.refresh_token) {
    throw new Error("Gmail not connected yet. Complete OAuth first.");
  }

  const auth = createOAuthClient(credentials, baseUrl);
  auth.setCredentials(tokens);
  return auth;
}

async function createAuthUrl(baseUrl, ledgerUserId = null) {
  const credentials = await getCredentials();
  if (!credentials?.clientId) {
    throw new Error("Gmail not configured. Save Google OAuth client ID first.");
  }

  const auth = createOAuthClient(credentials, baseUrl);
  const state = crypto.randomUUID();
  const { codeVerifier, codeChallenge } = buildPkcePair();
  const states = await getOAuthStates();
  states[state] = {
    createdAt: new Date().toISOString(),
    codeVerifier,
    ledgerUserId: ledgerUserId && typeof ledgerUserId === "string" ? ledgerUserId : null,
  };
  await saveOAuthStates(states);

  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: DEFAULT_SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  });

  return url;
}

async function handleOAuthCallback({ baseUrl, code, state }) {
  const states = await getOAuthStates();
  const stateData = states[state];
  if (!stateData) {
    throw new Error("Invalid OAuth state.");
  }
  if (!stateData.codeVerifier) {
    throw new Error("Missing PKCE verifier for this OAuth state. Please retry Connect Gmail.");
  }

  delete states[state];
  await saveOAuthStates(states);

  const credentials = await getCredentials();
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    code,
    code_verifier: stateData.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: getRedirectUri(baseUrl, credentials),
  });
  if (credentials.clientSecret) {
    params.set("client_secret", credentials.clientSecret);
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokenJson = await tokenResponse.json();
  if (!tokenResponse.ok) {
    const reason = tokenJson.error_description || tokenJson.error || "Token exchange failed";
    throw new Error(reason);
  }

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileRes.ok) {
    throw new Error("Could not read your Google profile after sign-in.");
  }
  const profile = await profileRes.json();
  const googleSub = String(profile.sub || "");
  if (!/^[0-9]{1,128}$/.test(googleSub)) {
    throw new Error("Unexpected Google account id.");
  }
  const ledgerFromState = stateData.ledgerUserId;
  let tokenUserId = googleSub;
  if (ledgerFromState && typeof ledgerFromState === "string") {
    if (/^c[0-9a-f]{32}$/.test(ledgerFromState)) {
      tokenUserId = ledgerFromState;
    } else if (/^g[0-9a-f]{32}$/.test(ledgerFromState)) {
      tokenUserId = ledgerFromState;
    }
    /* else: invalid ledger in state — fall back to googleSub for safety */
  }
  await saveTokens(tokenUserId, tokenJson);
  return { ledgerUserId: tokenUserId, googleSub, email: profile.email || "" };
}

async function fetchInboxSuggestions(baseUrl, options = {}) {
  const {
    maxResults = 20,
    requireExplicitDateTime = true,
    requireEventIntent = true,
    blockedSenders = [],
    allowedSenders = [],
    existingKeys = [],
    userId,
  } = options;
  if (!userId) {
    throw new Error("Missing user for Gmail request.");
  }
  const auth = await getAuthorizedClient(baseUrl, userId);
  const gmail = google.gmail({ version: "v1", auth });

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: "in:inbox newer_than:14d",
  });

  const messages = listResponse.data.messages || [];
  const suggestions = [];
  const existingSet = new Set(existingKeys.map((key) => key.toLowerCase()));
  const blocked = new Set(blockedSenders.map((value) => value.toLowerCase()));
  const allowed = new Set(allowedSenders.map((value) => value.toLowerCase()));

  for (const messageRef of messages) {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: messageRef.id,
      format: "full",
    });

    const payload = detail.data.payload || {};
    const subject = extractHeader(payload, "Subject");
    const from = extractHeader(payload, "From");
    const senderEmail = extractSenderEmail(from);
    if (blocked.has(senderEmail)) {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(senderEmail)) {
      continue;
    }
    const date = extractHeader(payload, "Date");
    const snippet = detail.data.snippet || "";
    const rawBody = extractPartsText(payload) || decodeBase64Url(payload.body?.data || "");
    const bodyText = htmlToText(rawBody);
    const intent = scoreEmailIntent({ subject, snippet, bodyText, from });
    if (requireEventIntent && !intent.isLikely) {
      continue;
    }

    const combinedText = `${subject}\n${snippet}\n${bodyText}`;
    const hasExplicit = hasExplicitDateTimeEvidence(combinedText);
    if (requireExplicitDateTime && !hasExplicit) {
      continue;
    }

    const focused = collectEventFocusedText(subject, snippet, bodyText);
    const explicitEvent =
      extractExplicitDateRange(combinedText) ||
      extractDateWithSingleTime(combinedText) ||
      extractTravelDateFromSubject(subject);
    const parsedEvents = parseEventsFromText(focused);
    const bestEvent = explicitEvent || pickBestEvent(parsedEvents);
    if (!bestEvent) {
      continue;
    }

    const allLinks = extractLinks(`${subject}\n${snippet}\n${rawBody}\n${bodyText}`);
    const messageUrl = `https://mail.google.com/mail/u/0/#inbox/${messageRef.id}`;
    const chosenTitle = chooseEventTitle(subject, from, bodyText);
    const { preferred, links } = pickRelevantLinks(allLinks, messageUrl);
    const confidence = computeConfidence({ explicitEvent, bestEvent, intentScore: intent.score, links });
    const reasons = [...intent.reasons];
    if (explicitEvent) reasons.push("Explicit date/time extracted");
    if (hasExplicit) reasons.push("Date and time both present");
    if (links.length > 0) reasons.push("Actionable link extracted");

    const key = `${messageRef.id}|${bestEvent.start}|${chosenTitle}`.toLowerCase();
    if (existingSet.has(key)) {
      continue;
    }

    const event = {
      ...bestEvent,
      title: chosenTitle,
      notes: buildImportantNotes({ from, subject, date, snippet, bodyText, messageUrl }),
      url: preferred,
      links,
    };

    suggestions.push({
      messageId: messageRef.id,
      threadId: detail.data.threadId,
      subject,
      from,
      senderEmail,
      date,
      snippet,
      messageUrl,
      confidence,
      reasons,
      links,
      event,
    });
  }

  return suggestions;
}

async function fetchInboxEventCandidates(baseUrl, maxResults = 12, userId) {
  const suggestions = await fetchInboxSuggestions(baseUrl, { maxResults, userId });
  return suggestions.map((suggestion) => ({
    messageId: suggestion.messageId,
    threadId: suggestion.threadId,
    subject: suggestion.subject,
    from: suggestion.from,
    date: suggestion.date,
    snippet: suggestion.snippet,
    messageUrl: suggestion.messageUrl,
    links: suggestion.links,
    events: [suggestion.event],
  }));
}

async function getStatus(userId) {
  const credentials = await getCredentials();
  if (!userId) {
    return {
      configured: Boolean(credentials?.clientId),
      connected: false,
      redirectUri: credentials?.redirectUri || null,
    };
  }
  const tokens = await getTokens(userId);
  return {
    configured: Boolean(credentials?.clientId),
    connected: Boolean(tokens?.access_token || tokens?.refresh_token),
    redirectUri: credentials?.redirectUri || null,
  };
}

module.exports = {
  saveCredentials,
  createAuthUrl,
  handleOAuthCallback,
  fetchInboxSuggestions,
  fetchInboxEventCandidates,
  getStatus,
  getAuthorizedClient,
};
