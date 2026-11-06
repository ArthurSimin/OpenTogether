// OpenCode v2 API compatibility.
//
// OpenCode 2.x moved its HTTP API under /api/*, wrapped every response in a
// `{ data: ... }` envelope, switched to Basic auth, and split "set the model"
// from "send the prompt". A user on v2.2.0 could not join at all: every call
// hit the v1 paths and got `405 Method Not Allowed`.
//
// These tests use a fake v2 server so they run without a real OpenCode install,
// plus pure-function checks for the message/event translation.
//
// Run: node test/v2.test.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { OpenCodeClient, normalizeV2Message, translateV2Event } from "../src/opencode-client.mjs";

const PASSWORD = "v2-test-password";
const AUTH = "Basic " + Buffer.from(`opencode:${PASSWORD}`, "utf8").toString("base64");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A tiny stand-in for an OpenCode v2 server. Records what was called so we can
 * assert on the exact request shapes the adapter produces.
 */
function createV2Server() {
  const calls = [];
  const state = {
    sessions: new Map(),
    messages: new Map(),
    seq: 0,
  };
  const id = (p) => `${p}_${(++state.seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;

    calls.push({ method: req.method, path: url.pathname, query: url.search, body });

    const json = (code, payload) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const noContent = () => {
      res.writeHead(204);
      res.end();
    };

    // The version probe: v2 publishes a real OpenAPI document here.
    if (url.pathname === "/openapi.json") {
      return json(200, { openapi: "3.1.0", info: { title: "opencode HttpApi" }, paths: {} });
    }

    // Everything under /api requires Basic auth, exactly like the real server.
    if (url.pathname.startsWith("/api/")) {
      if (req.headers.authorization !== AUTH) {
        return json(401, { _tag: "UnauthorizedError", message: "Authentication required" });
      }
    } else {
      // v1-style paths must not exist; the real v2 server answers 405/HTML.
      res.writeHead(405, { "content-type": "text/html" });
      return res.end("<!doctype html><html><body>nope</body></html>");
    }

    const p = url.pathname;

    if (p === "/api/session" && req.method === "POST") {
      const sid = id("ses");
      const session = {
        id: sid,
        title: body?.title ?? null,
        location: body?.location ?? { directory: "/tmp" },
        model: body?.model ?? null,
      };
      state.sessions.set(sid, session);
      state.messages.set(sid, []);
      return json(200, { data: session });
    }

    if (p === "/api/session" && req.method === "GET") {
      return json(200, { data: [...state.sessions.values()] });
    }

    let m = p.match(/^\/api\/session\/([^/]+)$/);
    if (m) {
      const s = state.sessions.get(m[1]);
      if (!s) return json(404, { _tag: "NotFoundError", message: "no session" });
      if (req.method === "DELETE") {
        state.sessions.delete(m[1]);
        return noContent();
      }
      return json(200, { data: s });
    }

    m = p.match(/^\/api\/session\/([^/]+)\/message$/);
    if (m && req.method === "GET") {
      const list = state.messages.get(m[1]) ?? [];
      const order = url.searchParams.get("order") ?? "desc";
      const limit = Number(url.searchParams.get("limit") ?? list.length);
      // Newest first by default; `limit` slices from the ordered end.
      const ordered = order === "asc" ? list.slice() : list.slice().reverse();
      return json(200, { data: ordered.slice(0, limit), cursor: { previous: null, next: null } });
    }

    m = p.match(/^\/api\/session\/([^/]+)\/model$/);
    if (m && req.method === "POST") {
      const s = state.sessions.get(m[1]);
      if (!body?.model?.id) {
        return json(400, {
          _tag: "InvalidRequestError",
          message: 'Missing key\n  at ["model"]["id"]',
          kind: "Payload",
        });
      }
      s.model = body.model;
      state.messages.get(m[1])?.push({
        id: id("msg"),
        type: "model-switched",
        time: { created: Date.now() },
        model: body.model,
      });
      return noContent();
    }

    m = p.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (m && req.method === "POST") {
      // The real endpoint rejects extra keys; enforce that so a regression in
      // the adapter (e.g. passing `model` inline again) fails loudly.
      const allowed = new Set(["id", "text", "files", "agents", "skills", "metadata", "delivery", "resume"]);
      const extra = Object.keys(body ?? {}).filter((k) => !allowed.has(k));
      if (extra.length) {
        return json(400, {
          _tag: "InvalidRequestError",
          message: `Unexpected key ${extra[0]}`,
          kind: "Payload",
        });
      }
      if (typeof body?.text !== "string") {
        return json(400, { _tag: "InvalidRequestError", message: 'Missing key\n  at ["text"]', kind: "Payload" });
      }
      const list = state.messages.get(m[1]);
      const userId = id("msg");
      list.push({ id: userId, type: "user", time: { created: Date.now() }, text: body.text });
      // Answer synchronously so the test doesn't need the event stream.
      list.push({
        id: id("msg"),
        type: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        agent: "build",
        model: { providerID: "test", id: "test-model" },
        content: [{ type: "text", text: "PONG" }],
        finish: "stop",
      });
      list.push({ id: id("msg"), type: "idle", time: { created: Date.now() }, outcome: "succeeded" });
      return json(200, { data: { id: userId, type: "user" } });
    }

    m = p.match(/^\/api\/session\/([^/]+)\/synthetic$/);
    if (m && req.method === "POST") {
      if (typeof body?.text !== "string") {
        return json(400, { _tag: "InvalidRequestError", message: 'Missing key\n  at ["text"]', kind: "Payload" });
      }
      const msg = { id: id("msg"), type: "synthetic", time: { created: Date.now() }, text: body.text };
      state.messages.get(m[1])?.push(msg);
      return json(200, { data: msg });
    }

    if (p === "/api/session/active") {
      return json(200, { data: {} });
    }

    if (p === "/api/agent") {
      return json(200, {
        location: { directory: "/tmp" },
        data: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
      });
    }

    if (p === "/api/provider") {
      return json(200, {
        location: { directory: "/tmp" },
        data: [{ id: "test", name: "Test" }],
      });
    }

    if (p === "/api/model") {
      return json(200, {
        location: { directory: "/tmp" },
        data: [{ id: "test-model", modelID: "test-model", providerID: "test" }],
      });
    }

    if (p === "/api/project") {
      return json(200, [
        { id: "p1", canonical: "/tmp/proj", time: { created: 1, updated: 1, active: 2 } },
      ]);
    }

    return json(404, { _tag: "NotFoundError", message: `no route ${p}` });
  });

  return { server, calls, state };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function main() {
  // ---- unit: v2 message → v1 shape -------------------------------------
  {
    const user = normalizeV2Message({
      id: "m1",
      type: "user",
      time: { created: 10 },
      text: "hello",
    });
    assert.equal(user.info.role, "user");
    assert.equal(user.parts[0].text, "hello");

    const assistant = normalizeV2Message({
      id: "m2",
      type: "assistant",
      time: { created: 20, completed: 21 },
      agent: "build",
      model: { providerID: "p", id: "m" },
      content: [
        { type: "text", text: "the answer" },
        { type: "tool", name: "bash", state: { status: "completed", input: { cmd: "ls" } } },
      ],
    });
    assert.equal(assistant.info.role, "assistant");
    assert.equal(assistant.info.model.providerID, "p");
    assert.equal(assistant.info.model.modelID, "m", "v2 `id` maps to v1 `modelID`");
    assert.equal(assistant.parts[0].text, "the answer");
    assert.equal(assistant.parts[1].type, "tool");
    assert.equal(assistant.parts[1].tool, "bash");
    assert.equal(assistant.parts[1].state.status, "completed");

    const idle = normalizeV2Message({
      id: "m3",
      type: "idle",
      time: { created: 22 },
      outcome: "failed",
      error: { type: "provider.x", message: "boom" },
    });
    assert.equal(idle.info.role, "idle");
    assert.equal(idle.info.outcome, "failed");

    const synthetic = normalizeV2Message({
      id: "m4",
      type: "synthetic",
      time: { created: 23 },
      text: "peer note",
    });
    assert.equal(synthetic.info.role, "user");
    assert.equal(synthetic.info.synthetic, true, "our own injections are marked synthetic");

    assert.equal(normalizeV2Message({ type: "model-switched" }), null);
    assert.equal(normalizeV2Message(null), null);
    console.log("   ✓ normalizeV2Message maps user/assistant/idle/synthetic");
  }

  // ---- unit: v2 event → v1 events --------------------------------------
  {
    const done = translateV2Event({
      type: "session.execution.succeeded",
      data: { sessionID: "ses_1" },
    });
    assert.equal(done.length, 1);
    assert.equal(done[0].type, "session.idle");
    assert.equal(done[0].properties.sessionID, "ses_1");

    const failed = translateV2Event({
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { type: "provider.x", message: "bad key" } },
    });
    assert.equal(failed.length, 2, "a failure both errors and idles");
    assert.equal(failed[0].type, "session.error");
    assert.equal(failed[0].properties.error.data.message, "bad key");
    assert.equal(failed[1].type, "session.idle");

    const typed = translateV2Event({
      type: "session.inbox.enqueued",
      created: 5,
      data: { sessionID: "ses_1", inboxID: "msg_9", item: { type: "user", payload: { text: "hi" } } },
    });
    assert.equal(typed.length, 1);
    assert.equal(typed[0].type, "message.updated");
    assert.equal(typed[0].properties.info.role, "user");

    assert.deepEqual(translateV2Event({ type: "server.connected", data: {} }), []);
    console.log("   ✓ translateV2Event maps execution/inbox events");
  }

  // ---- integration: the client against a fake v2 server ----------------
  {
    const { server, calls, state } = createV2Server();
    const url = await listen(server);
    try {
      const oc = new OpenCodeClient({ serverUrl: url, password: PASSWORD, directory: "/tmp/proj" });

      assert.equal(await oc.isV2(), true, "detects v2 via /openapi.json");
      assert.equal(await oc.isV2(), true, "detection is cached");

      // Discovery endpoints.
      const agents = await oc.agents();
      assert.deepEqual(agents.map((a) => a.id), ["build"]);

      const providers = await oc.providers();
      assert.equal(providers.length, 1);
      assert.equal(providers[0].id, "test");
      assert.deepEqual(providers[0].models, ["test-model"], "providers joined with /api/model");

      // Session creation carries the working directory in the BODY: v2 ignores
      // ?directory=, which silently scoped sessions to the wrong project.
      const session = await oc.createSession({ title: "link" });
      assert.ok(session.id?.startsWith("ses_"), "session id unwrapped from {data}");
      const createCall = calls.find((c) => c.method === "POST" && c.path === "/api/session");
      assert.deepEqual(createCall.body.location, { directory: "/tmp/proj" });

      // Sending a peer note must NOT wake the agent.
      await oc.appendNoReply(session.id, [{ type: "text", text: "peer said hi" }]);
      const synCall = calls.find((c) => c.path.endsWith("/synthetic"));
      assert.equal(synCall.body.resume, false, "synthetic uses resume:false so nothing runs");

      // Prompting sets the model first, then prompts with text only.
      await oc.prompt(session.id, "Say PONG", {
        model: { providerID: "test", modelID: "test-model" },
      });
      const modelCall = calls.find(
        (c) => c.method === "POST" && c.path === `/api/session/${session.id}/model`,
      );
      assert.ok(modelCall, "model is set in its own call");
      assert.deepEqual(modelCall.body.model, { providerID: "test", id: "test-model" });

      const promptCall = calls.find(
        (c) => c.method === "POST" && c.path === `/api/session/${session.id}/prompt`,
      );
      assert.equal(promptCall.body.text, "Say PONG");
      assert.equal(promptCall.body.model, undefined, "model must not be sent with the prompt");

      // Reading messages returns chronological order with v1 shapes.
      const msgs = await oc.messages(session.id);
      const roles = msgs.map((m) => m.info.role);
      assert.ok(roles.includes("user"), "user message present");
      assert.ok(roles.includes("assistant"), "assistant message present");
      const answer = msgs.find((m) => m.info.role === "assistant");
      assert.equal(answer.parts[0].text, "PONG");
      assert.equal(roles[roles.length - 1], "idle", "chronological: idle comes last");

      // statuses() reports nothing busy when /api/session/active is empty.
      assert.deepEqual(await oc.statuses(), {});

      // A v1-only path must not be used against a v2 server.
      const bad = calls.find((c) => c.path === "/session");
      assert.equal(bad, undefined, "never calls the v1 /session path");

      console.log("   ✓ v2 client: detect, sessions, synthetic, model+prompt, messages");
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // ---- integration: a v2 server rejects the prompt if model is inlined ---
  {
    const { server, state } = createV2Server();
    const url = await listen(server);
    try {
      const oc = new OpenCodeClient({ serverUrl: url, password: PASSWORD });
      const session = await oc.createSession({ title: "x" });
      // Directly posting a model with the prompt must fail — this is the exact
      // shape that used to be sent, and why v2 users got nowhere.
      const res = await fetch(`${url}/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: AUTH },
        body: JSON.stringify({ text: "hi", model: { providerID: "a", id: "b" } }),
      });
      assert.equal(res.status, 400, "v2 rejects a prompt carrying a model");
      assert.equal(state.messages.get(session.id).length, 0);
      console.log("   ✓ v2 prompt rejects an inline model (the old failure mode)");
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // ---- integration: wrong password is reported clearly ------------------
  {
    const { server } = createV2Server();
    const url = await listen(server);
    try {
      const oc = new OpenCodeClient({ serverUrl: url, password: "wrong" });
      await assert.rejects(
        () => oc.createSession({ title: "x" }),
        (err) => {
          assert.match(err.message, /401/);
          assert.match(err.message, /Authentication required/);
          return true;
        },
      );
      console.log("   ✓ a bad v2 password surfaces as a clear auth error");
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // ---- v1 is still detected as v1 --------------------------------------
  {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/openapi.json")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<!doctype html><html></html>");
      }
      res.writeHead(404);
      res.end();
    });
    const url = await listen(server);
    try {
      const oc = new OpenCodeClient({ serverUrl: url });
      assert.equal(await oc.isV2(), false, "an HTML /openapi.json means v1");
      console.log("   ✓ v1 is not mistaken for v2");
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  console.log("\nALL V2 TESTS PASSED");
}

main().catch((err) => {
  console.error("\nV2 TEST FAILED:", err);
  process.exit(1);
});
