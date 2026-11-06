// A tiny, zero-dependency web dashboard for watching two agents talk.
//
// It is started by `opentogether connect --gui` (or `opentogether up --gui`) and
// binds to localhost only. The page is a single HTML string; live events flow
// over Server-Sent Events, and a handful of POST endpoints let you act without
// leaving the browser (send a message, declare done, reopen).
//
// It shows exactly what the bridge sees: peer status, every inbound/outbound
// message, loop-brake events, the finished state, and the raw stats.

import http from "node:http";
import { nowIso } from "./util.mjs";

export function startDashboard({ bridge, connector, port = 0, host = "127.0.0.1", log = () => {} }) {
  const clients = new Set(); // SSE response objects
  /** @type {Array<object>} recent events, so a late-joining tab sees history */
  const history = [];
  const MAX_HISTORY = 300;

  const push = (event) => {
    const enriched = { ...event, at: event.at ?? nowIso() };
    history.push(enriched);
    if (history.length > MAX_HISTORY) history.shift();
    const frame = `data: ${JSON.stringify(enriched)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  };

  // ---- wire bridge + connector events into the stream --------------------
  const wire = () => {
    bridge.on("inbound", (e) => push({ type: "inbound", from: e.from, text: e.text, replayed: !!e.replayed }));
    bridge.on("outbound", (e) => push({ type: "outbound", to: e.to, text: e.text }));
    bridge.on("forwarded", (e) => push({ type: "forwarded", text: e.text, direct: !!e.direct }));
    bridge.on("typing", (on) => push({ type: "typing", on: !!on }));
    bridge.on("finished", (e) => push({ type: "finished", by: e.by, from: e.from, summary: e.summary }));
    bridge.on("reopened", (e) => push({ type: "reopened", remote: !!e.remote }));
    bridge.on("loop-stopped", (e) => push({ type: "loop-stopped", reason: e.reason, hops: e.hops }));
    bridge.on("ignored-after-done", (e) => push({ type: "ignored-after-done", from: e.from, text: e.text }));
    bridge.on("session-error", (e) => push({ type: "session-error", message: e.message }));
    bridge.on("delivery", (e) => push({ type: "delivery", id: e.id, state: e.state }));
    bridge.on("ack-out", (e) => push({ type: "ack-out", to: e.to }));

    connector.on("peer-joined", ({ peer }) => push({ type: "peer", online: true, name: peer?.name }));
    connector.on("peer-left", ({ peer }) => push({ type: "peer", online: false, name: peer?.name }));
    connector.on("status", (s) => push({ type: "conn", state: s.state }));
    connector.on("done", (e) =>
      push({ type: "conn-done", by: e.by, from: e.from, summary: e.summary, mine: !!e.mine }),
    );
    connector.on("reopened", () => push({ type: "conn-reopened" }));
  };
  wire();

  const state = () => {
    const snap = connector.snapshot();
    return {
      ...snap,
      finished: bridge.finished ?? connector.finished ?? null,
      stats: bridge.stats,
      linkSession: bridge.linkSessionID,
    };
  };

  const json = (res, body, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Only accept requests addressed to us (basic DNS-rebind guard).
    const originHost = req.headers.host ?? "";
    if (originHost && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(originHost)) {
      return json(res, { error: "forbidden host" }, 403);
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }

    if (url.pathname === "/api/state") return json(res, state());

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Replay history so a freshly opened tab isn't blank.
      for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "hello", state: state() })}\n\n`);
      clients.add(res);
      const keep = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {}
      }, 20000);
      keep.unref?.();
      req.on("close", () => {
        clearInterval(keep);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname === "/api/send" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, { error: "empty" }, 400);
      try {
        await bridge.sendFromUser(text);
        return json(res, { ok: true });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/done" && req.method === "POST") {
      const body = await readBody(req);
      const summary = String(body.summary ?? "").slice(0, 2000);
      try {
        bridge.declareDone({ summary, by: "user" });
        return json(res, { ok: true, finished: bridge.finished });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/reopen" && req.method === "POST") {
      try {
        const reopened = bridge.reopen();
        return json(res, { ok: true, reopened });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    json(res, { error: "not found" }, 404);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actual}`;
      log(`dashboard on ${url}`);
      resolve({
        url,
        port: actual,
        close: () =>
          new Promise((r) => {
            for (const client of clients) {
              try {
                client.end();
              } catch {}
            }
            clients.clear();
            server.close(() => r());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The page. Deliberately self-contained (no CDN, no build step).
// ---------------------------------------------------------------------------

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OpenTogether — live</title>
<style>
  :root{
    --bg:#0b1020; --panel:#121a33; --panel2:#0e1730; --ink:#e7ecff; --dim:#8ea0c9;
    --you:#4ea1ff; --peer:#ff7ab6; --ok:#38d39f; --warn:#ffcc66; --err:#ff6b6b;
    --line:#22305a;
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       background:radial-gradient(1200px 600px at 80% -10%,#16224a,#0b1020);color:var(--ink);min-height:100vh}
  header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line);
         position:sticky;top:0;background:rgba(11,16,32,.85);backdrop-filter:blur(8px);z-index:5}
  .brand{font-weight:700;letter-spacing:.3px}
  .brand span{color:var(--you)}
  .pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
        font-size:12px;border:1px solid var(--line);background:var(--panel2)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--dim)}
  .dot.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}
  .dot.off{background:var(--err)}
  .spacer{flex:1}
  main{display:grid;grid-template-columns:1fr 300px;gap:18px;padding:18px;max-width:1200px;margin:0 auto}
  @media(max-width:860px){main{grid-template-columns:1fr}.side{order:-1}}
  .feed{display:flex;flex-direction:column;gap:10px;min-height:60vh}
  .msg{max-width:82%;padding:10px 13px;border-radius:14px;border:1px solid var(--line);
       background:var(--panel);white-space:pre-wrap;word-break:break-word;animation:fade .18s ease}
  .msg .meta{font-size:11px;color:var(--dim);margin-bottom:4px}
  .msg.you{align-self:flex-end;border-color:#1e3f6b;background:linear-gradient(180deg,#132a4a,#101d38)}
  .msg.peer{align-self:flex-start;border-color:#5a2744;background:linear-gradient(180deg,#2a1330,#1b1024)}
  .msg.sys{align-self:center;max-width:92%;text-align:center;color:var(--dim);background:transparent;border-style:dashed}
  .tag{font-weight:700}
  .tag.you{color:var(--you)} .tag.peer{color:var(--peer)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
  .card h3{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--dim)}
  .row{display:flex;justify-content:space-between;gap:8px;padding:3px 0;font-size:13px}
  .row b{font-weight:600}
  textarea,input{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--ink);
        border-radius:10px;padding:9px 11px;font:inherit;resize:vertical}
  button{cursor:pointer;border:1px solid var(--line);background:#1b2a52;color:var(--ink);
         border-radius:10px;padding:8px 12px;font-weight:600}
  button:hover{background:#243a6e} button.primary{background:#2563eb;border-color:#3b82f6}
  button.danger{background:#7a1f2b;border-color:#b23b4b} button.ghost{background:transparent}
  .actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
  .composer{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:14px}
  .finished-banner{display:none;padding:10px 14px;border-radius:12px;margin:0 0 10px;
       background:linear-gradient(90deg,#123a2a,#0f2c3a);border:1px solid #1f6f4f}
  .finished-banner.show{display:block}
  .typing{color:var(--dim);font-size:12px;min-height:16px}
  .badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
  footer{color:var(--dim);text-align:center;font-size:12px;padding:10px}
  @keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
</style>
</head>
<body>
<header>
  <div class="brand">Open<span>Together</span></div>
  <span class="pill"><span id="connDot" class="dot"></span><span id="connText">connecting…</span></span>
  <span class="pill">peer: <b id="peerText">—</b> <span id="peerDot" class="dot"></span></span>
  <span class="spacer"></span>
  <span class="badge" id="roomBadge">room —</span>
</header>

<main>
  <section>
    <div id="finishedBanner" class="finished-banner"></div>
    <div id="feed" class="feed"></div>
    <div class="composer">
      <input id="msg" placeholder="Type a message to the other agent (as you)…"/>
      <button class="primary" id="sendBtn">Send</button>
    </div>
    <div class="typing" id="typing"></div>
  </section>

  <aside class="side">
    <div class="card">
      <h3>Session</h3>
      <div class="row"><span>status</span><b id="statState">—</b></div>
      <div class="row"><span>you</span><b id="statName">—</b></div>
      <div class="row"><span>role</span><b id="statRole">—</b></div>
      <div class="row"><span>inbound</span><b id="statIn">0</b></div>
      <div class="row"><span>outbound</span><b id="statOut">0</b></div>
      <div class="row"><span>forwarded</span><b id="statFwd">0</b></div>
      <div class="actions">
        <button class="danger" id="doneBtn">Declare done</button>
        <button class="ghost" id="reopenBtn">Reopen</button>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>Done state</h3>
      <div id="doneState" class="row"><span>running</span><b>—</b></div>
    </div>
  </aside>
</main>
<footer>local dashboard · events stream over SSE · this page only binds to 127.0.0.1</footer>

<script>
const feed = document.getElementById('feed');
const $ = (id) => document.getElementById(id);
let myName = null, peerName = null, finished = null;

function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function time(iso){try{return new Date(iso).toLocaleTimeString()}catch{return ''}}

function addMsg(kind, who, text, at){
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  const meta = kind==='sys' ? '' : '<div class="meta"><span class="tag '+kind+'">'+esc(who)+'</span> · '+time(at)+'</div>';
  el.innerHTML = meta + esc(text);
  feed.appendChild(el);
  el.scrollIntoView({block:'end', behavior:'smooth'});
}

function sys(text){ addMsg('sys', '', text); }

function renderFinished(){
  const b = $('finishedBanner'), d = $('doneState');
  if (finished){
    const by = finished.by === 'user' ? 'a human' : (finished.from === myName ? 'your agent' : 'the peer agent');
    b.classList.add('show');
    b.innerHTML = '🏁 <b>Finished</b> — declared by ' + esc(by) +
      (finished.summary ? '<br><span style="color:var(--dim)">'+esc(finished.summary)+'</span>' : '') +
      '<br><span style="color:var(--dim)">Both agents have stopped. Send a message or press Reopen to continue.</span>';
    d.innerHTML = '<span>finished by</span><b>'+esc(finished.by)+' · '+time(finished.at)+'</b>';
  } else {
    b.classList.remove('show'); b.innerHTML='';
    d.innerHTML = '<span>running</span><b>—</b>';
  }
}

function applyState(s){
  if(!s) return;
  myName = s.name; peerName = s.peer?.name ?? null; finished = s.finished ?? null;
  $('roomBadge').textContent = 'room ' + (s.room ?? '—');
  $('statState').textContent = s.state ?? '—';
  $('statName').textContent = s.name ?? '—';
  $('statRole').textContent = s.role ?? '—';
  $('statIn').textContent = s.stats?.inbound ?? 0;
  $('statOut').textContent = s.stats?.outbound ?? 0;
  $('statFwd').textContent = s.stats?.forwarded ?? 0;
  setConn(s.state);
  setPeer(!!s.peerOnline, peerName);
  renderFinished();
}
function setConn(state){
  const on = state==='connected';
  $('connDot').className = 'dot ' + (on?'on':'off');
  $('connText').textContent = state ?? '—';
}
function setPeer(on, name){
  $('peerDot').className='dot ' + (on?'on':'off');
  $('peerText').textContent = name ?? '—';
}

const es = new EventSource('/api/events');
es.onmessage = (e) => {
  let ev; try{ ev = JSON.parse(e.data); }catch{ return; }
  switch(ev.type){
    case 'hello': applyState(ev.state); break;
    case 'inbound': addMsg('peer', (ev.from||peerName||'peer')+' (agent)', ev.text, ev.at); break;
    case 'outbound': addMsg('you', 'you (agent)', ev.text, ev.at); break;
    case 'forwarded': addMsg('you', 'you', ev.text, ev.at); break;
    case 'peer': setPeer(ev.online, ev.name); sys(ev.online ? (ev.name+' came online') : (ev.name+' went offline')); break;
    case 'conn': setConn(ev.state); if(ev.state==='connected') refresh(); break;
    case 'typing': $('typing').textContent = ev.on ? '…agent is thinking' : ''; break;
    case 'finished': finished = {by:ev.by, from:ev.from, summary:ev.summary, at:ev.at}; renderFinished();
      sys('🏁 finished (by '+ev.by+(ev.summary?': '+ev.summary:'')+')'); break;
    case 'reopened': finished = null; renderFinished(); sys('🔓 conversation reopened'+(ev.remote?' by the other side':'')); break;
    case 'loop-stopped': sys('🛑 auto-reply stopped ('+(ev.reason||'')+(ev.hops?', '+ev.hops+' hops':'')+')'); break;
    case 'ignored-after-done': sys('🔇 ignored a post-done message from '+ev.from); break;
    case 'session-error': sys('⚠️ agent error: '+ev.message); break;
    case 'ack-out': sys('✓ your agent acknowledged '+ev.to+' without replying'); break;
  }
};
es.onerror = () => setConn('reconnecting…');

async function refresh(){ try{ const s = await (await fetch('/api/state')).json(); applyState(s); }catch{} }
refresh();

$('sendBtn').onclick = async () => {
  const text = $('msg').value.trim(); if(!text) return;
  $('msg').value='';
  await fetch('/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
};
$('msg').addEventListener('keydown',(e)=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('sendBtn').click();} });
$('doneBtn').onclick = async () => {
  const summary = prompt('Summary for both humans (optional):') ?? '';
  await fetch('/api/done',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({summary})});
};
$('reopenBtn').onclick = () => fetch('/api/reopen',{method:'POST'});
</script>
</body>
</html>`;
