// A fake OpenCode server for testing the bridge without burning tokens.
//
// Implements just the endpoints AgentBridge uses:
//   POST /session                      create session
//   GET  /session/:id                  fetch session
//   GET  /session/:id/message          list messages
//   POST /session/:id/message          prompt (honours noReply)
//   POST /session/:id/prompt_async     prompt, reply streamed via events
//   GET  /session/status               busy/idle map
//   GET  /event                        SSE event stream
//   GET  /global/health                health
//
// The "model" is programmable: set `server.reply = (promptText, history) => string`.

import http from "node:http";

let counter = 0;
const uid = (p) => `${p}_test${++counter}`;

export function createMockOpencode({ reply } = {}) {
  const sessions = new Map(); // id -> { id, title, metadata, messages: [] }
  const statuses = new Map(); // id -> { type }
  const sseClients = new Set();

  const state = {
    reply: reply ?? (() => "OK"),
    /** Array of { text, parts } the mock "assistant" produced, for assertions */
    assistantTurns: [],
    sentUserMessages: [],
    prompts: [],
    noReplyCount: 0,
  };

  function send(evt) {
    const payload = JSON.stringify(evt);
    for (const res of sseClients) res.write(`data: ${payload}\n\n`);
  }

  function event(type, properties) {
    send({ id: uid("evt"), type, properties });
  }

  function addMessage(session, role, parts, extra = {}) {
    const msg = {
      info: {
        id: uid("msg"),
        sessionID: session.id,
        role,
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "mock", modelID: "mock-model" },
        ...extra,
      },
      parts: parts.map((p) => ({
        id: uid("prt"),
        sessionID: session.id,
        messageID: "",
        ...p,
      })),
    };
    for (const p of msg.parts) p.messageID = msg.info.id;
    session.messages.push(msg);
    return msg;
  }

  async function runAssistantTurn(session, promptText) {
    statuses.set(session.id, { type: "busy" });
    event("session.status", { sessionID: session.id, status: { type: "busy" } });
    let text = "";
    let error = null;
    try {
      text = String(state.reply(promptText, session.messages) ?? "");
    } catch (e) {
      error = { name: "APIError", data: { message: e.message } };
    }
    await new Promise((r) => setTimeout(r, 30));
    if (error) {
      event("session.error", { sessionID: session.id, error });
    }
    const msg = addMessage(
      session,
      "assistant",
      text ? [{ type: "text", text }] : [],
      error ? { error } : {},
    );
    event("message.updated", { sessionID: session.id, info: msg.info });
    for (const p of msg.parts) event("message.part.updated", { sessionID: session.id, part: p, time: Date.now() });
    statuses.set(session.id, { type: "idle" });
    event("session.status", { sessionID: session.id, status: { type: "idle" } });
    event("session.idle", { sessionID: session.id });
    state.assistantTurns.push({ text, error });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = () =>
      new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => resolve(data ? JSON.parse(data) : {}));
      });

    if (path === "/global/health") return json({ ok: true });
    if (path === "/path") return json({ directory: process.cwd(), worktree: process.cwd() });
    if (path === "/agent") return json([{ name: "build", mode: "primary" }]);
    if (path === "/session/status") return json(Object.fromEntries(statuses));
    if (path === "/project/current") return json({ name: "mock-project" });

    if (path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ id: uid("evt"), type: "server.connected", properties: {} })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (path === "/session" && req.method === "POST") {
      const body = await readBody();
      const s = { id: uid("ses"), title: body.title ?? "untitled", metadata: body.metadata ?? {}, messages: [] };
      sessions.set(s.id, s);
      return json(s);
    }

    const m = path.match(/^\/session\/([^/]+)(\/message|\/prompt_async|\/abort)?$/);
    if (m) {
      const session = sessions.get(m[1]);
      if (!session) return json({ error: "not found" }, 404);
      const sub = m[2];

      if (!sub && req.method === "GET") return json(session);
      if (!sub && req.method === "PATCH") {
        const body = await readBody();
        Object.assign(session, body);
        return json(session);
      }
      if (sub === "/message" && req.method === "GET") return json(session.messages);
      if (sub === "/abort") {
        statuses.set(session.id, { type: "idle" });
        return json(true);
      }
      if (sub === "/message" && req.method === "POST") {
        const body = await readBody();
        const user = addMessage(session, "user", body.parts ?? [], {});
        state.sentUserMessages.push(user);
        if (body.noReply) {
          state.noReplyCount++;
          event("message.updated", { sessionID: session.id, info: user.info });
          return json(user);
        }
        const promptText = (body.parts ?? []).map((p) => p.text ?? "").join("\n");
        state.prompts.push(promptText);
        const run = runAssistantTurn(session, promptText);
        await run;
        return json({ info: user.info, parts: user.parts });
      }
      if (sub === "/prompt_async" && req.method === "POST") {
        const body = await readBody();
        const user = addMessage(session, "user", body.parts ?? [], {});
        state.sentUserMessages.push(user);
        const promptText = (body.parts ?? []).map((p) => p.text ?? "").join("\n");
        state.prompts.push(promptText);
        event("message.updated", { sessionID: session.id, info: user.info });
        runAssistantTurn(session, promptText);
        res.writeHead(204);
        return res.end();
      }
    }

    json({ error: `no route ${req.method} ${path}` }, 404);
  });

  return {
    server,
    state,
    sessions,
    listen: () =>
      new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address()))),
    close: () =>
      new Promise((resolve) => {
        for (const res of sseClients) res.end();
        sseClients.clear();
        server.close(() => resolve());
      }),
  };
}
