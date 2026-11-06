// One-button installer.
//
// `opentogether install` makes the tool available to *this* user with no npm,
// no sudo, and no manual edits:
//
//   1. puts an `opentogether` launcher on PATH (~/.local/bin, which fish and
//      most distros already search), symlinking to this checkout
//   2. registers the OpenCode plugin by merging a `plugin` entry into the
//      OpenCode config (~/.config/opencode/opencode.json or .jsonc) *without*
//      destroying its comments
//   3. makes sure ~/.local/bin is on the fish PATH (idempotent)
//
// Every step is idempotent and prints exactly what it did, so re-running is safe.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BIN_SRC = path.join(REPO_ROOT, "bin", "opentogether.mjs");
const PLUGIN_SRC = path.join(REPO_ROOT, "src", "plugin.mjs");

/** ~/.local/bin by default; honours XDG. */
export function localBinDir() {
  return path.join(os.homedir(), ".local", "bin");
}

/** All OpenCode config files we might have to patch, in priority order. */
export function opencodeConfigCandidates() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const dir = path.join(base, "opencode");
  return ["opencode.jsonc", "opencode.json", "config.json"].map((f) => path.join(dir, f));
}

// ---------------------------------------------------------------------------
// 1. CLI launcher
// ---------------------------------------------------------------------------

/**
 * Symlink `opentogether` into ~/.local/bin.
 * @returns {{path: string, action: "created"|"updated"|"unchanged"}}
 */
export function installLauncher({ binDir = localBinDir(), log = () => {} } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const link = path.join(binDir, "opentogether");
  const target = fs.realpathSync(BIN_SRC);

  let action = "created";
  try {
    const stat = fs.lstatSync(link);
    if (stat.isSymbolicLink()) {
      const cur = fs.realpathSync(link);
      if (cur === target) return { path: link, action: "unchanged" };
      action = "updated";
    } else {
      action = "updated";
    }
    fs.unlinkSync(link);
  } catch {
    /* nothing there yet */
  }
  fs.symlinkSync(target, link);
  // Make sure the entry point is executable too.
  try {
    fs.chmodSync(BIN_SRC, 0o755);
  } catch {}
  log(`launcher ${action}: ${link} -> ${target}`);
  return { path: link, action };
}

// ---------------------------------------------------------------------------
// 2. OpenCode plugin registration (JSONC-safe)
// ---------------------------------------------------------------------------

/**
 * Remove // and /* *\/ comments from JSON-with-comments, while respecting
 * strings. Good enough for the style OpenCode configs use.
 */
export function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === strCh) inStr = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Trailing commas are legal in most JSON5-ish configs but not JSON.parse.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Parse a (possibly commented) JSON config. Returns {} on empty/invalid. */
export function parseJsonc(text) {
  const cleaned = stripJsonComments(String(text ?? "")).trim();
  if (!cleaned) return {};
  try {
    return JSON.parse(cleaned);
  } catch {
    return null; // caller decides what to do with an unparseable file
  }
}

/**
 * Find the OpenCode config file that exists (or the one we should create).
 * @returns {{file: string, exists: boolean, isJsonc: boolean}}
 */
export function findOpencodeConfig() {
  for (const file of opencodeConfigCandidates()) {
    if (fs.existsSync(file)) {
      return { file, exists: true, isJsonc: file.endsWith(".jsonc") };
    }
  }
  const file = opencodeConfigCandidates()[0];
  return { file, exists: false, isJsonc: true };
}

function pluginUrl() {
  return "file://" + PLUGIN_SRC;
}

/**
 * Register the plugin in the given OpenCode config file.
 *
 * Strategy:
 *  - If the file does not exist: create it (JSONC) with just { plugin: [...] }.
 *  - If it exists and we can parse it: add our URL to the `plugin` array and
 *    write it back. For a .jsonc file we *try* a surgical text edit first so the
 *    user's comments/formatting survive; if that's ambiguous, we fall back to a
 *    pretty-printed JSON write.
 *
 * @returns {{file: string, action: "created"|"added"|"unchanged", preservedComments: boolean}}
 */
