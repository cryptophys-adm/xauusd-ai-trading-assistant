// GMI v12.70 re-gate with another Prophet structure (RFC_INDICATOR_AGENT_PLATFORM, the
// GMI "Prophet risk hold" candidate).
//
// GMI's shared Prophet core (R37 structure: subtype, d_enc) enters the verdict at exactly
// two points of local-engines/gmi/src/gmi-core.mjs:
//   1. mtf_state in the initial verdict cascade;
//   2. the R10 shared Prophet x GMI x VP gate: divergence direction, internal conflict,
//      prophet_dir and the risk hold (subtype 1, the bull trap).
// Everything else (entropy, footprint, zones, Fabio, JMA, kinetics, the value area) does
// not depend on the structure and is already in the approved local GMI record's
// diagnostics. This module recomputes only those two points, with the same formulas and
// the same Pine comparison helpers, so a structure-latch candidate can be judged on GMI's
// own output without forking the hashed engine file. With the active structure it must
// reproduce the active comparable fields exactly (test/gmi-regate.test.mjs).

import { gt, lt } from "../local-engines/gmi/src/pine.mjs";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** Verdict of a non-initial branch: set by that branch, independent of the structure. */
const BRANCH_VERDICT = Object.freeze({
  entropy_trap: 0, volume_veto: 0,
  gabfx_buy: 3, gabfx_sell: -3,
  fabio_m1_buy: 3, fabio_m1_sell: -3, fabio_m2_buy: 3, fabio_m2_sell: -3,
  jma_long: 3, jma_short: -3,
  kin_rev_long: 3, kin_rev_short: -3
});

/**
 * regateGmi -> { verdict, gate, gmi_dir, prophet_dir, conflict } or null when the
 * diagnostics cannot support a re-gate.
 *   diagnostics: the local GMI record's diagnostics (branch, htf_state, ltf_state,
 *                ext_state, vah, val, poc);
 *   close:       the bar close;
 *   proFast:     the shared core's pro_fast on that bar (structure independent);
 *   subtype, dEnc: the structure to gate with.
 */
export function regateGmi({ diagnostics, close, proFast, subtype, dEnc, sharedAlignment = true }) {
  const d = diagnostics;
  if (!d || typeof d.branch !== "string") return null;
  let verdict;
  if (d.branch === "initial") {
    // branch "initial" means no override fired, so kin_rev_long/short were false too
    // (they are the last overrides in the chain).
    const mtfState = (subtype === 2 || subtype === 3) ? 1 : (subtype === 1 || subtype === 4) ? -1 : 0;
    const htf = d.htf_state, ltf = d.ltf_state, ext = d.ext_state;
    verdict = 0;
    if (ext === 1 && htf === 1) verdict = -1;
    else if (ext === 2 && htf === 1) verdict = 4;
    else if (htf === 1 && (mtfState === 1 || ltf >= 1)) verdict = 3;
    else if (htf === -1 && (mtfState === -1 || ltf <= -1)) verdict = -3;
  } else if (Object.hasOwn(BRANCH_VERDICT, d.branch)) {
    verdict = BRANCH_VERDICT[d.branch];
  } else {
    return null;
  }

  const c = close, vah = d.vah, val = d.val, poc = d.poc;
  const vpDir = gt(c, vah) ? 1 : lt(c, val) ? -1 : 0;
  const profileValid = isNum(poc) && isNum(vah) && isNum(val) && vah >= poc && poc >= val;
  const divDir = (subtype === 2 || subtype === 3 || dEnc === 1) ? 1 : (subtype === 1 || subtype === 4 || dEnc === -1) ? -1 : 0;
  const pDir = gt(proFast, 0) ? 1 : lt(proFast, 0) ? -1 : 0;
  const internalConflict = pDir !== 0 && divDir !== 0 && pDir !== divDir;
  const prophetDir = internalConflict ? 0 : pDir !== 0 ? pDir : divDir;
  const gmiDirectional = verdict === 3 || verdict === -3;
  const gmiDir = verdict === 3 ? 1 : verdict === -3 ? -1 : 0;
  const gmiProphetConflict = gmiDirectional && prophetDir !== 0 && gmiDir !== prophetDir;
  const profileProphetConflict = vpDir !== 0 && prophetDir !== 0 && vpDir !== prophetDir;
  const riskHold = subtype === 1;
  const active = sharedAlignment;
  const evaluable = active && profileValid;
  const conflict = evaluable && (internalConflict || gmiProphetConflict || profileProphetConflict || riskHold);
  const aligned = evaluable && !conflict && gmiDirectional && prophetDir !== 0 && gmiDir === prophetDir && vpDir === prophetDir;
  const gate = !active ? 0 : !profileValid ? -2 : conflict ? -1 : aligned ? 2 : 1;
  if (conflict) verdict = 0;
  return { verdict, gate, gmi_dir: gmiDir, prophet_dir: prophetDir, conflict };
}
