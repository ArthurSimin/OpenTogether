// Loop-protection test: two agents that always reply must NOT talk forever.
//
// This reproduces the runaway loop we saw in manual testing, where the mock
// agent echoed the same sentence back on every turn. Run: node test/loop.test.mjs

import assert from "node:assert/strict";
import { createRelay } from "../src/relay.mjs";
import { Connector } from "../src/connector.mjs";
import { AgentBridge } from "../src/bridge.mjs";
import { OpenCodeClient } from "../src/opencode-client.mjs";
import { createMockOpencode } from "./mock-opencode.mjs";

const PASSPHRASE = "loop protection passphrase";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, label = "condition" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function machine({ name, role, relayUrl, reply, log, config = {} }) {
  const mock = createMockOpencode({ reply });
  const addr = await mock.listen();
  const oc = new OpenCodeClient({ serverUrl: `http://127.0.0.1:${addr.port}` });
  const connector = new Connector({ relayUrl, passphrase: PASSPHRASE, name, role });
  const bridge = new AgentBridge({
    opencode: oc,
    connector,
    config: { autoRespond: true, replyTimeoutMs: 8000, ...config },
    log,
  });
  await bridge.start();
  return { mock, oc, connector, bridge };
}

async function main() {
  const relay = createRelay({ port: 0, hostname: "127.0.0.1" });
  const addr = await relay.listen();
  const relayUrl = `ws://127.0.0.1:${addr.port}/ot`;
  const quiet = () => {};

  // ---- Case A: both agents always say the SAME thing (the loop we reproduced)
  {
    const echo = () => "I am on Linux and the error is ENOENT config.json";
    const a = await machine({ name: "A", role: "host", relayUrl, reply: echo, log: quiet });
    const b = await machine({ name: "B", role: "guest", relayUrl, reply: echo, log: quiet });
    await waitFor(() => a.connector.peerOnline && b.connector.peerOnline, { label: "paired" });

    a.connector.say("hello, let's debug", { kind: "agent", from: "A", hops: 1 });

    // Let it churn for a while — without brakes this was dozens of turns.
    await sleep(7000);

    const totalTurns = a.mock.state.assistantTurns.length + b.mock.state.assistantTurns.length;
    console.log(`   · total agent turns: ${totalTurns} (A=${a.mock.state.assistantTurns.length}, B=${b.mock.state.assistantTurns.length})`);
    assert.ok(totalTurns > 0, "there should be at least some back-and-forth");
    assert.ok(totalTurns < 12, `loop should be stopped, got ${totalTurns} turns`);
    const stopped = a.bridge._suppressed + b.bridge._suppressed;
    assert.ok(stopped > 0, "loop protection should have tripped");
    console.log(`   ✓ identical-reply loop stopped after ${totalTurns} turns (${stopped} suppressed)`);

    a.bridge.stop();
    b.bridge.stop();
    await a.mock.close();
    await b.mock.close();
  }

  // ---- Case B: hop counter alone stops an alternating conversation
  {
    let n = 0;
    const a = await machine({
      name: "A2",
      role: "host",
      relayUrl,
      reply: () => `turn ${++n} from A`,
      log: quiet,
      config: { maxHops: 4, turnBudget: 999 },
    });
    const b = await machine({
      name: "B2",
      role: "guest",
      relayUrl,
      reply: () => `turn ${++n} from B`,
      log: quiet,
      config: { maxHops: 4, turnBudget: 999 },
    });
    await waitFor(() => a.connector.peerOnline && b.connector.peerOnline, { label: "paired 2" });

    let stoppedEvent = null;
    a.bridge.on("loop-stopped", (e) => (stoppedEvent = e));
    b.bridge.on("loop-stopped", (e) => (stoppedEvent = stoppedEvent ?? e));

    a.connector.say("start", { kind: "agent", from: "A2", hops: 1 });
    await waitFor(() => !!stoppedEvent, { label: "hop limit hit" });
    console.log(`   ✓ hop limit tripped: ${JSON.stringify(stoppedEvent)}`);

    const total = a.mock.state.assistantTurns.length + b.mock.state.assistantTurns.length;
    assert.ok(total <= 8, `should stop near the hop limit, got ${total} turns`);
    console.log(`   ✓ conversation bounded at ${total} turns`);

    a.bridge.stop();
    b.bridge.stop();
    await a.mock.close();
    await b.mock.close();
  }

  // ---- Case C: a human speaking resets the brakes
  {
    const a = await machine({
      name: "A3",
      role: "host",
      relayUrl,
      reply: () => "ok",
      log: quiet,
      config: { maxHops: 2, turnBudget: 1 },
    });
    await machine({ name: "B3", role: "guest", relayUrl, reply: () => "ok", log: quiet }).then((m) => {
      a.b2 = m;
    });
    await waitFor(() => a.connector.peerOnline, { label: "paired 3" });
    a.bridge._window = [Date.now(), Date.now(), Date.now()]; // pretend budget is gone
    assert.equal(a.bridge._turnBudgetLeft() <= 0, true);
    await a.bridge.sendFromUser("I'll take it from here");
    assert.equal(a.bridge._turnBudgetLeft(), 1, "human message should reset the budget");
    console.log("   ✓ a human message resets the loop brakes");

    a.bridge.stop();
    a.b2.bridge.stop();
    await a.mock.close();
    await a.b2.mock.close();
  }

  await relay.close();
  console.log("\nALL LOOP TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nLOOP TEST FAILED:", e);
  process.exit(1);
});
