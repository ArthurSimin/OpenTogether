// Minimal client for the local OpenCode server HTTP API.
//
// We use plain `fetch` (no SDK dependency) so this works against any OpenCode
// version that exposes the documented endpoints.
//
// There are two live API shapes in the wild:
//
//   v1 (<= 1.x)  paths like /session, /event; bare JSON; model passed inline
//                with the prompt.
//   v2 (>= 2.0)  paths under /api/*; every response wrapped in { data: ... };
//                Basic auth required; the model is set with a separate call
//                before prompting, and prompts take { text } only.
//
// We detect which one we're talking to once and route every call accordingly,
// so the bridge code above doesn't have to care.

import { parseSSE, readJsonSafe, scrubSecrets, truncate, newId } from "./util.mjs";

export class OpenCodeClient {
  /**
   * @param {object} opts
   * @param {string} opts.serverUrl  e.g. http://127.0.0.1:4096
   * @param {string} [opts.directory] working directory of the instance we target
   * @param {string} [opts.password]  basic auth password (OPENCODE_SERVER_PASSWORD)
   * @param {string} [opts.username]  basic auth username (default "opencode")
   */
  constructor({ serverUrl, directory, password, username }) {
    this.base = String(serverUrl).replace(/\/+$/, "");
    this.directory = directory || undefined;
    this.password = password || process.env.OPENCODE_SERVER_PASSWORD || undefined;
    this.username = username || process.env.OPENCODE_SERVER_USERNAME || "opencode";
    /** @type {"v1"|"v2"|null} resolved lazily by detect() */
    this.api = null;
    /** @type {Promise<"v1"|"v2">|null} */
    this._detectPromise = null;
    /** @type {AbortController | null} */
    this._streamAbort = null;
    /** @type {Map<string, Set<(evt:any)=>void>>} sessionID -> listeners */
    this._listeners = new Map();
    /** @type {Set<(evt:any)=>void>} */
    this._globalListeners = new Set();
    this._streamStarted = false;
    this._streamGeneration = 0;
    /** Last error seen while switching model on a v2 server. */
    this.lastModelError = null;
    this.stats = { events: 0, reconnects: 0, lastEventAt: 0 };
  }

  _headers(extra = {}) {
    const h = { ...extra };
    if (this.password) {
      h.authorization =
        "Basic " + Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64");
    }
    return h;
  }

