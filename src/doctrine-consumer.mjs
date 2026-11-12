// The Doctrine Consumer for XAUUSD Trading Agents (Decision Council, War Rooms, Timeframe Threads).
// (owner 2026-11-11: "untuk setiap hasil knowledge council terkait update doctrine harus diterapkan ke aether untuk di consume agents").
//
// Topology & Protocol:
//  1. Nexus and Omega seats report hourly facts to Aether (src/doctrine-facts.mjs).
//  2. Daily at 03:52 UTC, Aether Knowledge Council (cryptophys-aether) evaluates drifts against DOCTRINE_BOUNDS.
//  3. The Council proposes amendments via consensus.propose to Cerebrum (cryptophys-ai-kernel).
//  4. Cerebrum executes approved amendments (doctrine_amendments table).
//  5. Hourly at :52, Aether syncs executed amendments via doctrine.status into doctrine_applied.
//  6. This module allows the AI Worker to consume Aether's effectiveDoctrine dynamically:
//     - Checks short-lived in-memory cache (5 min).
//     - Checks persistent KV cache in SIGNAL_CACHE (key: aether:doctrine:effective, TTL: 1 hr).
//     - Calls env.AETHER_READER.overview() over Service Binding when needed.
//     - Falls back safely to CANON_DOCTRINE_RULES when offline or in tests.
//     - Formats active doctrine directives for LLM prompt injection into Decision Council and Room Agents.

export const DOCTRINE_KV_KEY = "aether:doctrine:effective";
export const DOCTRINE_MEMORY_TTL_MS = 5 * 60_000; // 5 minutes
export const DOCTRINE_KV_TTL_SECONDS = 3600;       // 1 hour

