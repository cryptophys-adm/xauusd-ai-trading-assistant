// B10: the GMI and Prophet *.hud.v2 candidates and the Cryptophys Mizan Probe v1, read as text (no
// TradingView call), and their registration in the AI Worker.
//
// Longest-payload method. Each payload is built in one Pine function as `array.push(p, <part>)` lines
// joined by "," inside "{" and "}". Every part is a `+` chain of string literals and values. A literal
// counts as its decoded length; a value counts at the widest text it can print:
//   - str.tostring(x, "#.########") (f_*_adopt_num): 23 = sign + 13 integer digits + point + 8 decimals
//     (every value here is below 1e13 in magnitude: prices, volumes, ratios, scores);
//   - str.tostring(int) (f_*_adopt_int, f_probe_code, f_probe_bars): 11 (-2147483648) for the v2 files; the
//     Probe's codes are |c| <= 3 and its bar offsets 0..364, so 3 ("NaN" is 3 as well);
//   - the Probe's str.tostring(x, "#.######"): scores 11 (|x| < 1000: every score is bounded far below,
//     see the bounds table below), prices 15 (|x| < 1e7), volume 20 (|x| < 1e12);
//   - flags ("1" / "0") 1; str.tostring(time) 13 (epoch ms until 2286); syminfo.tickerid 40;
//     timeframe.period 4; the escaped webhook secret 128 (a secret of up to 64 characters, which JSON
//     escaping at most doubles).
// The sum, plus the commas and braces, is the longest payload the code can send. It must stay within
// 5,000 characters (2,000 for the Probe) and, for the v2 files, within Pine's 4,096-character string.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadWorker, webhookEnv, webhookOutcome, postRaw } from "./support/webhook-harness.mjs";
import { PARITY_GROUPS, BASE_ENGINES, groupsFor, groupIdentityOf, parityGroupProblems } from "../src/parity-registry.mjs";
import { INGEST_ENGINES, isHudSource } from "../src/evidence-fusion.mjs";
import { reconcileLocalComputation } from "../src/parity-sweep.mjs";
import { approvedComparable } from "../src/hud-store.mjs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const C = "pinescript/candidates/";
const FILES = {
  gmi: { v1: C + "Global-Multiverse-Interceptor-v12.70.hud.v1.txt", v2: C + "Global-Multiverse-Interceptor-v12.70.hud.v2.txt", from: "· R11 CPR CONTEXT ENGINE\"", to: "· R12 ADOPTION HUD\"", marker: "// R12 ADOPTION HUD ALERT", source: "gmi_v12_70_adopt_hud", engine: "gmi_adopt", payloadFn: "f_gmi_adopt_payload", requests: 24 },
  prophet: { v1: C + "The-Prophet-v7.02-R38.hud.v1.txt", v2: C + "The-Prophet-v7.02-R38.hud.v2.txt", from: "· R38\"", to: "· R38 ADOPTION HUD\"", marker: "// R38 ADOPTION HUD ALERT", source: "prophet_r38_adopt_hud", engine: "prophet_adopt", payloadFn: "f_prophet_adopt_payload", requests: 2, retired: "S4" }
};
const PROBE = C + "Cryptophys-Mizan-Probe.v1.txt";
const ENVELOPE = new Set(["v", "source", "src", "ticker", "symbol", "timeframe", "tf", "candle_time", "timestamp", "t", "o", "h", "l", "c", "volume", "secret"]);
// Sent but never compared: it accumulates from the chart's first bar (like prophet_r37_ssot structure_state).
const NOT_COMPARED = { gmi_v12_70_adopt_hud: ["cvd_life_pct"], prophet_r38_adopt_hud: [], probe_mizan_hud: [] };

/** The block appended to v1: from the blank lines before its banner to the end of the file. */
function split(spec) {
  const v1 = read(spec.v1), v2 = read(spec.v2);
  const at = v2.indexOf("\n\n// =============================================================================\n" + spec.marker);
  assert.ok(at > 0, "block banner found");
  return { v1, v2, head: v2.slice(0, at), block: v2.slice(at) };
}

