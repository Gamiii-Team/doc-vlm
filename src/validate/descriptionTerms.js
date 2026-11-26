// src/validate/descriptionTerms.js — deterministic grounding check for the exact
// source terms used in a figure description. No VLM calls, no domain word lists.

import { normalizeTerm } from "../figureContext.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "has", "have",
  "its", "their", "they", "them", "into", "over", "under", "each", "every", "not", "but",
  "also", "only", "than", "then", "when", "where", "which", "while", "across", "about",
  "shows", "show", "shown", "figure", "chart", "diagram", "image", "slide", "data", "value",
  "values", "group", "groups", "part", "parts", "item", "items", "label", "labels", "text",
  "english", "translated", "visible", "here", "there", "what", "how", "why", "does",
]);

/** Recursively collect strings from native hints / arbitrary JSON-shaped values. */
function collectStrings(value, out = []) {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function significantTokens(value) {
  return normalizeTerm(value)
    .split(/\s+/)
    .filter((tok) => tok.length >= 3 && !STOPWORDS.has(tok));
}

/**
 * Check declared exact terms against the strings actually present in the source.
 * Multiword terms must match verbatim (after normalization); single tokens may
 * match a token from a longer source string.
 */
export function auditDescriptionTerms({
  description: _description,
  descriptionTerms = [],
  visibleText = [],
  nativeStrings = null,
  textLayer = "",
} = {}) {
  const sources = [
    ...(Array.isArray(visibleText) ? visibleText : []),
    ...collectStrings(nativeStrings),
    ...(typeof textLayer === "string" && textLayer.trim() ? [textLayer] : []),
  ];

  const corpus = new Set();
  const corpusTokens = new Set();
  for (const source of sources) {
    const normalized = normalizeTerm(source);
    if (normalized) corpus.add(normalized);
    for (const token of significantTokens(source)) corpusTokens.add(token);
  }
  // Newline separator prevents two adjacent source strings from forming a
  // phrase that was never actually written (e.g. "message" + "queue").
  const corpusText = [...corpus].join("\n");

  const ungrounded = [];
  let checked = 0;
  const declared = Array.isArray(descriptionTerms) ? descriptionTerms : [];

  for (const raw of declared) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const normalized = normalizeTerm(raw);
    const tokens = significantTokens(raw);
    if (!normalized || tokens.length === 0) continue;
    checked += 1;

    const exact = corpus.has(normalized) || Boolean(corpusText.includes(normalized));
    const singleToken = tokens.length === 1
      && (corpusTokens.has(tokens[0]) || corpusText.includes(tokens[0]));
    if (!exact && !singleToken) ungrounded.push(raw);
  }

  return { ok: ungrounded.length === 0, ungrounded, checked };
}
