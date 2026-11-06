# OpenTogether

**Connect two OpenCode agents on two different computers so they can talk to each other and debug together.**

Your app is broken on your friend's PC. Your friend has OpenCode but doesn't really know how to debug. OpenTogether links *your* OpenCode agent to *their* OpenCode agent, so the two agents can talk directly and figure out what's wrong with *that specific machine*.

```
  YOUR COMPUTER                         RELAY                       FRIEND'S COMPUTER
  ┌───────────────────┐            ┌──────────────┐            ┌───────────────────┐
  │  OpenCode + you   │            │              │            │  OpenCode + friend│
  │        │          │            │  ws://…/ot   │            │        │          │
  │   my agent 🤖 ────┼────────────┼──────────────┼────────────┼──── their agent 🤖│
  └───────────────────┘            └──────────────┘            └───────────────────┘
        "hey, what does `node -v` print on your machine?"
                            ▼
        "v22.3.0, and the app crashes with ENOENT config.json"
```

No cloud account. No `npm install`. No daemon you have to babysit. Just Node.js and OpenCode.

---

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/ArthurSimin/OpenTogether/main/install.sh | bash
```

That's it. It clones into `~/.opentogether`, puts `opentogether` on your `PATH` (`~/.local/bin`), wires your **fish** shell, registers the **OpenCode Desktop** plugin (your `opencode.jsonc` keeps its comments), and fetches **cloudflared** if you don't have it. No `sudo`, no `npm`, re-run any time.

Already have the repo? Just run:

```bash
opentogether install     # or: node bin/opentogether.mjs install
```

Then **restart OpenCode Desktop** so it loads the plugin (you'll see `ot_send`, `ot_status`, `ot_done` in the tool list).

### Go live in one command

On the machine that will host:

```bash
opentogether up --tunnel --gui
```

This single command starts the relay, opens a **public `https://…trycloudflare.com` URL automatically** (no port-forwarding, no IP), prints a ready-to-paste share box, and opens a **live web dashboard** in your browser. On your friend's machine:

```bash
opentogether gui --relay wss://the-url-it-printed/ot
```

...enter the same passphrase, and watch both agents on the same dashboard.

---

## The live dashboard

`--gui` (or the `gui` command) serves a local web page — bound to `127.0.0.1` only — that shows:

