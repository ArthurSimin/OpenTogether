// A full-screen terminal dashboard (TUI) for watching two agents talk.
//
// Dependency-free: raw ANSI, alternate screen, and a tiny input line. It shows
// the same live stream as the web dashboard — peer status, inbound/outbound
// messages, loop-brake events, and the finished state — and lets you type a
// message, declare done, or reopen without leaving the terminal.
//
// Keys:
//   Enter   send the typed message (as you)
//   Ctrl+D  declare done
//   Ctrl+R  reopen
//   Ctrl+C  quit
//
// The TUI is intentionally simple: it redraws on every event (coalesced), which
// is plenty for a chat between two agents.

import readline from "node:readline";
import { c } from "./ui.mjs";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export function startTui({ bridge, connector, onQuit = () => {} }) {
  const out = process.stdout;
  const stdin = process.stdin;
  const isTTY = out.isTTY && stdin.isTTY;

  if (!isTTY) {
    // Not a TTY (piped/CI): fall back to plain streaming lines.
    return startPlainStream({ bridge, connector });
  }

  /** @type {Array<{kind:string, who:string, text:string, at:string}>} */
  const lines = [];
  const MAX_LINES = 500;
  let input = "";
  let typing = false;
  let finished = null;
  let status = "";
  let lastStats = "";

  const push = (kind, who, text) => {
    lines.push({ kind, who, text, at: new Date().toLocaleTimeString() });
    if (lines.length > MAX_LINES) lines.shift();
    scheduleDraw();
  };

  const sys = (text) => push("sys", "", text);

  // ---- events -----------------------------------------------------------
  bridge.on("inbound", (e) => push("peer", `${e.from} (agent)`, e.text));
  bridge.on("outbound", (e) => push("you", "you (agent)", e.text));
  bridge.on("forwarded", (e) => push("you", "you", e.text));
  bridge.on("typing", (on) => {
    typing = !!on;
    scheduleDraw();
  });
  bridge.on("finished", (e) => {
    finished = { by: e.by, from: e.from, summary: e.summary };
    sys(`🏁 finished (by ${e.by}${e.summary ? `: ${e.summary}` : ""})`);
  });
  bridge.on("reopened", (e) => {
    finished = null;
    sys("🔓 conversation reopened" + (e.remote ? " by the other side" : ""));
  });
  bridge.on("loop-stopped", (e) => sys(`🛑 auto-reply stopped (${e.reason}${e.hops ? `, ${e.hops} hops` : ""})`));
  bridge.on("ignored-after-done", (e) => sys(`🔇 ignored a post-done message from ${e.from}`));
  bridge.on("session-error", (e) => sys(`⚠️ agent error: ${e.message}`));
  bridge.on("delivery", () => scheduleDraw());
  connector.on("peer-joined", ({ peer }) => sys(`● ${peer?.name} came online`));
  connector.on("peer-left", ({ peer }) => sys(`○ ${peer?.name} went offline`));
  connector.on("status", () => scheduleDraw());

  // ---- input ------------------------------------------------------------
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  const send = async (text) => {
    if (!text.trim()) return;
    try {
      await bridge.sendFromUser(text);
      push("you", "you", text);
    } catch (err) {
      sys(`could not send: ${err.message}`);
    }
  };

  const onKey = (str, key = {}) => {
    if (key.ctrl && key.name === "c") return quit();
    if (key.ctrl && key.name === "d") {
      bridge.declareDone({ summary: input.trim(), by: "user" });
      input = "";
      return draw();
    }
    if (key.ctrl && key.name === "r") {
      bridge.reopen();
      input = "";
      return draw();
    }
    if (key.name === "return" || key.name === "enter") {
      const text = input;
      input = "";
      send(text);
      return draw();
    }
    if (key.name === "backspace") {
      input = input.slice(0, -1);
      return draw();
    }
    if (key.name === "escape") {
      input = "";
      return draw();
    }
    if (str && !key.ctrl && !key.meta) {
      input += str;
      draw();
    }
  };
  stdin.on("keypress", onKey);

  const cleanup = () => {
    try {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
    } catch {}
    out.write(SHOW_CURSOR + ALT_OFF);
  };

  const quit = () => {
    cleanup();
    onQuit();
  };

  // ---- drawing ----------------------------------------------------------
  let drawScheduled = false;
  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    setImmediate(() => {
      drawScheduled = false;
      draw();
    });
  }

  function draw() {
    const rows = out.rows || 24;
    const cols = out.columns || 80;
    const snap = connector.snapshot();
    const header = [
      c.bold(c.cyan("OpenTogether")),
      dot(snap.state === "connected", `relay ${snap.state}`),
      dot(!!snap.peerOnline, `peer ${snap.peer?.name ?? "—"}`),
      finished ? c.yellow(`🏁 finished by ${finished.by}`) : c.green("● running"),
    ].join("  ");

    const footerHint = c.dim("Enter send · Ctrl+D done · Ctrl+R reopen · Ctrl+C quit");

    // Reserve: header(1) + blank(1) + feed + blank(1) + typing(1) + input(1) + footer(1)
    const feedRows = Math.max(3, rows - 6);
    const feed = renderFeed(lines, feedRows, cols);

    const typingLine = typing ? c.dim("  …agent is thinking") : "";
    const inputLine = c.blue("you> ") + input + c.dim("▏");
    const finishedLine = finished
      ? c.yellow(`🏁 finished — send a message or Ctrl+R to reopen`)
      : "";

    let buf = "";
    buf += "\x1b[2J\x1b[H"; // clear + home
    buf += header + "\n";
    buf += c.dim("─".repeat(Math.min(cols, 120))) + "\n";
    buf += feed.join("\n") + "\n";
    buf += typingLine + "\n";
    buf += finishedLine + "\n";
    buf += inputLine + "\n";
    buf += footerHint;
    out.write(HIDE_CURSOR + buf);
  }

  function renderFeed(all, maxRows, cols) {
    // Greedy bottom-up wrap so the newest lines are visible.
    const wrapped = [];
    const width = Math.max(20, cols - 4);
    for (const line of all) {
      const prefix = line.kind === "sys" ? "" : `${line.who}: `;
      const tagColor =
        line.kind === "you" ? c.blue : line.kind === "peer" ? c.magenta : line.kind === "sys" ? c.dim : (s) => s;
      const body = wrapText(prefix + line.text, width);
      for (let i = 0; i < body.length; i++) {
        if (i === 0) {
          wrapped.push(tagColor(body[i]));
        } else {
          wrapped.push("  " + c.dim(body[i]));
        }
      }
    }
    const visible = wrapped.slice(-maxRows);
    while (visible.length < maxRows) visible.unshift("");
    return visible;
  }

  out.write(ALT_ON);
  draw();

  return {
    close: cleanup,
    quit,
  };
}

