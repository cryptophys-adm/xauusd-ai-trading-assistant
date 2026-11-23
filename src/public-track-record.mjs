// The public track record (owner 2026-11-20, confirmed: "Yes, build it"; cta.cryptophys.work's Performance page and the
// home's average box). Four numbers per exit scenario, in R only, from the Signal Ledger's replay of the rooms' plans:
//   first    "Exit at TP1"   the plan exits whole at its first target (signal_ledger r_tp1);
//   second   "Exit at TP2"   the plan exits at its second target where it has one (r_tp2);
//   managed  "Managed exit"  the system's managed policy. By default (PUBLIC_MANAGED_SOURCE "v3"; owner 2026-11-23: "yang
//                            ditampilkan di cta public harusnya omega (v3) bukan yang live omega v4") the Signal Ledger's
//                            own policy (signal_ledger r_omega sized by omega_size, closed at omega_closed_at), shown
//                            with no parity gate. "v4": the v4 replay through the live engine (ledger_omega4), shown
//                            only while the v4 parity check against the live account passes (src/ledger-omega4.mjs).
// Aggregates only: no plan, side, time or price of any single trade, no money, lot, balance or account. Only results
// closed more than the public delay ago (PUBLIC_DELAY_HOURS, default 24) count, as for every public recap.
import { publicDelayHours, PUBLIC_FORBIDDEN_KEYS } from "./public-projection.mjs";
import { OMEGA4_PARITY_KEY } from "./signal-ledger.mjs";

