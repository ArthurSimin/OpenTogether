// Wire protocol shared by the relay and the two connectors.
//
// Everything travels over one WebSocket. Messages are JSON:
//
//   client -> relay   { t: "hello", room, name, role, token, version }
//                     { t: "say",    id, text, meta }     a message to the peer
//                     { t: "update", text, meta }         supersede my last update
//                     { t: "ack",    id }                 "I received message <id>"
//                     { t: "done",   id, summary, reason, by }  "we're finished"
//                     { t: "typing", state }              {state:"on"|"off"}
//                     { t: "ping" }
//   relay -> client   { t: "welcome", room, you, peer, peers, missed, intray, finished }
//                     { t: "peer",  peer }                peer joined / left / changed
//                     { t: "say",    from, id, text, meta, at }
//                     { t: "update", from, text, meta, at }
//                     { t: "ack",    from, id, at }
//                     { t: "done",   from, id, summary, reason, by, at }
//                     { t: "typing", from, state }
//                     { t: "error",  code, message }
//                     { t: "pong" }
//
// Auth is a symmetric shared secret: both sides derive the room id and the
// auth token from the same passphrase + room name. The relay therefore only
// ever sees an HMAC-derived token, never the passphrase itself.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  text: 16 * 1024, // chars per message
  meta: 4 * 1024, // chars of serialized meta
  name: 32,
  roomName: 64,
  passphraseMin: 12,
};

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** Derive the room id and the auth token from passphrase + room name. */
export function deriveRoom(passphrase, roomName = "default") {
  const roomRaw = createHmac("sha256", passphrase).update("room:" + roomName).digest();
  const tokenRaw = createHmac("sha256", passphrase).update("token:" + roomName).digest();
  return {
    room: b64url(roomRaw).slice(0, 24),
    token: b64url(tokenRaw),
  };
}

export function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export const ROLES = ["host", "guest"];

/** Where a "done" declaration can come from. */
export const DONE_BY = ["agent", "user"];

export function newMessageId() {
  return "m" + randomBytes(8).toString("hex");
}

/**
 * A room holds at most two peers. It also keeps:
 *  - `intray`: the last few messages received, so a peer that was offline
 *    briefly can be told what it missed (and mark them delivered).
 *  - `updates`: at most one "live update" per sender (they supersede).
 */
export class Room {
  constructor({ intrayLimit = 200, idleTimeoutMs = 30 * 60 * 1000 } = {}) {
    this.peers = new Map(); // name -> { ws, role, since }
    this.intray = []; // [{ id, from, text, meta, at, deliveredTo:Set<string> }]
    this.updates = new Map(); // from -> { text, meta, at }
    this.intrayLimit = intrayLimit;
    this.idleTimeoutMs = idleTimeoutMs;
    this.lastActivity = Date.now();
    this.createdAt = Date.now();

    // The "we're finished" declaration. Once set, the relay tells any
    // reconnecting peer about it, so a restart doesn't silently resume
    // a conversation that was already over.
    // { from, by, summary, at } | null
    this.finished = null;
  }

  /** Mark the conversation done. Returns the recorded declaration. */
  declareDone({ from, by = "agent", summary = "" }) {
    this.finished = {
      from,
      by: DONE_BY.includes(by) ? by : "agent",
      summary: String(summary ?? "").slice(0, 2000),
      at: new Date().toISOString(),
    };
    this.touch();
    return this.finished;
  }

  /** Clear the finished state so the pair can talk again. */
  reopen() {
    this.finished = null;
    this.touch();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  get idleFor() {
    return Date.now() - this.lastActivity;
  }

  get size() {
    return this.peers.size;
  }

  addPeer(name, role, ws) {
    const existing = this.peers.get(name);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4000, "replaced by new connection");
      } catch {}
    }
    this.peers.set(name, { ws, role, since: Date.now() });
    this.touch();
  }

  removePeer(name, ws) {
    const cur = this.peers.get(name);
    if (cur && cur.ws === ws) this.peers.delete(name);
    this.touch();
  }

  peerOf(name) {
    for (const [peerName, info] of this.peers) {
      if (peerName !== name) return { name: peerName, role: info.role, since: info.since, ws: info.ws };
    }
    return null;
  }

  record(message) {
    this.intray.push(message);
    if (this.intray.length > this.intrayLimit) {
      this.intray.splice(0, this.intray.length - this.intrayLimit);
    }
    this.touch();
  }

  markDelivered(id, peerName) {
    const m = this.intray.find((x) => x.id === id);
    if (m) m.deliveredTo.add(peerName);
    this.touch();
  }

  /** Messages addressed *to* `viewer` that it has never been told about. */
  missedFor(viewer) {
    return this.intray
      .filter((m) => m.from !== viewer && !m.deliveredTo.has(viewer))
      .map((m) => ({ from: m.from, id: m.id, text: m.text, meta: m.meta, at: m.at }));
  }
}
