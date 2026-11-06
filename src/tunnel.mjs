// cloudflared quick-tunnel helper.
//
// The point: expose the local relay on a public HTTPS URL with ONE command and
// zero config, so a friend on another network can connect without port
// forwarding. `cloudflared tunnel --url http://localhost:PORT` prints a
// https://<random>.trycloudflare.com URL on startup; we scrape it and hand back
// the matching wss:// URL for the relay's websocket path.
//
// We never touch the user's cloudflared config — quick tunnels are stateless.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Is `cloudflared` available (PATH or a known local install)? */
export function findCloudflared() {
  const probe = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  if (!probe.error && probe.status === 0) {
    return { command: "cloudflared", version: String(probe.stdout || "").trim() };
  }
  // Common fallbacks.
  for (const p of [
    path.join(os.homedir(), ".local", "bin", "cloudflared"),
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
  ]) {
    try {
      if (fs.existsSync(p)) return { command: p, version: "local" };
    } catch {}
  }
  return null;
}

/**
 * Download cloudflared into ~/.local/bin (Linux/macOS). Returns the path or
 * throws with a clear message. We prefer this over making the user apt/pacman.
 */
export async function downloadCloudflared({ log = () => {} } = {}) {
  const plat = process.platform;
  const arch = os.arch();
  if (plat !== "linux" && plat !== "darwin") {
    throw new Error(`automatic cloudflared download not supported on ${plat}; install it manually`);
  }
  const asset =
    plat === "darwin"
      ? arch === "arm64"
        ? "cloudflared-darwin-arm64.tgz"
        : "cloudflared-darwin-amd64.tgz"
      : arch === "arm64"
        ? "cloudflared-linux-arm64"
        : "cloudflared-linux-amd64";
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;

  const destDir = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "cloudflared");

  log(`downloading cloudflared (${asset})…`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (asset.endsWith(".tgz")) {
    // macOS ships a tarball containing the binary.
    const tmp = path.join(os.tmpdir(), `cf-${Date.now()}.tgz`);
    fs.writeFileSync(tmp, buf);
    const untar = spawnSync("tar", ["-xzf", tmp, "-C", destDir], { encoding: "utf8" });
    fs.unlinkSync(tmp);
    if (untar.status !== 0) throw new Error(`could not extract cloudflared: ${untar.stderr}`);
  } else {
    fs.writeFileSync(dest, buf);
  }
  if (!fs.existsSync(dest)) {
    // tgz may extract under a slightly different name; find it.
    const found = fs
      .readdirSync(destDir)
      .find((f) => f.startsWith("cloudflared") && !f.endsWith(".tgz"));
    if (!found) throw new Error("cloudflared binary not found after download");
    fs.renameSync(path.join(destDir, found), dest);
  }
  fs.chmodSync(dest, 0o755);
  log(`cloudflared installed to ${dest}`);
  return { command: dest, version: "downloaded" };
}

/**
 * A running quick tunnel. Emits:
 *   "url"   { publicUrl, wsUrl }   once the trycloudflare URL is known
 *   "log"   string
 *   "exit"  { code }
 */
export class Tunnel extends EventEmitter {
  /**
   * @param {{ port: number, hostname?: string, path?: string, binary?: string, log?: Function }} opts
   */
  constructor({ port, hostname = "127.0.0.1", path: wsPath = "/ot", binary = "cloudflared", log = () => {} }) {
    super();
    this.port = port;
    this.hostname = hostname;
    this.wsPath = wsPath;
    this.binary = binary;
    this.log = log;
    this.publicUrl = null;
    this.wsUrl = null;
    this.proc = null;
    this._buf = "";
  }

  start() {
    if (this.proc) return this;
    const local = `http://${this.hostname === "0.0.0.0" ? "127.0.0.1" : this.hostname}:${this.port}`;
    const args = ["tunnel", "--no-autoupdate", "--url", local];
    this.log(`starting cloudflared: ${this.binary} ${args.join(" ")}`);
    this.proc = spawn(this.binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    const onData = (chunk) => {
      const text = chunk.toString();
      this._buf += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) this.emit("log", trimmed);
      }
      if (!this.publicUrl) {
        const m = this._buf.match(TRYCLOUDFLARE_RE);
        if (m) {
          this.publicUrl = m[0];
          // https://x.trycloudflare.com -> wss://x.trycloudflare.com/ot
          const u = new URL(this.publicUrl);
          u.protocol = "wss:";
          u.pathname = this.wsPath;
          this.wsUrl = u.toString();
          this.emit("url", { publicUrl: this.publicUrl, wsUrl: this.wsUrl });
        }
      }
    };
    this.proc.stdout.on("data", onData);
    this.proc.stderr.on("data", onData);

    this.proc.on("exit", (code) => {
      this.proc = null;
      this.emit("exit", { code });
    });
    this.proc.on("error", (err) => {
      this.emit("error", err);
    });
    return this;
  }

  /** @returns {Promise<{publicUrl:string, wsUrl:string}>} */
  waitForUrl({ timeoutMs = 30000 } = {}) {
    if (this.wsUrl) return Promise.resolve({ publicUrl: this.publicUrl, wsUrl: this.wsUrl });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for the cloudflared URL (is outbound HTTPS blocked?)"));
      }, timeoutMs);
      timer.unref?.();
      const onUrl = (info) => {
        cleanup();
        resolve(info);
      };
      const onExit = ({ code }) => {
        cleanup();
        reject(new Error(`cloudflared exited (code ${code}) before providing a URL`));
      };
      const onErr = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("url", onUrl);
        this.off("exit", onExit);
        this.off("error", onErr);
      };
      this.once("url", onUrl);
      this.once("exit", onExit);
      this.once("error", onErr);
    });
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {}
    this.proc = null;
  }
}