const stripComments = (src) => src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
// request.security() and request.security_lower_tf() calls in code (comments excluded).
const securityCalls = (src) => (stripComments(src).match(/request\.security(_lower_tf)?\(/g) || []).length;

/** The lines of one top-level Pine function (its header and its indented body). */
function fnBody(src, name) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith(name + "("));
  assert.ok(start >= 0, name + " defined");
  const out = [];
  for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

/** Splits a Pine `+` chain at top level (outside string literals and parentheses). */
function terms(expr) {
  const out = [];
  let depth = 0, inStr = false, cur = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inStr) { cur += ch; if (ch === "\\") { cur += expr[++i]; } else if (ch === "\"") inStr = false; continue; }
    if (ch === "\"") { inStr = true; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "+" && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const WIDTH = [
  [/^f_(gmi|prophet)_adopt_num\(/, 23], [/^f_(gmi|prophet)_adopt_int\(/, 11], [/^f_(gmi|prophet)_adopt_flag\(/, 1],
  [/^f_probe_score\(/, 11], [/^f_probe_price\(/, 15], [/^f_probe_volume\(/, 20], [/^f_probe_code\(/, 3], [/^f_probe_bars\(/, 3], [/^f_probe_flag\(/, 1],
  [/^str\.tostring\(time\)$/, 13], [/^syminfo\.tickerid$/, 40], [/^timeframe\.period$/, 4],
  [/^cta_webhook_secret_json$/, 128], [/^probe_secret_json$/, 128]
];
const decode = (lit) => JSON.parse(lit); // a Pine literal with \" and \\ escapes reads as JSON text

/** The payload's parts as { key, width, terms } and its longest length. */
function payloadModel(src, fn) {
  const body = fnBody(src, fn);
  assert.match(body.at(-1).trim(), /^"\{" \+ array\.join\(p, ","\) \+ "\}"$/, fn + " returns the joined parts");
  const parts = body.filter((l) => l.trim().startsWith("array.push(p, ")).map((l) => {
    const expr = l.trim().slice("array.push(p, ".length, -1);
    let width = 0, text = "";
    for (const t of terms(expr)) {
      if (t.startsWith("\"")) { const s = decode(t); width += s.length; text += s; continue; }
      const rule = WIDTH.find(([re]) => re.test(t));
      assert.ok(rule, `${fn}: no width rule for ${t}`);
      width += rule[1];
      text += "\u0000";
    }
    const key = /^"([a-z0-9_]+)":/.exec(text)?.[1];
    assert.ok(key, `${fn}: a part starts with its key: ${expr}`);
    return { key, width, expr };
  });
  return { parts, longest: 2 + parts.reduce((n, p) => n + p.width, 0) + parts.length - 1 };
}

const groupFields = (source) => Object.values(PARITY_GROUPS).filter((g) => g.source === source && g.kind === "hud").flatMap((g) => Object.keys(g.fields));

for (const [name, spec] of Object.entries(FILES)) {
  test(`B10 ${name} v2 minus its block is v1, byte for byte, apart from the title`, () => {
    const { v1, head, block } = split(spec);
    const v1Lines = v1.split("\n"), headLines = head.split("\n");
    assert.equal(headLines.length, v1Lines.length);
    const differ = v1Lines.map((l, i) => (l === headLines[i] ? -1 : i)).filter((i) => i >= 0);
    assert.equal(differ.length, 1, "only one line differs");
    assert.match(v1Lines[differ[0]], /^indicator\("/, "the differing line is the title");
    assert.equal(headLines[differ[0]], v1Lines[differ[0]].replace(spec.from, spec.to));
    assert.equal(head.replace(spec.to, spec.from), v1);
    // The block adds no input (the webhook secret stays the last input) and no request.security().
    assert.doesNotMatch(stripComments(block), /input\.|request\.|alertcondition/);
    // bar_index only as an age (bar_index - an event's bar), never sent.
    assert.ok([...stripComments(block).matchAll(/bar_index/g)].every((m) => stripComments(block).slice(m.index, m.index + 12) === "bar_index - "));
    const code2 = stripComments(read(spec.v2));
    const inputs = [...code2.matchAll(/input\.[a-z]+\(/g)];
    assert.equal(inputs.length, [...stripComments(v1).matchAll(/input\.[a-z]+\(/g)].length);
    assert.match(code2.slice(inputs.at(-1).index), /^input\.string\("", "CTA Webhook Secret", confirm=true\)/);
  });

  test(`B10 ${name} v2: request.security count equals v1's (${spec.requests})`, () => {
    assert.equal(securityCalls(read(spec.v1)), spec.requests);
    assert.equal(securityCalls(read(spec.v2)), securityCalls(read(spec.v1)));
  });

  test(`B10 ${name} v2: one alert() per confirmed realtime bar on 15/60/240/1D, the v1 payloads untouched`, () => {
    const { v1, block } = split(spec);
    const alerts = [...stripComments(block).matchAll(/^( *)alert\((.*)\)$/gm)];
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0][2], `${spec.payloadFn}(), alert.freq_once_per_bar_close`);
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.trim().startsWith("alert("));
    assert.match(lines[at - 1], /^if cta_webhook_enabled and \w+_adopt_tf and barstate\.isrealtime and barstate\.isconfirmed$/);
    assert.match(block, /_adopt_tf = timeframe\.period == "15" or timeframe\.period == "60" or timeframe\.period == "240" or timeframe\.period == "1D" or timeframe\.period == "D"/);
    // Codes only: every compared or searched literal of the block is text v1 itself renders.
    for (const m of block.matchAll(/(?:str\.contains\(\w+, |== )("(?:[^"\\]|\\.)*")/g)) {
      const lit = decode(m[1]);
      if (/^(15|60|240|1D|D)$/.test(lit)) continue;
      assert.ok(v1.includes(lit), `${name}: "${lit}" is a string v1 renders`);
    }
    // Every field is computed outside the gate: the gated lines are the alert alone.
    assert.equal(lines.length - 1, at, "the alert is the block's last line");
  });

  test(`B10 ${name} v2 payload: within 5,000 characters (and Pine's 4,096) at maximum width; keys match its groups`, () => {
    const { parts, longest } = payloadModel(read(spec.v2), spec.payloadFn);
    assert.ok(longest <= 4096, `${name}: longest payload ${longest}`);
    const keys = parts.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, "no key twice");
    assert.deepEqual(keys.slice(0, 15), ["v", "source", "src", "ticker", "symbol", "timeframe", "tf", "candle_time", "timestamp", "t", "o", "h", "l", "c", "volume"], "the OHLCV envelope of v1");
    assert.equal(keys.at(-1), "secret");
    assert.equal(parts[1].expr, `"\\"source\\":\\"${spec.source}\\""`);
    const fields = keys.filter((k) => !ENVELOPE.has(k));
    // S4 (2026-11-28): the prophet_adopt groups are retired with their records; the alert itself stays a candidate.
    if (spec.retired) assert.deepEqual(groupFields(spec.source), [], `${name}: its groups were retired in ${spec.retired}`);
    else assert.deepEqual([...fields].sort(), [...groupFields(spec.source), ...NOT_COMPARED[spec.source]].sort(), "every sent field is in exactly one group (or listed as never compared)");
    assert.equal(new Set(groupFields(spec.source)).size, groupFields(spec.source).length, "a field is in one group only");
    console.log(`B10 ${name}: ${parts.length} parts, longest payload ${longest} characters`);
  });
}

test("B10 Probe: Pine v6, CryptophysMizanLib/4, overlay=false, inputs in the B10 order with the secret last", () => {
  const src = read(PROBE);
  assert.match(src, /^\/\/@version=6\n/);
  assert.match(src, /\nindicator\("Cryptophys Mizan Probe v1", "Mizan Probe", overlay=false/);
  assert.match(src, /\nimport cryptophys\/CryptophysMizanLib\/4 as lib\n/);
  const inputs = [...stripComments(src).matchAll(/input\.([a-z]+)\(([^,)]+)/g)].map((m) => `${m[1]}:${m[2].trim()}`);
  assert.deepEqual(inputs, [
    "int:50", "int:100", "int:50", "int:55", "int:14", "int:7", "int:14", "int:21", "timeframe:\"240\"", "int:20", "int:20", "int:20", "int:20", "int:20", "int:10",
    "symbol:\"TVC:USOIL\"", "symbol:\"TVC:DXY\"", "symbol:\"CRYPTOCAP:USDT\"", "int:14", "bool:false", "string:\"\""
  ]);
  assert.match(src, /probe_secret += input\.string\("", "Probe Webhook Secret", confirm=true\)\n/);
});

test("B10 Probe: at most 8 request.security calls (seven), every library call is a CryptophysMizanLib export", () => {
  const src = read(PROBE);
  assert.equal(securityCalls(src), 7);
  const lib = read("pinescript/ssot/CryptophysMizanLib-uploaded.txt");
  const exported = new Map([...lib.matchAll(/^export ([a-z_0-9A-Z]+)\(([^)]*)\)/gm)].map((m) => [m[1], m[2].split(",").filter((a) => a.trim()).length]));
  const used = [...stripComments(src).matchAll(/lib\.([a-z_0-9A-Z]+)\(/g)].map((m) => m[1]);
  for (const name of new Set(used)) assert.ok(exported.has(name), `lib.${name} exists`);
  // Arity of each call (top-level commas) equals the export's parameter count.
  for (const m of stripComments(src).matchAll(/lib\.([a-z_0-9A-Z]+)\(/g)) {
    let depth = 1, i = m.index + m[0].length, args = 1, empty = true;
    for (; i < src.length && depth > 0; i++) {
      const ch = stripComments(src)[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "," && depth === 1) args++;
      if (depth > 0 && !/\s/.test(ch)) empty = false;
    }
    assert.equal(empty ? 0 : args, exported.get(m[1]), `lib.${m[1]} called with its ${exported.get(m[1])} parameters`);
  }
  for (const name of ["bayesian_net_tick", "markov_win_rate", "macro_penalty", "safe_mode", "gravity_veto", "sniper_override", "div_bonus", "state_energy", "project_tp", "project_sl", "bos_detect", "sweep_detect", "trap_detect", "extremes_52w", "psi_adaptive", "asset_gravity", "action_label"]) {
    assert.ok(used.includes(name), `the Probe calls lib.${name}`);
  }
});

test("B10 Probe: it alerts only on 15m, once per confirmed realtime bar, and never sends the action label", () => {
  const src = read(PROBE);
  const code = stripComments(src);
  assert.equal((code.match(/\balert\(/g) || []).length, 1);
  assert.doesNotMatch(code, /alertcondition/);
  assert.match(code, /\nif probe_enabled and timeframe\.period == "15" and barstate\.isrealtime and barstate\.isconfirmed\n {4}alert\(f_probe_payload\(\), alert\.freq_once_per_bar_close\)\n$/);
  const payload = fnBody(src, "f_probe_payload").join("\n");
  assert.doesNotMatch(payload, /action_label|bar_index/);
});

test("B10 Probe payload: within 2,000 characters at maximum width; its keys are the probe_mizan groups", () => {
  const { parts, longest } = payloadModel(read(PROBE), "f_probe_payload");
  assert.ok(longest <= 2000, `Probe: longest payload ${longest}`);
  const keys = parts.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys.slice(0, 11), ["v", "source", "ticker", "timeframe", "candle_time", "t", "o", "h", "l", "c", "volume"]);
  assert.equal(keys.at(-1), "secret");
  const fields = keys.filter((k) => !ENVELOPE.has(k));
  assert.deepEqual([...fields].sort(), [...groupFields("probe_mizan_hud")].sort());
  for (const k of ["net_raw", "net_core", "net_final", "action_code", "bos", "sweep", "trap", "ext_lo", "ext_hi", "prior_edge"]) assert.ok(keys.includes(k), k);
  // Bounds behind the score width (|x| < 1000): see the method at the top of this file.
  const BOUNDED = { z: 10, hurst: 1, entropy: 1, phi_wave: 1, regime: 1, er: 1, psi_ad: 1, rho: 1, ent_dyn: 1.625, mml: 1, noise: 1, vol_t: 3.1, conf: 1, risk: 1, mtf_h: 1, mtf_z: 10, true_phi: 1, phi_t: 1, psi_d: 1, gravity: 1, roc_dxy: 100, roc_usdt: 100, macro: 1, prior_edge: 1, markov: 1, reward: 1.5, break_bias: 0.2, grav_bonus: 0.15, poc_bonus: 0.05, fvg_bonus: 0.1, sing_bonus: 0.1, smr_bias: 0.1, div_bonus: 0.4, net_raw: 4.1, net_core: 4.1, net_final: 4.1, smri: 100, q_net: 1, energy: 20 };
  for (const p of parts.filter((x) => x.expr.includes("f_probe_score("))) assert.ok(p.key in BOUNDED && BOUNDED[p.key] < 1000, `${p.key} has a documented bound`);
  console.log(`B10 Probe: ${parts.length} parts, longest payload ${longest} characters`);
});

test("B10 groups: declared, sound, none starts with mizan, each on its source; prior_edge feeds the MZ1 witness", () => {
  assert.deepEqual(parityGroupProblems(), []);
  assert.ok(Object.keys(PARITY_GROUPS).every((id) => !id.startsWith("mizan")));
  const by = (engine) => Object.entries(PARITY_GROUPS).filter(([, g]) => g.engine === engine).map(([id]) => id);
  assert.deepEqual(by("gmi_adopt"), ["gmi_adopt_hud", "gmi_adopt_flow", "gmi_adopt_kin", "gmi_adopt_zone", "gmi_adopt_zone_levels", "gmi_adopt_burst", "gmi_adopt_order", "gmi_adopt_levels", "gmi_adopt_plan"]);
  assert.deepEqual(by("prophet_adopt"), [], "S4 retired the prophet_adopt groups");
  assert.deepEqual(by("probe_mizan"), ["probe_mizan_witness", "probe_mizan_core", "probe_mizan_mtf", "probe_mizan_decision", "probe_mizan_state"]);
  for (const [id, g] of Object.entries(PARITY_GROUPS)) {
    if (id === "probe_mizan_witness") continue;
    assert.equal(g.source, { gmi_adopt: "gmi_v12_70_adopt_hud", probe_mizan: "probe_mizan_hud" }[g.engine], id);
    assert.equal(g.kind, "hud");
    assert.equal(g.nullEqual, true);
    assert.ok(Object.entries(g.fields).every(([a, b]) => a === b));
  }
  assert.ok(groupFields("probe_mizan_hud").includes("prior_edge"));
});

test("B10, B11 then S4: no adoption engine is ingested; gmi_adopt keeps its groups as a base engine (B11b/c), prophet_adopt is retired; probe_mizan stays inert until B26", async () => {
  // S4 (2026-11-28): the prophet_adopt records and the adoption intake (ADOPT_ENGINES, ADOPT_INGEST) are retired.
  assert.deepEqual([...INGEST_ENGINES], ["mizan", "prophet", "gmi"]);
  assert.equal(BASE_ENGINES.includes("gmi_adopt"), true);
  assert.equal(BASE_ENGINES.includes("prophet_adopt"), false);
  const gmiAdopt = { engine: "gmi_adopt", timeframe: "15", provenance: { source_hash: "a".repeat(64), implementation_hash: "b".repeat(64) } };
  for (const id of groupsFor("gmi_adopt")) assert.equal(groupIdentityOf(gmiAdopt, id)?.engine, id + "_m15", id);
  assert.equal(INGEST_ENGINES.includes("probe_mizan"), false);
  assert.equal(BASE_ENGINES.includes("probe_mizan"), false);
  const probe = { engine: "probe_mizan", timeframe: "15", provenance: { source_hash: "a".repeat(64), implementation_hash: "b".repeat(64) } };
  for (const id of groupsFor("probe_mizan")) assert.equal(groupIdentityOf(probe, id), null, id);
  for (const engine of INGEST_ENGINES) assert.deepEqual(groupsFor(engine), [], engine);
  for (const source of ["gmi_v12_70_adopt_hud", "prophet_r38_adopt_hud", "probe_mizan_hud"]) assert.equal(isHudSource(source), true);
});

const SECRET = "fixture-secret-0123456789";
const worker = await loadWorker();
const hook = (source, extra) => `{"v":1,"source":"${source}","ticker":"OANDA:XAUUSD","timeframe":"15","candle_time":"1794178800000","t":1794178800000,"o":4001.1,"h":4006.2,"l":3999,"c":4004.4,"volume":1800,${extra},"secret":"${SECRET}"}`;

test("B10 registration: the existing gmi_v12_70_hud webhook is handled exactly as on main", async () => {
  const text = '{"v":1,"source":"gmi_v12_70_hud","src":"gmi_v12_70_hud","ticker":"OANDA:XAUUSD","symbol":"OANDA:XAUUSD","timeframe":"15","tf":"15","candle_time":"1794178800000","timestamp":"1794178800000","t":1794178800000,"verdict":3,"gate":2,"gmi_dir":1,"prophet_dir":1,"conflict":false,"cshi_viability":NaN,"deploy_status":3,"muddy_waters":false,"grid_viable":true,"secret":"' + SECRET + '"}';
  const main = JSON.parse(read("test/fixtures/b10-webhook-gmi-hud-main.json"));
  assert.deepEqual(await webhookOutcome(worker, SECRET, text), main);
});

test("B10 registration: the three new sources are accepted and stored for parity only; an early alert trusts nothing", async () => {
  for (const [source, extra] of [["gmi_v12_70_adopt_hud", '"swc":1.1,"wz1":NaN'], ["prophet_r38_adopt_hud", '"cshi":0.52,"mom":NaN'], ["probe_mizan_hud", '"net_final":0.31,"prior_edge":-0.2,"action_code":2']]) {
    const { env, sent } = await webhookEnv(SECRET);
    const r = await postRaw(worker, env, "/webhook", hook(source, extra));
    assert.equal(r.status, 202, source + ": " + r.text);
    const body = JSON.parse(r.text);
    assert.deepEqual([body.source, body.analysis_status, body.queued, body.reason], [source, "stored_only", false, "hud_comparator_source"]);
    const key = "OANDA:XAUUSD:15:1794178800000";
    assert.deepEqual([...env.WEBHOOK_BUFFER.map.keys()], ["candle:" + key + ":" + source]);
    const stored = JSON.parse(env.WEBHOOK_BUFFER.map.get("candle:" + key + ":" + source));
    assert.equal(stored.secret, undefined, "the secret is never stored");
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM webhook_sources WHERE source = ?").get(source).n, 1);
    assert.equal(sent.length, 0, "never the AI chain");
    // Its local counterpart is refused at ingest, and the parity sweep compares and trusts nothing.
    const local = await postRaw(worker, env, "/evidence/local-calculation", JSON.stringify({ schema_version: "cryptophys.local-calculation.v1", engine: { gmi_v12_70_adopt_hud: "gmi_adopt", prophet_r38_adopt_hud: "prophet_adopt", probe_mizan_hud: "probe_mizan" }[source], symbol: "OANDA:XAUUSD", timeframe: "15", candle_time: new Date(1794178800000).toISOString(), candle_key: key, computed_at: new Date().toISOString(), values: {}, provenance: {} }), { "content-type": "application/json", "x-webhook-secret": SECRET });
    assert.notEqual(local.status, 202, "no local record for a B10 engine until B11/B26: " + local.text);
    assert.deepEqual(await reconcileLocalComputation(env, key), { comparisons: {}, trust: {} });
    assert.equal(await approvedComparable(env, key), null);
    assert.deepEqual([...env.WEBHOOK_BUFFER.map.keys()].filter((k) => k.startsWith("localcalc")), []);
  }
  const { env } = await webhookEnv(SECRET);
  const unknown = JSON.parse((await postRaw(worker, env, "/webhook", hook("nope_hud", '"x":1'))).text);
  assert.deepEqual(unknown.accepted_sources.slice(-3), ["gmi_v12_70_adopt_hud", "prophet_r38_adopt_hud", "probe_mizan_hud"]);
});