  _url(path, extraQuery) {
    const url = new URL(this.base + path);
    if (this.directory) url.searchParams.set("directory", this.directory);
    for (const [k, v] of Object.entries(extraQuery ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async _json(method, path, body, extraQuery) {
    const res = await fetch(this._url(path, extraQuery), {
      method,
      headers: this._headers(body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await readJsonSafe(res);
      const msg =
        (detail && (detail.data?.message || detail.message || detail.error)) ||
        (typeof detail === "string" ? detail : "") ||
        res.statusText;
      throw new Error(`${method} ${path} failed (${res.status}): ${msg}`);
    }
    if (res.status === 204) return null;
    return readJsonSafe(res);
  }

  /**
   * v2 request: everything lives under /api, and successful payloads are
   * wrapped as { data, location?, cursor? }. Unwrap so callers see the same
   * shape they get from v1.
   */
  async _v2(method, path, body, extraQuery) {
    const res = await fetch(this._url("/api" + path, extraQuery), {
      method,
      headers: this._headers(body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await readJsonSafe(res);
      const msg =
        (detail && (detail.data?.message || detail.message || detail.error || detail._tag)) ||
        (typeof detail === "string" ? detail : "") ||
        res.statusText;
      const err = new Error(`${method} /api${path} failed (${res.status}): ${msg}`);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    if (res.status === 204) return null;
    const parsed = await readJsonSafe(res);
    // Unwrap the envelope only when it really is one.
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "data" in parsed &&
      Object.keys(parsed).every((k) => k === "data" || k === "location" || k === "cursor")
    ) {
      return parsed.data;
    }
    return parsed;
  }

  /**
   * Work out whether this server speaks v1 or v2.
   *
   * The one reliable difference is `GET /openapi.json`:
   *   v1 → 200 with an HTML page (it serves the web UI for unknown paths)
   *   v2 → 200 with a JSON OpenAPI document, or 401 with a JSON `_tag` body
   *        when no password was supplied
   *
   * Both versions answer /api/agent and v1 even has a partial /api facade, so
   * that path proves nothing. A 401 here is itself proof of v2.
   */
  async detect() {
    if (this.api) return this.api;
    if (this._detectPromise) return this._detectPromise;
    this._detectPromise = (async () => {
      let version = "v1";
      try {
        const res = await fetch(this.base + "/openapi.json", {
          headers: this._headers(),
          signal: AbortSignal.timeout(4000),
        });
        const ct = res.headers.get("content-type") ?? "";
        if (/json/i.test(ct)) {
          if (res.ok) {
            const doc = await readJsonSafe(res);
            if (doc && typeof doc === "object" && (doc.openapi || doc.paths)) version = "v2";
          } else if (res.status === 401 || res.status === 403) {
            // Authenticated JSON API that rejected us: definitely v2.
            version = "v2";
            this.needsPassword = true;
          }
        }
      } catch {
        // Network trouble: fall through and let the call itself fail loudly.
      }
      this.api = version;
      return version;
    })();
    return this._detectPromise;
  }

  /** True when the server speaks the v2 API. */
  async isV2() {
    return (await this.detect()) === "v2";
  }

  // ---------------------------------------------------------------- discovery

  async health() {
    if (await this.isV2()) {
      // v2 has no health endpoint; a successful session list proves it's up.
      try {
        await this._v2("GET", "/session", undefined, { limit: 1 });
        return { healthy: true, api: "v2" };
      } catch {
        return null;
      }
    }
    try {
      // /global/health is not directory scoped; harmless extra query param is fine.
      const res = await fetch(this.base + "/global/health", { headers: this._headers() });
      if (!res.ok) return null;
      return await readJsonSafe(res);
    } catch {
      return null;
    }
  }

  async path() {
    if (await this.isV2()) {
      // v2 reports the working directory on the envelope of several calls.
      const projects = await this._v2("GET", "/project").catch(() => []);
      const active = Array.isArray(projects)
        ? projects.find((p) => p?.time?.active) ?? projects[0]
        : null;
      return { directory: active?.canonical ?? this.directory ?? null };
    }
    return this._json("GET", "/path");
  }

  async agents() {
    if (await this.isV2()) {
      const list = await this._v2("GET", "/agent");
      return Array.isArray(list) ? list : [];
    }
    const list = await this._json("GET", "/agent");
    return Array.isArray(list) ? list : [];
  }

  async providers() {
    if (await this.isV2()) {
      // v2 splits providers and models across two endpoints: /api/provider
      // describes the integrations, /api/model lists every model with its
      // providerID. Join them into the { id, name, models[] } shape the rest of
      // the app expects.
      const [providerList, modelList] = await Promise.all([
        this._v2("GET", "/provider").catch(() => []),
        this._v2("GET", "/model").catch(() => []),
      ]);
      const byProvider = new Map();
      for (const m of Array.isArray(modelList) ? modelList : []) {
        const pid = m?.providerID;
        const mid = m?.modelID ?? m?.id;
        if (!pid || !mid) continue;
        if (!byProvider.has(pid)) byProvider.set(pid, []);
        byProvider.get(pid).push(mid);
      }
      const out = [];
      for (const p of Array.isArray(providerList) ? providerList : []) {
        const models = byProvider.get(p.id) ?? [];
        if (!models.length) continue;
        out.push({ id: p.id, name: p.name ?? p.id, models });
      }
      // Include providers that only appeared in the model list.
      for (const [pid, models] of byProvider) {
        if (!out.some((p) => p.id === pid)) out.push({ id: pid, name: pid, models });
      }
      return out;
    }
    const data = await this._json("GET", "/config/providers");
    const providers = Array.isArray(data?.providers) ? data.providers : [];
    return providers
      .map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        models: Object.keys(p.models ?? {}),
      }))
      .filter((p) => p.models.length > 0);
  }

  async agentNames() {
    const agents = await this.agents();
    return agents
      .filter((a) => !a.hidden && a.mode !== "subagent")
      .map((a) => a.name ?? a.id)
      .filter(Boolean);
  }

  async projectTitle() {
    if (await this.isV2()) {
      try {
        const projects = await this._v2("GET", "/project");
        const active = Array.isArray(projects)
          ? projects.find((p) => p?.time?.active) ?? projects[0]
          : null;
        if (!active) return null;
        const dir = active.canonical ?? "";
        return dir ? dir.split("/").filter(Boolean).pop() ?? dir : null;
      } catch {
        return null;
      }
    }
    try {
      const current = await this._json("GET", "/project/current");
      return current?.name ?? current?.worktree ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- sessions

  async createSession({ title, agent, model, parentID } = {}) {
    if (await this.isV2()) {
      const body = {};
      if (title) body.title = title;
      if (agent) body.agent = agent;
      if (parentID) body.parentID = parentID;
      if (model?.providerID && model?.modelID) {
        body.model = { providerID: model.providerID, id: model.modelID };
      }
      // v2 ignores ?directory= and takes the working directory in the body.
      if (this.directory) body.location = { directory: this.directory };
      const created = await this._v2("POST", "/session", body);
      return created ?? {};
    }
    const body = {};
    if (title) body.title = title;
    if (agent) body.agent = agent;
    if (parentID) body.parentID = parentID;
    if (model?.providerID && model?.modelID) {
      body.model = { providerID: model.providerID, id: model.modelID };
    }
    return this._json("POST", "/session", body);
  }

  async getSession(sessionID) {
    if (await this.isV2()) return this._v2("GET", `/session/${sessionID}`);
    return this._json("GET", `/session/${sessionID}`);
  }

  async updateSessionMeta(sessionID, metadata) {
    if (await this.isV2()) return this._v2("PATCH", `/session/${sessionID}`, { metadata });
    return this._json("PATCH", `/session/${sessionID}`, { metadata });
  }

  async deleteSession(sessionID) {
    if (await this.isV2()) return this._v2("DELETE", `/session/${sessionID}`);
    return this._json("DELETE", `/session/${sessionID}`);
  }

  /**
   * Read the full visible conversation of a session.
   * Returns [{ info, parts }] in chronological order.
   *
   * v2 returns its own message vocabulary (user/assistant/idle/synthetic/...)
   * with `content` parts; we normalise it into the v1 shape here so every
   * consumer above this layer stays unchanged.
   */
  async messages(sessionID) {
    if (await this.isV2()) {
      // v2 applies `limit` to whichever end `order` starts from, so
      // order=asc&limit=N would return the OLDEST N messages — useless when we
      // need the agent's latest reply. Take the newest page and reverse it into
      // chronological order, which is what every caller expects.
      const data = await this._v2("GET", `/session/${sessionID}/message`, undefined, {
        order: "desc",
        limit: 200,
      });
      const list = Array.isArray(data) ? data : [];
      return list
        .slice()
        .reverse()
        .map(normalizeV2Message)
        .filter(Boolean);
    }
    const data = await this._json("GET", `/session/${sessionID}/message`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Find the session's own model + agent selection (as chosen by the user).
   */
  async sessionSelection(sessionID) {
    const msgs = await this.messages(sessionID);
    let model = null;
    let agent = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i]?.info;
      if (!info) continue;
      if (!model && info.model?.providerID && info.model?.modelID) {
        model = { providerID: info.model.providerID, modelID: info.model.modelID };
      }
      if (!agent && info.agent) agent = info.agent;
      if (model && agent) break;
    }
    return { model, agent };
  }

  // ---------------------------------------------------------------- messaging

  /**
   * Store a message in a session *without* triggering an LLM reply.
   * Used to mirror the partner's words into the local session so the local
   * agent sees them in its normal conversation history.
   */
  async appendNoReply(sessionID, parts, { messageID } = {}) {
    if (await this.isV2()) {
      // v2's `synthetic` endpoint durably admits input without scheduling a
      // run (resume:false), which is exactly "record this, don't answer it".
      // It only takes one text blob, so join any text parts.
      const text = parts
        .map((p) => (p?.type === "text" ? p.text : p?.text))
        .filter(Boolean)
        .join("\n");
      const created = await this._v2("POST", `/session/${sessionID}/synthetic`, {
        text,
        resume: false,
      });
      return created ? { info: normalizeV2Message(created)?.info ?? created } : null;
    }
    const body = {
      parts: parts.map((p) => ({ ...p })),
      noReply: true,
    };
    if (messageID) body.messageID = messageID;
    return this._json("POST", `/session/${sessionID}/message`, body);
  }

  /**
   * Send a message that triggers the agent to reply. Resolves once the
   * server accepted the prompt (the reply streams via events).
   */
  async prompt(sessionID, text, { agent, model, tools, system } = {}) {
    if (await this.isV2()) {
      // v2 will not accept a model alongside the prompt (additionalProperties
      // is false), so the selection has to be applied first, in its own call.
      if (model?.providerID && model?.modelID) {
        await this.setModel(sessionID, model).catch((err) => {
          this.lastModelError = err;
          throw err;
        });
      }
      if (agent) await this._v2("POST", `/session/${sessionID}/agent`, { agent }).catch(() => null);
      return this._v2("POST", `/session/${sessionID}/prompt`, { text });
    }
    const body = { parts: [{ type: "text", text }] };
    if (agent) body.agent = agent;
    if (model?.providerID && model?.modelID) {
      body.model = { providerID: model.providerID, modelID: model.modelID };
    }
    if (tools) body.tools = tools;
    if (system) body.system = system;
    return this._json("POST", `/session/${sessionID}/prompt_async`, body);
  }

  /**
   * Point a session at a specific model. v2 needs this as a separate call and
   * expects the model id under `id` (not `modelID`).
   */
  async setModel(sessionID, model) {
    if (!model?.providerID || !(model.modelID ?? model.id)) return null;
    if (await this.isV2()) {
      return this._v2("POST", `/session/${sessionID}/model`, {
        model: { providerID: model.providerID, id: model.modelID ?? model.id },
      });
    }
    return null;
  }

  async abort(sessionID) {
    if (await this.isV2()) {
      return this._v2("POST", `/session/${sessionID}/interrupt`).catch(() => null);
    }
    return this._json("POST", `/session/${sessionID}/abort`).catch(() => null);
  }

  /** Session status map: { [sessionID]: { type: "idle" | "busy" | "retry" } } */
  async statuses() {
    if (await this.isV2()) {
      // v2 lists only the sessions that are currently doing work.
      const active = await this._v2("GET", "/session/active").catch(() => ({}));
      const out = {};
      for (const [sid, st] of Object.entries(active ?? {})) {
        const type = st?.type === "running" ? "busy" : st?.type;
        out[sid] = { type: type ?? "busy" };
      }
      return out;
    }
    const data = await this._json("GET", "/session/status");
    return data && typeof data === "object" ? data : {};
  }

  // ---------------------------------------------------------------- events

  /**
   * Subscribe to the server event stream. Calls `onEvent` for every event.
   * Auto-reconnects forever in the background.
   *
   * v2 emits a different vocabulary, so its events are translated into the v1
   * shapes the bridge already understands (`session.idle`, `session.error`,
   * `message.updated`).
   */
  startEventStream(onEvent, { onStatus } = {}) {
    if (this._streamStarted) return;
    this._streamStarted = true;
    const generation = ++this._streamGeneration;
    const loop = async () => {
      let delay = 500;
      while (generation === this._streamGeneration) {
        const controller = new AbortController();
        this._streamAbort = controller;
        try {
          const v2 = await this.isV2();
          const streamPath = v2 ? "/api/event" : "/event";
          const res = await fetch(this._url(streamPath), {
            headers: this._headers({ accept: "text/event-stream" }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
          onStatus?.({ connected: true });
          delay = 500;
          for await (const item of parseSSE(res.body)) {
            if (generation !== this._streamGeneration) return;
            this.stats.events++;
            this.stats.lastEventAt = Date.now();
            const payload = item.data;
            if (v2) {
              for (const translated of translateV2Event(payload)) onEvent(translated, item);
            } else {
              onEvent(payload, item);
            }
          }
          throw new Error("event stream ended");
        } catch (err) {
          if (generation !== this._streamGeneration) return;
          if (err?.name === "AbortError") return;
          this.stats.reconnects++;
          onStatus?.({ connected: false, error: err?.message ?? String(err) });
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 8000);
      }
    };
    loop().catch(() => {});
  }

  stopEventStream() {
    this._streamGeneration++;
    this._streamAbort?.abort();
    this._streamAbort = null;
    this._streamStarted = false;
  }
}

// ---------------------------------------------------------------- v2 adapters

/**
 * Translate one v2 message into the v1 `{ info, parts }` shape.
 *
 * v2 types we care about:
 *   user       → { role: "user", text }
 *   assistant  → { role: "assistant", content: [{type:"text"|"tool", ...}] }
 *   idle       → terminal marker for a run (carries outcome + error)
 *   synthetic  → input we injected ourselves (peer mirror / status note)
 *   model-switched, session.*  → metadata, dropped
 *
 * Returning null drops the message from the conversation entirely.
 */
export function normalizeV2Message(m) {
  if (!m || typeof m !== "object") return null;
  const id = m.id;
  const created = m.time?.created ?? m.time?.completed ?? 0;

  if (m.type === "user" || m.type === "synthetic") {
    return {
      info: {
        id,
        role: "user",
        sessionID: m.sessionID,
        time: { created },
        // Our own injections must not be mistaken for the human talking.
        synthetic: m.type === "synthetic" ? true : undefined,
      },
      parts: [{ type: "text", text: String(m.text ?? "") }],
    };
  }

  if (m.type === "assistant") {
    const parts = [];
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === "text" && typeof c.text === "string") {
        parts.push({ type: "text", text: c.text });
      } else if (c?.type === "reasoning" && typeof c.text === "string") {
        parts.push({ type: "reasoning", text: c.text });
      } else if (c?.type === "tool") {
        const st = c.state ?? {};
        parts.push({
          type: "tool",
          tool: c.name ?? st.name ?? "tool",
          state: {
            status:
              st.status === "completed"
                ? "completed"
                : st.status === "error"
                  ? "error"
                  : st.status ?? "called",
            input: st.input ?? st.args,
            error: st.error?.message ?? st.error,
          },
        });
      }
    }
    const info = {
      id,
      role: "assistant",
      sessionID: m.sessionID,
      agent: m.agent,
      time: { created, completed: m.time?.completed },
      error: m.error ?? undefined,
    };
    if (m.model?.providerID && m.model?.id) {
      info.model = { providerID: m.model.providerID, modelID: m.model.id };
    }
    return { info, parts };
  }

  if (m.type === "idle") {
    // Represented as an assistant-less marker so extractAssistantText can pick
    // up the outcome/error without inventing a reply.
    return {
      info: {
        id,
        role: "idle",
        sessionID: m.sessionID,
        time: { created },
        outcome: m.outcome,
        error: m.error ?? undefined,
      },
      parts: [],
    };
  }

  return null;
}

/**
 * Translate one v2 event into zero or more v1-shaped events.
 *
 * The bridge reacts to `session.idle` (turn finished), `session.error`, and
 * `message.updated` (user typed). Everything else is passed through untouched
 * so dashboards can still observe it.
 */
export function translateV2Event(evt) {
  if (!evt || typeof evt !== "object") return [];
  const sid = evt.data?.sessionID ?? evt.properties?.sessionID;
  const out = [];

  switch (evt.type) {
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      if (evt.type !== "session.execution.succeeded" && evt.data?.error) {
        const err = evt.data.error;
        out.push({
          type: "session.error",
          properties: {
            sessionID: sid,
            error: {
              name: err.type ?? "error",
              data: { message: err.message ?? String(err) },
            },
          },
        });
      }
      // The run is over either way — this is the "agent finished" signal.
      out.push({ type: "session.idle", properties: { sessionID: sid } });
      break;
    }
    case "session.inbox.enqueued": {
      // A user message was admitted to the session.
      const item = evt.data?.item;
      if (item?.type === "user") {
        out.push({
          type: "message.updated",
          properties: {
            info: {
              id: evt.data?.inboxID,
              role: "user",
              sessionID: sid,
              time: { created: evt.created },
            },
          },
        });
      }
      break;
    }
    case "server.connected":
      break;
    default:
      out.push({
        type: evt.type,
        properties: { sessionID: sid, ...(evt.data ?? {}) },
      });
      break;
  }

  return out;
}

// ---------------------------------------------------------------- history reading

/**
 * Turn raw OpenCode messages into a plain, model-readable transcript.
 *
 * We only surface things a *remote peer* should see:
 *  - user text, without our own transport plumbing
 *  - assistant text
 *  - tool calls in a compact one-liner (so the peer knows what was tried)
 *  - errors
 * Secrets are scrubbed. Everything is truncated to keep payloads sane.
 */
export function buildTranscript(messages, { maxChars = 24000, perMessageChars = 6000 } = {}) {
  const lines = [];
  for (const entry of messages) {
    const info = entry?.info ?? entry;
    const parts = entry?.parts ?? [];
    if (!info) continue;

    if (info.role === "user") {
      const text = parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (!text) continue;
      // Skip messages that are purely our own transport envelope.
      if (/^\s*\[\[OT:/.test(text) && !/\[\[OT:(UPDATE|ACK)/.test(text)) continue;
      lines.push(`### USER\n${truncate(scrubSecrets(text), perMessageChars)}`);
      continue;
    }

    if (info.role !== "assistant") continue;

    if (info.error) {
      const err = info.error;
      const msg = err?.data?.message ?? err?.message ?? err?.name ?? JSON.stringify(err);
      lines.push(`### ASSISTANT (failed)\n[error] ${truncate(scrubSecrets(String(msg)), 800)}`);
      continue;
    }

    const chunks = [];
    for (const p of parts) {
      if (p.type === "text" && p.text?.trim()) {
        chunks.push(scrubSecrets(p.text.trim()));
      } else if (p.type === "tool") {
        const st = p.state ?? {};
        const detail =
          st.status === "completed"
            ? "ran ok"
            : st.status === "error"
              ? `failed: ${truncate(String(st.error ?? ""), 200)}`
              : String(st.status ?? "called");
        const input = st.input ? truncate(JSON.stringify(st.input), 240) : "";
        chunks.push(`[tool ${p.tool} ${detail}]${input ? " " + input : ""}`);
      }
    }
    if (!chunks.length) continue;
    lines.push(`### ASSISTANT\n${truncate(chunks.join("\n"), perMessageChars)}`);
  }

  let out = lines.join("\n\n");
  if (out.length > maxChars) out = "… (earlier messages trimmed)\n\n" + out.slice(-maxChars);
  return out;
}

/**
 * Extract the final assistant answer text from a list of messages that came
 * *after* a given message id. Used to grab the local agent's reply.
 */
export function extractAssistantText(messages, { afterMessageId, agentFilter } = {}) {
  const startIdx = afterMessageId ? messages.findIndex((m) => m?.info?.id === afterMessageId) : -1;
  const slice = startIdx >= 0 ? messages.slice(startIdx + 1) : messages;
  let text = "";
  let error = null;
  for (const entry of slice) {
    const info = entry?.info ?? entry;
    if (info?.role !== "assistant") continue;
    if (agentFilter && info.agent && info.agent !== agentFilter) continue;
    if (info.error) {
      error = info.error?.data?.message ?? info.error?.message ?? info.error?.name ?? "unknown";
    }
    for (const p of entry.parts ?? []) {
      if (p.type === "text" && p.text?.trim() && !p.synthetic) {
        text += (text ? "\n" : "") + p.text.trim();
      }
    }
  }
  return { text: scrubSecrets(text).trim(), error };
}

export { newId };
