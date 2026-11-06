// Runs every test suite in sequence and reports a summary.
//   node run-tests.mjs            run all
//   node run-tests.mjs relay loop run a subset (substring match on filenames)

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const all = ["relay.test.mjs", "e2e.test.mjs", "control.test.mjs", "loop.test.mjs", "done.test.mjs", "install.test.mjs", "v2.test.mjs", "real-opencode.test.mjs"];
const filters = process.argv.slice(2);
const suites = filters.length ? all.filter((f) => filters.some((x) => f.includes(x))) : all;

const results = [];
for (const suite of suites) {
  console.log(`\n━━━ ${suite} ${"━".repeat(Math.max(0, 50 - suite.length))}`);
  const started = Date.now();
  const res = spawnSync(process.execPath, [path.join(here, suite)], { stdio: "inherit" });
  results.push({ suite, code: res.status, ms: Date.now() - started });
}

console.log("\n━━━ summary " + "━".repeat(45));
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${r.suite.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s`);
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
