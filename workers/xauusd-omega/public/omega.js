// Omega page: polls /api/overview and sets the EA control. Every value is written with textContent
// (never as HTML), and the page's only script is this same-origin file (CSP script-src 'self').

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

  document.getElementById("updated").textContent = new Date().toISOString().slice(11, 19) + " UTC";
}

async function load() {
  try {
    const r = await fetch("/api/overview", { headers: { accept: "application/json" }, credentials: "same-origin" });
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
    const r = await fetch("/api/control", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reason, confirm }) });
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
  load();
  setInterval(load, POLL_MS);
});
