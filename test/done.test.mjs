// "Done" test: an agent can declare the shared task finished. When it does,
// the peer is alerted and BOTH agents stop auto-replying. A human message
// reopens the conversation.
//
// Run: node test/done.test.mjs

import assert from "node:assert/strict";
import { createRelay } from "../src/relay.mjs";
import { Connector } from "../src/connector.mjs";
import { AgentBridge, parseFinalDeclaration } from "../src/bridge.mjs";
import { OpenCodeClient } from "../src/opencode-client.mjs";
import { createMockOpencode } from "./mock-opencode.mjs";

const PASSPHRASE = "the task is done passphrase";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, label = "condition" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function machine({ name, role, relayUrl, reply, log, passphrase = PASSPHRASE }) {
  const mock = createMockOpencode({ reply });
  const addr = await mock.listen();
  const oc = new OpenCodeClient({ serverUrl: `http://127.0.0.1:${addr.port}` });
  const connector = new Connector({ relayUrl, passphrase, name, role });
  const bridge = new AgentBridge({
    opencode: oc,
    connector,
    config: { autoRespond: true, replyTimeoutMs: 8000 },
    log,
  });
  await bridge.start();
  return { mock, oc, connector, bridge };
}

async function main() {
  const quiet = () => {};

  // ---- unit: the FINAL marker parser (incl. forgiving variants) ----------
  {
    assert.equal(parseFinalDeclaration("nothing here"), null);
    const a = parseFinalDeclaration("All done.\n[[OT:BEGIN kind=FINAL]]\nThe bug was a wrong config path.\n[[OT:END]]");
    assert.ok(a && a.done, "should detect FINAL");
    assert.ok(a.summary.includes("wrong config path"), "summary should be captured");
    const b = parseFinalDeclaration("[[OT:BEGIN kind=FINAL]]no end tag, summary here");
    assert.ok(b && b.summary.includes("summary here"), "summary without END tag");
    const c = parseFinalDeclaration("[[OT:BEGIN kind=FINAL]]");
    assert.ok(c && c.done && c.summary === "", "bare FINAL with no summary");
    console.log("   ✓ parseFinalDeclaration handles FINAL marker variants");
  }

  const relay = createRelay({ port: 0, hostname: "127.0.0.1" });
  const addr = await relay.listen();
  const relayUrl = `ws://127.0.0.1:${addr.port}/ot`;

  // ---- case: agent FINAL stops both sides and alerts the peer ------------
  {
    // A's agent declares FINAL as soon as it sees a peer message.
    const a = await machine({
      name: "A",
      role: "host",
      relayUrl,
      log: quiet,
      reply: () =>
        "Verified on this machine; the fix works.\n[[OT:BEGIN kind=FINAL]]\nRoot cause: config.json was read from the wrong cwd. Fixed by resolving it relative to the app dir.\n[[OT:END]]",
    });
    // B's agent always replies — it must be told to stop.
    const b = await machine({
      name: "B",
      role: "guest",
      relayUrl,
      log: quiet,
      reply: () => "Still debugging here",
    });
    await waitFor(() => a.connector.peerOnline && b.connector.peerOnline, { label: "A/B paired" });

    let peerSawFinished = null;
    b.bridge.on("finished", (rec) => (peerSawFinished = rec));

    // B's agent talks first; A's agent answers with FINAL.
    b.connector.say("can you confirm the fix on your side?", { kind: "agent", from: "B", hops: 1 });

    // A declares done…
    await waitFor(() => !!a.bridge.finished, { label: "A finished" });
    assert.equal(a.bridge.finished.by, "agent", "declared by the agent, not the user");
    assert.ok(
      a.bridge.finished.summary.includes("wrong cwd"),
      "summary should come from the FINAL marker",
    );
    console.log("   ✓ A's agent declared FINAL, with summary captured");

    // …and B learns about it (the alert), without the relay re-echoing A's own.
    await waitFor(() => !!peerSawFinished && !!b.bridge.finished, { label: "B learned A finished" });
    assert.equal(b.bridge.finished.from, "A", "B knows A declared it");
    assert.equal(b.bridge.finished.by, "agent");
    console.log("   ✓ B was alerted that the conversation is finished");

    // No more auto-replies from either side: let it sit, then check turn counts.
    const aTurns = a.mock.state.assistantTurns.length;
    const bTurns = b.mock.state.assistantTurns.length;
    await sleep(1500);
    assert.equal(a.mock.state.assistantTurns.length, aTurns, "A must not auto-reply after done");
    assert.equal(b.mock.state.assistantTurns.length, bTurns, "B must not auto-reply after done");
    console.log("   ✓ neither agent produced new turns after done");

    // A message that slips in after "done" is recorded but does NOT wake anyone.
    let ignored = null;
    a.bridge.on("ignored-after-done", (e) => (ignored = e));
    b.connector.say("wait, one more thing", { kind: "agent", from: "B", hops: 1 });
    await waitFor(() => !!ignored, { label: "post-done message ignored" });
    await sleep(400);
    assert.equal(a.mock.state.assistantTurns.length, aTurns, "post-done message must not wake A");
    console.log("   ✓ a message arriving after done does not restart the agents");

    // ---- the finished state survives a reconnect (relay replays it) ----
    b.connector.close("simulating drop");
    await sleep(200);
    const b2 = new Connector({ relayUrl, passphrase: PASSPHRASE, name: "B", role: "guest" });
    const welcome = new Promise((resolve) => b2.once("welcome", resolve));
    b.bridge.connector = b2;
    b2.on("message", (m) => b.bridge._onPeerMessage(m));
    b2.on("welcome", (w) => {
      if (w.finished && !b.bridge.finished) b.bridge.finished = { ...w.finished };
      for (const m of w.missed ?? []) b.bridge._onPeerMessage(m, { replayed: true });
    });
    b2.connect();
    const w = await welcome;
    assert.ok(w.finished, "relay should replay the finished declaration on welcome");
    assert.equal(w.finished.from, "A");
    assert.ok(b.bridge.finished, "bridge keeps the finished state after reconnect");
    console.log("   ✓ finished state survives a reconnect via the relay's welcome");

    // ---- a human message reopens the conversation ----
    const reopenedA = new Promise((resolve) => a.bridge.once("reopened", resolve));
    await b.bridge.sendFromUser("Actually, there's a regression — please take another look");
    await waitFor(() => !b.bridge.finished, { label: "B reopened" });
    assert.equal(b.bridge.finished, null);
    // A should hear about the reopen too.
    await waitFor(() => !a.bridge.finished, { label: "A reopened remotely" });
    await reopenedA;
    console.log("   ✓ a human message reopened the conversation on both sides");

    // After reopening, B's message should wake A again (FINAL will fire again,
    // but the point is that the pipe is live — a new turn is produced).
    const aTurnsAfterReopen = a.mock.state.assistantTurns.length;
    await waitFor(() => a.mock.state.assistantTurns.length > aTurnsAfterReopen, {
      label: "A active again after reopen",
    });
    console.log("   ✓ agents talk again after reopen");

    a.bridge.stop();
    b.bridge.stop();
    b2.close();
    await a.mock.close();
    await b.mock.close();
  }

  // ---- case: a human can declare done through the bridge ----------------
  {
    const pw = "a totally different room passphrase 2";
    const a = await machine({ name: "A2", role: "host", relayUrl, log: quiet, reply: () => "ok", passphrase: pw });
    const b = await machine({ name: "B2", role: "guest", relayUrl, log: quiet, reply: () => "ok", passphrase: pw });
    await waitFor(() => a.connector.peerOnline && b.connector.peerOnline, { label: "A2/B2 paired" });

    const peerFinished = new Promise((resolve) => b.bridge.once("finished", resolve));
    a.bridge.declareDone({ summary: "We're good, signing off", by: "user" });
    assert.equal(a.bridge.finished.by, "user");
    const rec = await peerFinished;
    assert.equal(rec.from, "A2");
    assert.equal(rec.by, "user");
    assert.ok(rec.summary.includes("signing off"));
    console.log("   ✓ a human can declare done and the peer is alerted");

    a.bridge.stop();
    b.bridge.stop();
    await a.mock.close();
    await b.mock.close();
  }

  await relay.close();
  console.log("\nALL DONE TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nDONE TEST FAILED:", e);
  process.exit(1);
});
