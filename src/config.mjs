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
 *
 * Both API generations are recognised. v2 requires Basic auth, so when a port
 * answers like v2 we look for its password (env var, then the Desktop app's
 * service.json) and return it alongside the URL.
 */
export async function discoverOpencode({ explicitUrl, directory, password } = {}) {
  const candidates = [];
  if (explicitUrl) candidates.push(explicitUrl);
  if (process.env.OPENCODE_SERVER_URL) candidates.push(process.env.OPENCODE_SERVER_URL);
  // Common OpenCode server ports: `opencode serve` defaults, plus the port the
  // OpenCode Desktop app's bundled server listens on.
  for (const port of [4096, 4097, 4098, 4099, 4100, 4111, 4112, 4113, 8080, 8081]) {
    candidates.push(`http://127.0.0.1:${port}`);
  }

  for (const url of [...new Set(candidates)]) {
    const clean = url.replace(/\/+$/, "");
    try {
      // --- v1: /global/health returns a JSON health payload ---------------
      const probe = new URL("/global/health", clean);
      if (directory) probe.searchParams.set("directory", directory);
      const res = await fetch(probe, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        // Require an actual OpenCode health payload — an unrelated web server
        // on the same port can answer 200 with HTML.
        const body = await res.json().catch(() => null);
        if (body && typeof body === "object" && (body.healthy || body.version)) {
          return { url: clean, health: body, api: "v1" };
        }
      }
    } catch {
      // fall through to the v2 probe
    }

    try {
      // --- v2: /openapi.json is a JSON document (or a 401 JSON rejection) --
      const pw = password || process.env.OPENCODE_SERVER_PASSWORD || readV2Password();
      const headers = {};
      if (pw) {
        headers.authorization =
          "Basic " + Buffer.from(`opencode:${pw}`, "utf8").toString("base64");
      }
      const res = await fetch(clean + "/openapi.json", {
        headers,
        signal: AbortSignal.timeout(1500),
      });
      const ct = res.headers.get("content-type") ?? "";
      if (!/json/i.test(ct)) continue;
      const doc = await res.json().catch(() => null);
      if (res.ok && doc && typeof doc === "object" && (doc.openapi || doc.paths)) {
        return { url: clean, health: { healthy: true, api: "v2" }, api: "v2", password: pw ?? "" };
      }
      if ((res.status === 401 || res.status === 403) && doc?._tag) {
        // It's a v2 server, we just don't have the password yet.
        return { url: clean, health: { healthy: false, api: "v2" }, api: "v2", password: "", needsPassword: true };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Try to find the password an OpenCode v2 server is using.
 *
 * The Desktop app writes one to ~/.config/opencode/service.json. A plain
 * `opencode serve` generates a random password and only prints it to stdout,
 * so there we can't help — the user has to pass it (or set
 * OPENCODE_SERVER_PASSWORD before starting the server).
 */
export function readV2Password() {
  if (process.env.OPENCODE_SERVER_PASSWORD) return process.env.OPENCODE_SERVER_PASSWORD;
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "service.json"),
    path.join(os.homedir(), ".local", "share", "opencode", "service.json"),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof data?.password === "string" && data.password) return data.password;
    } catch {
      continue;
    }
  }
  return "";
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