function startPlainStream({ bridge, connector }) {
  const log = (prefix, text) => console.log(`${prefix} ${text}`);
  const handlers = {
    inbound: (e) => log(`◀ ${e.from}`, e.text),
    outbound: (e) => log("▶ you (agent)", e.text),
    forwarded: (e) => log("▶ you", e.text),
    finished: (e) => log("🏁", `finished by ${e.by}${e.summary ? `: ${e.summary}` : ""}`),
    reopened: () => log("🔓", "reopened"),
    "loop-stopped": (e) => log("🛑", `auto-reply stopped (${e.reason})`),
    "ignored-after-done": (e) => log("🔇", `ignored post-done message from ${e.from}`),
  };
  for (const [ev, fn] of Object.entries(handlers)) bridge.on(ev, fn);
  return {
    close: () => {
      for (const [ev, fn] of Object.entries(handlers)) bridge.off(ev, fn);
    },
  };
}

function dot(on, label) {
  return `${on ? c.green("●") : c.yellow("○")} ${label}`;
}

function wrapText(text, width) {
  const str = String(text ?? "");
  if (str.length <= width) return [str];
  const words = str.split(/(\s+)/);
  const out = [];
  let line = "";
  for (const w of words) {
    if ((line + w).length > width) {
      if (line) out.push(line);
      line = w.trimStart();
    } else {
      line += w;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}
