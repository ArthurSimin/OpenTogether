// The relay: a tiny rendezvous server both machines connect to.
//
// It pairs exactly two peers per room, forwards messages, remembers what each
// peer has *not yet received* (so a brief disconnect doesn't lose a message),
// and expires idle rooms. It never stores passphrases: peers send an
// HMAC-derived token that identifies the room.

import http from "node:http";
import { acceptUpgrade } from "./ws.mjs";
import { Room, tokensMatch, PROTOCOL_VERSION, LIMITS, newMessageId } from "./protocol.mjs";

export function createRelay(options = {}) {
  const {
    port = 8787,
    hostname = "0.0.0.0",
    path = "/ot",
    log = () => {},
    maxRooms = 500,
    idleTimeoutMs = 30 * 60 * 1000,
    heartbeatMs = 15000,
  } = options;

  /** @type {Map<string, { room: Room, token: string, authToken: string }>} */
  const rooms = new Map();
  const wss = [];
  const stats = { connections: 0, messages: 0, startedAt: Date.now() };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "opentogether-relay",
          version: PROTOCOL_VERSION,
          rooms: rooms.size,
          connections: wss.length,
          uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
        }),
      );
      return;
    }
    if (url.pathname === "/" || url.pathname === "/info") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        [
          "OpenTogether relay is running.",
          "",
          `  WebSocket endpoint : ws://<this-host>:${port}${path}`,
          `  Rooms              : ${rooms.size}`,
          `  Live connections   : ${wss.length}`,
          "",
          "Point both OpenTogether apps at this URL and use the same passphrase.",
          "Give this machine's public IP/hostname to your friend, or tunnel port " + port + ".",
          "",
        ].join("\n"),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ws = acceptUpgrade(req, socket);
    if (!ws) return;
    wss.push(ws);
    stats.connections++;
    log(`connection from ${ws.remoteAddress}`);

    /** @type {{ roomKey: string, name: string } | null} */
    let membership = null;
    const helloTimer = setTimeout(() => {
      if (!membership) sendError(ws, "BAD_HELLO", "expected hello message");
      if (!membership) ws.close(4008, "no hello");
    }, 10000);
    helloTimer.unref?.();

    const sendError = (_ws, code, message) => {
      _ws.send(JSON.stringify({ t: "error", code, message }));
    };

    ws.on("message", (raw, type) => {
      if (type !== "text") return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return sendError(ws, "BAD_JSON", "invalid JSON");
      }

      if (msg.t === "ping") return void ws.send(JSON.stringify({ t: "pong" }));

      if (!membership) {
        if (msg.t !== "hello") return sendError(ws, "BAD_HELLO", "say hello first");
        return handleHello(ws, msg);
      }

      const entry = rooms.get(membership.roomKey);
      if (!entry) return sendError(ws, "NO_ROOM", "room no longer exists");
      const { room } = entry;
      const me = membership.name;
      room.touch();
      stats.messages++;

      switch (msg.t) {
        case "say":
        case "update":
          return handleOutbound(room, me, msg);
        case "ack": {
          if (typeof msg.id === "string" && msg.id.startsWith("m")) {
            room.markDelivered(msg.id, me);
            const sender = room.intray.find((x) => x.id === msg.id)?.from;
            const peer = sender ? room.peers.get(sender) : null;
            if (peer && !peer.ws.closed) {
              peer.ws.send(
                JSON.stringify({ t: "ack", from: me, id: msg.id, at: new Date().toISOString() }),
              );
            }
          }
          return;
        }
        case "typing": {
          const peer = room.peerOf(me);
          if (peer && !peer.ws.closed) {
            peer.ws.send(
              JSON.stringify({ t: "typing", from: me, state: msg.state === "on" ? "on" : "off" }),
            );
          }
          return;
        }
        case "done": {
          const summary = typeof msg.summary === "string" ? msg.summary : "";
          if (summary.length > LIMITS.text) {
            return sendError(ws, "TOO_LONG", "summary is too long");
          }
          const by = msg.by === "user" ? "user" : "agent";
          // Declaring done again just replaces the declaration (idempotent).
          const record = room.declareDone({ from: me, by, summary });
          const wire = {
            t: "done",
            id: typeof msg.id === "string" ? msg.id : newMessageId(),
            from: me,
            by: record.by,
            summary: record.summary,
            at: record.at,
          };
          // Back to the declarer too, so both sides converge on one record.
          ws.send(JSON.stringify(wire));
          const peer = room.peerOf(me);
          if (peer && !peer.ws.closed) peer.ws.send(JSON.stringify(wire));
          log(`room ${membership.roomKey.slice(0, 6)}…: ${me} declared DONE (${record.by})`);
          return;
        }
        case "reopen": {
          room.reopen();
          const wire = { t: "done", from: me, cleared: true, at: new Date().toISOString() };
          ws.send(JSON.stringify(wire));
          const peer = room.peerOf(me);
          if (peer && !peer.ws.closed) peer.ws.send(JSON.stringify(wire));
          log(`room ${membership.roomKey.slice(0, 6)}…: ${me} reopened the conversation`);
          return;
        }
        default:
          return sendError(ws, "BAD_TYPE", `unknown message type "${msg.t}"`);
      }
    });

    function handleHello(ws, msg) {
      clearTimeout(helloTimer);
      if (msg.version !== PROTOCOL_VERSION) {
        return sendError(ws, "VERSION", `protocol mismatch (relay=${PROTOCOL_VERSION})`);
      }
      const role = msg.role;
      if (role !== "host" && role !== "guest") {
        return sendError(ws, "BAD_HELLO", 'role must be "host" or "guest"');
      }
      if (typeof msg.room !== "string" || !msg.room) {
        return sendError(ws, "BAD_HELLO", "missing room");
      }
      if (typeof msg.token !== "string" || !msg.token) {
        return sendError(ws, "BAD_HELLO", "missing token");
      }
      const name = sanitize(msg.name);
      if (!name) return sendError(ws, "BAD_HELLO", "missing name");

      let entry = rooms.get(msg.room);
      if (!entry) {
        if (rooms.size >= maxRooms) {
          return sendError(ws, "BUSY", "relay is at capacity, try again later");
        }
        entry = { token: msg.token, room: new Room({ idleTimeoutMs }) };
        rooms.set(msg.room, entry);
        log(`room created ${msg.room.slice(0, 6)}… by ${name}`);
      } else if (!tokensMatch(entry.token, msg.token)) {
        log(`AUTH FAILED for room ${msg.room.slice(0, 6)}… from ${ws.remoteAddress}`);
        return sendError(ws, "AUTH_FAILED", "wrong passphrase or room name");
      }

      const room = entry.room;
      // Enforce a hard cap of two peers.
      if (!room.peers.has(name) && room.size >= 2) {
        return sendError(ws, "ROOM_FULL", "this room already has two people in it");
      }

      membership = { roomKey: msg.room, name };
      room.addPeer(name, role, ws);

      const peer = room.peerOf(name);
      ws.send(
        JSON.stringify({
          t: "welcome",
          room: msg.room,
          you: { name, role },
          peer: peer ? { name: peer.name, role: peer.role, since: peer.since } : null,
          peers: [...room.peers.entries()].map(([n, i]) => ({ name: n, role: i.role, since: i.since })),
          missed: room.missedFor(name),
          finished: room.finished,
        }),
      );

      // Tell the other peer.
      if (peer && !peer.ws.closed) {
        peer.ws.send(
          JSON.stringify({
            t: "peer",
            peer: { name, role, since: room.peers.get(name).since },
          }),
        );
      }
      log(`room ${msg.room.slice(0, 6)}…: ${name} (${role}) online, ${room.size} peer(s)`);
    }

    function handleOutbound(room, me, msg) {
      if (typeof msg.text !== "string") return sendError(ws, "BAD_MESSAGE", "text must be a string");
      if (msg.text.length > LIMITS.text) {
        return sendError(ws, "TOO_LONG", `message exceeds ${LIMITS.text} characters`);
      }
      let meta = msg.meta ?? null;
      if (meta && JSON.stringify(meta).length > LIMITS.meta) meta = { truncated: true };

      const peer = room.peerOf(me);
      if (msg.t === "update") {
        room.updates.set(me, { text: msg.text, meta, at: new Date().toISOString() });
        if (peer && !peer.ws.closed) {
          peer.ws.send(
            JSON.stringify({ t: "update", from: me, text: msg.text, meta, at: new Date().toISOString() }),
          );
        }
        return;
      }

      if (typeof msg.id !== "string" || !msg.id.startsWith("m") || msg.id.length > 40) {
        return sendError(ws, "BAD_MESSAGE", "say requires an id");
      }
      if (room.intray.some((m) => m.id === msg.id)) return; // duplicate

      const entry = {
        id: msg.id,
        from: me,
        text: msg.text,
        meta,
        at: new Date().toISOString(),
        deliveredTo: new Set(),
      };
      room.record(entry);
      if (peer && !peer.ws.closed) {
        const { deliveredTo, ...wire } = entry;
        peer.ws.send(JSON.stringify({ t: "say", from: me, ...wire }));
      }
    }

    ws.on("close", (code, reason) => {
      clearTimeout(helloTimer);
      const idx = wss.indexOf(ws);
      if (idx >= 0) wss.splice(idx, 1);
      if (!membership) return;
      const entry = rooms.get(membership.roomKey);
      if (!entry) return;
      entry.room.removePeer(membership.name, ws);
      const peer = entry.room.peerOf(membership.name);
      if (peer && !peer.ws.closed) peer.ws.send(JSON.stringify({ t: "peer", peer: null }));
      log(`room ${membership.roomKey.slice(0, 6)}…: ${membership.name} offline (${code})`);
    });

    ws.on("error", () => {});
  });

  // Heartbeat: ping every live socket, drop the ones that stopped answering.
  const heartbeat = setInterval(() => {
    for (const ws of [...wss]) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  // Reap empty rooms after their idle timeout.
  const reaper = setInterval(() => {
    for (const [key, entry] of rooms) {
      if (entry.room.size === 0 && entry.room.idleFor > idleTimeoutMs) {
        rooms.delete(key);
        log(`room ${key.slice(0, 6)}… expired`);
      }
    }
  }, Math.min(60000, idleTimeoutMs));
  reaper.unref?.();

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`port ${port} is already in use`);
    } else {
      log(`relay error: ${err.message}`);
    }
  });

  return {
    server,
    stats,
    get roomCount() {
      return rooms.size;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, hostname, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(reaper);
      for (const ws of [...wss]) ws.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function sanitize(name) {
  return String(name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9 _.\-]/g, "")
    .slice(0, LIMITS.name);
}