/** The 20 baseline Canon doctrine rules mirrored from Canon v2. Never throws. */
export const CANON_DOCTRINE_RULES = Object.freeze([
  { id: "execution_boundary", class: "constitutional", rule: "No Worker places an order or can read a broker credential. Trades happen only on the owner's own MetaTrader 5 terminal: the owner's EA executes the decision it reads from the signal API, or the Omega bridge executes what Omega plans and sizes from the owner's risk setting, at most 2% of equity per trade. Omega plans nothing unless both its switch and its page toggle are on, a real account also needs the typed LIVE arm, a kill closes the positions, and the EA and the Omega executor never run on the same account. Aether, the kernel and learned knowledge stay advisory." },
  { id: "no_levels_to_kernel", class: "constitutional", rule: "Reports to the platform kernel and decision cards to Aether never carry a price level, a size or order wording (entry, stop, target, zones, key levels, lots)." },
  { id: "kernel_rules", class: "constitutional", rule: "Calls to the platform kernel use RPC Service Bindings without shared secrets; reports are info or warning, never critical; a denial is final (no retry, no switching agent ids)." },
  { id: "parity_trust_only", class: "constitutional", rule: "Local engine trust comes only from the autonomous parity registry (24 consecutive candles that match TradingView); nothing is marked verified by hand, and the Pine sources and hashed engines are never edited. The local lane is the decision lane (local); TradingView webhooks only calibrate it." },
  { id: "fail_closed_wait", class: "constitutional", rule: "When the evidence is missing the answer is WAIT, never a guess. A room without a usable closed candle or without its quorum decides WAIT. The Decision Engine gives WAIT when any guardrail fails; when the council fails or answers invalidly, the strategy engine's decision stands only if its side passes every guardrail, otherwise WAIT. A closed market is always WAIT." },
  { id: "learned_is_not_canon", class: "constitutional", rule: "Learned knowledge is labelled as learned, cites its evidence, and never redefines a field or a rule of the canon. The doctrine changes only through a reviewed PR or an amendment Cerebrum executed (doctrine_protocol), never from learned knowledge." },
  { id: "promotion_by_owner", class: "constitutional", rule: "No change to an engine parameter, a prompt or a knowledge item is promoted automatically: candidates run in shadow, are judged by outcome scoring with a significance test, and the owner approves a separate promotion PR. Two things change without an operator: the room quorum weighting (weighting_auto) and operational doctrine amendments inside their hard bounds that Cerebrum executed (doctrine_protocol)." },
  { id: "doctrine_protocol", class: "constitutional", rule: "The doctrine follows the measured system through the Knowledge Council. Once a day its Nexus, Omega and Aether seats compare every rule's anchored facts with what the running system reports; a difference the reporting seat measured twice, at least 45 minutes apart, and the Aether seat validated, is proposed to the Cerebrum consensus. Cerebrum votes and executes it: an operational fact inside its hard bounds after the vote, anything else after one owner approval. Aether applies only amendments Cerebrum executed and folds them into the canon by a reviewed PR. No seat changes the doctrine by itself." },
  { id: "decision_engine_ssot", class: "operational", rule: "The Decision Engine is the single decision. At every 15m close one AI council, the only reader across the timeframes, chooses BUY, SELL or WAIT from witnesses that each judge from their own data, weighted D1 room 0.1469, 4H room 0.1469, 1H room 0.1469, 15m room 0.1103, News Daily 0.0735, Macro War Room 0.0367, strategy engine 0.0735, key levels 0.0459, regime 0.0459, cross-timeframe trend 0.0459, macro drivers 0.0276, session 0.02, economic calendar inside a release's horizon 0.08; a missing or stale witness drops out and the rest renormalise. It decides inside deterministic guardrails it cannot break (market_open, fresh, quorum, confirmation, no_veto, levels, reward, confidence); a BUY or SELL that breaks one becomes WAIT. Prices come only from the Key Level Agent's plan, never from a model. Its decision feeds the EA, Omega, Telegram, the Signal Ledger and Nexus." },
  { id: "engine_thresholds", class: "operational", rule: "In the intraday mode the Decision Engine's BUY or SELL needs more than 50% of the witnesses' weight on its side, or a lean of at least 0.15 with more weight than the other side; a confirmation; no veto; a plan from the key levels paying at least 1.5R to its target; and a confidence of at least 0.4. The trading mode (scalp, intraday or swing) sets these thresholds. In the scalp mode the target is the nearest key level ahead, with no reward-to-risk minimum." },
  { id: "confirmation_required", class: "operational", rule: "The rooms decide by their own quorum, without a confirmation gate. The Decision Engine never enters without a confirmation: the 15m or the 1H room decided that side, or a verified 5m or 15m Prophet confirmation; a 5m confirmation counts only while the 5m Prophet implementation is parity-approved." },
  { id: "h1_quorum", class: "operational", rule: "The H1 decision is the quorum of the 1H War Room: BUY or SELL only when the moderator concluded it and more than the room's quorum share (default 50%, tuned by weighting_auto) of the weight of the agents who spoke holds the matching bias, with prices from the 1H plan; otherwise WAIT. Indicator signals are the agents' arguments, never gates or vetoes. The H1 decision is one witness of the Decision Engine; it drives the EA and Telegram only while the Decision Engine is off." },
  { id: "independent_rooms", class: "operational", rule: "Every timeframe's room is independent: its agents read only that timeframe's own data, never another timeframe's room, desk or decision and never another agent; the Consensus Discussion stays inside each timeframe over an anonymous bus, and every answer names the metrics it decided from, never an agent. Only the Decision Engine's council reads across the timeframes." },
  { id: "bias_beside_action", class: "operational", rule: "Every opening states its action and its bias (BULLISH, BEARISH or NEUTRAL): the direction its own data leans, even when the action is WAIT." },
  { id: "support_rules", class: "operational", rule: "A room's BUY or SELL conclusion needs at least one agent holding that stance; a BULLISH or BEARISH bias needs at least one agent holding it." },
  { id: "calibration_status_once", class: "operational", rule: "Agents never mention calibration, parity or verification in their text; readers see each agent's calibration status once, next to its name. In the Live War Room 15m an agent with no calibrated statement speaks at confidence 0.4 or lower; the 1H, 4H and D1 rooms have no such cap." },
  { id: "own_data_only", class: "operational", rule: "Each HUD or indicator agent analyses only the data its own HUD or indicator produces." },
  { id: "weighting_auto", class: "operational", rule: "The quorum weighting of every room is tuned automatically per timeframe over a reviewed grid (auto mode): xauusd activates a point its replay rates better on discovery and holdout, at most once every 7 days, rolls a worse one back after 100 rooms of reverse shadow, and tells the owner on Telegram. Aether audits the reports and proposes nothing." },
  { id: "event_caution", class: "operational", rule: "A High-impact USD event, from 120 minutes before to 30 minutes after it, is a caution in the decision, never a forced WAIT; the EA and Omega make no new entry in that window. After a release with its value, the Calendar Agent's bias follows the surprise within the event's learned horizon." },
  { id: "omega_execution_gates", class: "operational", rule: "Omega opens at most once per signal, before it expires and within 10 minutes of the decision, outside the event blackout and the daily rollover quarantine (21:55-22:15 UTC), at a spread of at most 60 points, with fewer than 1 open positions and above the daily loss limit of 2% of the day's starting balance. It risks 0.5% of equity at the stop and keeps the plan's distances from the broker's own price; a position against the signal is closed. A new entry's lot is capped to what the day can still lose (the equity above the daily loss floor less the open positions' loss at their stops), and a second position on a side waits until every position on that side is protected, its stop at or beyond its open price. Omega alone moves an open position's stop and target, from the key levels and the latest decision's quorum power: past a key level the stop locks a small profit and steps behind the passed levels (further back with a strong power, tighter with a weak one), near the target a strong power moves it to the next key level, and a winner is closed when the power turns strongly against it; the executor's own break-even and trailing are off." }
]);

