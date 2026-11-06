#!/usr/bin/env node
// OpenTogether CLI
//
//   opentogether relay                      host the rendezvous server
//   opentogether setup                      interactive setup (writes config)
//   opentogether connect                    connect my agent to my friend's
//   opentogether chat                       connect + a terminal chat window
//   opentogether status                     show config + probe opencode
//   opentogether send "text"                one-shot send and exit
//   opentogether doctor                     check everything is reachable

import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { createRelay } from "./relay.mjs";
import { Connector, validatePassphrase } from "./connector.mjs";
import { AgentBridge } from "./bridge.mjs";
import { OpenCodeClient } from "./opencode-client.mjs";
import {
  loadConfig,
  saveConfig,
  configPath,
  discoverOpencode,
  relayUrlFromParts,
  defaultConfig,
} from "./config.mjs";
import { startControlServer, clearControlFile } from "./control.mjs";
import { startDashboard } from "./dashboard.mjs";
import { startTui } from "./tui.mjs";
import { runInstall, localBinDir } from "./install.mjs";
import { findCloudflared, downloadCloudflared, Tunnel } from "./tunnel.mjs";
import { c, banner, log, warn, error, info } from "./ui.mjs";

const VERSION = "1.1.0";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key.includes("=")) {
        const [k, ...rest] = key.split("=");
        args[k] = rest.join("=");
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      return printHelp();
    case "version":
    case "-v":
    case "--version":
      return console.log(`opentogether ${VERSION}`);
    case "relay":
      return runRelay(args);
    case "setup":
    case "init":
      return runSetup(args);
    case "connect":
      return runConnect(args, { chat: false });
    case "chat":
      return runConnect(args, { chat: true });
    case "up":
      return runUp(args);
    case "install":
      return runInstallCmd(args);
    case "tunnel":
      return runTunnel(args);
    case "gui":
      return runConnect(args, { chat: false, guiOnly: true });
    case "status":
      return runStatus(args);
    case "doctor":
      return runDoctor(args);
    case "send":
      return runSend(args, rest);
    default:
      console.error(`unknown command "${cmd}"`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp() {
  banner();
  console.log(`
${c.bold("USAGE")}
  opentogether <command> [options]

${c.bold("COMMANDS")}
  ${c.cyan("up")}        One command: start the relay + tunnel + GUI (the easy path)
  ${c.cyan("install")}   Put the CLI on your PATH and register the OpenCode plugin
  ${c.cyan("setup")}      Interactive setup. Writes ${c.dim(configPath())}
  ${c.cyan("tunnel")}    Expose a local relay publicly with cloudflared (auto-installs it)
  ${c.cyan("relay")}      Start the relay server (needs one public machine)
  ${c.cyan("connect")}    Connect your OpenCode agent to your peer's agent
  ${c.cyan("gui")}        Like connect, plus a live web dashboard in your browser
  ${c.cyan("chat")}       Like connect, plus a terminal chat window
  ${c.cyan("status")}     Show current config and probe your OpenCode
  ${c.cyan("doctor")}     Diagnose connectivity problems
  ${c.cyan("send")}       Send one message to the peer and exit

${c.bold("QUICK START")}
  ${c.dim("# 1. install (once, no sudo, works with fish + OpenCode Desktop)")}
  opentogether install

  ${c.dim("# 2. on the machine that will host: relay + public tunnel + dashboard")}
  opentogether up --tunnel --gui

  ${c.dim("# 3. on the other machine: join the same passphrase, open the GUI")}
  opentogether setup
  opentogether gui --relay wss://<the-trycloudflare-url>/ot

${c.bold("OPTIONS")}
  --relay <url>        ws://host:port/ot  (or an https:// trycloudflare URL)
  --room <name>        room name (default "default")
  --name <name>        your display name
  --role <host|guest>  who you are in the pair
  --passphrase <text>  shared secret (or OPENTOGETHER_PASSPHRASE)
  --opencode <url>     OpenCode server url (default http://127.0.0.1:4096)
  --dir <path>         project directory for OpenCode
  --model <p/m>        model for the agent, e.g. omniroute/cw/claude-sonnet-5-5
  --agent <name>       OpenCode agent to use (default: the session's own)
  --gui                open a live web dashboard
  --tui                open a full-screen terminal dashboard
  --tunnel             expose a local relay with a public cloudflared URL
  --port <n>           relay port for up/relay/tunnel (default 8787)
  --no-auto-respond    mirror peer messages but don't wake your agent
  --forward            also forward your own messages in the link session
`);
}

// ---------------------------------------------------------------- relay

async function runRelay(args) {
  banner();
  const port = Number(args.port ?? process.env.OPENTOGETHER_RELAY_PORT ?? 8787);
  const hostname = args.hostname ?? "0.0.0.0";
  const path = args.path ?? "/ot";
  const relay = createRelay({
    port,
    hostname,
    path,
    log: (m) => log(c.dim(`[relay] ${m}`)),
  });
  try {
    await relay.listen();
  } catch (err) {
    error(`could not start relay on ${hostname}:${port}: ${err.message}`);
    process.exit(1);
  }
  const lan = localAddresses();
  console.log(`${c.green("relay is up")} on port ${c.bold(String(port))}\n`);
  console.log(`  your friend should use:`);
  for (const ip of lan) console.log(`    ${c.cyan(`ws://${ip}:${port}${path}`)}  ${c.dim(`(LAN, if reachable)`)}`);
  console.log(`    ${c.cyan(`ws://<your-public-ip>:${port}${path}`)}  ${c.dim("(if you port-forwarded it)")}`);
  console.log(`\n  ${c.dim("No public IP? Use a tunnel, e.g. `cloudflared tunnel --url http://localhost:" + port + "`")}`);
  console.log(`  ${c.dim("then use  wss://<tunnel-host>/ot")}\n`);
  console.log(`${c.dim("Ctrl+C to stop. Health check: ")}http://127.0.0.1:${port}/health\n`);

  const shutdown = async () => {
    console.log(`\n${c.dim("shutting down relay…")}`);
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function localAddresses() {
  const out = new Set(["127.0.0.1"]);
  try {
    for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
      // Skip the virtual bridges and overlays that LXC/Docker/Tailscale create;
      // they're noise in the "your friend should use" list.
      if (/^(docker|br-|veth|virbr|tailscale|zt|utun|lo|ham)/i.test(ifname)) continue;
      for (const ni of list ?? []) {
        if (ni.family !== "IPv4" || ni.internal) continue;
        out.add(ni.address);
      }
    }
  } catch {}
  return [...out];
}

// ---------------------------------------------------------------- setup

async function runSetup(args, { fromUp = false } = {}) {
  if (!fromUp) banner();
  const { config } = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) =>
    new Promise((resolve) => {
      rl.question(`${q}${def ? c.dim(` [${def}]`) : ""}: `, (a) => resolve(a.trim() || def || ""));
    });

  if (fromUp) {
    console.log(c.bold("First-time setup (a few questions, then we go live).\n"));
    console.log(
      c.dim("Your relay URL is chosen automatically from the tunnel — you don't need to type it.\n"),
    );
  } else {
    console.log(c.bold("Let's set up OpenTogether.\n"));
  }
  console.log(c.dim("You and your friend must enter the SAME passphrase and room name.\n"));

  // Only ask for the relay URL when the user is running plain `setup`. Under
  // `opentogether up`, the tunnel prints the URL and `up` writes it for us.
  if (!fromUp) {
    config.relayUrl = relayUrlFromParts(await ask("Relay URL", config.relayUrl || "ws://127.0.0.1:8787/ot"));
  }
  config.room = await ask("Room name", config.room || "default");

  if (config.passphrase) {
    // Re-running setup: keep the existing passphrase unless they change it.
    const keep = await ask("Shared passphrase (press Enter to keep current)", "");
    if (keep) config.passphrase = keep;
  } else {
    config.passphrase = await ask("Shared passphrase (12+ chars — share this with your friend)", "");
  }
  const passErr = validatePassphrase(config.passphrase);
  if (passErr) {
    error(passErr);
    rl.close();
    process.exitCode = 1;
    return;
  }
  config.name = await ask("Your name", config.name || "");
  const role = await ask("Your role (host/guest)", config.role || "host");
  config.role = role === "guest" ? "guest" : "host";

  console.log(c.dim("\nProbing for a running OpenCode server…"));
  const found = await discoverOpencode({ explicitUrl: config.opencodeUrl });
  if (found) {
    info(`found OpenCode at ${found.url}`);
    config.opencodeUrl = found.url;
  } else {
    warn("no running OpenCode server found.");
    console.log(c.dim("  Start one with:  opencode serve --port 4096\n"));
    config.opencodeUrl = await ask("OpenCode URL", config.opencodeUrl || "http://127.0.0.1:4096");
  }
  if (!fromUp) {
    config.opencodeDirectory = await ask("Project directory to debug (blank = current)", config.opencodeDirectory || "");
  }

  const file = saveConfig(config);
  rl.close();
  console.log(`${c.green("saved")} ${c.dim(file)}\n`);
}

// ---------------------------------------------------------------- connect

/**
 * Parse a --model value into the {providerID, modelID} shape OpenCode wants.
 * Accepts "provider/model" (model ids may contain slashes, e.g.
 * "omniroute/cw/claude-sonnet-5-5") or a bare model id.
 */
function parseModelFlag(value) {
  if (!value) return undefined;
  const str = String(value).trim();
  if (!str) return undefined;
  const slash = str.indexOf("/");
  if (slash <= 0) return { modelID: str };
  return { providerID: str.slice(0, slash), modelID: str.slice(slash + 1) };
}

/**
 * Minimal "join a session" prompts: only what's missing. Used when a relay URL
 * was passed on the command line but the shared passphrase/name aren't known
 * yet, so joining a friend's tunnel is one command.
 *
 * @returns {Promise<boolean>} true if we're good to connect
 */
async function runJoinPrompts(config, { roleFromCli = false, roomFromCli = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) =>
    new Promise((resolve) => {
      rl.question(`${q}${def ? c.dim(` [${def}]`) : ""}: `, (a) => resolve(a.trim() || def || ""));
    });

  console.log(c.bold("\nJoining a session.\n"));
  console.log(c.dim(`  relay: ${config.relayUrl}\n`));

  if (!config.passphrase) {
    config.passphrase = await ask("Shared passphrase (from your friend)");
    const passErr = validatePassphrase(config.passphrase);
    if (passErr) {
      error(passErr);
      rl.close();
      process.exitCode = 1;
      return false;
    }
  }
  if (!config.name) config.name = await ask("Your name");
  if (!config.name) {
    error("a name is required so your peer knows who they're talking to.");
    rl.close();
    process.exitCode = 1;
    return false;
  }
  // Only ask about the room when it wasn't given on the command line. Joining
  // requires an exact room match, so don't silently assume the default.
  if (!roomFromCli) {
    config.room = await ask("Room name (must match your friend's)", config.room || "default");
  }

  // Someone joining a relay is the guest by default. Don't silently inherit the
  // "host" default from defaultConfig(), or both sides would claim to be host.
  if (!roleFromCli && (config.role === "host" || !config.role)) {
    const role = await ask("Your role (host/guest)", "guest");
    config.role = role === "host" ? "host" : "guest";
  }

  rl.close();
  try {
    const file = saveConfig(config);
    console.log(`${c.green("saved")} ${c.dim(file)}\n`);
  } catch (err) {
    warn(`could not save config: ${err.message}`);
  }
  return true;
}

async function runConnect(args, { chat, guiOnly = false }) {
  const { config: stored, exists } = loadConfig();
  const cli = {
    relayUrl: args.relay ? relayUrlFromParts(args.relay) : undefined,
    room: args.room,
    passphrase: args.passphrase ?? process.env.OPENTOGETHER_PASSPHRASE,
    name: args.name,
    role: args.role,
    opencodeUrl: args.opencode,
    opencodeDirectory: args.dir,
    autoRespond: args["no-auto-respond"] ? false : undefined,
    forwardLocalUserMessages: args.forward ? true : undefined,
    agent: args.agent,
    model: parseModelFlag(args.model),
  };
  const config = { ...stored };
  for (const [k, v] of Object.entries(cli)) if (v !== undefined) config[k] = v;

  if (!config.relayUrl) {
    error("missing configuration. Run `opentogether setup` first, or pass --relay/--passphrase/--name.");
    if (!exists) info(`no config file at ${configPath()}`);
    process.exitCode = 1;
    return;
  }

  // A relay URL was supplied but we still need the shared secret + identity.
  // This is the "join a friend's session" path: ask just those, then save, so
  // `opentogether gui --relay wss://.../ot` is a genuine one-command join.
  if (!config.passphrase || !config.name) {
    const joined = await runJoinPrompts(config, {
      roleFromCli: args.role !== undefined,
      roomFromCli: args.room !== undefined,
    });
    if (!joined) return;
  }

  const passErr = validatePassphrase(config.passphrase);
  if (passErr) {
    error(passErr);
    process.exitCode = 1;
    return;
  }

  if (!args.quietBanner) banner();
  // Locate OpenCode.
  let ocUrl = config.opencodeUrl;
  if (!(await probe(ocUrl, config.opencodeDirectory))) {
    warn(`cannot reach OpenCode at ${ocUrl} — searching…`);
    const found = await discoverOpencode({ directory: config.opencodeDirectory });
    if (!found) {
      error("no OpenCode server found. Start one with:  opencode serve --port 4096");
      process.exitCode = 1;
      return;
    }
    ocUrl = found.url;
    info(`using OpenCode at ${ocUrl}`);
  }

  const oc = new OpenCodeClient({
    serverUrl: ocUrl,
    directory: config.opencodeDirectory || undefined,
    password: config.opencodePassword || undefined,
  });

  let connector;
  try {
    connector = new Connector({
      relayUrl: config.relayUrl,
      passphrase: config.passphrase,
      room: config.room,
      name: config.name,
      role: config.role,
    });
  } catch (err) {
    error(err.message);
    process.exitCode = 1;
    return;
  }

  const bridge = new AgentBridge({
    opencode: oc,
    connector,
    config: { ...config, linkSessionId: config.linkSessionId },
    log: (m) => log(c.dim(`[bridge] ${m}`)),
  });

  connector.on("status", (s) => {
    if (s.state === "reconnecting") warn(`relay connection lost, retrying… ${c.dim(s.reason ?? "")}`);
    if (s.state === "closed" && s.error) error(`link closed: ${s.error}`);
    if (s.state === "connecting") info(`connecting to ${config.relayUrl}…`);
  });
  connector.on("error", (e) => {
    if (e.code === "AUTH_FAILED") {
      error("wrong passphrase or room name — both machines must use the same values.");
    } else {
      error(`link error: ${e.message}`);
    }
  });
  connector.on("welcome", (w) => {
    console.log(`${c.green("●")} connected to relay as ${c.bold(w.name)} (${w.role})`);
    if (w.peer) console.log(`${c.green("●")} peer online: ${c.bold(w.peer.name)}`);
    else console.log(`${c.yellow("○")} waiting for your peer to join…`);
  });
  connector.on("peer-joined", ({ peer }) => console.log(`${c.green("●")} ${c.bold(peer.name)} joined`));
  connector.on("peer-left", ({ peer }) => console.log(`${c.yellow("○")} ${peer?.name ?? "peer"} left`));
  bridge.on("inbound", ({ from, text }) => {
    console.log(`\n${c.magenta("◀ " + from)} ${text}`);
    console.log(c.dim("  …your agent is thinking"));
  });
  bridge.on("outbound", ({ text }) => console.log(`\n${c.blue("▶ you (agent)")} ${text}`));
  bridge.on("typing", (on) => {
    if (on) process.stdout.write(c.dim(`\r  ${connector.peer?.name ?? "peer"} is typing…   `));
    else process.stdout.write("\r" + " ".repeat(40) + "\r");
  });
  bridge.on("session-error", ({ message }) => error(`agent error: ${message}`));
  bridge.on("finished", (rec) => renderFinished(rec, connector));
  bridge.on("reopened", ({ remote } = {}) =>
    console.log(
      `\n${c.green("🔓")} ${c.bold("conversation reopened")}` +
        c.dim(remote ? " (by the other side)" : "") +
        "\n",
    ),
  );

  await bridge.start();
  // Persist the link session id so we reuse the same session next time.
  config.linkSessionId = bridge.linkSessionID;
  try {
    saveConfig(config);
  } catch {}

  console.log(
    `\n${c.dim("link session:")} ${bridge.linkSessionID}\n` +
      `${c.dim("open that session in the OpenCode TUI to watch the conversation.\n")}`,
  );

  if (args.control) {
    const control = await startControlServer({
      bridge,
      connector,
      log: (m) => log(c.dim(`[control] ${m}`)),
    });
    info(`plugin control endpoint ready — your agent can now use ot_send/ot_status`);
    const stop = async () => {
      await control.close();
      bridge.stop();
    };
    process.on("SIGINT", () => stop().then(() => process.exit(0)));
    process.on("SIGTERM", () => stop().then(() => process.exit(0)));
  }

  // Live dashboards. `--gui` (or the `gui` command) opens the web dashboard,
  // `--tui` opens the terminal one. They can be combined.
  const wantGui = guiOnly || args.gui === true || args.gui === "true";
  const wantTui = args.tui === true || args.tui === "true";

  if (wantGui) {
    const dash = await startDashboard({
      bridge,
      connector,
      port: Number(args["gui-port"] ?? 0),
      log: (m) => log(c.dim(`[dashboard] ${m}`)),
    });
    console.log(`\n${c.green("●")} dashboard: ${c.bold(dash.url)}`);
    openBrowser(dash.url);
    process.on("SIGINT", () => dash.close().then(() => {}));
  }

  if (wantTui) {
    return startTui({
      bridge,
      connector,
      onQuit: () => {
        bridge.stop();
        process.exit(0);
      },
    });
  }

  if (wantGui && !chat) {
    info("running with dashboard. Ctrl+C to exit.");
    return;
  }

  if (chat) return startChat({ bridge, connector, config });

  info("running. Ctrl+C to exit.");
  if (!args.control) {
    process.on("SIGINT", () => {
      bridge.stop();
      process.exit(0);
    });
  }
}

// ---------------------------------------------------------------- install

async function runInstallCmd(args) {
  banner();
  console.log(c.bold("Installing OpenTogether for this user…\n"));
  const binDir = args["bin-dir"] ?? localBinDir();
  const report = runInstall({ binDir, log: (m) => info(m) });

  console.log("");
  const line = (ok, label, detail = "") =>
    console.log(`  ${ok ? c.green("✔") : c.yellow("•")} ${label}${detail ? c.dim("  " + detail) : ""}`);

  if (report.launcher) line(true, "CLI launcher", report.launcher.path);
  if (report.plugin && !report.plugin.error) {
    const act = report.plugin.action === "unchanged" ? "already registered" : report.plugin.action;
    line(true, "OpenCode plugin", `${act} → ${report.plugin.file}`);
  }
  if (report.fish && !report.fish.skipped) {
    line(true, "fish PATH", report.fish.file);
  }
  for (const w of report.warnings ?? []) console.log(`  ${c.yellow("!")} ${w}`);

  console.log("");
  if (!report.onPath) {
    warn(`${report.binDir} is not on your PATH in this shell.`);
    console.log(c.dim(`  open a new terminal, or run:  source ~/.config/fish/config.fish`));
    console.log(c.dim(`  (until then you can call it with:  ${report.binDir}/opentogether)`));
  } else {
    console.log(`${c.green("done")} — run ${c.cyan("opentogether up --tunnel --gui")} to start.`);
  }
  console.log("");
  console.log(c.dim("  Restart OpenCode Desktop so it picks up the new plugin + tools."));
}

// ---------------------------------------------------------------- tunnel

async function ensureCloudflared() {
  let cf = findCloudflared();
  if (cf) return cf;
  info("cloudflared not found — downloading it (one time)…");
  try {
    return await downloadCloudflared({ log: (m) => log(c.dim(`  ${m}`)) });
  } catch (err) {
    error(`could not get cloudflared automatically: ${err.message}`);
    console.log(c.dim("  install it manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"));
    return null;
  }
}

async function runTunnel(args) {
  banner();
  const port = Number(args.port ?? process.env.OPENTOGETHER_RELAY_PORT ?? 8787);
  const pathName = args.path ?? "/ot";
  const cf = await ensureCloudflared();
  if (!cf) {
    process.exitCode = 1;
    return;
  }
  info(`using cloudflared (${cf.version})`);

  // If a relay is already listening on the port, just tunnel to it. Otherwise
  // start one ourselves so `opentogether tunnel` is genuinely one-command.
  const relayAlreadyUp = await probeRelayHealth(port);
  let relay = null;
  if (!relayAlreadyUp) {
    relay = createRelay({ port, hostname: "127.0.0.1", path: pathName, log: (m) => log(c.dim(`[relay] ${m}`)) });
    try {
      await relay.listen();
      info(`relay started on 127.0.0.1:${port}`);
    } catch (err) {
      error(`could not start relay on port ${port}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    info(`relay already running on port ${port}`);
  }

  const tunnel = new Tunnel({
    port,
    hostname: "127.0.0.1",
    path: pathName,
    binary: cf.command,
    log: (m) => log(c.dim(`[cloudflared] ${m}`)),
  }).start();

  console.log(c.dim("\n  waiting for cloudflared to publish a URL…"));
  let infoUrl;
  try {
    infoUrl = await tunnel.waitForUrl({ timeoutMs: 40000 });
  } catch (err) {
    error(err.message);
    tunnel.stop();
    if (relay) await relay.close();
    process.exitCode = 1;
    return;
  }

  try {
    await waitForPublicRelay(infoUrl.publicUrl, { timeoutMs: 20000 });
  } catch (err) {
    warn(`tunnel URL not yet reachable: ${err.message} (continuing anyway)`);
  }
  console.log(`\n${c.green("●")} public URL: ${c.bold(infoUrl.publicUrl)}`);
  console.log(`${c.green("●")} your peer should use: ${c.bold(infoUrl.wsUrl)}\n`);
  console.log(c.dim("  share this exact string + the same passphrase with your friend."));
  console.log(c.dim("  Ctrl+C to stop the tunnel" + (relay ? " and relay." : ".") + "\n"));

  const shutdown = async () => {
    console.log(`\n${c.dim("closing tunnel…")}`);
    tunnel.stop();
    if (relay) await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function probeRelayHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The tunnel can print its URL before it can actually carry websocket upgrades.
 * Poll the public /health endpoint until it answers (or we give up), so the
 * bridge's first connection doesn't hit a 1006 and have to retry.
 */
async function waitForPublicRelay(publicUrl, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${publicUrl.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.ok) return true;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tunnel did not become reachable within ${timeoutMs}ms (${lastErr})`);
}

// ---------------------------------------------------------------- up (one button)

async function runUp(args) {
  banner();
  console.log(c.bold("OpenTogether — one-command startup\n"));

  // 1. Make sure we're configured. If not, guide through setup once.
  let { config, exists } = loadConfig();
  if (!exists || !config.passphrase || !config.name) {
    info("first run — let's set things up once.");
    await runSetup(args, { fromUp: true });
    ({ config } = loadConfig());
  }

  const port = Number(args.port ?? process.env.OPENTOGETHER_RELAY_PORT ?? 8787);
  const pathName = args.path ?? "/ot";
  const wantTunnel = args.tunnel === true || args.tunnel === "true" || args.tunnel === undefined;

  // 2. Start the relay (unless one is already on the port).
  let relay = null;
  if (await probeRelayHealth(port)) {
    info(`relay already running on port ${port}`);
  } else {
    relay = createRelay({ port, hostname: "0.0.0.0", path: pathName, log: (m) => log(c.dim(`[relay] ${m}`)) });
    try {
      await relay.listen();
      info(`relay up on port ${port}`);
    } catch (err) {
      error(`could not start relay on ${port}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }

  // 3. Public tunnel — this is the "one button → public IP" part.
  let relayUrl = args.relay ? relayUrlFromParts(args.relay) : config.relayUrl;
  let tunnel = null;
  if (wantTunnel) {
    const cf = await ensureCloudflared();
    if (cf) {
      tunnel = new Tunnel({
        port,
        hostname: "127.0.0.1",
        path: pathName,
        binary: cf.command,
        log: (m) => log(c.dim(`[cloudflared] ${m}`)),
      }).start();
      console.log(c.dim("\n  publishing a public URL via cloudflared…"));
      try {
        const infoUrl = await tunnel.waitForUrl({ timeoutMs: 40000 });
        relayUrl = infoUrl.wsUrl;
        // cloudflared prints the URL before its edge connection is fully able to
        // carry WebSocket upgrades; connecting too early yields a 1006 blip.
        // Poll the public /health until it answers through the tunnel.
        console.log(c.dim("  waiting for the tunnel to be reachable…"));
        await waitForPublicRelay(infoUrl.publicUrl, { timeoutMs: 20000 });
        console.log(`\n${c.green("●")} public URL: ${c.bold(infoUrl.publicUrl)}`);
        console.log(`${c.green("●")} your peer joins with: ${c.bold(infoUrl.wsUrl)}`);
        console.log(c.dim("  + the same passphrase you set on this machine\n"));
      } catch (err) {
        warn(`tunnel failed: ${err.message} — continuing with the local relay only`);
      }
    }
  } else {
    info(`tunnel disabled; peer must reach ws://<this-host>:${port}${pathName}`);
  }

  // 4. Persist the relay URL so `gui` on the other machine is trivial too.
  config.relayUrl = relayUrl;
  try {
    saveConfig(config);
  } catch {}

  // 5. Connect this machine's agent and show the dashboard.
  const connectArgs = { ...args, quietBanner: true, relay: relayUrl, gui: args.gui !== false && args.gui !== "false" ? true : false };
  printShareBox(config, relayUrl);

  const cleanup = async () => {
    if (tunnel) tunnel.stop();
    if (relay) await relay.close();
  };
  process.on("SIGINT", () => cleanup().then(() => process.exit(0)));
  process.on("SIGTERM", () => cleanup().then(() => process.exit(0)));

  return runConnect(connectArgs, { chat: !!args.chat });
}

function printShareBox(config, relayUrl) {
  const pass = config.passphrase ?? "";
  const box = [
    `relay URL  : ${relayUrl || "(none)"}`,
    `passphrase : ${pass}`,
    `room       : ${config.room ?? "default"}`,
    `name       : ${config.name ?? ""}`,
  ];
  const width = Math.max(...box.map((l) => l.length)) + 2;
  console.log(c.dim("┌─ share with your friend " + "─".repeat(Math.max(0, width - 23)) + "┐"));
  for (const l of box) console.log(c.dim("│ ") + l.padEnd(width) + c.dim(" │"));
  console.log(c.dim("└" + "─".repeat(width + 1) + "┘"));
  console.log(c.dim("  they run:  opentogether gui --relay " + (relayUrl || "<url>") + "\n"));
}

function openBrowser(url) {
  if (process.env.OPENTOGETHER_NO_BROWSER) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(opener, cmdArgs, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no browser: the URL is printed already */
  }
}

function renderFinished(rec, connector) {
  const mine = rec?.from && connector?.name && rec.from === connector.name;
  const who =
    rec?.by === "user"
      ? mine
        ? "you"
        : "your peer"
      : mine
        ? "your agent"
        : `${connector?.peer?.name ?? "the peer"}'s agent`;
  console.log(
    `\n${c.green("🏁")} ${c.bold("finished")} — declared by ${who}. Both agents have stopped replying.`,
  );
  if (rec?.summary) console.log(c.dim("  " + rec.summary.replace(/\s+/g, " ").slice(0, 500)));
  console.log(c.dim("  say something (or /reopen) to start talking again.\n"));
}

async function startChat({ bridge, connector, config }) {
  bridge.addParticipating(bridge.linkSessionID);
  console.log(
    c.bold("chat ready") +
      c.dim(" — type a message and hit enter to talk to your peer's agent.\n") +
      c.dim("commands: /quit  /status  /ping  /ask <text> (wake local agent)\n") +
      c.dim("          /done [summary] (end the session)  /reopen\n"),
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.blue("you> ") });
  rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === "/quit" || text === "/exit") {
      rl.close();
      return;
    }
    if (text === "/status") {
      console.log(
        JSON.stringify(
          {
            ...connector.snapshot(),
            linkSession: bridge.linkSessionID,
            stats: bridge.stats,
            opencode: "connected",
          },
          null,
          2,
        ),
      );
      return rl.prompt();
    }
    if (text === "/ping") {
      connector.say("ping 👋", { kind: "note" });
      return rl.prompt();
    }
    if (text === "/done" || text.startsWith("/done ")) {
      const summary = text === "/done" ? "" : text.slice(6).trim();
      bridge.declareDone({ summary, by: "user" });
      return rl.prompt();
    }
    if (text === "/reopen") {
      if (!bridge.reopen()) console.log(c.dim("  (not finished — nothing to reopen)"));
      return rl.prompt();
    }
    if (text.startsWith("/ask ")) {
      await bridge.sendFromUser(text.slice(5));
      return rl.prompt();
    }
    // Default: send as a user message. Your local agent also sees it in the
    // link session (it's the same session), and the bridge forwards it.
    try {
      await bridge.sendFromUser(text);
      console.log(c.dim("  sent to peer"));
    } catch (e) {
      error(e.message);
    }
    rl.prompt();
  });
  rl.on("close", () => {
    console.log(c.dim("\nbye"));
    bridge.stop();
    process.exit(0);
  });
}

async function probe(url, directory) {
  try {
    const u = new URL("/global/health", url);
    const res = await fetch(u, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- status

async function runStatus() {
  banner();
  const { config, path, exists } = loadConfig();
  if (!exists) {
    warn(`no config yet (${path}). Run \`opentogether setup\`.`);
  }
  const safe = { ...config, passphrase: config.passphrase ? "•".repeat(Math.min(config.passphrase.length, 12)) : "" };
  console.log(c.bold("config"));
  for (const [k, v] of Object.entries(safe)) console.log(`  ${c.dim(k.padEnd(24))} ${v ?? ""}`);
  console.log(`\n${c.bold("opencode")}`);
  const found = await discoverOpencode({ explicitUrl: config.opencodeUrl, directory: config.opencodeDirectory });
  if (found) console.log(`  ${c.green("●")} reachable at ${found.url}`);
  else console.log(`  ${c.red("○")} not reachable — start it with: opencode serve --port 4096`);
}

// ---------------------------------------------------------------- doctor

async function runDoctor() {
  banner();
  const checks = [];
  const { config } = loadConfig();
  const add = (ok, label, detail = "") => {
    checks.push({ ok, label, detail });
    console.log(`  ${ok ? c.green("✔") : c.red("✘")} ${label}${detail ? c.dim("  " + detail) : ""}`);
  };

  console.log(c.bold("environment\n"));
  add(true, `node ${process.version}`);
  const passErr = validatePassphrase(config.passphrase ?? "");
  add(!passErr, "passphrase set (12+ chars)", passErr ?? "");
  add(/^wss?:\/\//.test(config.relayUrl ?? ""), "relay URL looks like ws:// or wss://", config.relayUrl ?? "");

  console.log(c.bold("\nopencode\n"));
  const found = await discoverOpencode({ explicitUrl: config.opencodeUrl, directory: config.opencodeDirectory });
  add(!!found, "OpenCode server reachable", found?.url ?? "start: opencode serve --port 4096");
  if (found) {
    const oc = new OpenCodeClient({ serverUrl: found.url, directory: config.opencodeDirectory || undefined });
    try {
      const agents = await oc.agentNames();
      add(agents.length > 0, `agents available: ${agents.join(", ") || "none"}`);
      const providers = await oc.providers();
      const configured = providers.filter((p) => p.models.length);
      add(configured.length > 0, `model providers configured: ${configured.map((p) => p.id).join(", ") || "none"}`);
    } catch (e) {
      add(false, "OpenCode API responds", e.message);
    }
  }

  console.log(c.bold("\nrelay\n"));
  if (config.relayUrl) {
    const httpUrl = config.relayUrl.replace(/^ws/, "http").replace(/\/ot$/, "/health");
    try {
      const res = await fetch(httpUrl, { signal: AbortSignal.timeout(3000) });
      const body = await res.json().catch(() => ({}));
      add(res.ok, "relay health endpoint", JSON.stringify(body));
    } catch (e) {
      add(false, "relay reachable", e.message);
    }
  } else {
    add(false, "relay URL configured");
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${c.yellow(failed + " check(s) need attention")}` : `\n${c.green("all checks passed")}`);
}

// ---------------------------------------------------------------- send

async function runSend(args, rest) {
  const text = rest.join(" ").trim() || args.text;
  if (!text) {
    error('usage: opentogether send "your message"');
    process.exitCode = 1;
    return;
  }
  const { config } = loadConfig();
  const connector = new Connector({
    relayUrl: args.relay ? relayUrlFromParts(args.relay) : config.relayUrl,
    passphrase: args.passphrase ?? config.passphrase,
    room: args.room ?? config.room,
    name: args.name ?? config.name,
    role: args.role ?? config.role,
  });
  connector.on("welcome", (w) => {
    console.log(`${c.green("●")} connected; peer ${w.peer ? c.bold(w.peer.name) : c.yellow("offline")}`);
  });
  connector.on("ack", ({ id }) => {
    console.log(`${c.green("✔")} delivered (${id})`);
    setTimeout(() => {
      connector.close();
      process.exit(0);
    }, 200);
  });
  connector.on("error", (e) => {
    error(e.message);
    process.exit(1);
  });
  connector.connect();
  await new Promise((r) => setTimeout(r, 800));
  const id = connector.say(text, { kind: "user", from: connector.name });
  console.log(c.dim(`queued ${id}; waiting for delivery…`));
  setTimeout(() => {
    warn("no delivery confirmation (peer may be offline; the relay will hold it)");
    connector.close();
    process.exit(0);
  }, 8000).unref?.();
}

main().catch((err) => {
  error(err.stack ?? err.message);
  process.exit(1);
});
