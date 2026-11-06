// OpenCode plugin integration.
//
// Drop this into your OpenCode config:
//
//   {
//     "plugin": ["file:///absolute/path/to/OpenTogether/src/plugin.mjs"]
//   }
//
// It gives your agent three tools it can call on its own:
//   ot_send   -> send a message to the peer's agent and wait for their reply
//   ot_status -> is the peer online? (also reports whether we're finished)
//   ot_done   -> declare the shared task finished; both agents stop auto-replying
//
// The bridge process (`opentogether connect --control`) must be running for the
// peer link to exist; the plugin talks to it over a small local HTTP port.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// Resolve @opencode-ai/plugin from wherever OpenCode installed it. The package
// is ESM-only, so we must use dynamic import(). Depending on how OpenCode is
// installed it can live in ~/.opencode/node_modules,
// ~/.config/opencode/node_modules or the process cwd.
const SDK_CANDIDATES = [
  () => import("@opencode-ai/plugin"),
  () =>
    import(
      pathToFileURL(path.join(os.homedir(), ".opencode/node_modules/@opencode-ai/plugin/dist/index.js")).href
    ),
  () =>
    import(
      pathToFileURL(
        path.join(os.homedir(), ".config/opencode/node_modules/@opencode-ai/plugin/dist/index.js"),
      ).href
    ),
  () =>
    import(pathToFileURL(path.join(process.cwd(), "node_modules/@opencode-ai/plugin/dist/index.js")).href),
];

async function loadPluginSdk() {
  for (const attempt of SDK_CANDIDATES) {
    try {
      return await attempt();
    } catch {}
  }
  return null;
}

const sdk = await loadPluginSdk();

// Minimal fallback so the plugin still works if the SDK can't be located.
const toolFn = sdk?.tool ?? ((def) => def);
const schema = sdk?.tool?.schema ?? null;

const CONTROL_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "opentogether",
  "control.json",
);

function readControl() {
  try {
    return JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function controlFetch(pathname, init = {}) {
  const control = readControl();
  if (!control?.url || !control?.token) {
    throw new Error(
      "OpenTogether bridge is not running. Start it with `opentogether connect --control` on this machine.",
    );
  }
  const timeout = Number(init.timeoutMs) || 10 * 60 * 1000;
  const { timeoutMs, ...rest } = init;
  let res;
  try {
    res = await fetch(new URL(pathname, control.url), {
      ...rest,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${control.token}`,
        ...(rest.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    // A stale control.json (bridge was killed) gives a connection error; make
    // it obvious what to do instead of a raw ECONNREFUSED.
    throw new Error(
      `could not reach the OpenTogether bridge at ${control.url} (${err.message}). ` +
        `Is \`opentogether connect --control\` still running?`,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `bridge responded ${res.status}`);
  return body;
}

export const OpenTogether = async ({ client, directory }) => {
  // Schema helpers: use the SDK's zod instance when available so tool argument
  // validation works exactly as OpenCode expects. If the SDK can't be found we
  // fall back to lightweight JSON-schema-ish descriptors that still support the
  // chainable `.describe()`/`.optional()` calls used below.
  const fallback = (type) => {
    const node = {
      type,
      describe() {
        return node;
      },
      optional() {
        return { ...node, optional: true };
      },
    };
    return node;
  };
  const str = () => (schema ? schema.string() : fallback("string"));
  const bool = () => (schema ? schema.boolean() : fallback("boolean"));

  return {
    tool: {
      ot_send: toolFn({
        description:
          "Send a message to your peer's OpenCode agent on the other computer and get their reply. " +
          "Use this to collaborate with a second agent that is debugging the same project on a " +
          "different machine (e.g. the user's friend's PC). Returns their answer as text.",
        args: {
          message: str().describe("What to tell the peer's agent. Be specific."),
          wait: bool()
            .optional()
            .describe("Wait for their reply (default true). Set false to fire-and-forget."),
        },
        async execute(args, ctx) {
          ctx.metadata({ title: `OpenTogether → ${args.wait === false ? "send" : "ask"}` });
          const result = await controlFetch("/send", {
            method: "POST",
            body: JSON.stringify({ text: args.message, wait: args.wait !== false }),
            timeoutMs: args.wait === false ? 15000 : undefined,
          });
          if (args.wait === false) return `Message sent (${result.id}). Peer will reply when ready.`;
          if (!result.reply) return "(peer's agent did not answer in time; they may still be working)";
          return result.reply;
        },
      }),

      ot_status: toolFn({
        description:
          "Check whether the peer's OpenCode agent (the other computer) is online. " +
          "The result also includes `finished`: when set, the shared task is done and neither " +
          "agent should keep talking.",
        args: {},
        async execute() {
          const s = await controlFetch("/status", { timeoutMs: 5000 });
          return JSON.stringify(s, null, 2);
        },
      }),

      ot_done: toolFn({
        description:
          "Declare the shared task FINISHED. This alerts the peer's agent and stops BOTH agents " +
          "from auto-replying to each other. Include a one-paragraph summary of what was concluded " +
          "or fixed so the humans on both sides know where things ended up. Only use this when the " +
          "work is genuinely complete — not to avoid answering a hard question.",
        args: {
          summary: str()
            .optional()
            .describe("Short summary of what was concluded / fixed. Shown to both humans."),
        },
        async execute(args, ctx) {
          ctx.metadata({ title: "OpenTogether → done" });
          const result = await controlFetch("/done", {
            method: "POST",
            body: JSON.stringify({ summary: args.summary ?? "" }),
            timeoutMs: 15000,
          });
          const f = result.finished ?? {};
          return (
            `Marked the session finished (by ${f.by ?? "agent"}). Both agents have stopped auto-replying.` +
            (f.summary ? `\n\nSummary: ${f.summary}` : "")
          );
        },
      }),
    },

    // Nudge the model to actually use the tools when the user mentions a friend.
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      const control = readControl();
      if (!control) return;
      output.system.push(
        [
          "You are connected to a second OpenCode agent on another computer via OpenTogether.",
          "When the user refers to their friend, the friend's PC, or 'the other agent', you can talk to",
          "that agent with the ot_send tool. Prefer asking the peer agent for environment-specific facts",
          "(OS, node version, exact error output, paths) instead of guessing.",
          "When the collaboration is genuinely complete (the bug is fixed, the question is answered),",
          "call ot_done with a short summary so both agents stop and the humans are told.",
        ].join(" "),
      );
    },
  };
};
