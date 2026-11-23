// TP1-KZ's "off" check: a seeded sample of strategies (price, 1H range, Key Level Agent zones with candidate and
// qualified flags, 15m bars) and, for each, the plans the strategy agents and the base plan give on both sides in
// scalp and in the other modes, and the reward guardrail on each. The same function ran on main before TP1-KZ (the
// hash in test/tp1-key-zone.test.mjs); with TP1_KEY_ZONE_MODE "off" the output must be byte-identical.
import { planForDirection } from "../../src/strategy-engine.mjs";
import { agentContext, agentPlans, agentStatuses, AGENT_IDS } from "../../src/strategy-agents.mjs";
import { agentPlanPasses } from "../../src/decision-engine.mjs";

export function tp1OffSample({ n = 160, seed = 20261123 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const statuses = agentStatuses({ STRATEGY_AGENTS_LIVE: AGENT_IDS.join(",") });
  const out = [];
  for (let k = 0; k < n; k++) {
    const atr = 8 + rnd() * 25, price = Math.round((3500 + rnd() * 200) * 100) / 100;
    const zones = Array.from({ length: 4 + Math.floor(rnd() * 8) }, (_, i) => {
      const mid = price + (rnd() - 0.5) * 8 * atr, w = rnd() * 0.6 * atr;
      const candidate = rnd() < 0.4;
      return { low: Math.round((mid - w / 2) * 100) / 100, high: Math.round((mid + w / 2) * 100) / 100, price: Math.round(mid * 100) / 100, candidate, qualified: candidate || rnd() < 0.5, label: `z${i}` };
    });
    let p = price + (rnd() - 0.5) * atr;
    const bars = Array.from({ length: 40 }, (_, i) => { const o = p; p += (rnd() - 0.5) * 0.6 * atr; const hi = Math.max(o, p) + rnd() * 0.3 * atr, lo = Math.min(o, p) - rnd() * 0.3 * atr; return { open_time: new Date(Date.UTC(2026, 10, 20, 0, 15 * i)).toISOString(), open: o, high: hi, low: lo, close: i === 39 ? price : p }; });
    const strategy = { price, atr_h1: atr, direction: rnd() < 0.5 ? "LONG" : "SHORT", plan: { at_level: rnd() < 0.3 }, setup: { type: "none" }, key_levels: { zones, patterns: [] } };
    for (const scalp of [false, true]) for (const dir of [1, -1]) {
      const g = { target_rule: scalp ? "nearest" : "rrr", min_rrr: scalp ? 0 : 1.5 };
      const base = planForDirection(strategy, dir, { scalp, keyZone: false });
      const plans = agentPlans(dir, agentContext({ strategy, bars, scalp, basePlan: planForDirection(strategy, dir, { scalp, keyZone: false }) }), statuses);
      out.push({ k, scalp, dir, base, plans, passes: Object.fromEntries(Object.entries(plans).map(([id, a]) => [id, agentPlanPasses(a.plan, g)])) });
    }
  }
  return JSON.stringify(out);
}
