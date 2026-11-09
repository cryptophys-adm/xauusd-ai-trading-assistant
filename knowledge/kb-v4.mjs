// Authored content of knowledge-base v4. Every encoding below is taken from
// the Pine SSOT sources in pinescript/ssot/ and cites the exact line it comes
// from (`ref`). `test/knowledge-base.test.mjs` fails if a cited line no longer
// contains the quoted text, so the KB cannot silently drift from the Pine.
// Build: `node scripts/build-knowledge-base.mjs --write`.

export const PINE_FILES = Object.freeze({
  prophet_r38: "pinescript/ssot/The-Prophet-v7.02-R38.txt",
  gmi_v12_70: "pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt",
  mizanlib: "pinescript/ssot/CryptophysMizanLib-uploaded.txt"
});

const ref = (file, line, contains) => ({ file, line, contains });

export const KB_V4_CONTENT = {
  version: 4,
  status: "derived_from_pine_ssot",
  purpose: "Field dictionary and decision rules for interpreting XAUUSD 1H evidence from the TradingView webhook lane and the local_computation lane. All encodings are derived from the Pine SSOT sources with line references; nothing here is inferred from field names.",

  input_lanes: {
    tradingview_webhook: "Indicator outputs computed by TradingView on the closed 1H candle. Three webhook sources: prophet_r38 (The Prophet v7.02 R38 indicator), prophet_r37_ssot (the shared Prophet structure core computed inside GMI from MizanLib) and gmi_v12_70 (Global Multiverse Interceptor v12.70). Ground truth for the indicator state.",
    local_computation: "Recomputed locally from raw TradingView OHLCV by three local engines: MizanLib (record engine id 'mizan'), Prophet (engine id 'prophet') and GMI (engine id 'gmi'). Only trust local values whose trust_status is approved_by_parity (24 consecutive candles matched the webhook field by field). values.diagnostics are unverified internals: use them only to explain, never as decisive evidence. The Prophet record also carries values.setup (surfaced as prophet_r38.setup_state): the Prophet setup state behind the HUD's READY line, derived from the same R38 logic; no alert carries it, so parity never compares it.",
    local_engines: {
      MizanLib: "engine id 'mizan'. Shared library core (prophet_structure_core, calculate_prophet_tensor) used by both Prophet and GMI. It has no webhook of its own; it is trusted only while an approved Prophet and an approved GMI both declare this MizanLib identity as their dependency.",
      Prophet: "engine id 'prophet'. values.comparable.prophet_r38 is compared with the prophet_r38 webhook and values.comparable.prophet_r37_ssot with the prophet_r37_ssot webhook.",
      GMI: "engine id 'gmi'. values.comparable.gmi_v12_70 is compared with the gmi_v12_70 webhook."
    },
    naming_rule: "Local engines are named MizanLib, Prophet and GMI. prophet_r38, prophet_r37_ssot and gmi_v12_70 are WEBHOOK source names (and the keys of values.comparable), not local engine names.",
    fundamental_news: "Completed news analysis (analyst, counselor, reasoner) of articles from the last hour. Context only; it never creates a technical trigger by itself.",
    lane_rules: [
      "Never merge, average or relabel values across lanes; attribute every claim to its lane.",
      "If webhook and approved local values disagree for the same field, report the disagreement and prefer WAIT.",
      "structure_state and shared_core_status are chart-relative bar_index values (may be NaN/null). They carry no direction; ignore them."
    ]
  },

  field_dictionary: {
    prophet_r38: {
      description: "The Prophet v7.02 R38 on the 1H chart, V2 (non-legacy) gate. Emitted once per closed bar.",
      ref: ref("prophet_r38", 1148, "string cta_prophet_payload"),
      fields: {
        direction: {
          values: { "1": "buy_confirmed on this bar", "-1": "sell_confirmed on this bar", "0": "no new confirmation on this bar" },
          note: "A one-bar EVENT, not a persistent bias. 0 on most bars is normal and means 'no new signal', not bearish or neutral bias.",
          ref: ref("prophet_r38", 1148, "buy_confirmed ? 1 : sell_confirmed ? -1 : 0")
        },
        buy_confirmed: {
          meaning: "True only on the first bar that passes the V2 buy gate after a raw buy cross.",
          gate: [
            "Raw buy cross: pro_fast crosses above pro_slow while pro_fast < -0.15 (deep oversold), on a confirmed bar.",
            "Within the confirmation window (3 bars on 1H) and not superseded by a later sell cross.",
            "Bullish price confirmation: close > open and close > previous high.",
            "Fresh bullish structure (event within 6 bars): d_enc == 1, or b_enc == 3 with d_enc != 0, or d_enc == -3 with subtype 3 (bear trap) or 2 (true breakout).",
            "Volume: no volume data, or signal volume ratio >= 0.85."
          ],
          refs: [
            ref("prophet_r38", 316, "bool raw_buy_cross"),
            ref("prophet_r38", 115, "const float RAW_CROSS_DEPTH = 0.15"),
            ref("prophet_r38", 335, "bool bullish_structure_v2"),
            ref("prophet_r38", 353, "bool buy_volume_pass"),
            ref("prophet_r38", 117, "const float MIN_VOLUME_RATIO = 0.85"),
            ref("prophet_r38", 402, "bool buy_confirmed = ")
          ]
        },
        sell_confirmed: {
          meaning: "Mirror of buy_confirmed: raw cross below with pro_fast > 0.15, bearish price confirmation (close < open and close < previous low), fresh bearish structure (d_enc == -1, or b_enc == -3 with d_enc != 0, or d_enc == 3 with subtype 1 or 4), volume ratio >= 0.85.",
          refs: [ref("prophet_r38", 336, "bool bearish_structure_v2")]
        },
        buy_high_quality: {
          meaning: "buy_confirmed AND real volume with signal ratio >= 1.0 AND the KWW z-score (50) reached <= -0.618 during the setup window (depth). Stronger than buy_confirmed alone.",
          refs: [
            ref("prophet_r38", 375, "bool buy_high_quality_raw"),
            ref("prophet_r38", 118, "const float HIGH_QUALITY_VOLUME_RATIO = 1.0"),
            ref("prophet_r38", 119, "const float SETUP_DEPTH_Z = 0.618")
          ]
        },
        sell_high_quality: { meaning: "Mirror of buy_high_quality (z-score reached >= +0.618)." },
        t_enc: {
          meaning: "Trade-management state of an EXISTING position (not an entry signal). Non-legacy precedence: d_enc==3 first, then price discovery, then the rest.",
          values: {
            "0": "NOMINAL (HOLD): nothing to manage",
            "1": "PYRAMID BULL: add to longs (bullish structure state d_enc==-3, or strong bullish cycle alignment with efficiency > 0.5, volume anomaly >= 0.85 and Hurst > 0.60)",
            "-1": "PYRAMID BEAR: add to shorts (mirror of 1)",
            "3": "REVERSAL: b_enc is +/-3 and the market is NOT strongly trending (Hurst <= 0.60)",
            "4": "RUTHLESS CUT LOSS: bearish structure state d_enc==3 without a strong macro filter. The only t_enc that acts as a veto for longs",
            "5": "AWAIT MACRO (HOLD): d_enc==3 but strong trend (Hurst > 0.60) and |z-score| >= 1.0. Not a veto (R37 FIX-1)",
            "6": "DISCOVERING HIGH: pro_fast >= 0.45 (price discovery up)",
            "-6": "DISCOVERING LOW: pro_fast <= -0.45 (price discovery down)",
            "2|-2": "TP (OVERBOUGHT/OVERSOLD): defined in the decoder but not assigned by R38"
          },
          management_direction: "tm_dir = +1 for t_enc 1, -2, 6; -1 for t_enc -1, 2, 4, -6; 0 otherwise.",
          refs: [
            ref("prophet_r38", 198, "float t_enc = 0.0"),
            ref("prophet_r38", 116, "const float PRICE_DISCOVERY_THRESHOLD = 0.45"),
            ref("prophet_r38", 120, "const float MACRO_FILTER_Z = 1.0"),
            ref("prophet_r38", 160, "bool is_strong_trend = hurst > 0.60"),
            ref("prophet_r38", 288, "int tm_dir = ")
          ]
        },
        d_enc: { see: "structure_core.d_enc" },
        structure_subtype: { see: "structure_core.subtype" },
        setup_state: {
          lane: "local_computation only. Not a TradingView alert field: the local Prophet engine derives it from the same R38 setup logic that drives the HUD's entry instruction, and parity never compares it.",
          meaning: "The Prophet setup STATE of the closed candle, which outlives the one-bar buy_confirmed / sell_confirmed event. The HUD shows 'BUY · READY' while the buy setup is still inside its confirmation window (3 closed bars on 1H), the gate passed within this setup and the bullish cycle alignment (inten == 3) still holds; the alert payload only carries the event bar, so on the following bars buy_confirmed is false while the HUD still reads READY.",
          fields: {
            buy_ready: "decision_buy_setup_active and last_buy_passed: the HUD's BUY · READY before its macro check. Counts as the Prophet entry trigger for a long on this closed candle.",
            sell_ready: "Mirror of buy_ready for a short (inten == -3).",
            buy_pass_age: "Closed bars since the bar where buy_confirmed was true within the current setup (0 on the event bar itself); null when the current setup has not passed.",
            sell_pass_age: "Mirror of buy_pass_age.",
            confirmation_window: "The setup's confirmation window in closed bars (3 on 1H).",
            buy_setup_active: "latest_is_buy and buy_window_active and inten == 3: a buy setup inside its window with the bullish cycle alignment.",
            sell_setup_active: "Mirror for a sell setup (inten == -3).",
            buy_passed: "The buy gate passed within the current setup (Pine last_buy_passed).",
            sell_passed: "Mirror of buy_passed.",
            superseded_by_trend: "'BUY' when a buy setup inside its window meets a bearish cycle alignment (inten == -3), 'SELL' for the mirror, else null. Not an entry.",
            macro_z_bull: "Pine is_macro_bull: the KWW z-score (50) is above 0. The GMI z-alignment half of buy_macro_ok is not reproduced locally; the GMI validator rules cover it.",
            macro_z_bear: "Pine is_macro_bear: the z-score is below 0.",
            gate_status: "The engine's gate reading: BUY_CONFIRMED, BUY_WAIT_PRICE, BUY_WAIT_STRUCTURE, BUY_WAIT_VOLUME, BUY_WAIT (mirror for SELL) or NO_ACTIVE_SETUP.",
            instruction: "BUY_READY, SELL_READY, BUY_SETUP_SUPERSEDED_BY_TREND, SELL_SETUP_SUPERSEDED_BY_TREND, a *_WAIT_* gate reading while a setup is active, or NO_SETUP.",
            buy_confirmed: "The one-bar event of this closed candle, repeated here so the state can be checked against the record.",
            sell_confirmed: "Mirror of buy_confirmed."
          },
          refs: [
            ref("prophet_r38", 424, "bool decision_buy_setup_active = latest_is_buy and buy_window_active and inten == 3.0"),
            ref("prophet_r38", 426, "bool buy_setup_superseded_by_trend"),
            ref("prophet_r38", 428, "bool last_buy_passed"),
            ref("prophet_r38", 655, "bool buy_macro_ok = is_macro_bull and gmi_z_alignment_code == 1"),
            ref("prophet_r38", 675, "\"BUY · READY\""),
            ref("prophet_r38", 93, "confirmation_window = auto_window")
          ]
        }
      }
    },

    prophet_r37_ssot: {
      description: "Shared Prophet structure core as computed inside GMI v12.70 (MizanLib prophet_structure_core) on the same 1H bar.",
      ref: ref("gmi_v12_70", 2817, "string cta_core_payload"),
      fields: {
        direction: {
          meaning: "r10_prophet_consensus_dir: sign of pro_fast, combined with the structure direction (subtype 2/3 or d_enc 1 -> +1; subtype 1/4 or d_enc -1 -> -1). If the two disagree the result is 0 (internal conflict). Persistent state, unlike prophet_r38.direction.",
          values: { "1": "bullish Prophet consensus", "-1": "bearish Prophet consensus", "0": "flat or internally conflicted" },
          refs: [ref("gmi_v12_70", 1313, "int r10_prophet_div_dir"), ref("gmi_v12_70", 1316, "int r10_prophet_consensus_dir")]
        },
        d_enc: { see: "structure_core.d_enc" },
        b_enc: { see: "structure_core.b_enc" },
        structure_subtype: { see: "structure_core.subtype" },
        bull_event: { meaning: "A bullish structure event (bullish divergence, bullish break, true breakout or bear trap) is on record since the last oscillator zero-cross. Not necessarily on this bar." },
        bear_event: { meaning: "Mirror of bull_event for bearish structure events." },
        structure_state: { meaning: "bar_index of the last trap/breakout resolution; chart-relative, ignore." }
      }
    },

    structure_core: {
      description: "MizanLib prophet_structure_core: divergence and structure state machine on the Prophet fast oscillator (pivots 5/2). States reset on an oscillator zero-cross and expire after state_max_age bars.",
      ref: ref("mizanlib", 856, "export prophet_structure_core"),
      d_enc: {
        values: {
          "0": "no active divergence/structure state",
          "1": "BULLISH DIVERGENCE: price made a lower low while the oscillator made a higher low below zero",
          "-1": "BEARISH DIVERGENCE: price made a higher high while the oscillator made a lower high above zero",
          "3": "BEARISH STRUCTURE STATE: resolved as subtype 1 (bull trap) or 4 (true breakdown)",
          "-3": "BULLISH STRUCTURE STATE: resolved as subtype 2 (true breakout) or 3 (bear trap / liquidity sweep down)"
        },
        warning: "Sign convention is inverted for the resolved states: d_enc 3 is BEARISH and d_enc -3 is BULLISH.",
        refs: [ref("mizanlib", 889, "d_state := -1.0"), ref("mizanlib", 902, "d_state := 1.0"), ref("mizanlib", 964, "bar_index - state_bar > state_max_age")]
      },
      b_enc: {
        values: {
          "1": "reset/neutral after an oscillator zero-cross",
          "2": "divergence just formed",
          "3": "bullish break: after a bullish divergence, close > previous high on a bullish candle; also set for true breakout / bear trap",
          "-3": "bearish break: after a bearish divergence, close < previous low on a bearish candle",
          "-4": "bearish resolved state (bull trap or true breakdown)"
        },
        refs: [ref("mizanlib", 931, "b_state := 3.0"), ref("mizanlib", 938, "b_state := -3.0")]
      },
      subtype: {
        values: {
          "0": "unresolved",
          "1": "BULL TRAP / FAKEOUT UP: after a bearish divergence price closed above the prior high but with top rejection or weak volume (bearish)",
          "2": "TRUE BREAKOUT: after a bearish divergence price closed above the prior high with real volume and no rejection (bullish)",
          "3": "BEAR TRAP / LIQUIDITY SWEEP DOWN: after a bullish divergence price closed below the prior low but with bottom rejection or weak volume (bullish)",
          "4": "TRUE BREAKDOWN: after a bullish divergence price closed below the prior low with real volume and no rejection (bearish)"
        },
        refs: [
          ref("mizanlib", 855, "// subtype: 0 unresolved, 1 bull trap, 2 true breakout, 3 bear trap, 4 true breakdown."),
          ref("mizanlib", 925, "subtype := 1"), ref("mizanlib", 932, "subtype := 2"),
          ref("mizanlib", 947, "subtype := 3"), ref("mizanlib", 954, "subtype := 4"),
          ref("prophet_r38", 111, "int SUB_BULL_TRAP = 1")
        ]
      }
    },

    gmi_v12_70: {
      description: "Global Multiverse Interceptor v12.70 action verdict after the override chain and the R10 Prophet x GMI x Volume-Profile confluence gate.",
      ref: ref("gmi_v12_70", 2818, "string cta_gmi_payload"),
      fields: {
        verdict: {
          values: {
            "3": "bullish verdict",
            "-3": "bearish verdict",
            "4": "EXTENSION STATE: review position risk (macro bullish and pro_fast > 0.45). Not an entry",
            "-1": "EXHAUSTION / RISK ALERT (macro bullish but kinetics decelerating). Not a short signal",
            "0": "WAIT / no directional verdict: includes entropy trap (avalanche), volume veto (fakeout likely), chaos, and R10 conflict resets"
          },
          derivation: [
            "Base state, first match wins: kinetic reversal long/short -> +/-3; ext_state 1 with bullish macro -> -1; ext_state 2 with bullish macro -> 4; bullish macro with bullish structure or flow -> 3; bearish macro with bearish structure or flow -> -3.",
            "Overrides, first match wins: entropy trap -> 0; zone setup with volume veto -> 0; GABFX/whale/Aegis OB buy or sell -> +/-3; Fabio Model 1 (NY trend) -> +/-3; Fabio Model 2 (London fakeout) -> +/-3; JMA oversold/overbought inside value area -> +/-3; kinetic reversal -> +/-3.",
            "R10 gate: if conflict, verdict is reset to 0."
          ],
          refs: [
            ref("gmi_v12_70", 1157, "float verdict_state = 0"),
            ref("gmi_v12_70", 888, "float htf_state = "),
            ref("gmi_v12_70", 892, "float mtf_state = "),
            ref("gmi_v12_70", 893, "float ltf_state = "),
            ref("gmi_v12_70", 894, "float ext_state = "),
            ref("gmi_v12_70", 1201, "if is_entropy_trap"),
            ref("gmi_v12_70", 1209, "and veto_active"),
            ref("gmi_v12_70", 1215, "else if pa_gabfx_buy"),
            ref("gmi_v12_70", 1228, "else if fabio_m1_buy"),
            ref("gmi_v12_70", 1252, "else if jma_alert_long and is_balance"),
            ref("gmi_v12_70", 1264, "else if kin_rev_long"),
            ref("gmi_v12_70", 1328, "if r10_integration_conflict")
          ]
        },
        gate: {
          values: {
            "2": "ALIGNED: GMI direction == Prophet consensus == volume-profile location (close above VAH for long, below VAL for short). Strongest confluence",
            "1": "evaluable, no conflict, but not fully aligned (for example GMI neutral or price inside the value area)",
            "-1": "CONFLICT: Prophet internal conflict, GMI vs Prophet, VP location vs Prophet, or Prophet risk hold (subtype 1 bull trap). Verdict forced to 0",
            "-2": "volume profile invalid; gate not evaluable",
            "0": "integration inactive (disabled or bar not confirmed)"
          },
          ref: ref("gmi_v12_70", 1326, "int r10_gate_status")
        },
        gmi_dir: {
          meaning: "Direction of the GMI verdict BEFORE the R10 reset (3 -> 1, -3 -> -1, else 0). With conflict=true you can see gmi_dir != 0 while verdict == 0.",
          ref: ref("gmi_v12_70", 1318, "int r10_gmi_dir")
        },
        prophet_dir: { see: "prophet_r37_ssot.direction" },
        conflict: {
          meaning: "r10_integration_conflict. True means GMI blocked the setup; treat as WAIT.",
          refs: [ref("gmi_v12_70", 1324, "bool r10_integration_conflict"), ref("gmi_v12_70", 1321, "bool r10_prophet_risk_hold")]
        },
        shared_core_status: { meaning: "bar_index of the shared structure state; chart-relative, may be NaN. Ignore." }
      },
      context_terms: {
        chaos: { meaning: "entropy >= 0.8 or noise >= 0.85: safe mode, no directional trust.", ref: ref("gmi_v12_70", 444, "bool is_chaos = ") },
        volume_veto: { meaning: "3-bar volume below 35% of its average: zone setups are vetoed as likely fakeouts.", ref: ref("gmi_v12_70", 734, "bool veto_active = ") },
        kinetic_reversal: { meaning: "TVA kinetics estimate a reversal within <= 5 bars with price outside the value area.", ref: ref("gmi_v12_70", 896, "bool kin_rev_long = ") },
        volume_profile: { meaning: "VAH/VAL/POC from the TDM profile; r10_vp_location_dir = +1 above VAH, -1 below VAL, 0 inside.", ref: ref("gmi_v12_70", 1311, "int r10_vp_location_dir") }
      }
    }
  },

  decision_policy: {
    basis: "Project policy (Prophet = base bias, GMI = validator) applied to the Pine encodings above. Field meanings come from Pine; these combination rules are the project's, not TradingView's.",
    prophet_is_base_bias: true,
    base_bias_source: "prophet_r37_ssot.direction (persistent consensus). prophet_r38.direction/buy_confirmed/sell_confirmed are entry TRIGGER events, not bias.",
    gmi_role: "validate, block or wait on Prophet setups; must not silently overwrite Prophet's bias",
    candle_semantics: "Every field describes the closed candle being decided: the bar that just closed (candle_time / candle_key), never the running candle. The alerts fire at bar close and the local engines compute the last closed bar. 'On the closed candle' below means that bar.",
    h1_decision_mode: "agent_quorum",
    h1_decision: "Owner decision 2026-11-09: the H1 decision is the quorum of the 1H War Room, independent of the TradingView webhooks, of parity approval and of any single indicator signal. BUY or SELL only when the moderator concluded BUY or SELL AND more than 50% of the weight of the agents who spoke (each weighted by its track record, the P7 crowd line; Aether tunes the weights) holds the matching bias (BULLISH for a BUY, BEARISH for a SELL). Otherwise WAIT. The entry, stop and target come from the Key Level Agent's zones through the strategy engine; without a valid entry, stop and target the decision is WAIT (the only hard rule besides the quorum).",
    indicators_are_arguments: "The rules below are how the agents read the indicators in the discussion. They are arguments that raise or lower an agent's stance and confidence, never gates or vetoes of the H1 decision.",
    entry_trigger: "The Prophet entry trigger is either the one-bar event (prophet_r38.buy_confirmed / sell_confirmed true on the closed candle) or the setup still READY (prophet_r38.setup_state.buy_ready / sell_ready: the confirmation passed within the current setup's confirmation window and the cycle alignment still holds; the Prophet HUD's READY line). It is an argument for an entry, read together with the GMI conditions on the same closed candle.",
    long_arguments: [
      "for: prophet_r38.buy_confirmed == true on the closed candle (stronger with buy_high_quality), or prophet_r38.setup_state.buy_ready == true",
      "for: gmi_v12_70.conflict == false and gmi_v12_70.gate in {1, 2} (1 = validated; 2 = full confluence)",
      "against: gmi_v12_70.verdict == -3, prophet_r38.t_enc == 4, gmi_v12_70.conflict == true or gate == -1"
    ],
    short_arguments: [
      "for: prophet_r38.sell_confirmed == true on the closed candle (stronger with sell_high_quality), or prophet_r38.setup_state.sell_ready == true",
      "for: gmi_v12_70.conflict == false and gmi_v12_70.gate in {1, 2}",
      "against: gmi_v12_70.verdict == 3, gmi_v12_70.conflict == true or gate == -1"
    ],
    always_wait_when: [
      "the 1H War Room did not conclude BUY or SELL, or its quorum is not reached",
      "the key levels give no valid entry, stop and target for the quorum's direction",
      "the closed candle itself is missing or stale (news and indicator lanes that are missing are noted, not blocking)"
    ],
    risk_management_signals: [
      "t_enc 4 (RUTHLESS CUT LOSS) is a strong argument against holding or entering; t_enc 5 is a hold",
      "gmi verdict 4 (extension) and -1 (exhaustion) mean review risk on existing positions; they are not entries"
    ],
    reversal_requires_explicit_auditable_evidence: true,
    allowed_decisions: ["BUY", "SELL", "WAIT", "NO_TRADE"],
    recommendation_only: true,
    automatic_trade_execution: false
  },

  analysis_requirements: [
    "Decode every numeric field with this field_dictionary before reasoning; quote the decoded meaning (for example 'd_enc -3 = bullish structure state').",
    "Separate reported indicator values from model interpretation, and attribute each value to its lane.",
    "State missing or conflicting evidence explicitly; never invent prices, levels or indicator states.",
    "Entry, stop and target prices may only come from the supplied plan (the Key Level Agent's zones) or candle OHLC values; otherwise leave them null and decide WAIT.",
    "Give bullish, bearish and neutral scenarios when evidence is mixed."
  ],

  limitations: [
    "Webhook payloads expose only the fields listed here; internal series (pro_fast values, z-scores, volume profile levels) are not in the webhook and must not be guessed.",
    "Local engine diagnostics are unverified unless the engine identity is approved_by_parity, and even then only the compared fields are verified.",
    "The assistant does not execute trades or connect to a broker."
  ],

  news_policy: {
    role: "Fundamental context for gold, dollar and oil. It can raise or lower conviction and add risks, but never creates a BUY/SELL on its own.",
    rules: [
      "Use only the supplied articles from the last hour; cite titles.",
      "If articles do not mention gold or its drivers (USD, real yields, Fed, inflation, geopolitics, safe-haven flows), say the evidence is weak.",
      "Output a bias (BULLISH_BIAS, BEARISH_BIAS, NEUTRAL, WAIT_FOR_TECHNICAL_CONFIRMATION), never an entry."
    ]
  }
};
