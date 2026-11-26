// Track A PR 9 (read-only study, the PR's report): how often the council and the War Room's Technical Analyst would
// read session_range, and what it adds to their prompts. Per recorded 15m decision (D1 engine_decisions: its close and
// 1H ATR) the reading is built from the KV 15m series up to that close and the MT5 calendar's high-impact releases,
// with the repository's own functions; the Technical Analyst's prompt is built as the War Room builds it (its four
// closed 15m candles), with and without the reading; the council's added characters are the reading and its prompt
// line, beside the council prompt of the zone scenario fixture as the reference size. Aggregates only (no row, no price).
//   node scripts/studies/orb/orb-council-size.mjs --data <dir> [--repo <checkout>]
// <dir>: raw_bars.txt and raw_decisions.txt as scripts/studies/orb/orb-replay.mjs reads them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const REPO = path.resolve(arg("--repo", path.join(here, "..", "..", "..")));
const DATA = path.resolve(arg("--data", path.join(here, "data")));
const { sessionRangeReading } = await import(`${REPO}/src/opening-range.mjs`);
const { openingMessages } = await import(`${REPO}/src/war-room.mjs`);
const de = await import(`${REPO}/src/decision-engine.mjs`);
const se = await import(`${REPO}/src/strategy-engine.mjs`);
const fx = await import(`${REPO}/test/support/zone-types-fixture.mjs`);

const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
const iso = (ms) => new Date(ms).toISOString();
const M15 = 15 * 60_000;
const bars = read("raw_bars.txt").bars.map(([o, op, h, l, c, cl]) => ({ open_time: iso(o), close_time: iso(cl ?? o + M15), open: op, high: h, low: l, close: c }));
const closeMs = bars.map((b) => Date.parse(b.close_time));
const raw = read("raw_decisions.txt");
const events = raw.cal.map(([time, currency, importance]) => ({ time, currency, impact: importance >= 3 ? "High" : "Medium" }));
const chars = (msgs) => msgs.reduce((s, m) => s + String(m.content).length, 0);

// The council's reference prompt: the zone scenario fixture's evidence (a full set of witnesses and plans).
const inputs = fx.zoneInputs();
const loaded = { inputs, strategy: se.buildStrategy(inputs), global: fx.zoneGlobal(), correlations: null, regime: "normal-trending" };
const a = de.assess(loaded, { now: fx.NOW, env: fx.ZONE_ENV });
const ref = chars(de.councilMessages(de.councilEvidence({ barClose: fx.CLOSE, cards: a.cards, quorum: a.quorum, guards: a.guards })));

let n = 0, present = 0, formed = 0, broke = 0, councilAdded = 0, techBase = 0, techWith = 0;
const bySession = { london: 0, new_york: 0 }, byStatus = {};
for (const [t, atr] of raw.rows) {
  let hi = closeMs.length; while (hi > 0 && closeMs[hi - 1] > t) hi--;
  const upTo = bars.slice(Math.max(0, hi - 192), hi);
  if (!upTo.length) continue;
  n++;
  const r = sessionRangeReading(upTo, { atr, events });
  const candles = upTo.slice(-4).map((b) => ({ t: b.close_time, o: b.open, h: b.high, l: b.low, c: b.close }));
  const base = chars(openingMessages("technical", { candles_15m: candles }));
  techBase += base;
  if (!r) { techWith += base; continue; }
  present++; bySession[r.session]++; byStatus[r.range.status] = (byStatus[r.range.status] || 0) + 1;
  if (r.range.status === "ok") formed++;
  if (r.breakout?.way) broke++;
  techWith += chars(openingMessages("technical", { candles_15m: candles, session_opening_range: r }));
  councilAdded += JSON.stringify({ session_range: r }).length + de.SESSION_RANGE_PROMPT.length + 1;
}
const r1 = (x) => Math.round(x * 10) / 10;
console.log(JSON.stringify({
  decisions: n, with_session_range: present, share_with: r1((100 * present) / n), by_session: bySession, by_status: byStatus, formed, with_breakout: broke,
  council: { reference_prompt_chars: ref, mean_added_chars_when_present: present ? Math.round(councilAdded / present) : 0, mean_added_pct_of_reference_when_present: present ? r1((100 * councilAdded / present) / ref) : 0, mean_added_pct_over_all_bars: r1((100 * councilAdded / n) / ref) },
  technical: { mean_prompt_chars_before: Math.round(techBase / n), mean_prompt_chars_after: Math.round(techWith / n), mean_growth_pct_over_all_bars: r1((100 * (techWith - techBase)) / techBase), mean_growth_pct_when_present: present ? r1((100 * (techWith - techBase)) / (techBase * present / n)) : 0 }
}, null, 2));