- **both sides of the conversation live** (peer messages vs your agent's replies)
- connection + peer online status, room, and running stats
- the 🏁 **finished** state, with the summary
- a box to **send a message**, **declare done**, or **reopen** — no terminal needed

Everything streams over Server-Sent Events; a late-opened tab replays recent history. Prefer the terminal? `--tui` opens a full-screen dashboard instead (Enter to send, `Ctrl+D` done, `Ctrl+R` reopen).

---

## What actually happens

1. Your friend's agent (or you, via `ot_send`) sends a message.
2. It reaches **your agent's OpenCode session** as a normal chat message.
3. Your agent reads it, runs commands on *your* machine if needed, and replies.
4. The reply goes back to your friend's agent — which reads it, runs commands on *their* machine, and answers.

Two agents, two machines, one conversation. The relay never sees your passphrase — only a token derived from it.

---

## Requirements

- **Node.js 18+** on both machines (`node --version`)
- **OpenCode** installed on both machines (`opencode --version`)
- The same **passphrase** on both sides
- One machine that the other can reach (a public IP, a LAN, or a tunnel — see below)

---

## Quick start

### Step 1 — One of you starts the relay

The relay is a tiny server both machines connect to. **You** run it (or your friend — whoever has the more reachable machine).

```bash
opentogether relay --port 8787
```

It prints the address to use:

```
relay is up on port 8787

  your friend should use:
    ws://192.168.1.42:8787/ot     (LAN, if reachable)
    ws://<your-public-ip>:8787/ot (if you port-forwarded it)
```

**Don't have a public IP?** That's normal. Use a tunnel — install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run:

```bash
cloudflared tunnel --url http://localhost:8787
```

It gives you a URL like `https://random-words.trycloudflare.com`. Your relay address is then:

```
wss://random-words.trycloudflare.com/ot
```

### Step 2 — Both of you set up

On **each** machine:

```bash
opentogether setup
```

It asks for:

| Question | Answer |
|---|---|
| Relay URL | the address from step 1 |
| Room name | any name, **same on both** (e.g. `debug-session-1`) |
| Shared passphrase | **same on both**, at least 12 characters |
| Your name | `Arthur` on your machine, `Friend` on theirs |
| Your role | `host` on yours, `guest` on theirs |
| OpenCode URL | press Enter (auto-detected) |
| Project directory | the folder with the broken app |

> **Security:** the passphrase is the only thing protecting the link. Use something long and not guessable. Anyone with the same passphrase *and* room name can join your room.

### Step 3 — Both of you start OpenCode

```bash
opencode serve --port 4096
```

Or just open the normal `opencode` TUI — that also starts a server. `opentogether setup` will find it.

### Step 4 — Connect

On **your** machine:

```bash
opentogether connect --control
```

On your **friend's** machine:

```bash
opentogether connect --control
```

`--control` lets your agent call the peer directly with the `ot_send` tool (see below). Now both agents can talk.

You'll see:

```
● connected to relay as Arthur (host)
● peer online: Friend
link session: ses_abc123…
```

---

## Talking to the other agent

There are three ways, from most to least hands-off.

### 1. Let the agents talk on their own (recommended)

With the `--control` flag and the plugin installed (below), your agent has a real tool:

```
ot_send({ message: "what does `node -v` print on your machine?" })
```

It returns the other agent's reply as text. Your agent decides when to use it — e.g. the moment you say *"my friend's app crashes, ask their agent what OS they're on"*.

**Install the plugin** so your agent can call it. Add this to your OpenCode config (`~/.config/opencode/opencode.json`), changing the path to wherever you put OpenTogether:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/you/OpenTogether/src/plugin.mjs"]
}
```

Restart OpenCode. You should now see `ot_send`, `ot_status` and `ot_done` in the tool list.

Then, in any OpenCode session, just talk:

> *"Ask my friend's OpenCode agent what version of node they have and paste the exact error."*

Your agent calls `ot_send`, the friend's agent runs `node -v` on their machine, and the answer comes back — all inside one conversation.

### 2. A terminal chat window

```bash
opentogether chat
```

Type and hit enter. Your message goes to the friend's agent, whose reply appears in your terminal.

```
you> hey, your app is crashing. what does the error say?
◀ Friend My user says it says: Error: Cannot find module './config.json'
```

### 3. Plugin-free: watch the link session

Even with no plugin and no `--control`, `opentogether connect` mirrors every peer message into a dedicated OpenCode session called **🔗 OpenTogether — agent link**. Open that session in the OpenCode TUI and you'll see the whole exchange as normal chat. Your agent sees it too.

---

## Loop protection (important)

Two agents that both auto-reply will talk to each other **forever** if you let them — each reply is a new message that deserves a new reply. That's expensive and useless. OpenTogether has three brakes:

| Brake | Default | What it stops |
|---|---|---|
| **Hop limit** | 8 hops | A conversation that has bounced agent→agent 8 times without a human stepping in. |
| **Turn budget** | 12 replies / 10 min | One side flooding the other. |
| **Repeat detection** | — | Answering an agent that just repeated itself. |

When a brake trips, the agent stops replying and notes it in the link session:

> `🛑 Auto-reply stopped: this conversation has gone 9 agent hops deep. You can step in and send a message yourself when ready.`

**The brakes reset the moment a human speaks** — send a message yourself (`opentogether chat`, or `ot_send` from your agent on your behalf) and the agents pick up again. That's the intended rhythm: agents work a few turns, then you steer.

Tune them in the config:

```jsonc
{
  "maxHops": 8,
  "turnBudget": 12,
  "budgetWindowMs": 600000
}
```

Agents are also told explicitly to reply with an `ACK` and stop when a conversation is going in circles. `--no-auto-respond` disables automatic replies entirely: peer messages are mirrored into your session, but only you can trigger a response.

---

## Declaring the task finished

The loop brakes above are a *safety net*. The **done** signal is the *intentional* end: when one agent decides the job is complete, it declares it, the other side is alerted, and **both agents stop auto-replying** — no trailing "thanks! / no problem!" ping-pong.

An agent declares done in one of two ways:

- **`ot_done` tool** (plugin): `ot_done({ summary: "what was fixed / concluded" })`
- **FINAL marker** in a normal reply:
  ```
  [[OT:BEGIN kind=FINAL]]
  <one short paragraph: what was concluded / what fixed it>
  [[OT:END]]
  ```

A human can end it too, from `opentogether chat`:

```
you> /done The bug was a stale config path — fixed on both sides.
```

Either way:
- The peer is told the session is finished (it appears in their link session and terminal).
- Both agents refuse to auto-reply to anything that arrives afterward — late messages are recorded but don't wake anyone.
- The **`finished`** state is stored on the relay, so a peer who reconnects or restarts learns the session was already over.
- `ot_status` / `/status` report `finished`.

**To keep going, a human just talks again.** Sending any message (or `/reopen` in `opentogether chat`) reopens the conversation and resets the loop brakes — same "human steers" rhythm as the brakes.

> Behaviour is covered by `test/done.test.mjs`: agent FINAL stops both sides, the peer is alerted, post-done messages are ignored, `finished` survives a reconnect, and a human message reopens.

---

## The debugging workflow, in practice

You want your agent to fix a bug that only happens on your friend's PC.

1. **Both run `opentogether connect --control`.** Your agent can now reach theirs.
2. **You tell your agent:**
   > "My friend is running my app on Windows and it crashes. Their agent is on the other end of `ot_send`. Find out why."
3. **Your agent asks the concrete questions.** OS, node version, the full error, the path it's looking for.
4. **Their agent runs the commands** on the actual broken machine and reports back.
5. **Your agent finds the cause** (e.g. a hard-coded POSIX path), edits your repo, and tells their agent what to test.
6. **Their agent pulls your fix, reruns the app, and confirms it works.**

Your friend doesn't need to understand any of it — they just keep OpenCode open.

---

## Commands

| Command | What it does |
|---|---|
| `opentogether install` | One-button: PATH launcher, fish PATH, OpenCode plugin (JSONC-safe) |
| `opentogether up` | **Easy path:** relay + public cloudflared URL + dashboard in one command |
| `opentogether up --tunnel --gui` | Same, explicitly with tunnel and dashboard (the default for `up`) |
| `opentogether tunnel` | Expose a local relay publicly (auto-installs cloudflared) |
| `opentogether gui` | Connect + live **web dashboard** |
| `opentogether connect --tui` | Connect + full-screen **terminal** dashboard |
| `opentogether setup` | Interactive setup, writes `~/.config/opentogether/config.json` |
| `opentogether relay` | Start the relay server |
| `opentogether connect` | Link your agent to your peer's (mirrors messages into a session) |
| `opentogether connect --control` | Same, plus the local endpoint your agent's tools use |
| `opentogether chat` | Connect + terminal chat |
| `opentogether send "text"` | Send one message and exit |
| `opentogether status` | Show config and probe OpenCode |
| `opentogether doctor` | Diagnose connectivity problems |

### Useful flags (for `connect` / `chat` / `gui` / `up` / `send`)

```
--relay <url>         ws://host:port/ot (or an https:// trycloudflare URL)
--room <name>         room name
--name <name>         your display name
--role host|guest
--gui                 open the live web dashboard
--tui                 open the full-screen terminal dashboard
--tunnel              expose a local relay with a public cloudflared URL
--port <n>            relay port for up/relay/tunnel (default 8787)
--passphrase <text>   or set OPENTOGETHER_PASSPHRASE
--opencode <url>      OpenCode server (default http://127.0.0.1:4096)
--dir <path>          project directory
--agent <name>        OpenCode agent to use (default: the session's own)
--no-auto-respond     mirror peer messages but never wake your agent
--forward             also forward your own messages from the link session
```

---

## Configuration

Stored in `~/.config/opentogether/config.json` (mode `0600`):

```jsonc
{
  "relayUrl": "wss://your-tunnel.trycloudflare.com/ot",
  "passphrase": "correct horse battery staple",
  "room": "debug-session-1",
  "name": "Arthur",
  "role": "host",
  "opencodeUrl": "http://127.0.0.1:4096",
  "opencodeDirectory": "/home/you/project",
  "autoRespond": true,             // wake your agent when a peer message arrives
  "forwardLocalUserMessages": false,
  "agent": "",                     // OpenCode agent name; "" = session default
  "linkSessionId": "ses_…"         // the "agent link" session (auto-managed)
}
```

---

## Security

This links two agents that can run commands on their own machines, so treat it seriously.

- **The passphrase is the whole security model.** The relay derives a room id and a token from it; a wrong passphrase puts you in a *different* room and you never see the other side. Use a long, random one.
- **The relay never sees plaintext passphrases** — only HMAC-derived values — and it sees message *contents* as they pass through. If that matters, run the relay on a machine you trust, or over Tailscale/WireGuard.
- **Transport:** use `wss://` (a TLS tunnel) if you're going over the internet, not a raw `ws://` to a public IP.
- **Secrets are scrubbed** before messages leave a machine: `sk-…` keys, bearer tokens, GitHub tokens, and `*_SECRET=`/`*_TOKEN=`/`*_PASSWORD=` style assignments become `[REDACTED]`.
- **The control endpoint** used by the plugin is bound to `127.0.0.1`, requires a random bearer token, and that token is written to a `0600` file.
- **Agents still have their normal OpenCode permissions.** Their agent can only do on their machine what OpenCode would let it do. Don't ask the other agent to run destructive commands without their human's consent.

---

## Troubleshooting

Run this first on both machines:

```bash
opentogether doctor
```

**`wrong passphrase or room name`**
Passphrases/rooms must match exactly, including case.

**`waiting for your peer to join…` forever**
Check the relay URL, that `opentogether relay` is running, and that your firewall lets the port through. Test the relay from the other machine:

```bash
curl http://<relay-host>:8787/health
```

**`no OpenCode server found`**
Start one: `opencode serve --port 4096`. Or point at an existing one with `--opencode http://host:port`. If you set `OPENCODE_SERVER_PASSWORD`, put it in `opencodePassword` in the config.

**`OpenTogether bridge is not running`**
The `ot_send` tool needs `opentogether connect --control` running in the background on that machine.

**Agent replies with an API error** (e.g. expired key)
That's your OpenCode provider, not OpenTogether. Fix it with `opencode auth login` / your provider config. The error is forwarded to the other side so they aren't left waiting.

**Their agent says nothing**
Their `autoRespond` may be off, or their session is busy. Check `ot_status`, and `opentogether status` on their side.

---

## How it works (for the curious)

| File | Role |
|---|---|
| `src/relay.mjs` + `src/ws.mjs` | Zero-dependency relay: RFC 6455 WebSocket server, two peers per room, offline message replay, idle-room reaping |
| `src/connector.mjs` | Client link: identity, heartbeats, exponential-backoff reconnect, acks, missed-message recovery |
| `src/bridge.mjs` | The glue: mirrors peer messages into a local OpenCode session with `noReply`, wakes your agent with a focused prompt, captures the new assistant text, ships it back |
| `src/opencode-client.mjs` | Thin HTTP client for OpenCode's server API + SSE event stream |
| `src/plugin.mjs` | OpenCode plugin exposing `ot_send` / `ot_status` / `ot_done` |
| `src/control.mjs` | Authenticated localhost endpoint the plugin calls |
| `src/install.mjs` | One-button installer: PATH launcher, fish PATH, JSONC-safe plugin registration |
| `src/tunnel.mjs` | cloudflared quick-tunnel manager (auto-install + public URL scraping) |
| `src/dashboard.mjs` | Live web dashboard (HTTP + SSE) with send/done/reopen controls |
| `src/tui.mjs` | Full-screen terminal dashboard |
| `src/protocol.mjs` | Wire format + passphrase → room/token derivation |

The trick that keeps this from being fragile: we never patch OpenCode. We use its documented server API — `POST /session/:id/message` with `noReply: true` to inject history, `prompt_async` to get a reply, and the `/event` SSE stream to know when the agent finished.

**Message size** is capped at 16 KiB per message; transcripts in the link session are trimmed so the context window doesn't explode over a long session.

---

## Tests

```bash
node test/run-tests.mjs           # everything, with a summary
node test/run-tests.mjs relay     # just the relay tests
```

| Suite | Covers |
|---|---|
| `relay.test.mjs` | auth, pairing, acks, offline replay, room cap |
| `e2e.test.mjs` | two simulated machines, full agent↔agent round trip |
| `control.test.mjs` | plugin control server, `ot_send` round trip, 0600 perms |
| `loop.test.mjs` | proves two always-replying agents can't loop forever |
| `done.test.mjs` | agent/peer `done`: both sides stop, peer alerted, survives reconnect, human reopens |
| `install.test.mjs` | JSONC-safe plugin registration, fish PATH, cloudflared URL parsing, dashboard endpoints |
| `real-opencode.test.mjs` | against a real `opencode serve` (skips if none) |

No test hits a real model — the mock OpenCode server in `test/mock-opencode.mjs` scripts replies, so the suite is free and offline.

---

## License

MIT
