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
</