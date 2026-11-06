// Tests the control server + plugin tool path and the CLI helpers.
// Run: node test/control.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRelay } from "../src/relay.mjs";
import { Connector } from "../src/connector.mjs";
import { AgentBridge } from "../src/bridge.mjs";
import { OpenCodeClient } from "../src/opencode-client.mjs";
import { startControlServer } from "../src/control.mjs";
import { createMockOpencode } from "./mock-opencode.mjs";
import { configDir } from "../src/config.mjs";
import { scrubSecrets, truncate } from "../src/util.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSPHRASE = "control test passphrase";

async function waitFor(fn, { timeout = 15000, label = "condition" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  // ---------- unit: scrubber ----------
  {
    assert.match(scrubSecrets("key sk-abcdefghijklmnop1234"), /REDACTED/);
    assert.match(scrubSecrets("OPENAI_API_KEY=supersecretvalue"), /REDACTED/);
    assert.doesNotMatch(scrubSecrets("this is a normal sentence"), /REDACTED/);
    assert.equal(truncate("abc", 10), "abc");
    assert.match(truncate("a".repeat(20), 5), /truncated/);
    console.log("   ✓ scrub + truncate helpers");
  }

  // ---------- control server + "plugin" caller ----------
  process.env.OPENTOGETHER_CONFIG_DIR = fs.mkdtempSync("/tmp/ot-cfg-");
  const relay = createRelay({ port: 0, hostname: "127.0.0.1" });
  const addr = await relay.listen();
  const url = `ws://127.0.0.1:${addr.port}/ot`;

  const mockA = createMockOpencode({ reply: () => "agent A reply" });
  const mockB = createMockOpencode({ reply: (p) => (p.includes("kind=FROM") ? "peer says hi back" : "ok") });
  const aAddr = await mockA.listen();
  const bAddr = await mockB.listen();

  const ocA = new OpenCodeClient({ serverUrl: `http://127.0.0.1:${aAddr.port}` });
  const ocB = new OpenCodeClient({ serverUrl: `http://127.0.0.1:${bAddr.port}` });
  const connA = new Connector({ relayUrl: url, passphrase: PASSPHRASE, name: "A", role: "host" });
  const connB = new Connector({ relayUrl: url, passphrase: PASSPHRASE, name: "B", role: "guest" });

  const bridgeA = new AgentBridge({ opencode: ocA, connector: connA, config: { autoRespond: true } });
  const bridgeB = new AgentBridge({ opencode: ocB, connector: connB, config: { autoRespond: true } });
  await bridgeA.start();
  await bridgeB.start();

  await waitFor(() => connA.peerOnline && connB.peerOnline, { label: "paired" });
  console.log("   ✓ paired for control test");

  const control = await startControlServer({ bridge: bridgeA, connector: connA });
  const controlFile = JSON.parse(fs.readFileSync(`${configDir()}/control.json`, "utf8"));
  assert.equal(controlFile.url, control.url);
  const mode = fs.statSync(`${configDir()}/control.json`).mode & 0o777;
  assert.equal(mode, 0o600, "control.json must be private");
  console.log("   ✓ control.json written with 0600 permissions");

  // health + status
  const health = await fetch(`${control.url}/health`, {
    headers: { authorization: `Bearer ${control.token}` },
  }).then((r) => r.json());
  assert.equal(health.ok, true);

  const status = await fetch(`${control.url}/status`, {
    headers: { authorization: `Bearer ${control.token}` },
  }).then((r) => r.json());
  assert.equal(status.peerOnline, true);
  assert.equal(status.peer.name, "B");
  console.log("   ✓ /status reports the peer");

  // unauthorized
  const unauth = await fetch(`${control.url}/status`);
  assert.equal(unauth.status, 401);
  console.log("   ✓ control server rejects requests without the token");

  // /send with wait -> should get the peer agent's reply back
  const sent = await fetch(`${control.url}/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "what OS are you on?", wait: true, timeoutMs: 20000 }),
  }).then((r) => r.json());
  assert.ok(sent.id, "should return a message id");
  assert.equal(sent.reply, "peer says hi back", `unexpected reply: ${JSON.stringify(sent)}`);
  console.log("   ✓ ot_send round trip returns the peer agent's answer");

  // /send fire-and-forget
  const fired = await fetch(`${control.url}/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "just fyi", wait: false }),
  }).then((r) => r.json());
  assert.equal(fired.queued, true);
  console.log("   ✓ fire-and-forget send");

  // ---------- /done + /reopen (the "we're finished" control endpoints) ----------
  {
    const peerFinished = new Promise((resolve) => bridgeB.once("finished", resolve));
    const doneRes = await fetch(`${control.url}/done`, {
      method: "POST",
      headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
      body: JSON.stringify({ summary: "root cause found on B, all good" }),
    }).then((r) => r.json());
    assert.ok(doneRes.finished, "should return a finished record");
    assert.equal(doneRes.finished.by, "agent");
    assert.ok(doneRes.finished.summary.includes("root cause"));

    const rec = await peerFinished;
    assert.equal(rec.from, "A");
    assert.ok(rec.summary.includes("root cause"), "peer should hear the summary");
    console.log("   ✓ /done declares finished (agent) and alerts the peer");

    // /status must now report finished
    const st = await fetch(`${control.url}/status`, {
      headers: { authorization: `Bearer ${control.token}` },
    }).then((r) => r.json());
    assert.ok(st.finished, "/status should include finished");
    assert.equal(st.finished.by, "agent");
    console.log("   ✓ /status reports the finished state");

    // Reopen
    const re = await fetch(`${control.url}/reopen`, {
      method: "POST",
      headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
    }).then((r) => r.json());
    assert.equal(re.finished, null);
    assert.equal(re.reopened, true);
    await waitFor(() => !bridgeB.finished, { label: "peer reopened" });
    console.log("   ✓ /reopen clears finished on both sides");
  }

  // ---------- cleanup ----------
  await control.close();
  assert.equal(fs.existsSync(`${configDir()}/control.json`), false, "control.json removed on close");
  bridgeA.stop();
  bridgeB.stop();
  await mockA.close();
  await mockB.close();
  await relay.close();
  console.log("\nALL CONTROL TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nCONTROL TEST FAILED:", e);
  process.exit(1);
});
