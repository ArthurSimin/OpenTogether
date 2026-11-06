// AgentBridge: connects one OpenCode agent to a peer's agent through the relay.
//
// The design goal: make two separate OpenCode instances behave like two
// teammates in the same chat, *without* hacking OpenCode's internals.
//
//  inbound  (peer -> my agent)
//    1. mirror the peer's words into a dedicated local session using
//       `noReply: true` (so it is just history, no LLM call)
//    2. send one short, explicit "wake" prompt that asks the agent to read the
//       peer's message and respond if a response is useful
//    3. wait for `session.idle`
//    4. take the *new* assistant text and send it back to the peer
//
//  outbound (my user -> peer)
//    when my user types into a *participating* session, we forward that text
//    (their session title/id travel along so the peer agent knows the context).

import { EventEmitter } from "node:events";
import { OpenCodeClient, buildTranscript, extractAssistantText } from "./opencode-client.mjs";
import { scrubSecrets, truncate, nowIso, newId } from "./util.mjs";

const MARK_BEGIN = "[[OT:BEGIN";
const MARK_END = "[[OT:END]]";

function marker(kind, extra = {}) {
  const attrs = Object.entries(extra)
    .map(([k, v]) => `${k}=${String(v).replace(/[\]\s]/g, "_")}`)
    .join(" ");
  return `${MARK_BEGIN} kind=${kind}${attrs ? " " + attrs : ""}]]`;
}