export function installPlugin({ file, log = () => {} } = {}) {
  const url = pluginUrl();
  const target = file ?? findOpencodeConfig().file;
  const isJsonc = target.endsWith(".jsonc");

  if (!fs.existsSync(target)) {
    const body = {
      $schema: "https://opencode.ai/config.json",
      plugin: [url],
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(body, null, 2) + "\n");
    log(`plugin config created: ${target}`);
    return { file: target, action: "created", preservedComments: false };
  }

  const original = fs.readFileSync(target, "utf8");
  const parsed = parseJsonc(original);
  if (parsed === null) {
    // Unparseable (unlikely): don't touch it, let the caller warn.
    return { file: target, action: "unchanged", preservedComments: true, error: "unparseable" };
  }

  const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  if (plugins.includes(url)) {
    return { file: target, action: "unchanged", preservedComments: true };
  }
  const nextPlugins = [...plugins, url];

  // Preferred: surgical text insert so comments survive.
  if (isJsonc) {
    const edited = insertPluginIntoText(original, nextPlugins);
    if (edited !== null) {
      fs.copyFileSync(target, target + ".bak");
      fs.writeFileSync(target, edited);
      log(`plugin added to ${target} (comments preserved; backup at ${path.basename(target)}.bak)`);
      return { file: target, action: "added", preservedComments: true };
    }
  }

  // Fallback: rewrite as plain JSON.
  parsed.plugin = nextPlugins;
  fs.copyFileSync(target, target + ".bak");
  fs.writeFileSync(target, JSON.stringify(parsed, null, 2) + "\n");
  log(`plugin added to ${target} (rewritten as JSON; backup at ${path.basename(target)}.bak)`);
  return { file: target, action: "added", preservedComments: false };
}

/**
 * Insert/update the `plugin` array in a JSONC text without reformatting.
 * Returns the new text, or null if we can't do it safely.
 */
export function insertPluginIntoText(text, pluginList) {
  const listJson = JSON.stringify(pluginList, null, 2).replace(/\n/g, "\n  ");

  // Case A: a "plugin": [ ... ] already exists — replace the whole array value.
  const re = /("plugin"\s*:\s*)\[[^\]]*\]/;
  if (re.test(text)) {
    return text.replace(re, (_m, pre) => `${pre}${listJson}`);
  }

  // Case B: no plugin key — inject before the final closing brace.
  const lastBrace = text.lastIndexOf("}");
  if (lastBrace < 0) return null;
  const before = text.slice(0, lastBrace);
  const after = text.slice(lastBrace);
  // Detect whether the object already has properties (to place a comma right).
  const hasProps = /[\w"']\s*:/.test(before);
  const insertion = `${hasProps ? ",\n  " : "\n  "}"plugin": ${listJson}\n`;
  return before.replace(/\s*$/, "") + insertion + after;
}

// ---------------------------------------------------------------------------
// 3. fish PATH
// ---------------------------------------------------------------------------

export function fishConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "fish", "config.fish");
}

/**
 * Ensure ~/.local/bin is on the fish PATH by appending a fish_add_path line to
 * config.fish. Idempotent. Returns {file, action} or {skipped:true}.
 */
export function installFishPath({ binDir = localBinDir(), log = () => {} } = {}) {
  // Only bother if fish actually exists.
  const fishDir = path.dirname(fishConfigPath());
  const fishExists =
    fs.existsSync(fishConfigPath()) ||
    fs.existsSync(path.join(os.homedir(), ".config", "fish")) ||
    fileExists("/usr/bin/fish") ||
    fileExists("/usr/local/bin/fish");
  if (!fishExists) return { skipped: true, reason: "fish not found" };

  fs.mkdirSync(fishDir, { recursive: true });
  const marker = "# opentogether: make the CLI available";
  const line = `fish_add_path ${binDir}`;
  let current = "";
  try {
    current = fs.readFileSync(fishConfigPath(), "utf8");
  } catch {}

  if (current.includes(marker) || new RegExp(`fish_add_path\\s+${escapeRe(binDir)}`).test(current)) {
    return { file: fishConfigPath(), action: "unchanged" };
  }
  const addition = `${current.endsWith("\n") || !current ? "" : "\n"}\n${marker}\n${line}\n`;
  fs.appendFileSync(fishConfigPath(), addition);
  log(`fish PATH updated: ${fishConfigPath()}`);
  return { file: fishConfigPath(), action: "added" };
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

/**
 * Run the whole install. Each part is best-effort; we collect a report.
 * @returns {object} a human-friendly report
 */
export function runInstall({ binDir, log = () => {} } = {}) {
  const report = { launcher: null, plugin: null, fish: null, onPath: false, warnings: [] };

  try {
    report.launcher = installLauncher({ binDir, log });
  } catch (err) {
    report.warnings.push(`could not install launcher: ${err.message}`);
  }

  try {
    const cfg = findOpencodeConfig();
    const res = installPlugin({ file: cfg.file, log });
    if (res.error) {
      report.warnings.push(
        `OpenCode config ${res.file} could not be parsed; add the plugin manually:`,
      );
    }
    report.plugin = res;
  } catch (err) {
    report.warnings.push(`could not register the OpenCode plugin: ${err.message}`);
  }

  try {
    report.fish = installFishPath({ binDir, log });
  } catch (err) {
    report.warnings.push(`could not update fish PATH: ${err.message}`);
  }

  // Check whether ~/.local/bin is on the *current* PATH.
  const dir = binDir ?? localBinDir();
  report.onPath = (process.env.PATH ?? "").split(path.delimiter).includes(dir);
  report.binDir = dir;
  report.pluginUrl = pluginUrl();
  return report;
}
