// Tests for the "easy install" surface: the JSONC-safe plugin registration,
// the cloudflared URL parsing, and the live web dashboard endpoints.
//
// Run: node test/install.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  parseJsonc,
  stripJsonComments,
  insertPluginIntoText,
  installPlugin,
  installFishPath,
} from "../src/install.mjs";
import { Tunnel } from "../src/tunnel.mjs";
import { startDashboard } from "../src/dashboard.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---------- JSONC comment stripping + parsing ----------
  {
    const src = `{
      // line comment
      "a": 1, /* block */
      "b": "has // not a comment",
      "trailing": true,
    }`;
    const parsed = parseJsonc(src);
    assert.equal(parsed.a, 1);
    assert.equal(parsed.b, "has // not a comment", "// inside a string must survive");
    assert.equal(parsed.trailing, true, "trailing comma tolerated");
    assert.ok(stripJsonComments(src).includes("has // not a comment"));
    console.log("   ✓ stripJsonComments + parseJsonc handle comments and strings");
  }

  // ---------- insertPluginIntoText preserves comments ----------
  {
    const src = `{
  // my config
  "theme": "dark",
  "provider": { "x": { "name": "X" } }
}`;
    const out = insertPluginIntoText(src, ["file:///p/plugin.mjs"]);
    assert.ok(out.includes("// my config"), "comment preserved");
    const parsed = parseJsonc(out);
    assert.deepEqual(parsed.plugin, ["file:///p/plugin.mjs"]);
    assert.deepEqual(Object.keys(parsed.provider), ["x"]);
    console.log("   ✓ insertPluginIntoText adds plugin and keeps comments");

    // Existing plugin array gets replaced (and merged list kept).
    const src2 = `{ "plugin": ["file:///old.mjs"], "theme": "x" }`;
    const out2 = insertPluginIntoText(src2, ["file:///old.mjs", "file:///new.mjs"]);
    assert.deepEqual(parseJsonc(out2).plugin, ["file:///old.mjs", "file:///new.mjs"]);
    console.log("   ✓ existing plugin array updated in place");
  }

  // ---------- installPlugin on real files (create + idempotent) ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-install-"));
    const jsonc = path.join(dir, "opencode.jsonc");
    fs.writeFileSync(jsonc, `{\n  // keep me\n  "theme": "dark"\n}\n`);

    const r1 = installPlugin({ file: jsonc });
    assert.equal(r1.action, "added");
    assert.ok(r1.preservedComments);
    const parsed = parseJsonc(fs.readFileSync(jsonc, "utf8"));
    assert.ok(parsed.plugin.some((p) => p.endsWith("/src/plugin.mjs")));
    assert.ok(fs.readFileSync(jsonc, "utf8").includes("// keep me"));

    const r2 = installPlugin({ file: jsonc });
    assert.equal(r2.action, "unchanged", "second run must be a no-op");

    // Creating a brand-new config file.
    const fresh = path.join(dir, "new.jsonc");
    const r3 = installPlugin({ file: fresh });
    assert.equal(r3.action, "created");
    assert.ok(parseJsonc(fs.readFileSync(fresh, "utf8")).plugin.length === 1);
    console.log("   ✓ installPlugin creates/updates idempotently and preserves comments");

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- installFishPath idempotency ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-fish-"));
    const cfg = path.join(dir, "config.fish");
    fs.writeFileSync(cfg, "set -g foo bar\n");
    const oldCfg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    // fishConfigPath derives <XDG>/fish/config.fish; create that structure.
    fs.mkdirSync(path.join(dir, "fish"), { recursive: true });
    fs.renameSync(cfg, path.join(dir, "fish", "config.fish"));

    const a = installFishPath({ binDir: "/tmp/mybins" });
    assert.equal(a.action, "added");
    const b = installFishPath({ binDir: "/tmp/mybins" });
    assert.equal(b.action, "unchanged", "second run is a no-op");
    const content = fs.readFileSync(path.join(dir, "fish", "config.fish"), "utf8");
    assert.ok(content.includes("fish_add_path /tmp/mybins"));

    if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldCfg;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("   ✓ installFishPath adds the PATH line once");
  }

  // ---------- Tunnel URL parsing (with a fake cloudflared binary) ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-tun-"));
    const fake = path.join(dir, "fake-cloudflared");
    // Emits a trycloudflare URL on stderr like the real one, then idles.
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node
      process.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\\n");
      setTimeout(() => {
        process.stderr.write("INF |  https://quick-quiet-forest.trycloudflare.com  |\\n");
      }, 50);
      setInterval(() => {}, 1000);
      `,
      { mode: 0o755 },
    );

    const t = new Tunnel({ port: 8787, binary: fake }).start();
    const infoUrl = await t.waitForUrl({ timeoutMs: 5000 });
    assert.equal(infoUrl.publicUrl, "https://quick-quiet-forest.trycloudflare.com");
    assert.equal(infoUrl.wsUrl, "wss://quick-quiet-forest.trycloudflare.com/ot");
    t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("   ✓ cloudflared output → public https URL + wss://.../ot for peers");
  }

  // ---------- Dashboard endpoints ----------
  {
    const bridge = new EventEmitter();
    bridge.stats = { inbound: 0, outbound: 0, forwarded: 0 };
    bridge.linkSessionID = "ses_x";
    bridge.finished = null;
    const sent = [];
    bridge.sendFromUser = async (t) => sent.push(t);
    bridge.declareDone = ({ summary, by }) => {
      bridge.finished = { by, from: "A", summary, at: new Date().toISOString() };
      bridge.emit("finished", bridge.finished);
    };
    bridge.reopen = () => {
      const had = !!bridge.finished;
      bridge.finished = null;
      bridge.emit("reopened", {});
      return had;
    };
    const connector = new EventEmitter();
    connector.name = "A";
    connector.snapshot = () => ({
      state: "connected",
      room: "default",
      name: "A",
      role: "host",
      peer: { name: "B" },
      peers: [],
      peerOnline: true,
      finished: bridge.finished,
    });

    const dash = await startDashboard({ bridge, connector, port: 0 });
    assert.match(dash.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const state = await (await fetch(dash.url + "/api/state")).json();
    assert.equal(state.peer.name, "B");

    const html = await (await fetch(dash.url + "/")).text();
    assert.ok(html.includes("EventSource"), "page uses SSE");

    const r = await fetch(dash.url + "/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello peer" }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(sent, ["hello peer"]);

    // Empty send is rejected.
    const bad = await fetch(dash.url + "/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assert.equal(bad.status, 400);

    // done + reopen flow reflected in /api/state.
    await fetch(dash.url + "/api/done", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "all good" }),
    });
    let st = await (await fetch(dash.url + "/api/state")).json();
    assert.equal(st.finished.by, "user");
    assert.equal(st.finished.summary, "all good");

    await fetch(dash.url + "/api/reopen", { method: "POST" });
    st = await (await fetch(dash.url + "/api/state")).json();
    assert.equal(st.finished, null);

    // A foreign Host header is rejected (DNS-rebind guard). Node's fetch won't
    // let us spoof Host, so use a raw http request.
    const http = await import("node:http");
    const port = new URL(dash.url).port;
    const evilStatus = await new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/state", headers: { host: "evil.example.com" }, method: "GET" },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", () => resolve(0));
      req.end();
    });
    assert.equal(evilStatus, 403);

    // SSE delivers the replay + hello.
    const ac = new AbortController();
    const res = await fetch(dash.url + "/api/events", { signal: ac.signal });
    const reader = res.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.ok(chunk.includes("hello"), "SSE greets with current state");
    ac.abort();

    await dash.close();
    console.log("   ✓ dashboard serves state, sends, done/reopen, guards Host, streams SSE");
  }

  console.log("\nALL INSTALL/DASHBOARD TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nINSTALL/DASHBOARD TEST FAILED:", e);
  process.exit(1);
});
