// Config storage + discovery.
//
// Config lives in ~/.config/opentogether/config.json (or $XDG_CONFIG_HOME).
// The passphrase is what keeps the link private, so we store it with 0600 perms.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function configDir() {
  const base = process.env.OPENTOGETHER_CONFIG_DIR || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return base.endsWith("opentogether") ? base : path.join(base, "opentogether");
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

export function defaultConfig() {
  return {
    version: 1,
    // relay
    relayUrl: "",
    passphrase: "",
    room: "default",
    name: "",
    role: "host",
    // opencode
    opencodeUrl: "http://127.0.0.1:4096",
    opencodeDirectory: "",
    opencodePassword: "",
    // behaviour
    autoRespond: true,
    forwardLocalUserMessages: false,
    agent: "",
    model: null,
    replyTimeoutMs: 600000,
    // loop protection
    maxHops: 8,
    turnBudget: 12,
    budgetWindowMs: 600000,
    linkSessionId: null,
  };
}

export function loadConfig() {
  const file = configPath();
  const base = defaultConfig();
  if (!fs.existsSync(file)) return { config: base, path: file, exists: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { config: { ...base, ...raw }, path: file, exists: true };
  } catch (err) {
    throw new Error(`config file ${file} is not valid JSON: ${err.message}`);
  }
}

export function saveConfig(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

/**
 * Discover a running OpenCode server. Checks:
 *  1. an explicit url in config
 *  2. $OPENCODE_SERVER_URL
 *  3. well-known ports
 */
export async function discoverOpencode({ explicitUrl, directory } = {}) {
  const candidates = [];
  if (explicitUrl) candidates.push(explicitUrl);
  if (process.env.OPENCODE_SERVER_URL) candidates.push(process.env.OPENCODE_SERVER_URL);
  // Common OpenCode server ports: `opencode serve` defaults, plus the port the
  // OpenCode Desktop app's bundled server listens on.
  for (const port of [4096, 4097, 4098, 4099, 4100, 4111, 4112, 4113, 8080, 8081]) {
    candidates.push(`http://127.0.0.1:${port}`);
  }

  for (const url of [...new Set(candidates)]) {
    try {
      const probe = new URL("/global/health", url);
      if (directory) probe.searchParams.set("directory", directory);
      const res = await fetch(probe, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      // Require an actual OpenCode health payload — an unrelated web server on
      // the same port can answer 200 with HTML.
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== "object") continue;
      return { url: url.replace(/\/+$/, ""), health: body };
    } catch {
      continue;
    }
  }
  return null;
}

export function relayUrlFromParts(url) {
  let u = String(url ?? "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) u = u.replace(/^http/i, "ws");
  else if (!/^wss?:\/\//i.test(u)) u = "ws://" + u;
  const parsed = new URL(u);
  if (parsed.pathname === "/" || parsed.pathname === "") parsed.pathname = "/ot";
  return parsed.toString();
}
