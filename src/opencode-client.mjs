// Minimal client for the local OpenCode server HTTP API.
//
// We use plain `fetch` (no SDK dependency) so this works against any OpenCode
// version that exposes the documented endpoints.

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
    /** @type {AbortController | null} */
    this._streamAbort = null;
    /** @type {Map<string, Set<(evt:any)=>void>>} sessionID -> listeners */
    this._listeners = new Map();
    /** @type {Set<(evt:any)=>void>} */
    this._globalListeners = new Set();
    this._streamStarted = false;
    this._streamGeneration = 0;
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

  // ---------------------------------------------------------------- discovery

  async health() {
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
    return this._json("GET", "/path");
  }

  async agents() {
    const list = await this._json("GET", "/agent");
    return Array.isArray(list) ? list : [];
  }

  async providers() {
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
    try {
      const current = await this._json("GET", "/project/current");
      return current?.name ?? current?.worktree ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- sessions

  async createSession({ title, agent, model, parentID } = {}) {
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
    return this._json("GET", `/session/${sessionID}`);
  }

  async updateSessionMeta(sessionID, metadata) {
    return this._json("PATCH", `/session/${sessionID}`, { metadata });
  }

  /**
   * Read the full visible conversation of a session.
   * Returns [{ info, parts }] in chronological order.
   */
  async messages(sessionID) {
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
    const body = { parts: [{ type: "text", text }] };
    if (agent) body.agent = agent;
    if (model?.providerID && model?.modelID) {
      body.model = { providerID: model.providerID, modelID: model.modelID };
    }
    if (tools) body.tools = tools;
    if (system) body.system = system;
    return this._json("POST", `/session/${sessionID}/prompt_async`, body);
  }

  async abort(sessionID) {
    return this._json("POST", `/session/${sessionID}/abort`).catch(() => null);
  }

  /** Session status map: { [sessionID]: { type: "idle" | "busy" | "retry" } } */
  async statuses() {
    const data = await this._json("GET", "/session/status");
    return data && typeof data === "object" ? data : {};
  }

  // ---------------------------------------------------------------- events

  /**
   * Subscribe to the server event stream. Calls `onEvent` for every event.
   * Auto-reconnects forever in the background.
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
          const res = await fetch(this._url("/event"), {
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
            onEvent(item.data, item);
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
