// Portable, dependency-free WebSocket framing (RFC 6455).
//
// Node 21+ ships a global WebSocket *client* but not a server, and we do not
// want to make people `npm install` before they can debug their broken app.
// So this file implements just enough of RFC 6455 for our own relay:
// handshake, text/binary frames, fragmentation, ping/pong, close.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const MAX_MESSAGE_BYTES = 1 << 20; // 1 MiB is plenty for chat-sized frames

export function acceptKey(key) {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

/**
 * Upgrade an IncomingMessage into a WebSocket connection.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:net").Socket} socket
 * @returns {WebSocketConnection}
 */
export function acceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  if (!key || version !== "13") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }

  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ];
  const protocol = req.headers["sec-websocket-protocol"];
  if (protocol) headers.push(`Sec-WebSocket-Protocol: ${String(protocol).split(",")[0].trim()}`);
  socket.write(headers.join("\r\n") + "\r\n\r\n");

  return new WebSocketConnection(socket);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.isAlive = true;
    this.closed = false;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;
    this._fragmentSize = 0;
    this.remoteAddress = socket.remoteAddress;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._finish(1006, "socket closed"));
    socket.on("error", (err) => {
      this.emit("error", err);
      this._finish(1006, "socket error");
    });
    socket.on("end", () => this._finish(1000, "socket ended"));
  }

  _onData(chunk) {
    if (this.closed) return;
    this.isAlive = true;
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    while (this._readFrame()) {
      /* keep parsing */
    }
  }

  _readFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return false;

    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    if (rsv !== 0) {
      this.close(1002, "RSV bits set");
      return false;
    }
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return false;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return false;
      const hi = buf.readUInt32BE(offset);
      const lo = buf.readUInt32BE(offset + 4);
      if (hi > 0) {
        this.close(1009, "frame too large");
        return false;
      }
      length = lo;
      offset += 8;
    }

    if (!masked) {
      // Clients MUST mask frames.
      this.close(1002, "unmasked client frame");
      return false;
    }
    if (buf.length < offset + 4) return false;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + length) return false;

    const payload = Buffer.from(buf.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this._buffer = buf.subarray(offset + length);
    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP.PING:
        this._writeFrame(OP.PONG, payload);
        return;
      case OP.PONG:
        this.isAlive = true;
        this.emit("pong");
        return;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        this._writeFrame(OP.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        this._finish(code, reason);
        return;
      }
      case OP.CONT: {
        if (this._fragmentOpcode === null) {
          this.close(1002, "unexpected continuation");
          return;
        }
        this._fragmentSize += payload.length;
        if (this._fragmentSize > MAX_MESSAGE_BYTES) {
          this.close(1009, "message too large");
          return;
        }
        this._fragments.push(payload);
        if (fin) this._deliver(this._fragmentOpcode, Buffer.concat(this._fragments));
        return;
      }
      case OP.TEXT:
      case OP.BINARY: {
        if (!fin) {
          this._fragmentOpcode = opcode;
          this._fragments = [payload];
          this._fragmentSize = payload.length;
          return;
        }
        this._deliver(opcode, payload);
        return;
      }
      default:
        this.close(1002, `unknown opcode ${opcode}`);
    }
  }

  _deliver(opcode, payload) {
    const type = opcode === OP.TEXT ? "text" : "binary";
    this._fragmentOpcode = null;
    this._fragments = [];
    this._fragmentSize = 0;
    this.emit("message", type === "text" ? payload.toString("utf8") : payload, type);
  }

  _writeFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      this.emit("error", err);
    }
  }

  send(data) {
    if (this.closed) return false;
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    if (buf.length > MAX_MESSAGE_BYTES) {
      this.close(1009, "message too large");
      return false;
    }
    this._writeFrame(typeof data === "string" ? OP.TEXT : OP.BINARY, buf);
    return true;
  }

  ping() {
    this._writeFrame(OP.PING, Buffer.from(randomBytes(4)));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), "utf8");
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._writeFrame(OP.CLOSE, payload);
    this._finish(code, reason);
  }

  terminate() {
    try {
      this.socket.destroy();
    } catch {}
    this._finish(1006, "terminated");
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this._buffer = Buffer.alloc(0);
    try {
      this.socket.end();
    } catch {}
    this.emit("close", code, reason);
  }
}
