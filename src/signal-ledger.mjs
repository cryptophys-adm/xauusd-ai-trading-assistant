// Signal Ledger (owner request 2026-11-07, "Nexus vs KIRA" item 1): every directional signal the
// system gives, followed to its outcome in R on the closed bars that came after it. Advisory only:
// R multiples of the advice itself, never money, lots, balances or positions.
//
// Sources:
//   h1_decision  the H1 Reasoner's BUY/SELL (trade_decisions: entry, stop, one take profit);
//   strategy     the strategy engine's TRIGGERED setups (entry, stop, TP1, TP2), snapshotted by the
//                sweep, at most one open per side.
//
// Simulation (deterministic, on closed 15m bars, else 1H bars where 15m bars do not reach):
//   - The entry is a limit at `entry`. It fills on the first bar whose range reaches it, within
//     FILL_WINDOW_MS of the signal. Before the fill, a stop touch cancels it (invalidated) and a
//     TP1 touch cancels it (target_before_entry). An unfilled signal expires (unfilled).
//   - Once filled, two independent policies run: "tp1" (the whole position exits at TP1) and "tp2"
//     (it exits at TP2; only when a TP2 exists). Each exits at its target (+R), at the stop (-1R),
//     or after HOLD_MAX_MS at the bar's close (time exit, mark to market).
//   - A bar that reaches both the stop and the target counts as the stop (conservative) and is
//     flagged ambiguous. The fill bar itself can stop out but only reaches its target when the
//     stop is not touched.
//   - R = (exit - entry) x side / |entry - stop|. MFE and MAE are kept in R.
// The ledger never feeds a room, a prompt or a decision.