let memoryCache = {
  data: null,
  cachedAt: 0,
  source: null
};

export function resetDoctrineConsumerCacheForTests() {
  memoryCache = { data: null, cachedAt: 0, source: null };
}

/**
 * Pure: normalises a raw doctrine rule list ensuring class and required fields.
 */
export function normaliseDoctrineRules(rawRules) {
  if (!Array.isArray(rawRules) || !rawRules.length) return CANON_DOCTRINE_RULES;
  return rawRules.map((r) => ({
    id: String(r.id),
    class: r.class === "constitutional" ? "constitutional" : "operational",
    rule: String(r.rule || ""),
    canon_rule: r.canon_rule ? String(r.canon_rule) : undefined,
    since: r.since ? String(r.since) : undefined,
    amended: r.amended && typeof r.amended === "object" ? {
      amendment_id: String(r.amended.amendment_id),
      action: String(r.amended.action),
      executed_at: String(r.amended.executed_at)
    } : null
  }));
}

/**
 * Reads effective doctrine from Aether over Service Binding or fallback to KV/canon.
 * Never throws.
 */
export async function fetchEffectiveDoctrine(env, { force = false, now = Date.now() } = {}) {
  // 1. Memory cache check
  if (!force && memoryCache.data && (now - memoryCache.cachedAt) < DOCTRINE_MEMORY_TTL_MS) {
    return memoryCache.data;
  }

  // 2. Persistent KV check (if not forcing fresh pull)
  if (!force && env?.SIGNAL_CACHE?.get) {
    try {
      const rawKv = await env.SIGNAL_CACHE.get(DOCTRINE_KV_KEY, "json");
      if (rawKv && Array.isArray(rawKv.rules) && rawKv.rules.length) {
        const cached = {
          version: rawKv.version || "v2",
          rules: normaliseDoctrineRules(rawKv.rules),
          applied: Array.isArray(rawKv.applied) ? rawKv.applied : [],
          council: rawKv.council || null,
          facts: rawKv.facts || null,
          source: "kv",
          cached_at: rawKv.cached_at || new Date(now).toISOString()
        };
        memoryCache = { data: cached, cachedAt: now, source: "kv" };
        return cached;
      }
    } catch { /* proceed to remote fetch */ }
  }

  // 3. Remote fetch via AETHER_READER Service Binding
  if (typeof env?.AETHER_READER?.overview === "function") {
    try {
      const overview = await env.AETHER_READER.overview();
      const rawRules = overview?.doctrine?.rules ?? overview?.canon?.doctrine;
      if (Array.isArray(rawRules) && rawRules.length) {
        const payload = {
          version: overview?.doctrine?.version || overview?.canon?.version || "v2",
          rules: normaliseDoctrineRules(rawRules),
          applied: Array.isArray(overview?.doctrine?.applied) ? overview.doctrine.applied : [],
          council: overview?.doctrine?.council || null,
          facts: overview?.doctrine?.facts || null,
          source: "aether",
          cached_at: new Date(now).toISOString()
        };

        // Cache in KV for fast multi-isolate reads
        if (env?.SIGNAL_CACHE?.put) {
          try {
            await env.SIGNAL_CACHE.put(
              DOCTRINE_KV_KEY,
              JSON.stringify(payload),
              { expirationTtl: DOCTRINE_KV_TTL_SECONDS }
            );
          } catch { /* non-fatal KV write failure */ }
        }

        memoryCache = { data: payload, cachedAt: now, source: "aether" };
        return payload;
      }
    } catch (e) {
      console.warn("fetchEffectiveDoctrine_aether_failed", e instanceof Error ? e.message : String(e));
    }
  }

  // 4. Default Canon Baseline Fallback
  const fallback = {
    version: "v2-baseline",
    rules: CANON_DOCTRINE_RULES,
    applied: [],
    council: null,
    facts: null,
    source: "canon_fallback",
    cached_at: new Date(now).toISOString()
  };
  memoryCache = { data: fallback, cachedAt: now, source: "canon_fallback" };
  return fallback;
}

