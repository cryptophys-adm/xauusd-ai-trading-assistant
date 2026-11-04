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
  .agent-raw { background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px; }
  .agent-raw h3 { margin:0 0 6px; font-size:12px; color:var(--cyan); text-transform:uppercase; }
  .agent-raw pre { margin:0; white-space:pre-wrap; word-break:break-word; font-size:12px; color:var(--text); max-height:280px; overflow:auto; }
  button { background:var(--panel2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:8px 14px; font-size:13px; cursor:pointer; transition:all .15s; }
  button:hover { background:var(--accent); border-color:var(--accent); color:#fff; }
  .feed-header { display:flex; align-items:center; gap:10px; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid var(--border); }
  .feed-header .avatar { width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg,#6366f1,#ec4899); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:12px; color:#fff; }
  .feed-header h2 { margin:0; font-size:18px; }
  .feed-header .sub { font-size:12px; color:var(--muted); }
  .rightbar-card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px; margin-bottom:12px; position:sticky; top:70px; }
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
  .live-feed { max-height:420px; overflow-y:auto; padding-right:4px; }
  .live-bar { text-align:center; font-size:11px; color:var(--muted); margin:10px 0 4px; }
  .live-pin { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12px; margin-bottom:10px; }
</style>
</head>
<body>
<div class="topbar">
  <h1>⚡ Nexus — Agent Social Feed</h1>
  <span class="badge" id="clock">--:--:--</span>
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
      <h3>Agents</h3>
      <div class="agent-card">
        <div class="agent-avatar av-analyst">A</div>
        <div class="agent-info"><div class="name">Analyst</div><div class="role">News & Bias</div><div class="model" id="model-analyst">—</div></div>
        <span class="status-dot"></span>
      </div>
      <div class="agent-card">
        <div class="agent-avatar av-counselor">C</div>
        <div class="agent-info"><div class="name">Counselor</div><div class="role">Scenarios</div><div class="model" id="model-counselor">—</div></div>
        <span class="status-dot"></span>
      </div>
      <div class="agent-card">
        <div class="agent-avatar av-reasoner">R</div>
        <div class="agent-info"><div class="name">Reasoner</div><div class="role">Final Decision</div><div class="model" id="model-reasoner">—</div></div>
        <span class="status-dot"></span>
      </div>
    </div>
    <div class="sidebar-card">
      <h3>Worker Status</h3>
      <div id="status-row"><div class="loader">Loading...</div></div>
    </div>
  </div>

  <!-- Main feed -->
  <div class="feed">

    <!-- Latest Decision -->
    <div class="decision-card" id="latest-decision">
      <div class="loader">Loading latest decision...</div>
    </div>

    <!-- Agent Debate Feed -->
    <div class="card">
      <div class="feed-header">
        <div class="avatar">AI</div>
        <div>
          <h2>Agent Debate</h2>
          <div class="sub">Analyst → Counselor → Reasoner · Latest News Analysis</div>
        </div>
      </div>
      <div class="tabs">
        <div class="tab active" data-tab="chat">Debate</div>
        <div class="tab" data-tab="raw">Raw Output</div>
      </div>
      <div id="agent-chat" class="debate"><div class="loader">Loading...</div></div>
      <div id="agent-raw" style="display:none"></div>
    </div>

    <!-- Phase 3: agent threads per news analysis -->
    <div class="card">
      <div class="feed-header">
        <div class="avatar">TH</div>
        <div>
          <h2>Agent Threads</h2>
          <div class="sub">One thread per news analysis · agents reply to each other · moderator consensus · advisory only</div>
        </div>
      </div>
      <div id="thread-list"><div class="loader">Loading threads...</div></div>
      <div id="thread-view" style="display:none"></div>
    </div>

    <!-- Phase 3: live 5m trading room -->
    <div class="card">
      <div class="feed-header">
        <div class="avatar">5m</div>
        <div>
          <h2>Live Room 5m</h2>
          <div class="sub">Technical · Risk · Moderator on each changed closed 5m bar</div>
        </div>
      </div>
      <div class="live-pin"><span class="badge-warn">UNVERIFIED 5m</span><span id="live-h1">H1 decision: —</span><span style="color:var(--muted)">Discussion only. No orders are placed.</span></div>
      <div id="live-feed" class="live-feed"><div class="loader">Loading live room...</div></div>
    </div>


  </div>

  <!-- Right sidebar -->
  <div class="rightbar">
    <div class="rightbar-card">
      <h3>News History</h3>
      <div id="news-list"><div class="loader">Loading...</div></div>
    </div>
    <div class="rightbar-card">
      <h3>Trade Decisions</h3>
      <div id="decisions-list"><div class="loader">Loading...</div></div>
    </div>
    <div class="rightbar-card">
      <h3>Local Lane (Parity)</h3>
      <div id="local-lane"><div class="loader">Loading...</div></div>
    </div>
    <div class="rightbar-card">
      <h3>Quick Stats</h3>
      <div id="quick-stats"><div class="loader">Loading...</div></div>
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
    const models = ai.models||{};
    [['analyst','model-analyst'],['counselor','model-counselor'],['reasoner','model-reasoner']].forEach(([k,id])=>{ if(models[k]) $(id).textContent = String(models[k]).split('/').pop(); });
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

async function loadNews(){
  try {
    const r = await fetch(API+'/api/news?limit=15'); const d = await r.json();
    if(!d.items||d.items.length===0){ $('news-list').innerHTML='<div class="loader">No news analysis yet.</div>'; return; }
    $('news-list').innerHTML = d.items.map(n=>{
      const rec = n.recommendation||'—';
      const cls = (rec==='BULLISH_BIAS'?'BUY':rec==='BEARISH_BIAS'?'SELL':rec==='WAIT_FOR_TECHNICAL_CONFIRMATION'?'WAIT':rec);
      return '<div class="news-item"><div class="news-title">'+esc(rec)+' <span class="badge-decision '+cls+'">'+esc(rec)+'</span></div>'
        +'<div class="news-meta">'+esc(n.analyzed_at)+' · '+n.article_count+' articles · conf: '+(n.confidence!=null?Math.round(n.confidence*100)+'%':'—')+'</div>'
        +'<div class="news-meta" style="margin-top:4px"><a href="#" onclick="loadAnalysis(\\''+esc(n.analysis_key)+'\\');return false;" class="news-link">View debate →</a></div></div>';
    }).join('');
  } catch(e){ $('news-list').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}

async function loadDecisions(){
  try {
    const r = await fetch(API+'/api/decisions?limit=15'); const d = await r.json();
    if(!d.items||d.items.length===0){ $('decisions-list').innerHTML='<div class="loader">No trade decisions yet.</div>'; return; }
    let html = '<table><thead><tr><th>Time</th><th>Decision</th><th>Conf</th></tr></thead><tbody>';
    d.items.forEach(x=>{
      const cls = (x.decision==='BUY'?'BUY':x.decision==='SELL'?'SELL':'WAIT');
      html += '<tr onclick="loadTechnicalDecision(\\''+esc(x.candle_key)+'\\')" style="cursor:pointer">'
        +'<td>'+esc(String(x.timestamp).slice(0,16).replace('T',' '))+'</td>'
        +'<td><span class="badge-decision '+cls+'">'+esc(x.decision)+'</span></td>'
        +'<td>'+(x.confidence!=null?Math.round(x.confidence*100)+'%':'—')+'</td></tr>';
    });
    html += '</tbody></table>';
    $('decisions-list').innerHTML = html;
    $('quick-stats').innerHTML = '<div class="stat"><span class="label">Total Decisions</span><span class="value">'+d.items.length+'</span></div>'
      +'<div class="stat"><span class="label">Latest</span><span class="value">'+esc(d.items[0].decision)+'</span></div>';
  } catch(e){ $('decisions-list').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}

async function loadTechnicalDecision(key){
  try {
    const r = await fetch(API+'/api/decision/'+encodeURIComponent(key)); const d = await r.json();
    if(d.status!=='ok'){ alert('Failed to load technical decision'); return; }
    const syn = d.synthesis||{};
    const dec = syn.decision||{};
    const cls = (dec.decision==='BUY'?'BUY':dec.decision==='SELL'?'SELL':'WAIT');
    let m5ctx = '';
    try {
      const cr = await fetch(API+'/api/m5-context');
      if (cr.ok) { const cd = await cr.json();
      if (cd && cd.status === 'ok' && cd.context) {
        const c = cd.context;
        m5ctx = '<div style="font-size:12px;color:var(--muted);margin-top:8px"><span style="background:#f59e0b;color:#000;padding:2px 6px;border-radius:4px;font-weight:700">UNVERIFIED 5m</span> '
          +'<b>'+esc(c.engine||'5m')+'</b> · bias '+esc(c.bias||'—')+' · buy '+esc(String(c.buy_confirmed))+' · sell '+esc(String(c.sell_confirmed))
          +' · candle '+esc(String(c.candle_time||''))+'</div>';
      }
      }
    } catch(e) { m5ctx = ''; }
    try {
      const mr = await fetch('/api/ohlcv?timeframe=M5&limit=12');
      if (mr.ok) { const md = await mr.json();
      if (md && Array.isArray(md.candles) && md.candles.length) {
        const last = md.candles[md.candles.length-1];
        m5ctx += '<div style="font-size:12px;color:var(--muted);margin-top:4px"><b>5m bars (last '+md.candles.length+')</b>: close '+esc(String(last.close))+' · H '+esc(String(last.high))+' · L '+esc(String(last.low))+'</div>';
      }
      }
    } catch(e) {}
    $('latest-decision').innerHTML =
      '<div class="decision-card">'
      +'<div class="decision-badge '+cls+'">'+esc(dec.decision||'—')+'</div>'
      +'<div class="conf">Confidence: '+(dec.confidence!=null?Math.round(dec.confidence*100)+'%':'—')+' · '+esc(d.candle_key||'')+'</div>'
      +'<div class="rationale-box">'+esc(dec.reasoning||syn.reasoning||'—')+'</div>'
      +m5ctx
      +'<div id="bus-consensus" style="margin-top:10px"></div>'
      +'</div>';
    const msgs = [
      {av:'av-analyst', cls:'analyst', name:'Analyst', model:(function(m){return String(m||'').split('/').pop();})(syn.analyst_model), content:syn.analyst_output||'(empty)'},
      {av:'av-counselor', cls:'counselor', name:'Counselor', model:(function(m){return String(m||'').split('/').pop();})(syn.counselor_model), content:syn.counselor_output||'(empty)'},
      {av:'av-reasoner', cls:'reasoner', name:'Reasoner', model:(function(m){return String(m||'').split('/').pop();})(syn.reasoner_model), content:syn.reasoner_output||'(empty)'},
    ];
    $('agent-chat').innerHTML = msgs.map(m=>
      '<div class="debate-msg"><div class="debate-avatar '+m.av+'">'+m.name[0]+'</div>'
      +'<div class="debate-bubble '+m.cls+'"><div class="meta"><span class="role">'+m.name+'</span><span class="model">'+m.model+'</span></div>'
      +'<div class="content">'+esc(m.content)+'</div></div></div>'
    ).join('');
    $('agent-raw').innerHTML = '<div class="agent-raw"><h3>Technical Decision</h3><pre>'+esc(JSON.stringify(dec,null,2))+'</pre></div>'
      +'<div class="agent-raw"><h3>Analyst Output</h3><pre>'+esc(syn.analyst_output||'')+'</pre></div>'
      +'<div class="agent-raw"><h3>Counselor Output</h3><pre>'+esc(syn.counselor_output||'')+'</pre></div>'
      +'<div class="agent-raw"><h3>Reasoner Output</h3><pre>'+esc(syn.reasoner_output||'')+'</pre></div>';
  } catch(e){ $('latest-decision').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}

async function loadAnalysis(key){
  try {
    const r = await fetch(API+'/api/news/'+encodeURIComponent(key)); const d = await r.json();
    if(d.status!=='ok'){ alert('Failed to load analysis'); return; }
    const rec = d.recommendation||{};
    const cls = (rec.recommendation==='BULLISH_BIAS'?'BUY':rec.recommendation==='BEARISH_BIAS'?'SELL':rec.recommendation==='WAIT_FOR_TECHNICAL_CONFIRMATION'?'WAIT':rec.recommendation);
    $('latest-decision').innerHTML =
      '<div class="decision-card">'
      +'<div class="decision-badge '+cls+'">'+esc(rec.recommendation||'—')+'</div>'
      +'<div class="conf">Confidence: '+(rec.confidence!=null?Math.round(rec.confidence*100)+'%':'—')+' · Horizon: '+esc(rec.horizon||'—')+'</div>'
      +'<div class="rationale-box">'+esc(rec.rationale||'—')+'</div>'
      +'<div class="ev-row">'
      + (Array.isArray(rec.supporting_evidence)?rec.supporting_evidence.map(e=>'<span class="ev-tag support">✓ '+esc(e)+'</span>').join(''):'')
      + (Array.isArray(rec.opposing_evidence)?rec.opposing_evidence.map(e=>'<span class="ev-tag oppose">✗ '+esc(e)+'</span>').join(''):'')
      + (Array.isArray(rec.risks)?rec.risks.map(e=>'<span class="ev-tag risk">⚠ '+esc(e)+'</span>').join(''):'')
      +'</div>'
      +'<div style="font-size:12px;color:var(--muted);margin-top:10px"><b>Confirmation:</b> '+esc(rec.confirmation_needed||'—')+'</div>'
      +'<div style="font-size:12px;color:var(--muted)"><b>Invalidation:</b> '+esc(rec.invalidation_conditions||'—')+'</div>'
      +'</div>';
    const msgs = [
      {av:'av-analyst', cls:'analyst', name:'Analyst', model:(function(m){return String(m||'').split('/').pop();})(d.analyst_model), content:d.analyst_output||'(empty)'},
      {av:'av-counselor', cls:'counselor', name:'Counselor', model:(function(m){return String(m||'').split('/').pop();})(d.counselor_model), content:d.counselor_output||'(empty)'},
      {av:'av-reasoner', cls:'reasoner', name:'Reasoner', model:(function(m){return String(m||'').split('/').pop();})(d.reasoner_model), content:d.reasoner_output||'(empty)'},
    ];
    $('agent-chat').innerHTML = msgs.map(m=>
      '<div class="debate-msg"><div class="debate-avatar '+m.av+'">'+m.name[0]+'</div>'
      +'<div class="debate-bubble '+m.cls+'"><div class="meta"><span class="role">'+m.name+'</span><span class="model">'+m.model+'</span></div>'
      +'<div class="content">'+esc(m.content)+'</div></div></div>'
    ).join('');
    $('agent-raw').innerHTML = '<div class="agent-raw"><h3>Analyst Output</h3><pre>'+esc(d.analyst_output||'')+'</pre></div>'
      +'<div class="agent-raw"><h3>Counselor Output</h3><pre>'+esc(d.counselor_output||'')+'</pre></div>'
      +'<div class="agent-raw"><h3>Reasoner Output</h3><pre>'+esc(d.reasoner_output||'')+'</pre></div>'
      +'<div class="agent-raw"><h3>Evidence (articles)</h3><pre>'+esc(JSON.stringify(d.evidence?.articles||[],null,2))+'</pre></div>';
  } catch(e){ $('latest-decision').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}

document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    const tab=t.dataset.tab;
    $('agent-chat').style.display = tab==='chat'?'flex':'none';
    $('agent-raw').style.display = tab==='raw'?'block':'none';
  });
});


async function loadLocalLane(){
  try {
    const r = await fetch('/api/local-lane'); const d = await r.json();
    if (!r.ok) { $('local-lane').innerHTML = '<div class="error">'+esc(d.error||r.status)+'</div>'; return; }
    const diag = d.body || d;
    const lr = diag.last_refresh || {};
    const lp = diag.last_publish || {};
    const b = diag.budget || {};
    const series = Array.isArray(diag.series) ? diag.series : [];
    const latestBars = series.map(s => esc(s.timeframe)+': '+esc(String(s.latest_close_time||'—'))).join(' · ');
    $('local-lane').innerHTML = '<div style="font-size:12px;line-height:1.6">'
      +'<div><b>Last refresh:</b> '+esc(String(lr.status||'—'))+' @ '+esc(String(lr.checked_at||'—'))+'</div>'
      +'<div><b>Last publish:</b> '+esc(String(lp.candle_key||'—'))+' · '+esc(String(lp.status||'—'))+' @ '+esc(String(lp.published_at||'—'))+'</div>'
      +'<div><b>Budget:</b> '+esc(String(b.used||0))+'/'+esc(String(b.daily||'—'))+'</div>'
      +'<div><b>Latest bars:</b> '+latestBars+'</div>'
      +'</div>';
  } catch(e){ $('local-lane').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}

async function autoLoad(){
  try {
    const r = await fetch(API+'/api/decisions?limit=1'); const d = await r.json();
    if(d.items && d.items.length>0) loadTechnicalDecision(d.items[0].candle_key);
  } catch(e){}
  try {
    const r = await fetch(API+'/api/news?limit=1'); const d = await r.json();
    if(d.items && d.items.length>0) loadAnalysis(d.items[0].analysis_key);
  } catch(e){}
}


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
// ---- Phase 3: agent threads and live room ----
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
function modelShort(m){ return esc(String(m||'').split('/').pop()); }
let threadSelected = null;
async function loadThreads(){
  if (threadSelected) return;
  try {
    const r = await fetch(API+'/api/threads?kind=news&limit=15'); const d = await r.json();
    if (!r.ok) { $('thread-list').innerHTML = '<div class="error">'+esc(d.error||r.status)+'</div>'; return; }
    const items = d.items || [];
    if (!items.length) { $('thread-list').innerHTML = '<div class="loader">No threads yet. Threads appear after the next news analysis.</div>'; return; }
    $('thread-list').innerHTML = items.map(t => '<div class="thread-item" data-thread="'+escAttr(t.id)+'">'
      +'<div class="t-title">'+esc(t.title)+'</div>'
      +'<div class="thread-meta">'+chip(t.consensus)+'<span>'+t.reply_count+' replies</span><span>'+esc(timeAgo(t.created_at))+'</span>'
      +(t.post && t.post.article_count ? '<span>'+t.post.article_count+' articles</span>' : '')+'</div></div>').join('');
  } catch(e){ $('thread-list').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}
function renderThreadMsg(m, depth){
  const body = m.insight || m.summary || '';
  const status = m.status && m.status !== 'ok' ? '<span class="badge-warn">'+esc(m.status)+'</span>' : '';
  const fb = m.fallback_used ? '<span>fallback</span>' : '';
  let html = '<div class="tmsg'+(m.agent==='moderator'?' mod':'')+'" style="margin-left:'+(Math.min(depth,4)*18)+'px">'
    +'<div class="m-head"><span class="m-agent">'+esc(m.agent)+'</span><span>'+modelShort(m.model)+'</span><span>'+esc(timeAgo(m.ts))+'</span>'
    +chip(m.stance)+(m.confidence!=null ? '<span>conf '+Math.round(m.confidence*100)+'%</span>' : '')+status+fb+'</div>'
    +'<div class="m-body">'+esc(body)+'</div>'
    +(m.dissent && m.dissent.length ? '<div class="m-refs">Dissent: '+esc(m.dissent.join('; '))+'</div>' : '')
    +(m.refs && m.refs.length ? '<div class="m-refs">refs: '+esc(m.refs.join(', '))+'</div>' : '')
    +'</div>';
  (m.replies||[]).forEach(c => { html += renderThreadMsg(c, depth+1); });
  return html;
}
async function openThread(id){
  threadSelected = id;
  $('thread-list').style.display = 'none';
  $('thread-view').style.display = 'block';
  $('thread-view').innerHTML = '<div class="loader">Loading thread...</div>';
  try {
    const r = await fetch(API+'/api/threads/'+encodeURIComponent(id)); const d = await r.json();
    if (!r.ok || !d.thread) { $('thread-view').innerHTML = '<div class="error">'+esc(d.error||d.status||r.status)+'</div>'; return; }
    const t = d.thread; const p = t.post || {};
    const rec = p.recommendation || {};
    $('thread-view').innerHTML = '<button data-thread-back="1">&larr; All threads</button>'
      +'<div class="post-box" style="margin-top:10px"><div class="t-title" style="font-weight:700;font-size:15px">'+esc(t.title)+'</div>'
      +'<div class="thread-meta" style="margin:6px 0">'+esc(timeAgo(t.created_at))+(p.article_count ? ' · '+p.article_count+' articles' : '')+(rec.stance ? ' · news analysis: '+esc(rec.stance) : '')+'</div>'
      +((p.headlines||[]).length ? '<ul style="margin:6px 0 0 18px">'+p.headlines.map(h => '<li>'+esc(h)+'</li>').join('')+'</ul>' : '')
      +'</div>'
      +(t.messages||[]).map(m => renderThreadMsg(m, 0)).join('');
  } catch(e){ $('thread-view').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}
document.addEventListener('click', ev => {
  const back = ev.target.closest('[data-thread-back]');
  if (back) { threadSelected = null; $('thread-view').style.display='none'; $('thread-list').style.display='block'; loadThreads(); return; }
  const item = ev.target.closest('[data-thread]');
  if (item) openThread(item.getAttribute('data-thread'));
});
let liveSince = 0; let liveLastBar = null; let liveLoaded = false;
async function loadLive(){
  const feed = $('live-feed');
  try {
    const r = await fetch(API+'/api/live?since='+liveSince+'&limit=60'); const d = await r.json();
    if (!r.ok) { if (!liveLoaded) feed.innerHTML = '<div class="error">'+esc(d.error||r.status)+'</div>'; return; }
    const items = d.items || [];
    if (!liveLoaded) { feed.innerHTML = ''; liveLoaded = true; }
    if (!items.length) { if (!feed.children.length) feed.innerHTML = '<div class="loader">'+(d.enabled ? 'Waiting for the next changed 5m bar...' : 'Live room is off in this environment.')+'</div>'; return; }
    if (feed.querySelector('.loader')) feed.innerHTML = '';
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    let html = '';
    items.forEach(m => {
      if (m.bar_time !== liveLastBar) { liveLastBar = m.bar_time; html += '<div class="live-bar">5m bar '+esc(String(m.bar_time||'').replace('T',' ').slice(0,16))+' UTC</div>'; }
      html += renderThreadMsg(Object.assign({}, m, { replies: [] }), m.parent_id ? 1 : 0);
      liveSince = Math.max(liveSince, m.id);
    });
    feed.insertAdjacentHTML('beforeend', html);
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  } catch(e){ if (!liveLoaded) feed.innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}
async function loadLiveH1(){
  try {
    const r = await fetch(API+'/api/decisions?limit=1'); const d = await r.json();
    const x = (d.items||[])[0];
    if (x) $('live-h1').innerHTML = 'H1 decision: '+chip(x.decision)+' <span style="color:var(--muted)">'+esc(x.candle_key||'')+'</span>';
  } catch(e){}
}
loadThreads(); loadLive(); loadLiveH1();
setInterval(loadLive, 10000);
setInterval(()=>{ loadThreads(); loadLiveH1(); }, 60000);

loadChart(true);
setInterval(()=>loadChart(false), 60000);
loadStatus(); loadNews(); loadDecisions(); autoLoad(); loadLocalLane();
setInterval(()=>{ loadStatus(); loadNews(); loadDecisions(); loadLocalLane(); }, 30000);
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

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }

    return json({ error: "Not found", endpoints: ["GET /", "GET /dashboard", "GET /api/ohlcv", "GET /api/local-lane", "GET /api/*"] }, 404);
  }
};
