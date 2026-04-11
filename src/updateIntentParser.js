const STOP_WORDS = new Set([
  "for",
  "the",
  "my",
  "our",
  "an",
  "a",
  "to",
  "is",
  "on",
  "at",
  "event",
  "upcoming",
]);

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function toTitleCase(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function parseBirthdayTarget(targetRaw) {
  const match = targetRaw.match(/(.+?)'?s?\s+(bday|birthday)/i);
  if (!match) {
    return {
      displayTarget: "Birthday",
      searchTerms: ["birthday"],
      requiredMatches: 1,
    };
  }

  const person = match[1].replace(/[^\w\s'-]/g, "").trim();
  const personTerm = person.length >= 2 ? person.toLowerCase() : "";
  return {
    displayTarget: `${toTitleCase(person || "Birthday")}${person ? "'s" : ""} Birthday`,
    searchTerms: personTerm ? [personTerm, "birthday"] : ["birthday"],
    requiredMatches: personTerm ? 2 : 1,
  };
}

function parseTripTarget(targetRaw) {
  const cleaned = targetRaw
    .replace(/\btrip\b/gi, "")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const location = cleaned || "Trip";
  const terms = location
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 2 && !STOP_WORDS.has(part));
  return {
    displayTarget: `${toTitleCase(location)} Trip`,
    searchTerms: terms.length ? [...terms, "trip"] : ["trip"],
    requiredMatches: terms.length ? 1 : 1,
  };
}

function parseGenericTarget(targetRaw) {
  const cleaned = targetRaw.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const terms = cleaned
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length >= 2 && !STOP_WORDS.has(part));
  return {
    displayTarget: toTitleCase(cleaned),
    searchTerms: terms,
    requiredMatches: terms.length > 1 ? 2 : 1,
  };
}

function parseUpdateIntent(inputText) {
  const text = normalizeText(inputText);
  if (!text) {
    return null;
  }

  const directPattern = /^(?:need to|remember to|dont forget to|don't forget to|please)\s+(.+?)\s+for\s+(.+)$/i;
  const neutralPattern = /^(.+?)\s+for\s+(.+)$/i;
  const toPattern = /^(?:add|note|remember)\s+(.+?)\s+(?:to|for)\s+(.+)$/i;
  const match = text.match(directPattern) || text.match(toPattern) || text.match(neutralPattern);
  if (!match) {
    return null;
  }

  const noteRaw = normalizeText(match[1]);
  const targetRaw = normalizeText(match[2]);
  if (!noteRaw || !targetRaw) {
    return null;
  }

  let target;
  if (/\bbday\b|\bbirthday\b/i.test(targetRaw)) {
    target = parseBirthdayTarget(targetRaw);
  } else if (/\btrip\b/i.test(targetRaw)) {
    target = parseTripTarget(targetRaw);
  } else {
    target = parseGenericTarget(targetRaw);
  }

  const noteText = noteRaw[0].toUpperCase() + noteRaw.slice(1);

  return {
    noteText,
    originalText: text,
    targetRaw,
    displayTarget: target.displayTarget || targetRaw,
    searchTerms: target.searchTerms,
    requiredMatches: target.requiredMatches || 1,
  };
}

module.exports = {
  parseUpdateIntent,
};