export const LEDGER_VERSION = "cryptophys.signal-ledger.v1";
export const FILL_WINDOW_MS = 8 * 3600_000;
export const HOLD_MAX_MS = 72 * 3600_000;
export const SOURCES = Object.freeze(["h1_decision", "strategy"]);

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();
/** D1 datetime('now') text ("YYYY-MM-DD HH:MM:SS", UTC) or ISO, to epoch ms. */
export const toMs = (t) => (typeof t === "string" ? Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z") : NaN);

/** A signal is valid when its prices are ordered for its side. */
export function validSignal(s) {
  const dir = s?.side === "BUY" ? 1 : s?.side === "SELL" ? -1 : 0;
  if (!dir || ![s.entry, s.stop, s.tp1].every(finite)) return false;
  if (dir * (s.entry - s.stop) <= 0 || dir * (s.tp1 - s.entry) <= 0) return false;
  if (s.tp2 != null && (!finite(s.tp2) || dir * (s.tp2 - s.tp1) < 0)) return false;
  return true;
}

/**
 * Pure: the outcome of one signal on `bars` (closed bars, oldest first, { open_time, close_time,
 * high, low, close }). `now` bounds the windows: a signal whose window is still running stays
 * pending or open.
 */
export function simulateSignal(signal, bars, { now = Date.now(), fillWindowMs = FILL_WINDOW_MS, holdMaxMs = HOLD_MAX_MS } = {}) {
  const dir = signal.side === "BUY" ? 1 : -1;
  const { entry, stop, tp1 } = signal, tp2 = finite(signal.tp2) ? signal.tp2 : null;
  const risk = Math.abs(entry - stop);
  const R = (price) => r3(((price - entry) * dir) / risk);
  const reaches = (b, price) => b.low <= price && price <= b.high;
  const beyond = (b, price, up) => (up ? b.high >= price : b.low <= price);
  const opened = toMs(signal.opened_at);
  const after = bars.filter((b) => toMs(b.open_time) >= opened && toMs(b.close_time) <= now);

  let filledAt = null, i = 0;
  for (; i < after.length; i++) {
    const b = after[i];
    if (toMs(b.close_time) - opened > fillWindowMs && !reaches(b, entry)) break;
    if (reaches(b, entry)) { filledAt = b.open_time; break; }
    if (beyond(b, stop, dir < 0)) return { status: "cancelled", exit_reason: "invalidated", closed_at: b.close_time };
    if (beyond(b, tp1, dir > 0)) return { status: "cancelled", exit_reason: "target_before_entry", closed_at: b.close_time };
  }
  if (filledAt == null) {
    const windowOver = now - opened > fillWindowMs;
    return windowOver ? { status: "cancelled", exit_reason: "unfilled", closed_at: iso(opened + fillWindowMs) } : { status: "pending" };
  }

  const fillMs = toMs(filledAt);
  const policy = (target) => {
    let mfe = 0, mae = 0, ambiguous = false;
    for (let k = i; k < after.length; k++) {
      const b = after[k];
      const favorable = dir > 0 ? b.high : b.low, adverse = dir > 0 ? b.low : b.high;
      mfe = Math.max(mfe, R(favorable)); mae = Math.min(mae, R(adverse));
      const hitStop = beyond(b, stop, dir < 0), hitTarget = beyond(b, target, dir > 0);
      if (hitStop) { ambiguous = hitTarget; return { result: "stop", r: -1, exit_price: stop, closed_at: b.close_time, bars: k - i + 1, mfe, mae: -1, ambiguous }; }
      if (hitTarget) return { result: "target", r: R(target), exit_price: target, closed_at: b.close_time, bars: k - i + 1, mfe: Math.max(mfe, R(target)), mae, ambiguous };
      if (toMs(b.close_time) - fillMs >= holdMaxMs) return { result: "time", r: R(b.close), exit_price: b.close, closed_at: b.close_time, bars: k - i + 1, mfe, mae, ambiguous };
    }
    return { result: "open", r: after.length > i ? R(after.at(-1).close) : 0, mfe, mae, bars: after.length - i };
  };
  const p1 = policy(tp1), p2 = tp2 != null ? policy(tp2) : null;
  const done = p1.result !== "open" && (p2 == null || p2.result !== "open");
  return {
    status: done ? "closed" : "open", filled_at: filledAt,
    exit_reason: p1.result === "open" ? null : p1.result, closed_at: done ? [p1.closed_at, p2?.closed_at].filter(Boolean).sort().at(-1) : null,
    r_tp1: p1.result === "open" ? null : p1.r, r_tp2: p2 && p2.result !== "open" ? p2.r : null,
    open_r: p1.result === "open" ? p1.r : null,
    exit_price: p1.exit_price ?? null, bars_held: p1.bars, mfe_r: r3(p1.mfe), mae_r: r3(p1.mae),
    ambiguous: Boolean(p1.ambiguous || p2?.ambiguous)
  };
}

/** Pure: performance of closed, filled signals under one policy ("tp1" or "tp2"). */
export function performance(items, policy = "tp1") {
  const key = policy === "tp2" ? "r_tp2" : "r_tp1";
  const closed = items.filter((x) => x.status === "closed" && finite(x[key])).sort((a, b) => toMs(a.closed_at) - toMs(b.closed_at));
  const rs = closed.map((x) => x[key]);
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r < 0);
  let cum = 0, peak = 0, maxDd = 0;
  const equity = closed.map((x) => { cum += x[key]; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); return { t: x.closed_at, r: r3(cum), id: x.id }; });
  const sumWin = wins.reduce((a, b) => a + b, 0), sumLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    policy, trades: rs.length, wins: wins.length, losses: losses.length,
    win_rate: rs.length ? r3(wins.length / rs.length) : null,
    avg_win_r: wins.length ? r3(sumWin / wins.length) : null, avg_loss_r: losses.length ? r3(-sumLoss / losses.length) : null,
    expectancy_r: rs.length ? r3(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    total_r: r3(cum), profit_factor: sumLoss > 0 ? r3(sumWin / sumLoss) : null,
    max_drawdown_r: r3(maxDd), equity
  };
}

