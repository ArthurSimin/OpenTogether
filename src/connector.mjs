// Connector: the client side of an OpenTogether link.
//
// One Connector object owns one WebSocket to the relay and exposes a clean
// event API to whatever drives it (the Electron/plugin side). It handles
// identity, heartbeats, exponential backoff reconnect and "what did I miss".

import { EventEmitter } from "node:events";
import { deriveRoom, tokensMatch, PROTOCOL_VERSION, LIMITS } from "./protocol.mjs";
import { newId, sanitizeName, nowIso } from "./util.mjs";

export class Connector extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.relayUrl
   * @param {string} opts.passphrase
   * @param {string} [opts.room]        human room name (hashed before sending)
   * @param {string} opts.name          my display name
   * @param {"host"|"guest"} opts.role
   * @param {boolean} [opts.autoReconnect]
   */
  constructor({ relayUrl, passphrase, room = "default", name, role, autoReconnect = true }) {
    super();
    this.relayUrl = String(relayUrl).trim();
    if (!/^wss?:\/\//i.test(this.relayUrl)) {
      throw new Error(`relay URL must start with ws:// or wss:// (got "${relayUrl}")`);
    }
    if (!passphrase || passphrase.length < LIMITS.passphraseMin) {
      throw new Error(`passphrase must be at least ${LIMITS.passphraseMin} characters`);
    }
    const derived = deriveRoom(passphrase, room);
    this.room = derived.room;
    this.roomName = room;
    this._token = derived.token;
    this.name = sanitizeName(name);
    this.role = role;
    this.autoReconnect = autoReconnect;

    this.ws = null;
    this.state = "idle"; // idle | connecting | connected | reconnecting | closed
    this.peer = null;
    this.peers = [];
    this.missed = [];
    /** Last "we're done" declaration from either side: {by, from, summary, at} | null */
    this.finished = null;
    this._attempt = 0;
    this._retryTimer = null;
    this._heartbeat = null;
    this._closedByUser = false;
    this._pending = []; // messages queued while connecting
  }

  // ------------------------------------------------------------------- status

  get connected() {
    return this.state === "connected";
  }

  get peerOnline() {
    return !!this.peer;
  }

  snapshot() {
    return {
      state: this.state,
      room: this.roomName,
      name: this.name,
      role: this.role,
      peer: this.peer,
      peers: this.peers,
      peerOnline: this.peerOnline,
      finished: this.finished,
    };
  }

  // -------------------------------------------------------------- lifecycle

  connect() {
    if (this.role !== "host" && this.role !== "guest") {
      throw new Error(`invalid role "${this.role}"`);
    }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this._closedByUser = false;
    this._attempt = 0;
    this._open();
  }

  _setState(state, extra = {}) {
    if (this.state === state) return;
    this.state = state;
    this.emit("status", { ...this.snapshot(), ...extra });
  }

  _open() {
    clearTimeout(this._retryTimer);
    this._setState(this._attempt === 0 ? "connecting" : "reconnecting");
    let ws;
    try {
      ws = new WebSocket(this.relayUrl);
    } catch (err) {
      this.emit("error", new Error(`cannot open websocket: ${err?.message ?? err}`));
      this._scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this._send({
        t: "hello",
        room: this.room,
        name: this.name,
        role: this.role,
        token: this._token,
        version: PROTOCOL_VERSION,
      });
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this._onMessage(msg);
    });

    ws.addEventListener("close", (ev) => {
      this._stopHeartbeat();
      if (this.ws !== ws) return;
      this.ws = null;
      const wasConnected = this.state === "connected";
      this.peer = null;
      this.peers = [];
      if (this._closedByUser) {
        this._setState("closed");
        return;
      }
      if (!this.autoReconnect) {
        this._setState("closed", { reason: ev.reason || `code ${ev.code}` });
        return;
      }
      if (wasConnected) this.emit("disconnected", { code: ev.code, reason: ev.reason });
      this._setState("reconnecting", { reason: ev.reason || `code ${ev.code}` });
      this._scheduleRetry();
    });

    ws.addEventListener("error", () => {
      // The close handler does the retry scheduling; errors are noisy otherwise.
    });
  }

  _scheduleRetry() {
    if (this._closedByUser || !this.autoReconnect) return;
    this._attempt++;
    const delay = Math.min(500 * 2 ** Math.min(this._attempt, 6), 20000);
    const jitter = Math.floor(Math.random() * 400);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._open(), delay + jitter);
  }

  close(reason = "closed by user") {
    this._closedByUser = true;
    clearTimeout(this._retryTimer);
    this._stopHeartbeat();
    this._pending.length = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, reason);
      } catch {}
      // Make sure a half-open socket can never keep the process alive.
      try {
        ws.addEventListener("close", () => {});
      } catch {}
    }
    this.peer = null;
    this.peers = [];
    this._setState("closed");
    this.emit("closed");
  }

  // ---------------------------------------------------------------- protocol

  _send(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  _onMessage(msg) {
    switch (msg.t) {
      case "welcome": {
        this.peer = msg.peer ?? null;
        this.peers = msg.peers ?? [];
        this.missed = Array.isArray(msg.missed) ? msg.missed : [];
        this.finished = msg.finished ?? null;
        this._attempt = 0;
        this._setState("connected");
        this._startHeartbeat();
        this.emit("welcome", { ...this.snapshot(), missed: this.missed });
        // Flush anything we tried to send while connecting.
        const queued = this._pending.splice(0);
        for (const item of queued) this._send(item);
        return;
      }
      case "peer": {
        const before = this.peer?.name ?? null;
        this.peer = msg.peer ?? null;
        const after = this.peer?.name ?? null;
        if (before !== after) {
          this.emit(after ? "peer-joined" : "peer-left", { peer: this.peer, ...this.snapshot() });
        }
        this.emit("status", this.snapshot());
        return;
      }
      case "say": {
        this.emit("message", {
          from: msg.from,
          id: msg.id,
          text: msg.text,
          meta: msg.meta ?? null,
          at: msg.at,
        });
        // Confirm receipt so the sender knows it landed and it won't be
        // replayed as "missed" after a reconnect.
        this._send({ t: "ack", id: msg.id });
        return;
      }
      case "update": {
        this.emit("update", { from: msg.from, text: msg.text, meta: msg.meta ?? null, at: msg.at });
        return;
      }
      case "ack": {
        this.emit("ack", { from: msg.from, id: msg.id, at: msg.at });
        return;
      }
      case "done": {
        if (msg.cleared) {
          this.finished = null;
          this.emit("reopened", { from: msg.from, at: msg.at });
          this.emit("status", this.snapshot());
          return;
        }
        const record = {
          by: msg.by === "user" ? "user" : "agent",
          from: msg.from,
          summary: typeof msg.summary === "string" ? msg.summary : "",
          at: msg.at,
        };
        this.finished = record;
        this.emit("done", { ...record, id: msg.id, mine: msg.from === this.name });
        this.emit("status", this.snapshot());
        return;
      }
      case "typing": {
        this.emit("typing", { from: msg.from, state: msg.state });
        return;
      }
      case "error": {
        const err = new Error(msg.message || "relay error");
        err.code = msg.code;
        this.emit("error", err);
        if (msg.code === "AUTH_FAILED" || msg.code === "VERSION" || msg.code === "BAD_HELLO") {
          // Retrying with the same credentials cannot help.
          this._closedByUser = true;
          this.state = "closed";
          this.emit("status", { ...this.snapshot(), error: err.message });
          try {
            this.ws?.close(1000, "fatal");
          } catch {}
        }
        return;
      }
      case "pong":
        this._lastPong = Date.now();
        return;
      default:
        return;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastPong = Date.now();
    this._heartbeat = setInterval(() => {
      if (!this._send({ t: "ping" })) return;
      // If the relay has been silent for too long, force a reconnect.
      if (Date.now() - (this._lastPong ?? 0) > 45000) {
        try {
          this.ws?.close(4001, "heartbeat timeout");
        } catch {}
      }
    }, 15000);
    this._heartbeat.unref?.();
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeat);
    this._heartbeat = null;
  }

  // ------------------------------------------------------------------ outbound

  /** Send a durable message to the peer. Returns the message id. */
  say(text, meta) {
    const id = newId("m", 8);
    const payload = { t: "say", id, text: String(text ?? ""), meta: meta ?? null };
    if (!this._send(payload)) this._pending.push(payload);
    return id;
  }

  /** Send a transient "live update" (supersedes the previous one). */
  update(text, meta) {
    const payload = { t: "update", text: String(text ?? ""), meta: meta ?? null };
    if (!this._send(payload)) this._pending.push(payload);
  }

  typing(state) {
    this._send({ t: "typing", state: state ? "on" : "off" });
  }

  /**
   * Declare the conversation finished. The relay records it and tells the peer,
   * which will then stop auto-replying.
   * @param {{summary?: string, by?: "agent"|"user"}} opts
   */
  declareDone({ summary = "", by = "agent" } = {}) {
    const id = "d" + Math.random().toString(36).slice(2, 10);
    this._send({ t: "done", id, summary: String(summary ?? ""), by });
    return id;
  }

  /** Undo a "done": both sides may talk again. */
  reopen() {
    this._send({ t: "reopen" });
  }

  /** Tell the relay we have handled these ids (so they aren't replayed). */
  ack(ids) {
    for (const id of [].concat(ids)) this._send({ t: "ack", id });
  }
}

/** Small helper so callers can validate a passphrase the same way everywhere. */
export function validatePassphrase(p) {
  if (typeof p !== "string" || p.length < LIMITS.passphraseMin) {
    return `Passphrase must be at least ${LIMITS.passphraseMin} characters.`;
  }
  return null;
}

export { tokensMatch, deriveRoom, PROTOCOL_VERSION, LIMITS, nowIso };
