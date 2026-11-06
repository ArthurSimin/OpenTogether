// Smoke test against a REAL opencode server if one is reachable.
// Skips gracefully when none is running. This verifies our HTTP usage matches
// the real API (sessions, noReply mirroring, status, event stream).
//
// Run: node test/real-opencode.test.mjs [serverUrl] [directory]

import assert from "node:assert/strict";
import { OpenCodeClient } from "../src/opencode-client.mjs";
import { discoverOpencode } from "../src/config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const explicit = process.argv[2] || process.env.OPENCODE_SERVER_URL;
  const directory = process.argv[3] || process.env.OPENCODE_DIRECTORY;
  const found = explicit ? { url: explicit } : await discoverOpencode({ directory });
  if (!found) {
    console.log("SKIP: no opencode server reachable (start one with: opencode serve --port 4096)");
    process.exit(0);
  }
  console.log("using opencode at", found.url);
  const oc = new OpenCodeClient({ serverUrl: found.url, directory });

  const health = await oc.health();
  // An unrelated web service on the same port can answer 200 with HTML. A real
  // OpenCode server always answers /global/health with JSON — if it didn't, skip
  // rather than fail (there simply is no opencode here).
  if (health == null || typeof health !== "object") {
    if (explicit) assert.ok(false, "health endpoint must answer with JSON");
    console.log(
      `SKIP: ${found.url} is not an opencode server (health was not JSON). ` +
        `Start one with: opencode serve --port 4096`,
    );
    process.exit(0);
  }
  console.log("   ✓ health:", JSON.stringify(health));

  let agents = [];
  try {
    agents = await oc.agentNames();
  } catch (err) {
    if (explicit) throw err;
    console.log(`SKIP: ${found.url} is not a usable opencode server (${err.message})`);
    process.exit(0);
  }
  if (agents.length === 0 && !explicit) {
    console.log(`SKIP: ${found.url} reports no agents — not a usable opencode server`);
    process.exit(0);
  }
  assert.ok(agents.length > 0, "at least one agent");
  console.log("   ✓ agents:", agents.join(", "));

  const providers = await oc.providers();
  console.log("   ✓ providers with models:", providers.map((p) => p.id).join(", ") || "(none)");

  const session = await oc.createSession({ title: "opentogether-smoke" });
  assert.match(session.id, /^ses/, "session id shape");
  console.log("   ✓ session created:", session.id);

  const stored = await oc.appendNoReply(session.id, [
    { type: "text", text: "[[OT:BEGIN kind=FROM peer=Smoke]]\nhello\n[[OT:END]]", metadata: { ot: true } },
  ]);
  assert.ok(stored?.info?.id, "noReply stores a message");
  const msgs = await oc.messages(session.id);
  assert.equal(msgs.length, 1, "message is persisted");
  assert.equal(msgs[0].info.role, "user");
  console.log("   ✓ noReply mirroring works (no LLM call)");

  const selection = await oc.sessionSelection(session.id);
  if (selection.model) console.log("   ✓ session model:", `${selection.model.providerID}/${selection.model.modelID}`);

  const statuses = await oc.statuses();
  assert.equal(typeof statuses, "object");
  console.log("   ✓ session status endpoint shape ok");

  // Event stream connects.
  let connected = false;
  let events = 0;
  oc.startEventStream(
    () => events++,
    { onStatus: (s) => { if (s.connected) connected = true; } },
  );
  await sleep(1500);
  assert.ok(connected, "event stream must connect");
  console.log(`   ✓ event stream connected (${events} event(s) so far)`);
  oc.stopEventStream();

  console.log("\nREAL OPENCODE TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nREAL OPENCODE TEST FAILED:", e);
  process.exit(1);
});
