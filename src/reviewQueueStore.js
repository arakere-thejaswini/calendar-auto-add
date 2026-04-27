const crypto = require("node:crypto");
const { userQueuePath, ensureUserDir, assertValidUserId } = require("./userPaths");
const { getJson, setJson } = require("./kvStore");

const DEFAULT_DATA = {
  suggestions: [],
  processedKeys: [],
  senderRules: {
    blocked: [],
    allowed: [],
  },
  settings: {
    requireExplicitDateTime: true,
    requireEventIntent: true,
    pollingEnabled: true,
    pollIntervalSec: 120,
    autoApproveHighConfidence: false,
    autoApproveThreshold: 92,
  },
};

function queueKey(userId) {
  return `user:${assertValidUserId(userId)}:review_queue`;
}

async function readQueueData(userId) {
  await ensureUserDir(userId);
  const parsed = await getJson(queueKey(userId), {
    fileFallback: userQueuePath(userId),
    defaultValue: null,
  });
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_DATA };
  }
  return {
    ...DEFAULT_DATA,
    ...parsed,
    senderRules: {
      ...DEFAULT_DATA.senderRules,
      ...(parsed.senderRules || {}),
    },
    settings: {
      ...DEFAULT_DATA.settings,
      ...(parsed.settings || {}),
    },
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    processedKeys: Array.isArray(parsed.processedKeys) ? parsed.processedKeys : [],
  };
}

async function writeQueueData(userId, data) {
  await ensureUserDir(userId);
  await setJson(queueKey(userId), data, { fileFallback: userQueuePath(userId) });
}

function suggestionKey(suggestion) {
  return `${suggestion.messageId}|${suggestion.event.start}|${suggestion.event.title}`.toLowerCase();
}

function mergeSuggestions(existing, incoming) {
  const now = new Date().toISOString();
  const byKey = new Map(existing.map((entry) => [suggestionKey(entry), entry]));
  let newCount = 0;

  for (const suggestion of incoming) {
    const key = suggestionKey(suggestion);
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: crypto.randomUUID(),
        status: "pending",
        rejectionReason: "",
        createdAt: now,
        updatedAt: now,
        ...suggestion,
      });
      newCount += 1;
      continue;
    }

    const current = byKey.get(key);
    if (current.status === "pending") {
      byKey.set(key, {
        ...current,
        ...suggestion,
        id: current.id,
        status: current.status,
        createdAt: current.createdAt,
        updatedAt: now,
      });
    }
  }

  return {
    suggestions: Array.from(byKey.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    newCount,
  };
}

function updateSuggestionStatus(suggestions, suggestionId, status, extra = {}) {
  const now = new Date().toISOString();
  return suggestions.map((suggestion) => {
    if (suggestion.id !== suggestionId) {
      return suggestion;
    }
    return {
      ...suggestion,
      ...extra,
      status,
      updatedAt: now,
    };
  });
}

function getQueueSummary(suggestions) {
  const counts = { pending: 0, approved: 0, rejected: 0, added: 0, failed: 0 };
  for (const suggestion of suggestions) {
    if (counts[suggestion.status] !== undefined) {
      counts[suggestion.status] += 1;
    }
  }
  return counts;
}

module.exports = {
  readQueueData,
  writeQueueData,
  mergeSuggestions,
  updateSuggestionStatus,
  getQueueSummary,
  suggestionKey,
};
