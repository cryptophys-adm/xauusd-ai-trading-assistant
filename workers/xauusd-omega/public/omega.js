// Omega page: polls ./api/overview, sets the EA control, and runs the broker engine's settings and
// connection. Every value is written with textContent (never as HTML); scripts are same-origin files
// only (CSP script-src 'self'); every URL is relative so the page works at omega.cryptophys.work/ and
// at nexus.cryptophys.work/omega/.
import { buildEnvelope } from "./omega-crypto.js";

const POLL_MS = 15_000;
let viewer = { can_control: false };
let busy = false;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v; else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
const slot = (name) => document.querySelector(`[data-slot="${name}"]`);
const fill = (name, ...nodes) => slot(name).replaceChildren(...nodes.filter((n) => n != null));
const num = (v, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const money = (v, cur = "") => (typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}${cur ? " " + cur : ""}` : "—");
const tone = (v) => (typeof v !== "number" || v === 0 ? "" : v > 0 ? "ok" : "bad");
const time = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const ago = (ms) => {
  if (ms == null) return "never";
  const m = Math.round(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const chip = (text, cls) => el("span", { class: `chip ${cls}` }, el("span", { class: "dot" }), text);
const kv = (pairs) => el("dl", { class: "kv" }, pairs.flatMap(([k, v, cls]) => [el("dt", {}, k), el("dd", { class: cls || "" }, v)]));
function table(headers, rows, empty) {
  if (!rows.length) return el("p", { class: "dim" }, empty);
  return el("table", {}, el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => (c instanceof Node ? el("td", {}, c) : el("td", {}, c ?? "—")))))));
}

function render(o) {
  const s = o.signal || {}, c = o.control || {}, hb = o.heartbeat || null, ea = o.ea || {};
  viewer = o.viewer || viewer;
  const cur = hb?.currency || "";

  document.getElementById("chips").replaceChildren(...[
    chip(ea.connected ? "EA connected" : "EA offline", ea.connected ? "ok" : "bad"),
    chip(hb?.mode ? `${hb.mode} account` : "account unknown", hb?.mode === "live" ? "warn" : "info"),
    chip(`control: ${c.mode || "active"}`, c.mode === "killed" ? "bad" : c.mode === "paused" ? "warn" : "ok"),
    s.kill ? chip(`kill (${s.kill_source || "server"})`, "bad") : null,
    s.blackout ? chip("event blackout", "warn") : null
  ].filter(Boolean));
  document.getElementById("who").textContent = viewer.subject ? `${viewer.subject}${viewer.can_control ? "" : " · read only"}` : "";

  fill("signal",
    el("div", { class: `side ${s.side || "NONE"}` }, s.side === "NONE" || !s.side ? "NO TRADE" : `${s.side} · ${(s.action || "").replace("ENTER_", "")}`),
    kv([
      ["Entry", num(s.entry, 3)], ["Stop", num(s.stop, 3)], ["Target", num(s.tp1, 3)],
      ["Risk : reward", s.risk_reward ? num(s.risk_reward, 2) : "—"], ["Confidence", s.confidence ? `${Math.round(s.confidence * 100)}%` : "—"],
      ["Issued", time(s.issued_ms)], ["Expires", time(s.expires_ms)],
      ["Feed price", s.market_price ? `${num(s.market_price, 3)} (${time(s.market_ms)})` : "—"],
      ["Blackout", s.blackout ? s.blackout_reason || "yes" : "no", s.blackout ? "warn" : ""],
      ["Signal id", s.signal_id || "—"]
    ])
  );

  fill("control",
    el("div", { class: `mode ${c.mode || "active"}` }, c.mode || "active"),
    kv([["Since", c.at ? time(Date.parse(c.at)) : "—"], ["By", c.actor || "—"], ["Reason", c.reason || "—"]]),
    s.kill_source === "env" ? el("p", { class: "warn" }, "The server kill switch (EA_SIGNALS_ENABLED) is on: it overrides this control.") : null
  );
  for (const b of document.querySelectorAll("#control-form button[data-mode]")) b.disabled = busy || !viewer.can_control || b.dataset.mode === c.mode;

  fill("ea", kv([
    ["Heartbeat", ago(ea.heartbeat_age_ms), ea.connected ? "ok" : "bad"],
    ["Version", hb?.version || "—"], ["Trading allowed", hb ? (hb.trading_allowed ? "yes" : "no") : "—", hb && !hb.trading_allowed ? "warn" : ""],
    ["EA control seen", hb?.control || "—"], ["Positions", hb?.positions ?? "—"],
    ["Floating P&L", money(hb?.floating_pnl, cur), tone(hb?.floating_pnl)], ["Today P&L", money(hb?.today_pnl, cur), tone(hb?.today_pnl)],
    ["Daily loss", hb?.daily_loss_pct != null ? `${num(hb.daily_loss_pct)}%` : "—"], ["Spread", hb?.spread_points != null ? `${hb.spread_points} pts` : "—"],
    ["Last signal", hb?.last_signal_id || "—"], ["Note", hb?.note || "—"]
  ]));

  const st = o.stats || {};
  const statCard = (label, x) => el("article", { class: "card stat" }, el("h2", {}, label),
    el("div", { class: `big ${tone(x?.net)}` }, money(x?.net, cur)),
    el("div", { class: "small" }, `${x?.trades ?? 0} trade${x?.trades === 1 ? "" : "s"} · win rate ${x?.win_rate != null ? Math.round(x.win_rate * 100) + "%" : "—"} · PF ${x?.profit_factor ?? "—"} · max DD ${num(x?.max_drawdown)}`));
  fill("stats", statCard("Today (UTC)", st.today), statCard("7 days", st.week), statCard("30 days", st.month));

  fill("positions", table(["Ticket", "Side", "Volume", "Entry", "Stop", "Target", "P&L", "Opened", "Signal"],
    (hb?.positions_detail || []).map((p) => [String(p.ticket), el("span", { class: p.side === "BUY" ? "ok" : "bad" }, p.side), num(p.volume), num(p.entry, 3), num(p.sl, 3), num(p.tp, 3),
      el("span", { class: tone(p.profit) }, money(p.profit, cur)), time(p.opened_ms), p.signal_id || "—"]),
    hb ? "No open position." : "No heartbeat from the EA yet."));

  fill("deals", table(["Closed", "Side", "Volume", "Entry", "Exit", "Net", "Reason", "Mode", "Signal"],
    (o.deals || []).map((d) => {
      const net = (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0);
      return [time(d.closed_ms), el("span", { class: d.side === "BUY" ? "ok" : "bad" }, d.side), num(d.volume), num(d.entry_price, 3), num(d.exit_price, 3),
        el("span", { class: tone(net) }, money(net, d.currency || "")), d.reason, d.mode, d.signal_id || "—"];
    }), "No closed deal reported yet."));

  fill("events", table(["At", "From", "To", "By", "Reason"],
    (o.control_events || []).map((e) => [time(Date.parse(e.at)), e.previous_mode, el("span", { class: e.mode === "killed" ? "bad" : e.mode === "paused" ? "warn" : "ok" }, e.mode), e.actor, e.reason || "—"]),
    "No control change yet."));

  renderBroker(o.broker || null);
  document.getElementById("updated").textContent = new Date().toISOString().slice(11, 19) + " UTC";
}

// ---------------------------------------------------------------- broker engine

let broker = null;
let engineDirty = false;
const INTENT_TONE = { done: "ok", failed: "bad", expired: "warn", pending: "info", sent: "info" };
const CONNECTION_TEXT = {
  none: "No broker connection stored.",
  stored: "Stored; the bridge applies it at its next sync.",
  needs_reentry: "The bridge's key changed: enter the credentials again.",
  cleared: "Disconnected; the bridge clears the terminal login."
};

function renderBroker(b) {
  broker = b;
  if (!b) {
    for (const name of ["broker", "engine", "bridge"]) fill(name, el("p", { class: "dim" }, "The broker engine is not available."));
    return;
  }
  const e = b.engine || {}, c = b.connection || {}, br = b.bridge || {};
  const effective = !e.env_enabled ? ["off (server switch OMEGA_ENGINE_ENABLED)", "bad"] : !e.enabled ? ["off (enable it below)", "warn"] : ["on", "ok"];

  fill("broker", kv([
    ["Status", CONNECTION_TEXT[c.status] || c.status || "—", c.status === "stored" ? "ok" : c.status === "needs_reentry" ? "warn" : ""],
    ["Server", c.server || "—"], ["Version", c.version ? `v${c.version}` : "—"], ["By", c.updated_by || "—"], ["At", time(c.updated_ms)]
  ]));

  fill("engine", kv([
    ["Effective", effective[0], effective[1]],
    ["Live (real account)", e.live_armed ? "armed" : "not armed", e.live_armed ? "warn" : ""],
    ["Risk", e.risk_pct != null ? `${e.risk_pct}% of equity` : "—"], ["Max positions", e.max_positions ?? "—"],
    ["Max daily loss", e.max_daily_loss_pct != null ? `${e.max_daily_loss_pct}%` : "—"], ["Max spread", e.max_spread_points != null ? `${e.max_spread_points} pts` : "—"],
    ["Max signal age", e.max_signal_age_ms ? `${Math.round(e.max_signal_age_ms / 60000)} min` : "—"], ["Changed by", e.updated_by || "—"]
  ]));
  if (!engineDirty) {
    document.getElementById("e-enabled").checked = e.enabled === true;
    document.getElementById("e-policy-auto").checked = e.policy_auto === true;
    document.getElementById("e-risk").value = e.risk_pct ?? "";
    document.getElementById("e-maxpos").value = e.max_positions ?? "";
    document.getElementById("e-loss").value = e.max_daily_loss_pct ?? "";
    document.getElementById("e-spread").value = e.max_spread_points ?? "";
    document.getElementById("e-age").value = e.max_signal_age_ms ? Math.round(e.max_signal_age_ms / 60000) : "";
  }

  fill("bridge", kv([
    ["Bridge", br.seen ? `seen ${ago(br.synced_age_ms)}` : br.synced_age_ms != null ? `last seen ${ago(br.synced_age_ms)}` : "never seen", br.seen ? "ok" : "bad"],
    ["Terminal", br.terminal_connected ? `connected to ${br.server || "?"}` : "not connected", br.terminal_connected ? "ok" : "bad"],
    ["Algo trading", br.trade_allowed === true ? "allowed" : "DISABLED (enable in MT5)", br.trade_allowed === true ? "ok" : "bad"],
    ["Account", br.trade_mode || "—", br.trade_mode === "real" ? "warn" : ""], ["Balance", money(br.balance, br.currency || "")], ["Equity", money(br.equity, br.currency || "")],
    ["Symbol", br.symbol || "—"], ["Spread", br.spread_points != null ? `${br.spread_points} pts` : "—"], ["Positions", String((br.positions || []).length)],
    ["Bridge version", br.bridge_version || "—"]
  ]));

  const controls = viewer.can_control;
  for (const id of ["b-connect", "b-disconnect", "e-save", "e-arm", "e-disarm"]) document.getElementById(id).disabled = !controls;
  document.getElementById("b-connect").disabled = !controls || !br.kid;
  document.getElementById("b-disconnect").disabled = !controls || c.status !== "stored";
  document.getElementById("e-arm").disabled = !controls || e.live_armed || !e.enabled;
  document.getElementById("e-disarm").disabled = !controls || !e.live_armed;

  fill("intents", table(["Created", "Id", "Kind", "Side", "Volume", "SL", "TP", "Status", "Result"],
    (b.intents || []).map((i) => [time(i.created_ms), i.id, i.kind, i.side || "—", i.volume != null ? num(i.volume) : "—", i.sl != null ? num(i.sl, 3) : "—", i.tp != null ? num(i.tp, 3) : "—",
      el("span", { class: INTENT_TONE[i.status] || "" }, i.status), i.result ? (i.result.ok ? `ticket ${i.result.ticket ?? "?"}` : i.result.error || "failed") : "—"]),
    "No intent yet."));
  fill("omega-events", table(["At", "By", "Action", "Detail"],
    (b.events || []).map((x) => [time(x.ms), x.actor, x.action, x.detail ? JSON.stringify(x.detail).slice(0, 160) : "—"]),
    "No engine event yet."));
}

async function send(path, method, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const headers = { accept: "application/json" };
    if (body != null) headers["content-type"] = "application/json";
    const r = await fetch(path, { method, credentials: "same-origin", headers, body: body == null ? undefined : JSON.stringify(body), signal: ctrl.signal });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || out.ok === false) throw new Error(out.error || `HTTP ${r.status}`);
    return out;
  } finally { clearTimeout(timer); }
}
function say(id, cls, text) { const m = document.getElementById(id); m.className = `msg ${cls}`; m.textContent = text; }

async function connectBroker() {
  const server = document.getElementById("b-server").value.trim();
  const login = document.getElementById("b-login").value.trim();
  const password = document.getElementById("b-password").value;
  if (!server || !login || !password) { say("broker-msg", "warn", "Fill in the server, login and password."); return; }
  say("broker-msg", "", "Encrypting…");
  try {
    const kr = await fetch("./api/bridge/key", { headers: { accept: "application/json" }, credentials: "same-origin" });
    const key = await kr.json().catch(() => ({}));
    if (!kr.ok) throw new Error(key.error || `HTTP ${kr.status}`);
    const envelope = await buildEnvelope(key.public_key, key.kid, { server, login, password });
    const out = await send("./api/connection", "POST", { server, envelope });
    say("broker-msg", "ok", `Stored v${out.version} for ${out.server}. The bridge logs the terminal in at its next sync.`);
  } catch (e) {
    say("broker-msg", "bad", `Refused: ${e.message}`);
  } finally {
    for (const id of ["b-login", "b-password"]) document.getElementById(id).value = "";
    await load();
  }
}

async function disconnectBroker() {
  const reason = "disconnect requested from omega page";
  say("broker-msg", "", "Disconnecting…");
  send(`./api/connection?disconnect=1&reason=${encodeURIComponent(reason)}`, "GET")
    .then(() => { say("broker-msg", "ok", "Disconnected."); load(); })
    .catch((e) => { say("broker-msg", "bad", `Refused: ${e.message}`); load(); });
}

async function saveEngine(extra = {}) {
  const n = (id) => { const v = document.getElementById(id).value; return v === "" ? undefined : Number(v); };
  const body = {
    enabled: document.getElementById("e-enabled").checked,
    policy_auto: document.getElementById("e-policy-auto").checked,
    risk_pct: n("e-risk"), max_positions: n("e-maxpos"), max_daily_loss_pct: n("e-loss"), max_spread_points: n("e-spread"), max_signal_age_min: n("e-age"),
    ...extra
  };
  try {
    await send("./api/settings", "POST", body);
    engineDirty = false;
    say("engine-msg", "ok", extra.live_armed === true ? "Live armed." : extra.live_armed === false ? "Live disarmed." : "Saved.");
  } catch (e) { say("engine-msg", "bad", `Refused: ${e.message}`); }
  await load();
}

async function load() {
  try {
    const r = await fetch("./api/overview", { headers: { accept: "application/json" }, credentials: "same-origin" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    render(await r.json());
  } catch (e) {
    document.getElementById("updated").textContent = `error (${e.message})`;
  }
}

async function setControl(mode, confirm) {
  const msg = document.getElementById("control-msg");
  const reason = document.getElementById("reason").value.trim();
  if (mode !== "active" && !reason) { msg.className = "msg warn"; msg.textContent = "Write a reason first."; return; }
  busy = true;
  msg.className = "msg"; msg.textContent = "Sending…";
  try {
    const r = await fetch("./api/control", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reason, confirm }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) throw new Error(body.error || `HTTP ${r.status}`);
    msg.className = "msg ok"; msg.textContent = `Control set to ${mode}. The EA applies it at its next poll.`;
    document.getElementById("reason").value = "";
  } catch (e) {
    msg.className = "msg bad"; msg.textContent = `Refused: ${e.message}`;
  } finally {
    busy = false;
    await load();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const confirmBox = document.querySelector(".kill-confirm");
  for (const b of document.querySelectorAll("#control-form button[data-mode]")) {
    b.addEventListener("click", () => {
      if (b.dataset.mode === "killed") { confirmBox.hidden = false; document.getElementById("confirm").focus(); return; }
      setControl(b.dataset.mode);
    });
  }
  document.getElementById("kill-go").addEventListener("click", () => {
    const typed = document.getElementById("confirm").value.trim();
    if (typed !== "KILL") { const m = document.getElementById("control-msg"); m.className = "msg warn"; m.textContent = "Type KILL exactly."; return; }
    confirmBox.hidden = true; document.getElementById("confirm").value = "";
    setControl("killed", "KILL");
  });
  document.getElementById("kill-cancel").addEventListener("click", () => { confirmBox.hidden = true; document.getElementById("confirm").value = ""; });
  document.getElementById("control-form").addEventListener("submit", (e) => e.preventDefault());

  document.getElementById("broker-form").addEventListener("submit", (e) => { e.preventDefault(); connectBroker(); });
  document.getElementById("b-disconnect").addEventListener("click", disconnectBroker);
  const engineForm = document.getElementById("engine-form");
  engineForm.addEventListener("input", () => { engineDirty = true; });
  engineForm.addEventListener("submit", (e) => { e.preventDefault(); saveEngine(); });
  const liveBox = document.querySelector(".live-confirm");
  document.getElementById("e-arm").addEventListener("click", () => { liveBox.hidden = false; document.getElementById("e-live").focus(); });
  document.getElementById("e-live-cancel").addEventListener("click", () => { liveBox.hidden = true; document.getElementById("e-live").value = ""; });
  document.getElementById("e-live-go").addEventListener("click", () => {
    const typed = document.getElementById("e-live").value.trim();
    if (typed !== "LIVE") { say("engine-msg", "warn", "Type LIVE exactly."); return; }
    liveBox.hidden = true; document.getElementById("e-live").value = "";
    saveEngine({ live_armed: true, confirm: "LIVE" });
  });
  document.getElementById("e-disarm").addEventListener("click", () => saveEngine({ live_armed: false }));
  load();
  setInterval(load, POLL_MS);
});