/** Pure: the ledger view of `items` (rows of signal_ledger, with their outcome fields). */
export function ledgerView(items, { days }) {
  const by = (source) => items.filter((x) => source == null || x.source === source);
  const block = (list) => {
    const count = (s) => list.filter((x) => x.status === s).length;
    const cancelled = {};
    for (const x of list.filter((x) => x.status === "cancelled")) cancelled[x.exit_reason] = (cancelled[x.exit_reason] || 0) + 1;
    const filled = list.filter((x) => x.filled_at).length;
    return {
      signals: list.length, pending: count("pending"), open: count("open"), closed: count("closed"), cancelled,
      fill_rate: list.length - count("pending") ? r3(filled / (list.length - count("pending"))) : null,
      ambiguous: list.filter((x) => x.ambiguous).length,
      tp1: performance(list, "tp1"), tp2: performance(list.filter((x) => finite(x.tp2)), "tp2")
    };
  };
  return {
    version: LEDGER_VERSION, window_days: days,
    rules: { fill_window_hours: FILL_WINDOW_MS / 3600_000, hold_max_hours: HOLD_MAX_MS / 3600_000, same_bar: "stop first (conservative)", unit: "R, never money" },
    all: block(by(null)), by_source: Object.fromEntries(SOURCES.map((s) => [s, block(by(s))])),
    items: items.slice().sort((a, b) => toMs(b.opened_at) - toMs(a.opened_at)).slice(0, 100)
  };
}

// ---------------------------------------------------------------------------
// D1 persistence.

