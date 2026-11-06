// Local control server.
//
// The OpenCode plugin (src/plugin.mjs) runs *inside* OpenCode and cannot own
// the relay connection itself (each OpenCode session can be restarted). So the
// `opentogether connect --control` process hosts a tiny authenticated HTTP
// server on localhost, and the plugin calls it:
//
//   POST /send   { text, wait }  -> { id, reply? }
//   POST /done   { summary }     -> { finished: {...} }   declare the job finished
//   POST /reopen                 -> { finished: null }    undo that
//   GET  /status                 -> { peer, connected, finished, ... }
//   GET  /health                 -> { ok }
//
// The URL + bearer token are written to ~/.config/opentogether/control.json
// (mode 0600) so the plugin can discover them.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { configDir } from "./config.mjs";

function controlFilePath() {
  return path.join(configDir(), "control.json");
}

export function startControlServer({ bridge, connector, log = () => {} }) {
  const token = randomBytes(24).toString("hex");
  const pending = new Map(); // requestId -> { resolve, timeout }
  let reqSeq = 0;

  // When the peer replies, hand it to whoever is waiting.
  bridge.on("inbound", ({ id, from, text }) => {
    for (const [reqId, waiter] of pending) {
      if (waiter.awaitingReply) {
        clearTimeout(waiter.timeout);
        pending.delete(reqId);
        waiter.resolve({ reply: text, from });
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    const json = (body, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== `Bearer ${token}`) {
      return json({ error: "unauthorized" }, 401);
    }
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/health") return json({ ok: true });

    if (url.pathname === "/status") {
      return json({
        ...connector.snapshot(),
        finished: bridge.finished ?? connector.finished ?? null,
        linkSession: bridge.linkSessionID,
        stats: bridge.stats,
      });
    }

    if (url.pathname === "/done" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const summary = String(payload.summary ?? "").slice(0, 2000);
      const record = bridge.declareDone({ summary, by: "agent" });
      log(`agent declared the conversation finished via control API`);
      return json({ finished: bridge.finished ?? record });
    }

    if (url.pathname === "/reopen" && req.method === "POST") {
      const reopened = bridge.reopen();
      return json({ finished: bridge.finished ?? null, reopened });
    }

    if (url.pathname === "/send" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const text = String(payload.text ?? "").trim();
      if (!text) return json({ error: "empty message" }, 400);
      if (!connector.peerOnline && payload.wait !== false) {
        // Still send: the relay holds it until the peer returns. But say so.
        log("peer offline — message will be queued by the relay");
      }
      const id = bridge.connector.say(text, { kind: "agent", from: connector.name });

      if (payload.wait === false) return json({ id, queued: true });

      const requestId = "r" + ++reqSeq;
      const reply = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          resolve(null);
        }, Number(payload.timeoutMs) || 5 * 60 * 1000);
        timeout.unref?.();
        // Resolve with just the text; the event carries a {reply,from} object.
        pending.set(requestId, { resolve: (v) => resolve(v?.reply ?? v ?? null), timeout, awaitingReply: true });
      });
      return json({ id, reply, from: connector.peer?.name ?? null });
    }

    return json({ error: "not found" }, 404);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const info = { url: `http://127.0.0.1:${port}`, token, pid: process.pid };
      const dir = configDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(controlFilePath(), JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
      log(`control server on ${info.url}`);
      resolve({
        url: info.url,
        token,
        close: () =>
          new Promise((r) => {
            try {
              fs.unlinkSync(controlFilePath());
            } catch {}
            server.close(() => r());
          }),
      });
    });
  });
}

/** Remove a stale control.json (used at shutdown / doctor). */
export function clearControlFile() {
  try {
    fs.unlinkSync(controlFilePath());
    return true;
  } catch {
    return false;
  }
}