/**
 * Accessor for active doctrine rules. Never throws.
 */
export async function getEffectiveDoctrine(env, options = {}) {
  const result = await fetchEffectiveDoctrine(env, options);
  return result?.rules ?? CANON_DOCTRINE_RULES;
}

/**
 * Formats active doctrine rules into prompt directives for the Decision Council and Room Agents.
 * Emphasizes constitutional boundaries and execution rules.
 */
export function formatDoctrineDirectives(rules, { role = "council" } = {}) {
  const active = Array.isArray(rules) && rules.length ? rules : CANON_DOCTRINE_RULES;
  const constitutional = active.filter((r) => r.class === "constitutional");
  const operational = active.filter((r) => r.class === "operational");

  const lines = [
    "ACTIVE SYSTEM DOCTRINE (enforced by Cerebrum Consensus & Aether Knowledge Council):",
    "Constitutional Invariants:"
  ];

  for (const r of constitutional) {
    const amended = r.amended ? ` [AMENDED by Cerebrum]` : "";
    lines.push(`- ${r.id}${amended}: ${r.rule}`);
  }

  lines.push("Operational Mandates:");
  // Filter relevant operational rules based on agent role
  const targetIds = role === "council"
    ? ["decision_engine_ssot", "engine_thresholds", "confirmation_required", "event_caution", "omega_execution_gates"]
    : ["independent_rooms", "bias_beside_action", "support_rules", "calibration_status_once", "own_data_only"];

  for (const r of operational) {
    if (targetIds.includes(r.id) || r.amended) {
      const amended = r.amended ? ` [AMENDED: ${r.amended.amendment_id}]` : "";
      lines.push(`- ${r.id}${amended}: ${r.rule}`);
    }
  }

  return lines.join("\n");
}