export const LEDGER_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS signal_ledger (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    candle_key TEXT,
    opened_at TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    entry REAL NOT NULL, stop REAL NOT NULL, tp1 REAL NOT NULL, tp2 REAL,
    confidence REAL, note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'closed', 'cancelled')),
    filled_at TEXT, closed_at TEXT, exit_reason TEXT, exit_price REAL,
    r_tp1 REAL, r_tp2 REAL, open_r REAL, mfe_r REAL, mae_r REAL, bars_held INTEGER, ambiguous INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_signal_ledger_opened ON signal_ledger(opened_at)",
  "CREATE INDEX IF NOT EXISTS idx_signal_ledger_status ON signal_ledger(status)"
];
let schemaReady = false;
export function resetLedgerSchemaCacheForTests() { schemaReady = false; }
export async function ensureLedgerSchema(db) {
  if (schemaReady) return;
  for (const sql of LEDGER_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

async function series(env, interval) {
  try {
    const r = JSON.parse((await env.SIGNAL_CACHE?.get?.(`market-data:v2:series:OANDA:XAUUSD|${interval}`)) || "null");
    return (Array.isArray(r?.candles) ? r.candles : []).filter((c) => [c.high, c.low, c.close].every(finite) && c.open_time && c.close_time)
      .sort((a, b) => toMs(a.open_time) - toMs(b.open_time));
  } catch { return []; }
}

/** Closed 15m bars, with 1H bars before the first 15m bar (the 15m series is shorter). */
export async function ledgerBars(env) {
  const [m15, h1] = await Promise.all([series(env, "15m"), series(env, "1h")]);
  const start = m15.length ? toMs(m15[0].open_time) : Infinity;
  return [...h1.filter((b) => toMs(b.close_time) <= start), ...m15];
}

const insertSql = "INSERT OR IGNORE INTO signal_ledger (id, source, candle_key, opened_at, side, entry, stop, tp1, tp2, confidence, note, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)";

/** New H1 Reasoner BUY/SELL decisions since `sinceIso` (each candle once). */
export async function ingestH1Decisions(env, { sinceIso, now = Date.now() }) {
  const rows = (await env.DB.prepare("SELECT candle_key, decision, confidence, entry_price, stop_loss, take_profit, created_at FROM trade_decisions WHERE decision IN ('BUY', 'SELL') AND created_at >= ? ORDER BY id").bind(sinceIso.replace("T", " ").slice(0, 19)).all()).results || [];
  let added = 0;
  for (const r of rows) {
    const s = { side: r.decision, entry: r.entry_price, stop: r.stop_loss, tp1: r.take_profit, tp2: null };
    if (!validSignal(s)) continue;
    const res = await env.DB.prepare(insertSql).bind("h1_decision:" + r.candle_key, "h1_decision", r.candle_key, iso(toMs(r.created_at)), s.side, s.entry, s.stop, s.tp1, null, r.confidence ?? null, null, iso(now)).run();
    added += Number(res?.meta?.changes) || 0;
  }
  return added;
}

/** The strategy engine's TRIGGERED setup, once per H1 bar, and only without an open one of the same side. */
export async function ingestStrategy(env, strategy, { now = Date.now() } = {}) {
  const plan = strategy?.plan;
  if (!plan || (strategy.decision !== "BUY" && strategy.decision !== "SELL")) return 0;
  const s = { side: strategy.decision, entry: plan.entry, stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2 ?? null };
  if (!validSignal(s)) return 0;
  const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM signal_ledger WHERE source = 'strategy' AND side = ? AND status IN ('pending', 'open')").bind(s.side).first();
  if (Number(live?.n) > 0) return 0;
  const hour = Math.floor(now / 3600_000) * 3600_000;
  const res = await env.DB.prepare(insertSql).bind(`strategy:${iso(hour)}`, "strategy", strategy.h1_chain?.candle_key ?? null, iso(now), s.side, s.entry, s.stop, s.tp1, s.tp2, finite(strategy.confidence) ? r3(strategy.confidence) : null, String(strategy.headline ?? "").slice(0, 300), iso(now)).run();
  return Number(res?.meta?.changes) || 0;
}

/** Re-simulates every pending or open signal on the latest closed bars. */
export async function evaluateOpenSignals(env, { now = Date.now(), bars = null } = {}) {
  const live = (await env.DB.prepare("SELECT * FROM signal_ledger WHERE status IN ('pending', 'open')").all()).results || [];
  if (!live.length) return 0;
  const closed = bars ?? await ledgerBars(env);
  let changed = 0;
  for (const s of live) {
    const o = simulateSignal(s, closed, { now });
    await env.DB.prepare("UPDATE signal_ledger SET status = ?, filled_at = ?, closed_at = ?, exit_reason = ?, exit_price = ?, r_tp1 = ?, r_tp2 = ?, open_r = ?, mfe_r = ?, mae_r = ?, bars_held = ?, ambiguous = ?, updated_at = ? WHERE id = ?")
      .bind(o.status, o.filled_at ?? null, o.closed_at ?? null, o.exit_reason ?? null, o.exit_price ?? null, o.r_tp1 ?? null, o.r_tp2 ?? null, o.open_r ?? null, o.mfe_r ?? null, o.mae_r ?? null, o.bars_held ?? null, o.ambiguous ? 1 : 0, iso(now), s.id).run();
    if (o.status !== s.status) changed += 1;
  }
  return changed;
}

/** The sweep's ledger step: ingest new signals, then follow every live one. Never fatal. */
export async function runSignalLedger(env, { now = Date.now(), readStrategy = null } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  await ensureLedgerSchema(env.DB);
  const added = { h1_decision: await ingestH1Decisions(env, { sinceIso: iso(now - 7 * 86_400_000), now }), strategy: 0 };
  if (readStrategy) { try { added.strategy = await ingestStrategy(env, await readStrategy(env, { now }), { now }); } catch { added.strategy = 0; } }
  const changed = await evaluateOpenSignals(env, { now });
  return { status: "ok", added, changed };
}

/** GET /api/ledger: the ledger of the last `days` days. */
export async function readLedger(env, { days = 30, now = Date.now() } = {}) {
  await ensureLedgerSchema(env.DB);
  const rows = (await env.DB.prepare("SELECT * FROM signal_ledger WHERE opened_at >= ? ORDER BY opened_at").bind(iso(now - days * 86_400_000)).all()).results || [];
  return ledgerView(rows.map((r) => ({ ...r, ambiguous: Boolean(r.ambiguous) })), { days });
}
