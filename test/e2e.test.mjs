// End-to-end test: two "computers", each with a mock OpenCode server, a
// connector and an AgentBridge, talking through one relay.
//
// Run: node test/e2e.test.mjs

import assert from "node:assert/strict";
import { createRelay } from "../src/relay.mjs";
import { Connector } from "../src/connector.mjs";
import { AgentBridge } from "../src/bridge.mjs";
import { OpenCodeClient } from "../src/opencode-client.mjs";
import { createMockOpencode } from "./mock-opencode.mjs";

const PASSPHRASE = "super secret debug passphrase";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, interval = 100, label = "condition" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function makeMachine({ name, role, relayUrl, reply, log }) {
  const mock = createMockOpencode({ reply });
  const addr = await mock.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const oc = new OpenCodeClient({ serverUrl: base });
  const connector = new Connector({ relayUrl, passphrase: PASSPHRASE, name, role });
  const config = {
    autoRespond: true,
    forwardLocalUserMessages: true,
    replyTimeoutMs: 10000,
  };
  const bridge = new AgentBridge({ opencode: oc, connector, config, log });
  await bridge.start();
  return { name, mock, oc, connector, bridge, config };
}

async function main() {
  const relay = createRelay({ port: 0, hostname: "127.0.0.1", path: "/ot" });
  const raddr = await relay.listen();
  const relayUrl = `ws://127.0.0.1:${raddr.port}/ot`;
  const quiet = () => {};

  // ---- Host machine: its agent knows how to fix things.
  const me = await makeMachine({
    name: "Arthur",
    role: "host",
    relayUrl,
    log: quiet,
    reply: (prompt) => {
      // If asked about the peer's message, answer like a debugging partner.
      if (prompt.includes("kind=FROM")) {
        return "Bro, that error means the config path is wrong. Ask your user to run `which node` and tell me the output.";
      }
      return "ack";
    },
  });

  // ---- Guest machine: the friend with the bugged app.
  const friend = await makeMachine({
    name: "Friend",
    role: "guest",
    relayUrl,
    log: quiet,
    reply: (prompt) => {
      if (prompt.includes("kind=FROM")) {
        return "My user ran `which node` and got /usr/local/bin/node. Also the app crashes with ENOENT on config.json.";
      }
      return "got it";
    },
  });

  await waitFor(() => me.connector.peerOnline && friend.connector.peerOnline, {
    label: "both peers paired",
  });
  console.log("   ✓ both machines paired through the relay");
  assert.equal(me.connector.peer.name, "Friend");
  assert.equal(friend.connector.peer.name, "Arthur");

  // ===================== SCENARIO 1: friend's agent asks my agent ==========
  // Simulate the friend's agent sending a message (as bridge would on outbound).
  const friendSaid = friend.connector.say("Hey, your app crashes on my PC with ENOENT config.json", {
    kind: "agent",
    from: "Friend",
  });
  console.log("   · friend agent -> me:", friendSaid);

  // My agent must receive it, be woken, and reply back to the friend.
  await waitFor(() => me.bridge.stats.outbound >= 1, { label: "my agent replied", timeout: 20000 });
  const myReplyMsg = me.mock.state.assistantTurns.find((t) => t.text.includes("which node"));
  assert.ok(myReplyMsg, "my agent's reply should contain its debugging instructions");
  console.log("   ✓ my agent received the message and composed a reply");

  // The friend's bridge should have mirrored my reply into its own session.
  await waitFor(
    () =>
      friend.mock.state.noReplyCount >= 1 &&
      friend.mock.sessions.size > 0 &&
      [...friend.mock.sessions.values()].some((s) =>
        s.messages.some((m) =>
          m.parts.some((p) => p.type === "text" && p.text.includes("which node")),
        ),
      ),
    { label: "friend agent mirrored my reply", timeout: 20000 },
  );
  console.log("   ✓ my reply reached the friend's agent as conversation history");

  // And the friend's agent should have responded back (its own outbound).
  await waitFor(() => friend.bridge.stats.outbound >= 1, {
    label: "friend agent replied back",
    timeout: 20000,
  });
  await waitFor(
    () =>
      [...me.mock.sessions.values()].some((s) =>
        s.messages.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("ENOENT"))),
      ),
    { label: "friend's answer reached my agent", timeout: 20000 },
  );
  console.log("   ✓ friend's answer came back to my agent (full round trip!)");

  // ===================== SCENARIO 2: my user talks to friend agent =========
  const beforeForward = friend.bridge.stats.inbound;
  me.bridge.addParticipating(me.bridge.linkSessionID);
  // Simulate the user typing in the link session.
  await me.oc.prompt(me.bridge.linkSessionID, "Please check if their node version is too old", {
    // our mock will run the local agent too; that's fine
  });
  await waitFor(() => friend.bridge.stats.inbound > beforeForward, {
    label: "friend received my user's message",
    timeout: 15000,
  });
  const mirrored = [...friend.mock.sessions.values()]
    .flatMap((s) => s.messages)
    .some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("node version is too old")));
  assert.ok(mirrored, "user message forwarded to friend agent");
  console.log("   ✓ my user's message was forwarded to the friend's agent");

  // ===================== SCENARIO 3: secrets are scrubbed ==================
  me.connector.say("my key is sk-live-ABCDEFGHIJKLMNOP1234567890 and OPENAI_API_KEY=abc123def456", {
    kind: "agent",
  });
  await waitFor(
    () =>
      [...friend.mock.sessions.values()]
        .flatMap((s) => s.messages)
        .some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("my key is"))),
    { label: "secret-bearing message arrives", timeout: 15000 },
  );
  const mirroredTexts = [...friend.mock.sessions.values()]
    .flatMap((s) => s.messages)
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text")
    .map((p) => p.text);
  const leakedKey = mirroredTexts.some((t) => t.includes("sk-live-ABCDEFGHIJKLMNOP1234567890"));
  const leakedEnv = mirroredTexts.some((t) => t.includes("abc123def456"));
  assert.equal(leakedKey, false, "API key must be redacted before reaching the other machine");
  assert.equal(leakedEnv, false, "env-style secret must be redacted");
  assert.ok(
    mirroredTexts.some((t) => t.includes("[REDACTED")),
    "redaction marker should be present",
  );
  console.log("   ✓ secrets redacted before crossing the machine boundary");

  // ===================== SCENARIO 4: offline delivery ======================
  const missedBefore = friend.bridge.stats.inbound;
  friend.connector.close("simulating wifi drop");
  await sleep(300);
  assert.equal(friend.connector.peerOnline, false);
  me.connector.say("this arrived while you were offline", { kind: "agent" });
  await sleep(200);
  const friend2 = new Connector({
    relayUrl,
    passphrase: PASSPHRASE,
    name: "Friend",
    role: "guest",
  });
  const welcome = new Promise((resolve) => friend2.once("welcome", resolve));
  // point the existing bridge at the new connector
  friend.bridge.connector = friend2;
  friend2.on("message", (m) => friend.bridge._onPeerMessage(m));
  friend2.on("welcome", (w) => {
    for (const m of w.missed ?? []) friend.bridge._onPeerMessage(m, { replayed: true });
  });
  friend2.connect();
  const w = await welcome;
  assert.ok(w.missed.some((m) => m.text.includes("while you were offline")), "offline message replayed");
  await waitFor(() => friend.bridge.stats.inbound > missedBefore, { label: "replayed message handled" });
  console.log("   ✓ message sent while offline was delivered on reconnect");

  // ===================== teardown =========================================
  me.bridge.stop();
  friend.bridge.stop();
  friend2.close();
  await me.mock.close();
  await friend.mock.close();
  await relay.close();
  console.log("\nALL E2E TESTS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nE2E TEST FAILED:", err);
  process.exit(1);
});