export const TRACK_RECORD_VERSION = "cryptophys.public-track-record.v1";
export const SCENARIOS = Object.freeze([
  { id: "first", label: "Exit at TP1" },
  { id: "second", label: "Exit at TP2" },
  { id: "managed", label: "Managed exit (the system's live rules)" }
]);
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => (finite(x) ? Math.round(x * 100) / 100 : null);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
/** The managed scenario's source: "v3" (default) or "v4". */
export function publicManagedSource(env) {
  return String(env?.PUBLIC_MANAGED_SOURCE ?? "v3").trim().toLowerCase() === "v4" ? "v4" : "v3";
}
const ms = (t) => (typeof t === "string" ? Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z") : NaN);

/** Pure: the four numbers (and their base) of a list of R results. */
export function summarise(rs) {
  const list = rs.filter(finite);
  const won = list.filter((r) => r > 0), lost = list.filter((r) => r < 0);
  const sumWin = won.reduce((a, b) => a + b, 0), sumLoss = -lost.reduce((a, b) => a + b, 0);
  const net = list.reduce((a, b) => a + b, 0);
  return {
    count: list.length, won: won.length, lost: lost.length, even: list.length - won.length - lost.length,
    win_rate: list.length ? r3(won.length / list.length) : null,
    expectancy_r: list.length ? r2(net / list.length) : null,
    net_r: r2(net),
    avg_win_r: won.length ? r2(sumWin / won.length) : null,
    avg_loss_r: lost.length ? r2(-sumLoss / lost.length) : null,
    profit_factor: sumLoss > 0 ? r2(sumWin / sumLoss) : null
  };
}

/**
 * Pure: the public track record from the ledger's decision rows (`ledger`: r_tp1, r_tp2, tp1_closed_at, tp2_closed_at,
 * closed_at, opened_at) and the managed rows: with `source` "v3" the ledger's own policy (`managed`: r_omega, omega_size,
 * omega_closed_at, opened_at; R sized as the ledger's omega policy sizes it), shown with no parity gate
 * (replay_check { status: "not_required", shown: true }); with "v4" the v4 rows (r_omega4, omega4_closed_at, issued_ms),
 * shown only on a passing parity check. Results closed after `cutoff` are left out.
 */
export function publicTrackRecord({ ledger = [], managed = [], parity = null, now = Date.now(), delayHours = 24, source = "v3" } = {}) {
  const cutoff = now - delayHours * 3600_000;
  const due = (t) => finite(ms(t)) && ms(t) <= cutoff;
  const first = ledger.filter((x) => finite(x.r_tp1) && due(x.tp1_closed_at ?? x.closed_at));
  const second = ledger.filter((x) => finite(x.r_tp2) && due(x.tp2_closed_at ?? x.closed_at));
  const v4 = source === "v4";
  const status = v4 ? (typeof parity?.status === "string" ? parity.status : "unknown") : "not_required";
  const shown = v4 ? status === "pass" : true;
  // v3: the ledger's omega policy R (src/signal-ledger.mjs performance(items, "omega"): r_omega x omega_size, 1 when unsized).
  const rOf = (x) => (v4 ? x.r_omega4 : finite(x.r_omega) ? r3(x.r_omega * (finite(x.omega_size) ? x.omega_size : 1)) : null);
  const done = managed.filter((x) => finite(rOf(x)) && due(v4 ? x.omega4_closed_at : x.omega_closed_at));
  const since = (rows, key) => { const t = rows.map((x) => (key === "issued_ms" ? x.issued_ms : ms(x[key]))).filter(finite); return t.length ? new Date(Math.min(...t)).toISOString().slice(0, 10) : null; };
  const scenarios = [
    { ...SCENARIOS[0], shown: true, since: since(first, "opened_at"), ...summarise(first.map((x) => x.r_tp1)) },
    { ...SCENARIOS[1], shown: true, since: since(second, "opened_at"), ...summarise(second.map((x) => x.r_tp2)) },
    shown
      ? { ...SCENARIOS[2], shown: true, since: since(done, v4 ? "issued_ms" : "opened_at"), ...summarise(done.map(rOf)) }
      : { ...SCENARIOS[2], shown: false, note: "Shown once the replay matches the live account." }
  ];
  const count = Math.max(scenarios[0].count, 0);
  return {
    version: TRACK_RECORD_VERSION, unit: "R", simulated: true, delay_hours: delayHours,
    updated_at: new Date(now).toISOString(), count, since: scenarios[0].since,
    replay_check: { status, shown },
    scenarios
  };
}

/** Pure: the forbidden keys found at any depth of `value` (none in a valid record). */
export function forbiddenKeys(value, found = []) {
  if (Array.isArray(value)) { for (const v of value) forbiddenKeys(v, found); return found; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (PUBLIC_FORBIDDEN_KEYS.includes(k)) found.push(k); forbiddenKeys(v, found); }
  return found;
}

const MEMO_MS = 10 * 60_000;
let memo = { at: 0, body: null };
export function resetTrackRecordMemoForTests() { memo = { at: 0, body: null }; }

/** The public track record, read from D1 and the parity in KV, kept 10 minutes per isolate. Never throws. */
export async function readPublicTrackRecord(env, { now = Date.now() } = {}) {
  if (memo.body && now - memo.at < MEMO_MS) return memo.body;
  const delayHours = publicDelayHours(env);
  const source = publicManagedSource(env);
  let ledger = [], managed = [], parity = null;
  try {
    ledger = (await env.DB.prepare("SELECT opened_at, closed_at, r_tp1, r_tp2, tp1_closed_at, tp2_closed_at FROM signal_ledger WHERE source = 'decision' AND (r_tp1 IS NOT NULL OR r_tp2 IS NOT NULL)").all()).results || [];
  } catch { ledger = []; }
  try {
    managed = (await env.DB.prepare(source === "v4"
      ? "SELECT issued_ms, omega4_closed_at, r_omega4 FROM ledger_omega4 WHERE omega4_status = 'closed'"
      : "SELECT opened_at, omega_closed_at, r_omega, omega_size FROM signal_ledger WHERE source = 'decision' AND omega_status = 'closed' AND r_omega IS NOT NULL").all()).results || [];
  } catch { managed = []; }
  if (source === "v4") { try { parity = JSON.parse((await env.SIGNAL_CACHE?.get?.(OMEGA4_PARITY_KEY)) || "null"); } catch { parity = null; } }
  const body = publicTrackRecord({ ledger, managed, parity, now, delayHours, source });
  if (forbiddenKeys(body).length) return { version: TRACK_RECORD_VERSION, status: "unavailable" };
  memo = { at: now, body };
  return body;
}
