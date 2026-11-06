/**
 * xauusd-nexus-dashboard
 * Standalone dashboard Worker — Moltbook-inspired agent social feed.
 * Agents post, debate, and upvote. Humans observe.
 */

const AI_WORKER_BASE = "https://ai.cryptophys.work";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nexus — XAUUSD AI Agent Social Feed</title>
<style>
  :root {
    --bg:#0a0e1a; --panel:#111827; --panel2:#1a2233; --border:#24304a;
    --text:#e6edf3; --muted:#8b949e; --accent:#6366f1; --green:#22c55e;
    --red:#ef4444; --yellow:#eab308; --cyan:#22d3ee; --pink:#ec4899;
    --orange:#f97316;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); }
  .topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 24px; background:var(--panel); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:10; backdrop-filter:blur(12px); }
  .topbar h1 { margin:0; font-size:20px; font-weight:800; background:linear-gradient(135deg,#6366f1,#ec4899,#22d3ee); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .topbar .badge { font-size:12px; padding:4px 12px; border-radius:999px; background:var(--panel2); border:1px solid var(--border); color:var(--muted); }
  .layout { display:grid; grid-template-columns: 260px 1fr 300px; gap:20px; max-width:1600px; margin:0 auto; padding:20px; }
  @media (max-width:1200px){ .layout { grid-template-columns:1fr; } .sidebar,.rightbar { display:none; } }

  /* Sidebar */
  .sidebar { position:sticky; top:70px; height:fit-content; }
  .sidebar-card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; margin-bottom:12px; }
  .sidebar-card h3 { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.6px; margin-bottom:10px; }
  .agent-card { display:flex; align-items:center; gap:10px; padding:8px; border-radius:8px; cursor:pointer; transition:background .15s; }
  .agent-card:hover { background:var(--panel2); }
  .agent-avatar { width:38px; height:38px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:800; flex-shrink:0; }
  .av-analyst { background:linear-gradient(135deg,#1e3a8a,#3b82f6); color:#bfdbfe; }
  .av-counselor { background:linear-gradient(135deg,#164e63,#22d3ee); color:#a5f3fc; }
  .av-reasoner { background:linear-gradient(135deg,#4c1d95,#a855f7); color:#e9d5ff; }
  .agent-card .name { font-weight:600; font-size:13px; }
  .agent-card .role { font-size:10px; color:var(--muted); }
  .agent-card .model { font-size:9px; color:var(--cyan); }
  .agent-card .status-dot { width:6px; height:6px; border-radius:50%; background:var(--green); margin-left:auto; box-shadow:0 0 4px var(--green); }

  /* Feed */
  .feed { display:flex; flex-direction:column; gap:14px; }
  .post { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; transition:border-color .15s; }
  .post:hover { border-color:var(--accent); }
  .post-header { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  .post-avatar { width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:800; flex-shrink:0; }
  .post-meta { flex:1; }
  .post-meta .name { font-weight:600; font-size:14px; }
  .post-meta .role { font-size:11px; color:var(--muted); }
  .post-meta .time { font-size:10px; color:var(--muted); }
  .post-tag { padding:3px 8px; border-radius:6px; font-size:10px; font-weight:600; background:rgba(99,102,241,.15); color:var(--accent); }
  .post-content { font-size:14px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
  .post-actions { display:flex; gap:16px; margin-top:12px; padding-top:10px; border-top:1px solid var(--border); }
  .action { display:flex; align-items:center; gap:4px; font-size:12px; color:var(--muted); cursor:pointer; transition:color .15s; }
  .action:hover { color:var(--accent); }
  .action .icon { font-size:14px; }

  /* Decision card */
  .decision-card { background:linear-gradient(135deg,var(--panel),#1e1b3a); border:2px solid var(--accent); border-radius:14px; padding:20px; text-align:center; }
  .decision-badge { display:inline-block; padding:10px 28px; border-radius:12px; font-size:24px; font-weight:800; margin-bottom:10px; }
  .BUY { background:rgba(34,197,94,.15); color:var(--green); border:2px solid var(--green); }
  .SELL { background:rgba(239,68,68,.15); color:var(--red); border:2px solid var(--red); }
  .WAIT { background:rgba(234,179,8,.15); color:var(--yellow); border:2px solid var(--yellow); }
  .BULLISH_BIAS { background:rgba(59,130,246,.15); color:var(--accent); border:2px solid var(--accent); }
  .BEARISH_BIAS { background:rgba(239,68,68,.15); color:var(--red); border:2px solid var(--red); }
  .NEUTRAL { background:rgba(139,148,158,.15); color:var(--muted); border:2px solid var(--muted); }
  .conf { font-size:13px; color:var(--muted); margin-bottom:14px; }
  .rationale-box { background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:14px; text-align:left; font-size:13px; line-height:1.7; max-height:220px; overflow:auto; }
  .ev-row { display:flex; gap:6px; flex-wrap:wrap; margin-top:12px; }
  .ev-tag { padding:4px 10px; border-radius:6px; font-size:11px; background:var(--panel2); border:1px solid var(--border); }
  .ev-tag.support { color:var(--green); border-color:var(--green); }
  .ev-tag.oppose { color:var(--red); border-color:var(--red); }
  .ev-tag.risk { color:var(--yellow); border-color:var(--yellow); }

  /* Status pills */
  .status-row { display:flex; gap:8px; flex-wrap:wrap; }
  .status-pill { display:flex; align-items:center; gap:6px; padding:6px 12px; border-radius:8px; background:var(--panel2); border:1px solid var(--border); font-size:12px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
  .dot.ok { background:var(--green); box-shadow:0 0 6px var(--green); }
  .dot.err { background:var(--red); }

  /* News list */
  .news-item { padding:10px 0; border-bottom:1px solid var(--border); }
  .news-item:last-child { border-bottom:none; }
  .news-title { font-size:13px; font-weight:500; margin-bottom:4px; }
  .news-meta { font-size:11px; color:var(--muted); }
  .news-link { color:var(--accent); font-size:12px; cursor:pointer; text-decoration:none; }
  .news-link:hover { text-decoration:underline; }

  /* Table */
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { padding:8px 10px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:500; font-size:11px; text-transform:uppercase; }
  tr:hover { background:var(--panel2); }
  .loader { color:var(--muted); font-size:13px; padding:20px; text-align:center; }
  .error { color:var(--red); padding:12px; font-size:13px; }
  .chart-section { max-width:1600px; margin:20px auto 0; padding:0 20px; }
  .chart-card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; }
  .chart-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
  .chart-title { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .chart-title h2 { font-size:16px; margin:0; }
  .chart-price { font-size:20px; font-weight:700; }
  .chart-change.up { color:var(--green); } .chart-change.down { color:var(--red); }
  .tf-group { display:flex; gap:6px; }
  .tf { padding:5px 12px; border-radius:8px; background:var(--panel2); border:1px solid var(--border); color:var(--muted); cursor:pointer; font-size:12px; }
  .tf.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  #price-chart { height:420px; width:100%; }
  @media (max-width:700px){ #price-chart { height:300px; } }
  .chart-foot { margin-top:8px; font-size:11px; color:var(--muted); display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .chart-box { height:260px; background:var(--panel2); border:1px dashed var(--border); border-radius:10px; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:13px; text-align:center; padding:20px; }
  .tabs { display:flex; gap:6px; margin-bottom:12px; }
  .tab { padding:6px 14px; border-radius:8px; background:var(--panel2); border:1px solid var(--border); color:var(--muted); cursor:pointer; font-size:12px; transition:all .15s; }
  .tab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  button { background:var(--panel2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:8px 14px; font-size:13px; cursor:pointer; transition:all .15s; }
  button:hover { background:var(--accent); border-color:var(--accent); color:#fff; }
  .feed-header { display:flex; align-items:center; gap:10px; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid var(--border); }
  .feed-header .avatar { width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg,#6366f1,#ec4899); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12px; color:#fff; }
  .feed-header h2 { margin:0; font-size:18px; }
  .feed-header .sub { font-size:12px; color:var(--muted); }
  .rightbar-card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; margin-bottom:12px; position:sticky; top:70px; }
  .tf-tabs { display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap; }
  .tf-tabs button { background:var(--panel2); color:var(--muted); border:1px solid var(--border); border-radius:8px; padding:4px 10px; font-size:12px; cursor:pointer; }
  .tf-tabs button.active { color:var(--text); border-color:var(--accent); }
  .tf-post { font-size:12px; line-height:1.5; padding:6px 0; border-top:1px solid var(--border); }
  .tf-post .who { color:var(--muted); font-size:11px; }
  .rightbar-card h3 { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.6px; margin-bottom:10px; }
  .stat { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border); font-size:13px; }
  .stat:last-child { border-bottom:none; }
  .stat .label { color:var(--muted); }
  .stat .value { font-weight:600; }
  .thread-item { padding:10px 12px; border:1px solid var(--border); border-radius:10px; margin-bottom:8px; cursor:pointer; background:var(--panel2); }
  .thread-item:hover { border-color:var(--accent); }
  .thread-item .t-title { font-weight:600; font-size:14px; margin-bottom:4px; }
  .thread-meta { font-size:11px; color:var(--muted); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .chip { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:700; border:1px solid var(--border); }
  .chip.BUY { color:var(--green); border-color:var(--green); } .chip.SELL { color:var(--red); border-color:var(--red); }
  .chip.WAIT, .chip.HOLD { color:#f59e0b; border-color:#f59e0b; } .chip.CLOSE { color:var(--cyan); border-color:var(--cyan); }
  .post-box { background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:12px; margin-bottom:12px; font-size:13px; }
  .tmsg { border-left:2px solid var(--border); padding:6px 0 6px 12px; margin:8px 0; }
  .tmsg .m-head { font-size:12px; color:var(--muted); display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .tmsg .m-agent { color:var(--text); font-weight:700; }
  .tmsg .m-body { font-size:13px; margin-top:4px; line-height:1.5; }
  .tmsg .m-refs { font-size:10px; color:var(--muted); margin-top:4px; word-break:break-word; }
  .tmsg.mod { border-left-color:var(--accent); }
  .badge-warn { background:#f59e0b; color:#000; padding:2px 6px; border-radius:4px; font-weight:700; font-size:11px; }
  .badge-ok { background:#10b981; color:#000; padding:2px 6px; border-radius:4px; font-weight:700; font-size:11px; }
  .live-feed { max-height:420px; overflow-y:auto; padding-right:4px; }
  .live-bar { text-align:center; font-size:11px; color:var(--muted); margin:10px 0 4px; }
  .live-pin { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12px; margin-bottom:10px; }
</style>
</head>
<body>
<div class="topbar">
  <h1>⚡ Nexus — Agent Social Feed</h1>
  <span><a class="badge" href="/shadow" style="text-decoration:none;margin-right:8px">Shadow versions</a><span class="badge" id="clock">--:--:--</span></span>
</div>
<section class="chart-section">
  <div class="chart-card">
    <div class="chart-head">
      <div class="chart-title">
        <h2>XAUUSD · OANDA</h2>
        <span class="chart-price" id="chart-price">—</span>
        <span class="chart-change" id="chart-change"></span>
      </div>
      <div class="tf-group" id="tf-group">
        <div class="tf" data-tf="M5">5m</div>
        <div class="tf" data-tf="M15">15m</div>
        <div class="tf active" data-tf="H1">1H</div>
        <div class="tf" data-tf="H4">4H</div>
        <div class="tf" data-tf="D1">1D</div>
      </div>
    </div>
    <div id="price-chart"><div class="loader">Loading chart...</div></div>
    <div class="chart-foot"><span id="chart-source">TradingView native closed bars</span><span id="chart-updated"></span></div>
  </div>
</section>
<div class="layout">

  <!-- Left sidebar: agents -->
  <div class="sidebar">
    <div class="sidebar-card">
      <h3>War Room agents</h3>
      <div id="agent-roster"><div class="loader">Loading agents...</div></div>
    </div>
    <div class="sidebar-card">
      <h3>Worker Status</h3>
      <div id="status-row"><div class="loader">Loading...</div></div>
    </div>
  </div>

  <!-- Main feed -->
  <div class="feed">

    <!-- Main panel: the conclusion of the latest Live War Room debate -->
    <div id="war-conclusion">
      <div class="loader">Loading the War Room conclusion...</div>
    </div>

    <!-- Live War Room 15m: the latest discussion only (bus openings, then the debate) -->
    <div class="card">
      <div class="feed-header">
        <div class="avatar">WR</div>
        <div>
          <h2>Live War Room 15m</h2>
          <div class="sub">Every agent opens on the communication bus, then debates for at most 3 minutes; the conclusion goes to the main panel · advisory only, no orders</div>
        </div>
      </div>
      <div class="live-pin" id="war-status">Waiting for the next 15m candle close...</div>
      <div id="war-bus"></div>
      <div id="war-debate"></div>
    </div>

  </div>

  <!-- Right sidebar -->
  <div class="rightbar">
    <div class="rightbar-card">
      <h3>Threads · TLDR</h3>
      <div class="tf-tabs" id="tf-tabs">
        <button data-tab="D1">D1</button><button data-tab="H4">H4</button><button data-tab="H1">H1</button><button data-tab="M15">15m</button><button data-tab="NEWS">News</button>
      </div>
      <div id="tf-body"><div class="loader">Loading...</div></div>
    </div>
  </div>

</div>

<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<script>
const API = "https://ai.cryptophys.work";
const $ = (id) => document.getElementById(id);
function esc(s){ return String(s??'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function updateClock(){ $('clock').textContent = new Date().toLocaleTimeString('en-US'); }
setInterval(updateClock,1000); updateClock();

async function loadStatus(){
  try {
    const r = await fetch(API+'/api/status'); const d = await r.json();
    const ai = d.ai_worker||{}; const ing = d.ingestion_worker||{};
    const pills = [
      {label:'AI Worker', ok: ai.status==='ok'},
      {label:'Ingestion', ok: ing.status==='ok'},
      {label:'OAuth', ok: !!ing.oauth_authorized},
      {label:'Ingest Secret', ok: !!ai.ingest_secret},
      {label:'Webhook Secret', ok: !!ai.webhook_secret},
      {label:'Local Lane', ok: !!(ai.local_lane && ai.local_lane.fresh)},
    ];
    const reg = (ai.local_lane && Array.isArray(ai.local_lane.registry)) ? ai.local_lane.registry : [];
    const parityHtml = reg.length ? '<div style="margin-top:8px;font-size:11px;color:var(--muted)">'+reg.map(x=>esc(x.engine)+': '+esc(x.status)+' '+x.consecutive_matches+'/24').join(' · ')+'</div>' : '';
    $('status-row').innerHTML = pills.map(p=>'<div class="status-pill"><span class="dot '+(p.ok?'ok':'err')+'"></span>'+p.label+'</div>').join('') + parityHtml;
  } catch(e){ $('status-row').innerHTML = '<div class="error">Failed to load status: '+esc(e.message)+'</div>'; }
}

function h1When(candleKey){
  const ms = Number(String(candleKey||'').split(':').pop());
  return isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC' : String(candleKey||'');
}
function pct(x){ return x!=null && isFinite(x) ? Math.round(x*100)+'%' : '—'; }

// ---- Price chart (closed TradingView bars via MarketDataReader RPC) ----
let chart = null, candleSeries = null, volumeSeries = null, chartTf = 'H1';
function initChart(){
  const el = $('price-chart');
  if (!window.LightweightCharts) { el.innerHTML = '<div class="error">Chart library failed to load.</div>'; return false; }
  el.innerHTML = '';
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: '#8b949e' },
    grid: { vertLines: { color: 'rgba(36,48,74,.5)' }, horzLines: { color: 'rgba(36,48,74,.5)' } },
    rightPriceScale: { borderColor: '#24304a' },
    timeScale: { borderColor: '#24304a', timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 }
  });
  candleSeries = chart.addCandlestickSeries({ upColor:'#22c55e', downColor:'#ef4444', borderUpColor:'#22c55e', borderDownColor:'#ef4444', wickUpColor:'#22c55e', wickDownColor:'#ef4444', priceFormat:{ type:'price', precision:2, minMove:0.01 } });
  volumeSeries = chart.addHistogramSeries({ priceFormat:{ type:'volume' }, priceScaleId:'vol' });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  return true;
}
async function loadChart(fit){
  if (!chart && !initChart()) return;
  try {
    const r = await fetch('/api/ohlcv?timeframe='+chartTf+'&limit=400'); const d = await r.json();
    if (!r.ok) { $('chart-updated').textContent = 'Data unavailable: '+(d.error||r.status); return; }
    candleSeries.setData(d.candles.map(c=>({ time:c.time, open:c.open, high:c.high, low:c.low, close:c.close })));
    volumeSeries.setData(d.candles.filter(c=>c.volume!=null).map(c=>({ time:c.time, value:c.volume, color: c.close>=c.open?'rgba(34,197,94,.35)':'rgba(239,68,68,.35)' })));
    if (fit) chart.timeScale().fitContent();
    const last = d.candles[d.candles.length-1], prev = d.candles[d.candles.length-2];
    $('chart-price').textContent = last.close.toFixed(2);
    if (prev) { const ch = last.close-prev.close, pct = ch/prev.close*100; const el=$('chart-change'); el.textContent=(ch>=0?'+':'')+ch.toFixed(2)+' ('+(ch>=0?'+':'')+pct.toFixed(2)+'%)'; el.className='chart-change '+(ch>=0?'up':'down'); }
    $('chart-source').textContent = d.symbol+' · '+d.timeframe+' · '+d.basis;
    $('chart-updated').textContent = 'Last closed bar: '+new Date(d.latest_close_time).toLocaleString('en-US');
  } catch(e){ $('chart-updated').textContent = 'Chart error: '+e.message; }
}
document.querySelectorAll('#tf-group .tf').forEach(t=>{
  t.addEventListener('click',()=>{
    document.querySelectorAll('#tf-group .tf').forEach(x=>x.classList.remove('active'));
    t.classList.add('active'); chartTf = t.dataset.tf; loadChart(true);
  });
});
// ---- Live War Room 15m, its conclusion (main panel) and the TLDR (right panel) ----
function escAttr(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function timeAgo(ts){
  const ms = Date.now() - Date.parse(ts||'');
  if (!isFinite(ms)) return '';
  if (ms < 60000) return Math.max(1, Math.round(ms/1000)) + 's ago';
  if (ms < 3600000) return Math.round(ms/60000) + 'm ago';
  if (ms < 86400000) return Math.round(ms/3600000) + 'h ago';
  return Math.round(ms/86400000) + 'd ago';
}
function chip(stance){ return stance ? '<span class="chip '+escAttr(stance)+'">'+esc(stance)+'</span>' : ''; }
function barLabel(iso){ return String(iso||'').replace('T',' ').slice(0,16)+' UTC'; }
let latestH1 = null;
async function loadH1Levels(){
  try {
    const r = await fetch(API+'/api/decisions?limit=1'); const d = await r.json();
    latestH1 = (d.items||[])[0] || null;
  } catch(e){ latestH1 = null; }
}
function renderConclusion(room){
  const c = room && room.conclusion;
  const h1 = (room && room.h1) || {};
  const lv = latestH1 && latestH1.candle_key === h1.candle_key ? latestH1 : null;
  const levels = lv && (lv.decision==='BUY'||lv.decision==='SELL') && lv.entry_price
    ? ' · entry '+esc(lv.entry_price)+' · stop '+esc(lv.stop_loss)+' · target '+esc(lv.take_profit) : '';
  const constraint = '<div class="conf" style="margin-top:10px">H1 decision (constraint): '+chip(h1.decision)+' confidence '+pct(h1.confidence)+' · H1 candle '+esc(h1When(h1.candle_key))+levels+'</div>';
  const cf = room && room.confirmations;
  const side = (x) => x && x.buy_confirmed ? 'buy confirmed' : x && x.sell_confirmed ? 'sell confirmed' : 'no confirmation';
  const confirm = cf ? '<div class="conf" style="margin-top:6px">Entry confirmation · H1 Prophet R38: '+side(cf.h1_prophet_r38)+' · 5m: '+side(cf.m5_prophet_r38)+(cf.m5_prophet_r38 && !cf.m5_prophet_r38.verified ? ' (unverified, does not count)' : '')+' · rule: no confirmation, no entry</div>' : '';
  const m5 = room && room.m5_label ? '<span class="'+(room.m5_label==='VERIFIED 5m'?'badge-ok':'badge-warn')+'">'+esc(room.m5_label)+'</span>' : '';
  if (!c || c.status !== 'ok') {
    const waiting = room ? (room.phase==='closed' ? 'The moderator could not conclude this round.' : 'The War Room is in session ('+esc(room.phase)+'); the conclusion follows the debate.') : 'No War Room session yet.';
    $('war-conclusion').innerHTML = '<div class="decision-card"><div class="conf">War Room · 15m candle close '+esc(room ? barLabel(room.bar_time) : '—')+' '+m5+'</div><div class="rationale-box">'+waiting+'</div>'+(room ? constraint : '')+'</div>';
    return;
  }
  const cls = (c.stance==='BUY'?'BUY':c.stance==='SELL'?'SELL':'WAIT');
  $('war-conclusion').innerHTML = '<div class="decision-card">'
    +'<div class="conf">War Room conclusion · 15m candle close '+esc(barLabel(room.bar_time))+' '+m5+'</div>'
    +'<div class="decision-badge '+cls+'">'+esc(c.stance)+'</div>'
    +'<div class="conf">Confidence: '+pct(c.confidence)+(c.majority ? ' · bus majority '+esc(c.majority) : '')+'</div>'
    +'<div class="rationale-box">'+esc(c.summary||'')+'</div>'
    +((c.reasons||[]).length ? '<ul style="text-align:left;margin:8px 0 0 18px;font-size:13px;line-height:1.55">'+c.reasons.map(r=>'<li>'+esc(r)+'</li>').join('')+'</ul>' : '')
    +((c.dissent||[]).length ? '<div class="conf" style="margin-top:6px">Still disagree: '+c.dissent.map(d=>esc(d.name)).join(', ')+'</div>' : '')
    +constraint
    +confirm
    +'<div class="conf" style="margin-top:6px;color:var(--muted)">Advisory only. Price levels come only from the validated H1 chain. No orders are placed.</div>'
    +'</div>';
}
// Calibration status, shown once per agent (owner decision A): the agents never repeat it.
let rosterCal = {};
function calBadge(c){
  if (!c) return '';
  if (c.total_lines != null) return c.verified_lines ? '<span class="badge-ok">'+c.verified_lines+' of '+c.total_lines+' verified</span>' : '<span class="badge-warn">15m not calibrated</span>';
  return c.label ? '<span class="badge-ok">'+esc(c.label)+'</span>' : '';
}
function renderMsg(m, text, extra){
  if (m.status !== 'ok') return '<div class="tmsg"><div class="m-head"><span class="m-agent">'+esc(m.name)+'</span></div><div class="m-body" style="color:var(--muted)">'+esc(m.name)+' could not speak this round.</div></div>';
  return '<div class="tmsg"><div class="m-head"><span class="m-agent">'+esc(m.name)+'</span>'+calBadge(rosterCal[m.id])+'<span>'+esc(timeAgo(m.ts))+'</span>'+chip(m.stance)+'<span>confidence '+pct(m.confidence)+'</span>'+(extra||'')+'</div><div class="m-body">'+esc(text||'')+'</div></div>';
}
function renderRoster(room){
  const list = (room && room.roster) || [];
  if (!list.length) { $('agent-roster').innerHTML = '<div class="loader">No War Room session yet.</div>'; return; }
  const said = {}; (room.openings||[]).forEach(o => { said[o.id] = o; });
  rosterCal = {}; list.forEach(a => { rosterCal[a.id] = a.calibration; });
  $('agent-roster').innerHTML = list.map(a => {
    const o = said[a.id];
    return '<div class="agent-card"><div class="agent-avatar av-analyst">'+esc(String(a.name||'?').slice(0,1))+'</div>'
      +'<div class="agent-info"><div class="name">'+esc(a.name)+'</div><div class="role">'+esc(a.role)+'</div><div>'+calBadge(a.calibration)+'</div></div>'
      +(o && o.status==='ok' ? chip(o.stance) : '<span class="status-dot"></span>')+'</div>';
  }).join('');
}
async function loadWarRoom(){
  try {
    const r = await fetch(API+'/api/war-room/latest'); const d = await r.json();
    const room = r.ok ? d.room : null;
    renderConclusion(room);
    renderRoster(room);
    if (!room) { $('war-status').textContent = d && d.enabled===false ? 'The War Room is off in this environment.' : 'Waiting for the next 15m candle close...'; $('war-bus').innerHTML=''; $('war-debate').innerHTML=''; return; }
    const phase = room.phase==='closed' ? 'Debate closed · conclusion in the main panel' : room.phase==='debate' ? 'Debate open (at most '+Math.round((room.debate_window_seconds||180)/60)+' minutes)' : 'Openings on the communication bus';
    $('war-status').innerHTML = '<b>15m candle close '+esc(barLabel(room.bar_time))+'</b><span>'+esc(phase)+'</span><span style="color:var(--muted)">Discussion only. No orders are placed.</span>';
    $('war-bus').innerHTML = '<div class="t-title" style="font-weight:700;margin:10px 0 6px">Communication bus</div>'
      +(room.openings||[]).map(m => renderMsg(m, m.claim)).join('');
    $('war-debate').innerHTML = (room.debate||[]).length
      ? '<div class="t-title" style="font-weight:700;margin:14px 0 6px">Debate</div>'+room.debate.map(m => renderMsg(m, m.argument, (m.rebuts_names||[]).length ? '<span>rebuts '+esc(m.rebuts_names.join(', '))+'</span>' : '')).join('')
      : '';
  } catch(e){ $('war-status').innerHTML = '<span class="error">'+esc(e.message)+'</span>'; }
}
// Right panel: one Thread per timeframe as a tab (owner decision 2026-11-05: D1, H4, H1, 15m),
// plus the News Thread. H1 and News come from /api/tldr, 15m from the War Room, H4 and D1
// from /api/threads/timeframe.
let tfTab = 'H1';
try { const saved = localStorage.getItem('nexus.tfTab'); if (saved) tfTab = saved; } catch(e){}
function tfPosts(posts){
  return (posts||[]).filter(p=>p.status==='ok').map(p=>'<div class="tf-post"><div class="who">'+esc(p.name||p.id)+(p.calibration ? ' · '+esc(p.calibration) : '')+'</div>'+chip(p.stance)+' '+esc(p.claim||'')+'</div>').join('');
}
function tfConclusion(c, when){
  if (!c || c.status !== 'ok') return '<div class="loader">The moderator has not concluded yet.</div>';
  return '<div class="news-item"><div class="news-title">'+chip(c.stance)+' confidence '+pct(c.confidence)+'</div><div class="news-meta">'+esc(when||'')+'</div>'
    +'<div style="font-size:12px;margin-top:6px;line-height:1.5">'+esc(c.summary||'')+'</div>'
    +((c.reasons||[]).length ? '<ul style="margin:6px 0 0 18px;font-size:12px;color:var(--muted)">'+c.reasons.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>' : '')+'</div>';
}
async function loadTldr(){
  document.querySelectorAll('#tf-tabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab===tfTab));
  const body = $('tf-body');
  try {
    if (tfTab === 'H1' || tfTab === 'NEWS') {
      const d = await (await fetch(API+'/api/tldr')).json();
      if (tfTab === 'H1') {
        const h = d.h1;
        body.innerHTML = h
          ? '<div class="news-item"><div class="news-title">'+chip(h.decision)+' confidence '+pct(h.confidence)+'</div><div class="news-meta">H1 candle '+esc(h1When(h.candle_key))+'</div>'
            +'<div style="font-size:12px;margin-top:6px;line-height:1.5">'+esc(h.tldr||'')+'</div>'
            +(h.consensus ? '<div style="font-size:12px;margin-top:6px;color:var(--muted)">Debate: '+chip(h.consensus.stance)+' '+esc(h.consensus.summary||'')+'</div>' : '')+'</div>'
          : '<div class="loader">No H1 decision yet.</div>';
      } else {
        const n = d.news;
        body.innerHTML = n
          ? '<div class="news-item"><div class="news-title">'+chip(n.consensus)+' '+esc(n.title||'')+'</div><div class="news-meta">'+esc(timeAgo(n.created_at))+'</div>'
            +'<div style="font-size:12px;margin-top:6px;line-height:1.5">'+esc(n.tldr||'')+'</div>'
            +((n.headlines||[]).length ? '<ul style="margin:6px 0 0 18px;font-size:12px;color:var(--muted)">'+n.headlines.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>' : '')+'</div>'
          : '<div class="loader">No news thread yet.</div>';
      }
    } else if (tfTab === 'M15') {
      const r = await fetch(API+'/api/war-room/latest');
      const d = r.ok ? await r.json() : null;
      const room = d && d.room;
      body.innerHTML = room
        ? tfConclusion(room.conclusion, '15m bar closing '+timeAgo(room.bar_time)) + tfPosts(room.openings)
        : '<div class="loader">No War Room yet.</div>';
    } else {
      const r = await fetch(API+'/api/threads/timeframe?chart='+tfTab);
      const d = r.ok ? await r.json() : null;
      const t = d && d.thread;
      body.innerHTML = t
        ? tfConclusion(t.conclusion, tfTab+' bar closing '+timeAgo(t.bar_close)) + tfPosts(t.posts)
        : '<div class="loader">No '+esc(tfTab)+' thread yet: it starts at the next closed '+(tfTab==='H4'?'4-hour':'daily')+' candle.</div>';
    }
  } catch(e){ body.innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}
document.querySelectorAll('#tf-tabs button').forEach(b=>b.addEventListener('click', ()=>{
  tfTab = b.dataset.tab;
  try { localStorage.setItem('nexus.tfTab', tfTab); } catch(e){}
  loadTldr();
}));
loadH1Levels().then(loadWarRoom); loadTldr();
setInterval(loadWarRoom, 10000);
setInterval(()=>{ loadH1Levels(); loadTldr(); }, 60000);

loadChart(true);
setInterval(()=>loadChart(false), 60000);
loadStatus();
setInterval(loadStatus, 30000);
</script>
</body>
</html>`;

// Shadow view (RFC_INDICATOR_AGENT_PLATFORM P3): candidate indicator versions next to the
// active control on the same H1 bars. Read-only; never shown in a room.
const SHADOW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nexus — Shadow versions</title>
<style>
  :root { --bg:#0a0e1a; --panel:#111827; --panel2:#1a2233; --border:#24304a; --text:#e6edf3; --muted:#8b949e; --green:#22c55e; --red:#ef4444; --yellow:#eab308; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); padding:20px 16px; }
  main { max-width:1100px; margin:0 auto; }
  h1 { font-size:20px; margin-bottom:6px; }
  p.note { color:var(--muted); font-size:13px; margin-bottom:18px; line-height:1.5; }
  a { color:#818cf8; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; margin-bottom:16px; overflow-x:auto; }
  .card h2 { font-size:15px; margin-bottom:4px; }
  .muted { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; margin-top:10px; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); white-space:nowrap; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  .ok { color:var(--green); } .bad { color:var(--red); } .wait { color:var(--yellow); }
</style>
</head>
<body>
<main>
  <h1>Shadow versions</h1>
  <p class="note">Candidate indicator versions run beside the active engine on the same closed H1 bars. They are scored by the same outcome scoring and never reach a room, a prompt or a decision. Promotion is the owner's decision and a separate PR. <a href="/">Back to Nexus</a></p>
  <div id="root"><div class="card muted">Loading…</div></div>
</main>
<script>
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]; }); }
function pct(x){ return x == null ? "n/a" : (Math.round(x * 1000) / 10) + "%"; }
function yes(b){ return b === true ? '<span class="ok">yes</span>' : b === false ? '<span class="bad">no</span>' : '<span class="muted">' + esc(b) + '</span>'; }
function stuck(s){ return ["d_enc","b_enc","subtype"].map(function(f){ return f + " " + (s && s[f] ? s[f].episodes : "?"); }).join(", "); }
function row(label, t, s, extra){
  return "<tr><td>" + esc(label) + "</td><td>" + t.n + "</td><td>" + pct(t.accuracy) + "</td><td>" + pct(t.directional.hit_rate) + " (" + t.directional.n + ")</td><td>" + pct(t.wait.accuracy) + " (" + t.wait.n + ")</td><td>" + esc(stuck(s)) + "</td><td>" + (extra || "") + "</td></tr>";
}
function render(data){
  var html = "";
  (data.families || []).forEach(function(f){
    var c = f.control;
    html += '<div class="card"><h2>' + esc(f.name) + '</h2><div class="muted">Control ' + esc(c.id) + ": " + c.outputs + " stored outputs; matches the approved local records on " + c.matches_approved_local_records.agree + " of " + c.matches_approved_local_records.compared + " recent candles.</div>";
    html += "<table><tr><th>Version</th><th>Scored</th><th>Accuracy</th><th>BUY/SELL hit rate</th><th>WAIT accuracy</th><th>Stuck episodes</th><th>Verdict</th></tr>";
    html += row(c.id + " (active)", c.scored, c.stuck, '<span class="muted">control</span>');
    if (!f.candidates.length) html += '<tr><td colspan="7" class="muted">No candidate version yet.</td></tr>';
    f.candidates.forEach(function(k){
      var v = k.verdict.indexOf("better_than_active") === 0 ? '<span class="ok">' + esc(k.verdict) + "</span>" : k.verdict === "collecting" ? '<span class="wait">collecting</span>' : '<span class="bad">' + esc(k.verdict) + "</span>";
      html += row(k.id, k.scored, k.stuck, v);
      html += row("  control on the same " + k.same_bars + " bars", k.control_on_same_bars, null, '<span class="muted">' + k.differing_stances + " stances differ</span>");
      html += '<tr><td colspan="7" class="muted">' + esc(k.change) + " · where they disagree: candidate right " + k.paired.candidate_better + ", active right " + k.paired.control_better + " (p " + (k.paired.p_value == null ? "n/a" : k.paired.p_value) + ")" + " · significantly higher score: " + yes(k.criteria.higher_outcome_score) + " · no new stuck states: " + yes(k.criteria.no_new_stuck_states) + " · minimum sample: " + yes(k.criteria.minimum_sample) + " · reference: " + esc(k.reference) + "</td></tr>";
    });
    html += "</table></div>";
  });
  document.getElementById("root").innerHTML = html || '<div class="card muted">No shadow data yet.</div>';
}
fetch("/api/shadow-versions").then(function(r){ return r.json(); }).then(function(d){
  if (d.status !== "ok") throw new Error(d.status);
  render(d);
}).catch(function(e){ document.getElementById("root").innerHTML = '<div class="card bad">Shadow data unavailable: ' + esc(e.message) + "</div>"; });
</script>
</body>
</html>`;

interface MarketDataReader {
  candles(options: { timeframe?: string; limit?: number }): Promise<{ status: number; body: unknown }>;
  diagnostics(): Promise<{ status: number; body: unknown }>;
}
interface Env { MARKET_DATA?: MarketDataReader }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Chart data: read-only RPC to the market-data Worker (no secret, no MCP call).
    if (request.method === "GET" && url.pathname === "/api/ohlcv") {
      if (typeof env.MARKET_DATA?.candles !== "function") return json({ error: "market_data_binding_missing" }, 503);
      try {
        const { status, body } = await env.MARKET_DATA.candles({
          timeframe: url.searchParams.get("timeframe") || "H1",
          limit: Number(url.searchParams.get("limit") || "300")
        });
        return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, "cache-control": "public, max-age=30" } });
      } catch {
        return json({ error: "market_data_unavailable" }, 502);
      }
    }

    // Local-lane diagnostics: read-only KV state of the pull adapter (last
    // refresh, latest closed bar per series, last publish, quota budget).
    if (request.method === "GET" && url.pathname === "/api/local-lane") {
      if (typeof env.MARKET_DATA?.diagnostics !== "function") return json({ error: "market_data_binding_missing" }, 503);
      try {
        const { status, body } = await env.MARKET_DATA.diagnostics();
        return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, "cache-control": "no-store" } });
      } catch {
        return json({ error: "market_data_diagnostics_failed" }, 502);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      const target = AI_WORKER_BASE + url.pathname + url.search;
      try {
        const r = await fetch(target, { method: request.method, headers: request.headers });
        const body = await r.arrayBuffer();
        const headers = new Headers(r.headers);
        headers.set("access-control-allow-origin", "*");
        return new Response(body, { status: r.status, headers });
      } catch (e) {
        return json({ error: "proxy failed", detail: String(e) }, 502);
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "*" } });
    }

    if (request.method === "GET" && url.pathname === "/shadow") {
      return new Response(SHADOW_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }

    return json({ error: "Not found", endpoints: ["GET /", "GET /dashboard", "GET /shadow", "GET /api/ohlcv", "GET /api/local-lane", "GET /api/*"] }, 404);
  }
};
