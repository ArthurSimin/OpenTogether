// Integration test for relay + connectors. Run with: node test/relay.test.mjs
import assert from "node:assert/strict";
import { createRelay } from "../src/relay.mjs";
import { Connector, deriveRoom } from "../src/connector.mjs";

const PASSPHRASE = "correct horse battery staple";
const log = (...a) => process.env.VERBOSE && console.log(...a);

function once(emitter, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeout);
    emitter.once(event, (v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

/** Connect raw and send a hello with an arbitrary token; return the error code. */
function rawHelloExpectError(url, room, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error("timeout")), 4000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ t: "hello", room, name: "Raw", role: "guest", token, version: 1 })),
    );
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === "error") {
        clearTimeout(t);
        ws.close();
        resolve(msg.code);
      }
    });
    ws.addEventListener("error", reject);
  });
}

async function main() {
  const relay = createRelay({ port: 0, hostname: "127.0.0.1", log });
  const addr = await relay.listen();
  const url = `ws://127.0.0.1:${addr.port}/ot`;
  console.log("relay on", url);

  // ---- 1. wrong passphrase does not let you into someone else's room, and
  //         a mismatched token against an existing room is rejected.
  {
    const host = new Connector({
      relayUrl: url,
      passphrase: PASSPHRASE,
      name: "Host",
      role: "host",
      autoReconnect: false,
    });
    host.connect();
    await once(host, "welcome");

    // A different passphrase lands in a *different* room — never sees the host.
    const wrong = new Connector({
      relayUrl: url,
      passphrase: "a completely different one",
      name: "Intruder",
      role: "guest",
      autoReconnect: false,
    });
    const wrongWelcome = once(wrong, "welcome");
    wrong.connect();
    const ww = await wrongWelcome;
    assert.equal(ww.peer, null, "wrong passphrase must not be paired with host");
    console.log("   ✓ wrong passphrase lands in a separate room (no leak)");
    wrong.close();

    // Raw token mismatch against the existing room is rejected outright.
    const errCode = await rawHelloExpectError(url, host.room, "bogus-token");
    assert.equal(errCode, "AUTH_FAILED");
    console.log("   ✓ mismatched room token rejected:", errCode);

    host.close();
    await new Promise((r) => setTimeout(r, 200));
  }

  // ---- 2. normal message flow, typing, ack, update
  const host = new Connector({ relayUrl: url, passphrase: PASSPHRASE, name: "Arthur", role: "host" });
  const guest = new Connector({ relayUrl: url, passphrase: PASSPHRASE, name: "Friend", role: "guest" });
  host.connect();
  await once(host, "welcome");
  const peerJoined = once(host, "peer-joined");
  guest.connect();
  await once(guest, "welcome");
  const joined = await peerJoined;
  console.log("   ✓ peers paired:", joined.peer.name);
  assert.equal(joined.peer.name, "Friend");

  assert.equal(host.peerOnline, true);
  assert.equal(guest.peerOnline, true);

  // message host -> guest
  const gotMsg = once(guest, "message");
  const ackedP = once(host, "ack");
  const id = host.say("hey, your app crashes on startup", { kind: "user" });
  const msg = await gotMsg;
  assert.equal(msg.text, "hey, your app crashes on startup");
  assert.equal(msg.from, "Arthur");
  assert.equal(msg.meta.kind, "user");
  const ack = await ackedP;
  assert.equal(ack.id, id);
  console.log("   ✓ message delivered + acked");

  // typing
  const typingP = once(host, "typing");
  guest.typing(true);
  const typing = await typingP;
  assert.equal(typing.state, "on");
  console.log("   ✓ typing indicator");

  // update (transient)
  const updateP = once(guest, "update");
  host.update("checking logs…");
  const upd = await updateP;
  assert.equal(upd.text, "checking logs…");
  console.log("   ✓ live update");

  // ---- 3. missed messages survive a disconnect
  const guestWasOffline = once(guest, "closed");
  guest.close("simulating network drop");
  await guestWasOffline;
  // host sends while guest is gone
  const offlineId = host.say("this message was sent while you were offline");
  // bring the guest back (same identity => same room)
  const guest2 = new Connector({
    relayUrl: url,
    passphrase: PASSPHRASE,
    name: "Friend",
    role: "guest",
  });
  const welcomeP = once(guest2, "welcome");
  guest2.connect();
  const welcome = await welcomeP;
  const missedIds = welcome.missed.map((m) => m.id);
  console.log("   ✓ missed replay:", welcome.missed.length, "message(s)");
  assert.ok(missedIds.includes(offlineId), "offline message should be replayed");
  assert.equal(welcome.peer.name, "Arthur");
  const replayed = welcome.missed.find((m) => m.id === offlineId);
  guest2.ack([offlineId]);
  await new Promise((r) => setTimeout(r, 100));

  // ---- 4. room cap
  {
    const third = new Connector({
      relayUrl: url,
      passphrase: PASSPHRASE,
      name: "Third",
      role: "guest",
      autoReconnect: false,
    });
    const errP = once(third, "error");
    third.connect();
    const err = await errP;
    assert.equal(err.code, "ROOM_FULL");
    console.log("   ✓ third peer rejected:", err.code);
    third.close();
  }

  // ---- 5. room derivation is stable + distinct
  const a = deriveRoom(PASSPHRASE, "default");
  const b = deriveRoom(PASSPHRASE, "default");
  const c = deriveRoom(PASSPHRASE, "other");
  assert.deepEqual(a, b);
  assert.notEqual(a.room, c.room);
  assert.notEqual(a.token, c.token);
  console.log("   ✓ passphrase/room derivation");

  host.close();
  guest2.close();
  await relay.close();
  console.log("\nALL RELAY TESTS PASSED");
}

main().catch((err) => {
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
