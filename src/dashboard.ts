export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>XAUUSD AI Trading Assistant — Dashboard</title>
<style>
  :root { --bg:#0b0f17; --panel:#121826; --panel2:#1a2233; --border:#24304a; --text:#e6edf3; --muted:#8b949e; --accent:#3b82f6; --green:#22c55e; --red:#ef4444; --yellow:#eab308; --cyan:#22d3ee; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
  .topbar { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; background:var(--panel); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:10; }
  .topbar h1 { margin:0; font-size:18px; font-weight:600; }
  .topbar .badge { font-size:12px; padding:4px 10px; border-radius:999px; background:var(--panel2); border:1px solid var(--border); color:var(--muted); }
  .container { max-width:1400px; margin:0 auto; padding:20px; }
  .grid { display:grid; grid-template-columns: repeat(12,1fr); gap:16px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px; }
  .card h2 { margin:0 0 12px; font-size:14px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .span-4 { grid-column: span 4; }
  .span-6 { grid-column: span 6; }
  .span-8 { grid-column: span 8; }
  .span-12 { grid-column: span 12; }
  @media (max-width:900px){ .span-4,.span-6,.span-8 { grid-column: span 12; } }
  .status-row { display:flex; gap:12px; flex-wrap:wrap; }
  .status-pill { display:flex; align-items:center; gap:6px; padding:6px 12px; border-radius:8px; background:var(--panel2); border:1px solid var(--border); font-size:13px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
  .dot.ok { background:var(--green); box-shadow:0 0 6px var(--green); }
  .dot.err { background:var(--red); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { padding:8px 10px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:500; font-size:12px; text-transform:uppercase; }
  tr:hover { background:var(--panel2); }
  .badge-decision { padding:3px 8px; border-radius:6px; font-size:11px; font-weight:600; }
  .BUY { background:rgba(34,197,94,.15); color:var(--green); }
  .SELL { background:rgba(239,68,68,.15); color:var(--red); }
  .WAIT, .WAIT_FOR_TECHNICAL_CONFIRMATION { background:rgba(234,179,8,.15); color:var(--yellow); }
  .NEUTRAL, .BULLISH_BIAS, .BEARISH_BIAS { background:rgba(59,130,246,.15); color:var(--accent); }
  .agent-block { background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px; }
  .agent-block h3 { margin:0 0 6px; font-size:13px; color:var(--cyan); }
  .agent-block pre { margin:0; white-space:pre-wrap; word-break:break-word; font-size:12px; color:var(--text); max-height:300px; overflow:auto; }
  .chat-timeline { display:flex; flex-direction:column; gap:12px; }
  .chat-msg { display:flex; gap:10px; }
  .chat-avatar { width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; flex-shrink:0; }
  .av-analyst { background:#1e3a8a; color:#93c5fd; }
  .av-counselor { background:#164e63; color:#67e8f9; }
  .av-reasoner { background:#4c1d95; color:#c4b5fd; }
  .chat-bubble { flex:1; background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
  .chat-bubble .meta { font-size:11px; color:var(--muted); margin-bottom:4px; }
  .chat-bubble .content { font-size:13px; white-space:pre-wrap; word-break:break-word; max-height:240px; overflow:auto; }
  .loader { color:var(--muted); font-size:13px; padding:20px; text-align:center; }
  .error { color:var(--red); padding:12px; }
  .chart-box { height:260px; background:var(--panel2); border:1px dashed var(--border); border-radius:8px; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:13px; }
  .tabs { display:flex; gap:6px; margin-bottom:12px; }
  .tab { padding:6px 12px; border-radius:6px; background:var(--panel2); border:1px solid var(--border); color:var(--muted); cursor:pointer; font-size:12px; }
  .tab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .news-item { padding:10px 0; border-bottom:1px solid var(--border); }
  .news-item:last-child { border-bottom:none; }
  .news-title { font-size:13px; font-weight:500; }
  .news-meta { font-size:11px; color:var(--muted); margin-top:2px; }
  select, button { background:var(--panel2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:13px; cursor:pointer; }
  button:hover { background:var(--accent); border-color:var(--accent); color:#fff; }
  .refresh-btn { float:right; }
</style>
</head>
<body>
<div class="topbar">
  <h1>⚡ XAUUSD AI Trading Assistant</h1>
  <span class="badge" id="clock">--:--:--</span>
</div>
<div class="container">
  <div class="grid">

    <!-- Status -->
    <div class="card span-12">
      <h2>Status Worker</h2>
      <div class="status-row" id="status-row"><div class="loader">Memuat status...</div></div>
    </div>

    <!-- Chart placeholder -->
    <div class="card span-8">
      <h2>Chart Harga (XAUUSD)</h2>
      <div class="chart-box">Sumber data OHLCV belum terverifikasi (pull adapter stub). Chart akan diaktifkan setelah sumber data dikonfigurasi.</div>
    </div>

    <!-- Latest decision -->
    <div class="card span-4">
      <h2>Keputusan Terakhir</h2>
      <div id="latest-decision"><div class="loader">Memuat...</div></div>
    </div>

    <!-- Agent conversation -->
    <div class="card span-12">
      <h2>Visualisasi Percakapan Agent (Latest News Analysis)</h2>
      <div class="tabs">
        <div class="tab active" data-tab="chat">Chat Timeline</div>
        <div class="tab" data-tab="raw">Raw Output</div>
      </div>
      <div id="agent-chat" class="chat-timeline"><div class="loader">Memuat...</div></div>
      <div id="agent-raw" style="display:none"></div>
    </div>

    <!-- News history -->
    <div class="card span-6">
      <h2>Riwayat News Analysis</h2>
      <div id="news-list"><div class="loader">Memuat...</div></div>
    </div>

    <!-- Decisions history -->
    <div class="card span-6">
      <h2>Riwayat Keputusan (Trade Decisions)</h2>
      <div id="decisions-list"><div class="loader">Memuat...</div></div>
    </div>

  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
function esc(s){ return String(s??'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function updateClock(){ $('clock').textContent = new Date().toLocaleTimeString('id-ID'); }
setInterval(updateClock,1000); updateClock();

async function loadStatus(){
  try {
    const r = await fetch('/api/status'); const d = await r.json();
    const ai = d.ai_worker||{}; const ing = d.ingestion_worker||{};
    const pills = [
      {label:'AI Worker', ok: ai.status==='ok'},
      {label:'Ingestion', ok: ing.status==='ok'},
      {label:'OAuth', ok: !!ing.oauth_authorized},
      {label:'Ingest Secret', ok: !!ai.ingest_secret},
      {label:'Webhook Secret', ok: !!ai.webhook_secret},
      {label:'RPC Binding', ok: !!ai.news_ingestion_rpc},
    ];
    $('status-row').innerHTML = pills.map(p=>'<div class="status-pill"><span class="dot '+(p.ok?'ok':'err')+'"></span>'+p.label+'</div>').join('');
  } catch(e){ $('status-row').innerHTML = '<div class="error">Gagal memuat status: '+esc(e.message)+'</div>'; }
}

async function loadNews(){
  try {
    const r = await fetch('/api/news?limit=15'); const d = await r.json();
    if(!d.items||d.items.length===0){ $('news-list').innerHTML='<div class="loader">Belum ada news analysis.</div>'; return; }
    $('news-list').innerHTML = d.items.map(n=>{
      const rec = n.recommendation||'—';
      const cls = (rec==='BULLISH_BIAS'?'BUY':rec==='BEARISH_BIAS'?'SELL':rec==='WAIT_FOR_TECHNICAL_CONFIRMATION'?'WAIT':rec);
      return '<div class="news-item"><div class="news-title">'+esc(rec)+' <span class="badge-decision '+cls+'">'+esc(rec)+'</span></div>'
        +'<div class="news-meta">'+esc(n.analyzed_at)+' · '+n.article_count+' artikel · conf: '+(n.confidence!=null?Math.round(n.confidence*100)+'%':'—')+'</div>'
        +'<div class="news-meta" style="margin-top:4px"><a href="#" onclick="loadAnalysis(\\''+esc(n.analysis_key)+'\\');return false;" style="color:var(--accent)">Lihat detail agent →</a></div></div>';
    }).join('');
  } catch(e){ $('news-list').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}

async function loadDecisions(){
  try {
    const r = await fetch('/api/decisions?limit=15'); const d = await r.json();
    if(!d.items||d.items.length===0){ $('decisions-list').innerHTML='<div class="loader">Belum ada trade decision.</div>'; return; }
    let html = '<table><thead><tr><th>Waktu</th><th>Decision</th><th>Conf</th><th>Candle</th></tr></thead><tbody>';
    d.items.forEach(x=>{
      const cls = (x.decision==='BUY'?'BUY':x.decision==='SELL'?'SELL':'WAIT');
      html += '<tr><td>'+esc(String(x.timestamp).slice(0,16).replace('T',' '))+'</td>'
        +'<td><span class="badge-decision '+cls+'">'+esc(x.decision)+'</span></td>'
        +'<td>'+(x.confidence!=null?Math.round(x.confidence*100)+'%':'—')+'</td>'
        +'<td style="font-size:11px;color:var(--muted)">'+esc(x.candle_key)+'</td></tr>';
    });
    html += '</tbody></table>';
    $('decisions-list').innerHTML = html;
  } catch(e){ $('decisions-list').innerHTML = '<div class="error">'+esc(e.message)+'</div>'; }
}

async function loadAnalysis(key){
  try {
    const r = await fetch('/api/news/'+encodeURIComponent(key)); const d = await r.json();
    if(d.status!=='ok'){ alert('Gagal memuat analisis'); return; }
    const rec 