/** Is this user message one the bridge itself injected? */
export function isBridgeMessage(text) {
  return typeof text === "string" && /\[\[OT:(FROM|BEGIN|ACK|INFO|DONE)/.test(text);
}

/**
 * Detect an agent's "we're finished" declaration.
 *
 * The agent ends its reply with a line like:
 *   [[OT:BEGIN kind=FINAL]]optional summary[[OT:END]]
 * We accept a few forgiving variants (no summary, summary on later lines).
 * Returns { done: true, summary } or null.
 */
export function parseFinalDeclaration(text) {
  if (typeof text !== "string") return null;
  const m = text.match(
    /\[\[OT:BEGIN\s+kind=FINAL\]\]([\s\S]*?)(?:\[\[OT:END\]\]|$)/i,
  );
  if (!m) return null;
  const summary = String(m[1] ?? "")
    .replace(/\[\[OT:END\]\]/gi, "")
    .trim();
  return { done: true, summary };
}

/** True when the reply is nothing but an acknowledgement. */
export function isAckOnly(text) {
  if (typeof text !== "string") return false;
  return /^\s*\[\[OT:BEGIN\s+kind=ACK/i.test(text.trim());
}

/**
 * Remove the [[OT:BEGIN kind=FINAL]] ... [[OT:END]] block from a reply, leaving
 * whatever real answer the agent wrote. Used so declaring done doesn't discard
 * the message the peer was waiting for.
 */
export function stripFinalMarker(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\[\[OT:BEGIN\s+kind=FINAL\]\][\s\S]*?(?:\[\[OT:END\]\]|$)/gi, "")
    .replace(/\[\[OT:END\]\]/gi, "")
    .trim();
}

/**
 * Turn a cryptic provider/model failure into a hint a human can act on.
 * Returns "" when we have nothing useful to add.
 */
export function modelErrorHint(error) {
  const msg = String(error ?? "");
  if (!msg) return "";
  if (/api key has expired|invalid api key|unauthorized|401/i.test(msg)) {
    return "hint: your agent's model rejected its API key. Pick a working model with `--model provider/model` (e.g. --model omniroute/cw/claude-sonnet-5-5).";
  }
  if (/model not found|unknown model|no such model/i.test(msg)) {
    return "hint: that model doesn't exist on your server. Run `opentogether doctor` to list providers, then pass `--model provider/model`.";
  }
  if (/rate limit|quota|429/i.test(msg)) {
    return "hint: rate-limited or out of quota. Try another provider with `--model provider/model`.";
  }
  return "";
}

export class AgentBridge extends EventEmitter {
  constructor({
    opencode, // OpenCodeClient
    connector, // Connector
    config, // resolved config object (see config.mjs)
    log = () => {},
  }) {
    super();
    this.oc = opencode;
    this.connector = connector;
    this.config = config;
    this.log = log;

    this.linkSessionID = config.linkSessionId ?? null; // dedicated "phone line"
    this.participating = new Set(); // sessionIDs whose user messages get forwarded
    this.busy = false; // one inbound turn at a time
    this.queue = []; // pending inbound messages while busy
    this._idleWaiters = new Map(); // sessionID -> [resolve]
    this._started = false;
    this.stats = { inbound: 0, outbound: 0, forwarded: 0, errors: 0, lastInboundAt: 0, lastOutboundAt: 0 };
    this._sentIds = new Set(); // ids we already processed (dedupe on replay)
    this._pendingForward = new Map(); // messageID -> { text } awaiting reply capture

    // ---- loop protection -------------------------------------------------
    // Two agents that both auto-respond will happily talk forever unless we
    // bound it. Three independent brakes:
    //   1. hop counter  — every relayed message carries how many agent turns
    //                     it has been through; past maxHops we stop replying.
    //   2. turn budget  — max consecutive auto-replies per time window; after
    //                     that the human has to nudge it.
    //   3. content dedupe — an agent repeating itself is not worth answering.
    this.maxHops = config.maxHops ?? 8;
    this._window = []; // timestamps of recent auto-replies
    this._windowMs = config.budgetWindowMs ?? 10 * 60 * 1000;
    this._budget = config.turnBudget ?? 12;
    this._recentReplies = []; // normalized recent replies (dedupe)
    this._suppressed = 0;

    // ---- finished state --------------------------------------------------
    // When either agent declares the job done, we stop talking. This is the
    // *intentional* end of a conversation, as opposed to the loop brakes
    // above, which are a safety net. Nobody auto-replies once this is set
    // until a human reopens the conversation.
    this.finished = null; // { by, from, summary, at } | null
    this._dismissedLocally = new Set(); // ids already handled as "done"
  }

  get isFinished() {
    return !!this.finished;
  }

  /** Mirror the connector's finished state into the bridge. */
  _syncFinishedFromConnector() {
    if (this.connector.finished && !this.finished) {
      this.finished = { ...this.connector.finished };
      this._afterFinished(this.finished, { announce: true });
    } else if (!this.connector.finished && this.finished) {
      this.finished = null;
    }
  }

  /** Adopt the relay's record without announcing it again. */
  _syncFinishedFromConnectorQuiet() {
    if (this.connector.finished) {
      this.finished = { ...this.connector.finished };
    }
  }

  _afterFinished(record, { announce = true } = {}) {
    // Drop anything queued: those messages belong to a conversation that the
    // other side has just declared over.
    if (this.queue.length) {
      this.log(`dropping ${this.queue.length} queued message(s) — conversation is finished`);
      this.queue.length = 0;
    }
    this.emit("finished", record);
    const peerName = this.connector.peer?.name ?? "peer";
    const who = record.from === this.connector.name ? "You" : peerName;
    if (announce) {
      this._announce(
        record.from === this.connector.name
          ? `✅ You declared this finished. Both agents have stopped replying.${
              record.summary ? `\n\n${truncate(record.summary, 800)}` : ""
            }\n\nSay "reopen" (or send a message) to start talking again.`
          : `✅ ${peerName} declared this finished. Your agent will not auto-reply anymore.${
              record.summary ? `\n\n${truncate(record.summary, 800)}` : ""
            }\n\nSay "reopen" (or send a message) to start talking again.`,
      );
    }
    this.log(`conversation finished (declared by ${who}${record.by === "user" ? " (human)" : ""})`);
  }

  /** Human or agent declares the pair finished. */
  declareDone({ summary = "", by = "user" } = {}) {
    if (this.finished) return this.finished;
    const id = this.connector.declareDone({ summary, by });
    this.finished = {
      by,
      from: this.connector.name,
      summary: String(summary ?? ""),
      at: new Date().toISOString(),
    };
    this._afterFinished(this.finished);
    return { ...this.finished, id };
  }

  /** Reopen a finished conversation so the agents can talk again. */
  reopen({ silent = false } = {}) {
    if (!this.finished) return false;
    this.finished = null;
    this.connector.reopen();
    this.resetLoopProtection();
    if (!silent) {
      this._announce("🔓 Conversation reopened. Both agents may talk again.");
    }
    this.emit("reopened", {});
    return true;
  }

  /** How many auto-replies have we sent recently? */
  _turnBudgetLeft() {
    const cutoff = Date.now() - this._windowMs;
    this._window = this._window.filter((t) => t > cutoff);
    return this._budget - this._window.length;
  }

  _normalizeForDedupe(text) {
    return String(text ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim()
      .slice(0, 400);
  }

  _isRepeated(text) {
    const n = this._normalizeForDedupe(text);
    if (!n) return false;
    return this._recentReplies.includes(n);
  }

  _rememberReply(text) {
    const n = this._normalizeForDedupe(text);
    if (!n) return;
    this._recentReplies.push(n);
    if (this._recentReplies.length > 40) this._recentReplies.shift();
    this._window.push(Date.now());
  }

  // ------------------------------------------------------------------ startup

  async start() {
    if (this._started) return;
    this._started = true;

    // 1. Make sure the link session exists.
    if (this.linkSessionID) {
      try {
        await this.oc.getSession(this.linkSessionID);
        this.log(`reusing link session ${this.linkSessionID}`);
      } catch {
        this.log(`link session ${this.linkSessionID} is gone, creating a new one`);
        this.linkSessionID = null;
      }
    }
    if (!this.linkSessionID) {
      const session = await this.oc.createSession({
        title: this.config.linkTitle ?? "🔗 OpenTogether — agent link",
        agent: this.config.agent || undefined,
      });
      this.linkSessionID = session.id;
      this.config.linkSessionId = session.id;
      this.log(`created link session ${session.id}`);
    }

    // 2. Subscribe to the local OpenCode event stream.
    this.oc.startEventStream(
      (evt) => this._onOpencodeEvent(evt),
      {
        onStatus: ({ connected, error }) => {
          this.emit("opencode-status", { connected, error });
          if (error) this.log(`opencode event stream: ${error}`);
        },
      },
    );

    // 3. Wire the relay.
    this.connector.on("message", (m) => this._onPeerMessage(m));
    this.connector.on("welcome", (w) => {
      if (w.missed?.length) this.log(`replaying ${w.missed.length} missed peer message(s)`);
      for (const m of w.missed ?? []) this._onPeerMessage(m, { replayed: true });
      // A session that was already declared done stays done across restarts.
      if (w.finished && !this.finished) {
        this.finished = { ...w.finished };
        this._afterFinished(this.finished, { announce: true });
      }
    });
    this.connector.on("peer-joined", ({ peer }) => {
      this.log(`peer "${peer?.name}" connected`);
      this._announce(`${peer?.name ?? "Peer"} is online.`);
    });
    this.connector.on("peer-left", ({ peer }) => {
      this.log(`peer "${peer?.name}" disconnected`);
      this._announce(`${peer?.name ?? "Peer"} went offline. Messages will be delivered when they return.`);
    });
    this.connector.on("ack", ({ id }) => {
      this.emit("delivery", { id, state: "delivered" });
      this.log(`peer confirmed delivery of ${id}`);
    });

    // Someone declared the job done (either side, agent or human).
    this.connector.on("done", (rec) => {
      if (rec.id && this._dismissedLocally.has(rec.id)) return;
      if (rec.id) this._dismissedLocally.add(rec.id);
      // The relay echoes our own declaration back; keep whichever we have.
      if (this.finished) {
        this._syncFinishedFromConnectorQuiet();
        return;
      }
      this.finished = { by: rec.by, from: rec.from, summary: rec.summary, at: rec.at };
      this._afterFinished(this.finished, { announce: !rec.mine });
    });

    this.connector.on("reopened", () => {
      if (!this.finished) return;
      this.finished = null;
      this.resetLoopProtection();
      this._announce("🔓 The conversation was reopened by the other side.");
      this.emit("reopened", { remote: true });
    });

    this.connector.connect();
    this.emit("started", { linkSessionId: this.linkSessionID });
  }

  stop() {
    this._started = false;
    this.connector.close("bridge stopped");
    this.oc.stopEventStream();
  }

  // ------------------------------------------------------------- opencode side

  addParticipating(sessionID) {
    this.participating.add(sessionID);
    this.emit("participating", [...this.participating]);
  }

  removeParticipating(sessionID) {
    this.participating.delete(sessionID);
    this.emit("participating", [...this.participating]);
  }

  async _onOpencodeEvent(evt) {
    if (!evt || typeof evt !== "object") return;

    // Track idle state so we know when the agent finished its turn.
    if (evt.type === "session.idle" && evt.properties?.sessionID) {
      this._releaseIdle(evt.properties.sessionID);
      // A forwarded user message in a participating session now has a reply
      // we should ship back to the peer.
      setImmediate(() => this._captureForwardedReply(evt.properties.sessionID).catch(() => {}));
      return;
    }

    if (evt.type === "session.error") {
      const sid = evt.properties?.sessionID;
      const err = evt.properties?.error;
      const msg = err?.data?.message ?? err?.message ?? err?.name ?? "unknown error";
      this.stats.errors++;
      this.emit("session-error", { sessionID: sid, message: msg });
      this.log(`session error (${sid ?? "?"}): ${msg}`);
      // If the *link* session errored, tell the peer so they aren't left hanging.
      if (sid === this.linkSessionID) {
        this._releaseIdle(sid);
        this.connector.say(
          `⚠️ My agent hit an error while processing your message:\n${msg}\n\n(Please continue without a reply from my agent if needed.)`,
          { kind: "error", from: this.connector.name },
        );
      }
      return;
    }

    // Outbound: the user typed something in a participating session.
    if (evt.type === "message.updated") {
      const info = evt.properties?.info;
      if (!info || info.role !== "user") return;
      if (!this.config.forwardLocalUserMessages) return;
      if (!this.participating.has(info.sessionID)) return;

      const msgs = await this.oc.messages(info.sessionID).catch(() => []);
      const entry = msgs.find((m) => m?.info?.id === info.id);
      if (!entry) return;
      const text = (entry.parts ?? [])
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (!text) return;
      if (this._pendingForward.has(info.id)) return; // already handled
      if (isBridgeMessage(text)) return; // injected by us
      // The user's message is local: let the local agent answer it too, but
      // also ship it to the peer so both agents see the same conversation.
      this._pendingForward.set(info.id, { text, sessionID: info.sessionID });
      this._forwardToPeer(text, info.sessionID, info.id);
    }
  }

  _releaseIdle(sessionID) {
    const waiters = this._idleWaiters.get(sessionID);
    if (!waiters?.length) return;
    this._idleWaiters.delete(sessionID);
    for (const fn of waiters) fn();
  }

  /** Resolve when a session becomes idle (or after `timeoutMs`). */
  _waitForIdle(sessionID, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const list = this._idleWaiters.get(sessionID);
        if (list) {
          const i = list.indexOf(finish);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) this._idleWaiters.delete(sessionID);
        }
        resolve();
      };
      const timer = setTimeout(() => {
        if (!done) this.log(`timed out waiting for ${sessionID} to go idle`);
        finish();
      }, timeoutMs);
      timer.unref?.();
      if (!this._idleWaiters.has(sessionID)) this._idleWaiters.set(sessionID, []);
      this._idleWaiters.get(sessionID).push(finish);
    });
  }

  /** Is the session currently working (busy/retrying)? */
  async _isBusy(sessionID) {
    const st = await this.oc.statuses().catch(() => ({}));
    const s = st?.[sessionID];
    return !!s && s.type !== "idle";
  }

  // ---------------------------------------------------------------- inbound

  async _onPeerMessage(msg, { replayed = false } = {}) {
    const { from, id, text } = msg;
    if (!id || this._sentIds.has(id)) return; // duplicate / already handled
    this._sentIds.add(id);
    if (this._sentIds.size > 5000) {
      // keep the dedupe set bounded
      const first = this._sentIds.values().next().value;
      this._sentIds.delete(first);
    }

    const peerName = from ?? this.connector.peer?.name ?? "peer";
    this.stats.inbound++;
    this.stats.lastInboundAt = Date.now();
    this.emit("inbound", { from: peerName, id, text, replayed });

    // System-style notes/errors from the peer are shown but never trigger a
    // reply — otherwise two failing agents would ping-pong forever.
    const kind = msg.meta?.kind;
    if (kind === "error" || kind === "note") {
      this._announce(`⚠️ ${peerName}: ${truncate(String(text ?? ""), 400)}`);
      return;
    }

    // A "final" message is the peer's last word before it declares done. It is
    // shown in full (it's usually the answer we were waiting for) but it must
    // not wake our agent — the work is over.
    if (kind === "final") {
      this._announce(`🏁 ${peerName} (final): ${truncate(String(text ?? ""), 600)}`);
      return;
    }

    // Brake 0: the conversation is already finished. Escaped messages can still
    // be in flight when someone declares done; record them but stay silent.
    if (this.finished) {
      this._suppressed++;
      this.log(`ignoring message from ${peerName}: conversation is finished`);
      this._announce(
        `🔇 ${peerName} sent another message after "done": ${truncate(String(text ?? ""), 300)}\n` +
          `(not auto-replying — say "reopen" to continue)`,
      );
      this.emit("ignored-after-done", { from: peerName, text });
      return;
    }

    // Mirror into the link session so the agent sees it as history...
    const clean = scrubSecrets(String(text ?? ""));
    const body = `${marker("FROM", { peer: peerName })}\n${clean}\n${MARK_END}`;
    try {
      const stored = await this.oc.appendNoReply(this.linkSessionID, [
        { type: "text", text: body, metadata: { ot: { kind: "peer", from: peerName, wireId: id } } },
      ]);
      this._lastPeerMessageRef = { id: stored?.info?.id, text: clean, from: peerName };
    } catch (err) {
      this.log(`failed to mirror peer message: ${err.message}`);
      this.stats.errors++;
      return;
    }

    // ...then decide whether to wake the agent.
    const hops = Number(msg.meta?.hops ?? 0) + 1;

    // Brake 1: hop limit. The conversation has bounced agent-to-agent too many
    // times; stop here so two auto-responding agents can't run forever.
    if (hops > this.maxHops) {
      this._suppressed++;
      this.log(`hop limit reached (${hops} > ${this.maxHops}); not auto-replying`);
      this._announce(
        `🛑 Auto-reply stopped: this conversation has gone ${hops} agent hops deep. ` +
          `You can step in and send a message yourself when ready.`,
      );
      this.emit("loop-stopped", { reason: "hops", hops });
      if (this.config.autoRespond) {
        this.connector.say(
          `(auto-reply paused after ${this.maxHops} hops to avoid an endless loop — a human will continue)`,
          { kind: "note", from: this.connector.name, hops },
        );
      }
      return;
    }

    // Brake 2: turn budget within a time window.
    if (this.config.autoRespond && this._turnBudgetLeft() <= 0) {
      this._suppressed++;
      this.log(`turn budget exhausted (${this._budget} in ${this._windowMs / 1000}s)`);
      this._announce(
        `🛑 Auto-reply paused: ${this._budget} automatic replies sent in the last ` +
          `${Math.round(this._windowMs / 60000)} min. Say something to resume.`,
      );
      this.emit("loop-stopped", { reason: "budget" });
      return;
    }

    // Brake 3: the peer agent is just repeating itself.
    if (this.config.autoRespond && this._isRepeated(clean)) {
      this._suppressed++;
      this.log("peer repeated itself; not waking the agent again");
      this._announce(`↩︎ Ignored a repeated message from ${peerName} (same text as before).`);
      this.emit("loop-stopped", { reason: "repeat" });
      return;
    }

    if (this.config.autoRespond) {
      this._enqueueWake(peerName, clean, id, hops);
    } else {
      this._announce(`${peerName} says: ${truncate(clean, 400)}`);
    }
  }

  _enqueueWake(peerName, text, wireId, hops = 1) {
    this.queue.push({ peerName, text, wireId, hops });
    if (!this.busy) this._drainQueue();
  }

  async _drainQueue() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        await this._wakeAgent(item).catch((err) => {
          this.log(`wake failed: ${err.message}`);
          this.stats.errors++;
        });
      }
    } finally {
      this.busy = false;
    }
  }

  async _wakeAgent({ peerName, text, wireId, hops = 1 }) {
    // Record where the history "ends" so we only take the new reply.
    const before = await this.oc.messages(this.linkSessionID).catch(() => []);
    const lastMessageId = before.at(-1)?.info?.id;

    const wake = [
      `📨 You have a new message from your peer's OpenCode agent (${peerName}) on the other computer.`,
      ``,
      `It is quoted in full inside the message just above this one, between`,
      `${MARK_BEGIN} kind=FROM …]] and ${MARK_END}. Read it carefully.`,
      ``,
      `How to respond:`,
      `- If the peer's agent asked a question, needs information only you have, or`,
      `  would benefit from your perspective, write a reply.`,
      `- Your reply text is what gets sent to them. Put ONLY the reply in your`,
      `  final message — no "sure, here is my reply" wrapper.`,
      `- If the message is purely informational, needs no answer, or the problem`,
      `  is already resolved, reply with exactly: ${marker("ACK", { to: peerName })}`,
      `- KNOW WHEN TO STOP. If this exchange is going in circles, if you'd just be`,
      `  repeating yourself, or if finishing requires the humans to decide`,
      `  something, reply with ${marker("ACK", { to: peerName })} and summarize the`,
      `  situation for your user instead. Do not keep answering forever.`,
      `- 🏁 IF THE JOB IS DONE, declare it. When the bug is fixed, the question is`,
      `  answered, or there is genuinely nothing left to do, end your reply with:`,
      `      ${marker("FINAL")}`,
      `      <one short paragraph: what was concluded / what fixed it>`,
      `      ${MARK_END}`,
      `  This tells the other agent's side that you are finished; BOTH agents stop`,
      `  automatically and it alerts the humans. Only declare FINAL when the work`,
      `  is truly complete — not to dodge an awkward question.`,
      `- You may run commands, read files, and inspect this machine first. When`,
      `  you are done investigating, finish with your reply to ${peerName}.`,
      hops > 1
        ? `\n(This message has already bounced between agents ${hops} time(s). Stay focused and wrap up soon.)`
        : "",
    ].join("\n");

    const selection = await this.oc.sessionSelection(this.linkSessionID).catch(() => ({}));
    this.emit("typing", true);
    this.connector.typing(true);
    try {
      // Wait until the session is free before injecting the wake prompt.
      for (let i = 0; i < 60 && (await this._isBusy(this.linkSessionID)); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      // IMPORTANT: register the idle waiter *before* prompting, or a fast
      // agent could emit session.idle before we start listening.
      const idle = this._waitForIdle(this.linkSessionID, this.config.replyTimeoutMs ?? 10 * 60 * 1000);
      await this.oc.prompt(this.linkSessionID, wake, {
        model: this.config.model ?? selection.model ?? undefined,
        agent: this.config.agent || selection.agent || undefined,
      });
      await idle;

      const after = await this.oc.messages(this.linkSessionID).catch(() => []);
      const { text: replyRaw, error } = extractAssistantText(after, { afterMessageId: lastMessageId });
      const reply = scrubSecrets(replyRaw ?? "").trim();

      if (!reply) {
        this.log(`agent produced no reply${error ? ` (error: ${error})` : ""}`);
        // Model/auth problems are the most common cause and are cryptic, so
        // translate them into something the human can act on.
        const hint = modelErrorHint(error);
        // Never leave the peer hanging: tell them what happened.
        this.connector.say(
          error
            ? `⚠️ My agent could not answer: ${scrubSecrets(String(error)).slice(0, 300)}${hint ? `\n${hint}` : ""}`
            : `(my agent finished but had nothing to say about that)`,
          { kind: error ? "error" : "note", from: this.connector.name, inReplyTo: wireId },
        );
        return;
      }

      // Did the agent declare the job finished? That ends the conversation for
      // both sides. But the agent may have also written a real answer *before*
      // the marker — that answer must still reach the peer, otherwise declaring
      // done silently swallows the result of the work.
      const final = parseFinalDeclaration(reply);
      if (final) {
        this.log(`agent declared FINAL${final.summary ? `: ${final.summary.slice(0, 80)}` : ""}`);
        const answer = stripFinalMarker(reply);
        if (answer) {
          this.stats.outbound++;
          this.stats.lastOutboundAt = Date.now();
          this._rememberReply(answer);
          const id = this.connector.say(answer, {
            kind: "final",
            from: this.connector.name,
            role: this.connector.role,
            inReplyTo: wireId,
            hops,
          });
          this.emit("outbound", { id, text: answer, to: peerName, hops });
        }
        this.declareDone({ summary: final.summary, by: "agent" });
        return;
      }

      if (isAckOnly(reply)) {
        this.log(`agent acknowledged ${peerName}'s message without replying`);
        this.emit("ack-out", { to: peerName, wireId });
        return;
      }

      this.stats.outbound++;
      this.stats.lastOutboundAt = Date.now();
      this._rememberReply(reply);
      const wireIdOut = this.connector.say(reply, {
        kind: "agent",
        from: this.connector.name,
        role: this.connector.role,
        inReplyTo: wireId,
        hops,
      });
      this.emit("outbound", { id: wireIdOut, text: reply, to: peerName, hops });
    } finally {
      this.emit("typing", false);
      this.connector.typing(false);
    }
  }

  // --------------------------------------------------------------- outbound

  /** Forward something the user said to the peer agent. */
  _forwardToPeer(text, sessionID, messageID) {
    const clean = scrubSecrets(text);
    // A human speaking means a fresh conversation: reopen if it was finished,
    // and reset the loop brakes.
    if (this.finished) this.reopen();
    this.resetLoopProtection();
    const id = this.connector.say(clean, {
      kind: "agent",
      from: this.connector.name,
      role: this.connector.role,
      session: { id: sessionID },
      origin: this.config.sessionLabel ?? "local user",
      hops: 0,
    });
    this.stats.forwarded++;
    this.emit("forwarded", { id, text: clean, sessionID, messageID });
    return id;
  }

  /** Clear hop/budget/dedupe state. Called whenever a human takes the wheel. */
  resetLoopProtection() {
    this._window = [];
    this._recentReplies = [];
    this._suppressed = 0;
  }

  /** After a participating session goes idle, send the local agent's answer to the peer. */
  async _captureForwardedReply(sessionID) {
    // find the most recent forwarded user message we haven't shipped yet
    const pending = [...this._pendingForward.entries()].filter(([, v]) => v.sessionID === sessionID);
    if (!pending.length) return;
    const msgs = await this.oc.messages(sessionID).catch(() => []);
    for (const [messageID, info] of pending) {
      this._pendingForward.delete(messageID);
      const { text } = extractAssistantText(msgs, { afterMessageId: messageID });
      if (!text) continue;
      const id = this.connector.say(scrubSecrets(text), {
        kind: "agent",
        from: this.connector.name,
        role: this.connector.role,
        session: { id: sessionID },
      });
      this.stats.outbound++;
      this.emit("outbound", { id, text, to: this.connector.peer?.name ?? "peer" });
    }
  }

  // ------------------------------------------------------------------ helpers

  /** Show a short status line inside the link session (no LLM call). */
  _announce(text) {
    return this.oc
      .appendNoReply(this.linkSessionID, [
        { type: "text", text: `${marker("INFO")}\n${text}\n${MARK_END}`, metadata: { ot: { kind: "info" } } },
      ])
      .catch(() => null);
  }

  /** Let the user talk to the peer agent directly, without waking the local agent. */
  async sendFromUser(text) {
    const clean = scrubSecrets(String(text ?? "").trim());
    if (!clean) throw new Error("nothing to send");
    if (this.finished) this.reopen();
    this.resetLoopProtection();
    const id = this.connector.say(clean, {
      kind: "user",
      from: this.connector.name,
      role: this.connector.role,
      at: nowIso(),
      hops: 0,
    });
    await this._announce(`📤 You sent (no local agent wake-up): ${truncate(clean, 300)}`);
    this.stats.forwarded++;
    this.emit("forwarded", { id, text: clean, direct: true });
    return id;
  }
}

export { MARK_BEGIN, MARK_END, newId };
