// Small shared helpers: ids, hashing, SSE parsing, tiny HTTP helpers, logging.

import { createHash, randomBytes } from "node:crypto";

export function newId(prefix, len = 6) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return prefix + out;
}

export function shortHash(input, len = 8) {
  return createHash("sha256").update(String(input)).digest("hex").slice(0, len);
}

export function nowIso() {
  return new Date().toISOString();
}

/** Redact obvious secrets from text that we are about to send over the wire. */
export function scrubSecrets(text) {
  if (typeof text !== "string") return text;
  let out = text;
  const rules = [
    // Common provider API keys
    [/\b(sk-[A-Za-z0-9_\-]{12,})/g, "[REDACTED_API_KEY]"],
    [/\b(lumo_live_[A-Za-z0-9_\-]{8,})/g, "[REDACTED_API_KEY]"],
    [/\b(Bearer\s+)[A-Za-z0-9._\-]{16,}/gi, "$1[REDACTED_TOKEN]"],
    [/\b(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{16,}/g, "[REDACTED_GITHUB_TOKEN]"],
    // KEY=value style env assignments for anything that smells secret-ish
    [
      /((?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*)\s*[:=]\s*)(["']?)([^\s"',;]{6,})\2/gi,
      "$1$2[REDACTED]$2",
    ],
  ];
  for (const [re, rep] of rules) out = out.replace(re, rep);
  return out;
}

export function truncate(text, max) {
  if (typeof text !== "string") return text;
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

/**
 * Parse an HTTP SSE (`text/event-stream`) response body.
 * Yields `{ event, data }` where data is JSON-parsed when possible.
 */
export async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const item = parseSSEBlock(raw);
        if (item) yield item;
      }
    }
    // Flush a trailing block if the stream ended without a blank line.
    const tail = parseSSEBlock(buffer);
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

function parseSSEBlock(raw) {
  if (!raw.trim()) return null;
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  const joined = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(joined) };
  } catch {
    return { event, data: joined };
  }
}

export function quietFetch(url, opts = {}) {
  return fetch(url, { ...opts, cache: "no-store" }).catch((err) => {
    throw new Error(`cannot reach ${url}: ${err?.message ?? err}`);
  });
}

export async function readJsonSafe(response) {
  const text = await response.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function sanitizeName(name) {
  return (
    String(name ?? "")
      .trim()
      .replace(/[^A-Za-z0-9 _.\-]/g, "")
      .slice(0, 32) || "partner"
  );
}
