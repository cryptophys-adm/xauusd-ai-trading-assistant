// F3: OmegaFeed.mq5 is a data-only exporter. These pins fail the build if any trade code, account data or intents
// reading ever appears in it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../ea/mt5/OmegaFeed.mq5", import.meta.url), "utf8");
// Code only: the header comment may name what the EA does not do.
const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("OF-1. no trade code at all: no order, position, deal or trade request API", () => {
  for (const re of [/OrderSend/, /OrderSendAsync/, /OrderModify/, /OrderClose/, /OrderDelete/, /CTrade/, /Trade\.mqh/, /MqlTradeRequest/, /MqlTradeResult/,
    /PositionSelect/, /PositionGet/, /PositionsTotal/, /PositionClose/, /OrderSelect/, /OrdersTotal/, /HistoryDeal/, /HistorySelect/, /TRADE_ACTION_/]) {
    assert.doesNotMatch(code, re, `forbidden in the feed EA: ${re}`);
  }
});

test("OF-2. no account amounts, no login, no intents or results files", () => {
  for (const re of [/ACCOUNT_BALANCE/, /ACCOUNT_EQUITY/, /ACCOUNT_LOGIN/, /ACCOUNT_MARGIN/, /ACCOUNT_PROFIT/, /intents\.txt/, /results\.txt/, /reference\.txt/, /processed\.txt/]) {
    assert.doesNotMatch(code, re, `forbidden in the feed EA: ${re}`);
  }
});

test("OF-3. it writes the state and the gold M1 corpus in the executor's formats, with the contract recorded", () => {
  assert.match(code, /"omega\/state\.json"/);
  assert.match(code, /"omega\/corpus\.json"/);
  assert.match(code, /\\"timeframe\\":\\"M1\\"/);
  assert.match(code, /SYMBOL_TRADE_CONTRACT_SIZE/);
  assert.match(code, /SYMBOL_CURRENCY_PROFIT/);
  assert.match(code, /CopyRates\(sym, PERIOD_M1, 1, n, rates\)/, "closed bars only");
  const v = src.match(/#property version\s+"([\d.]+)"/)?.[1];
  assert.equal(src.match(/OMEGA_FEED_VERSION = "([\d.]+)"/)?.[1], v, "the version constant equals #property version");
});

test("OF-4. 1.01 macro export: an explicit BASE=SYMBOL map, the executor's corpus_macro format, data only", async () => {
  const { CORPUS_MACRO_BASES, readCorpusMacro } = await import("../bridge/omega-bridge/src/files.mjs");
  assert.ok(["1.01", "1.02", "1.03"].includes(src.match(/#property version\s+"([\d.]+)"/)?.[1]), "1.01 or later");
  assert.match(code, /"omega\/corpus_macro\.json"/);
  assert.match(code, /input bool\s+MacroEnabled = true;/);
  const map = code.match(/input string MacroSymbols = "([^"]+)";/)?.[1];
  assert.ok(map, "MacroSymbols has a default");
  const pairs = map.split(",").map((p) => p.split("="));
  assert.ok(pairs.every((p) => p.length === 2 && p[0] && p[1]), "every entry is BASE=SYMBOL");
  assert.ok(!map.includes("|"), "explicit names: no alternatives to guess between");
  const bases = pairs.map((p) => p[0]);
  assert.deepEqual(bases, ["XAGUSD", "USOIL", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF"]);
  for (const b of bases) assert.ok(CORPUS_MACRO_BASES.includes(b), `${b} is a base the server accepts`);
  assert.deepEqual(Object.fromEntries(pairs), { XAGUSD: "XAGUSD", USOIL: "USOIL.sml", EURUSD: "EURUSD.sml", GBPUSD: "GBPUSD.sml", USDJPY: "USDJPY.sml", USDCAD: "USDCAD", USDCHF: "USDCHF" });
  assert.match(code, /CopyRates\(sym, PERIOD_M1, 1, n, rates\); \/\/ closed bars only/);
  assert.match(code, /WriteCorpusMacroJson\(\);\n  \}/, "called from the timer");
  // The JSON the EA writes (same StringFormat as OmegaExecutor) is what the bridge's reader accepts.
  const file = JSON.stringify({ server: "Feed-Server", timeframe: "M1", utc_offset_s: 7200, written_ms: 1, series: pairs.map(([base, symbol], i) => ({ base, symbol, digits: 5, bars: [[60_000 * (i + 1), 1.1, 1.2, 1.0, 1.15, 10, 2]] })) });
  const fs = { existsSync: () => true, readFileSync: () => file };
  const got = readCorpusMacro("/omega", { fs });
  assert.deepEqual(got.series.map((s) => s.base), bases);
  assert.equal(got.series.find((s) => s.base === "USOIL").symbol, "USOIL.sml");
});

test("OF-5. 1.02 backfill (BF1 c): reads the bridge's corpus_from.json, writes at most 600 closed bars from there and echoes the start; still data only", async () => {
  const { readCorpus, writeBackfillRequest, BACKFILL_MAX_BARS } = await import("../bridge/omega-bridge/src/files.mjs");
  assert.ok(["1.02", "1.03"].includes(src.match(/#property version\s+"([\d.]+)"/)?.[1]), "1.02 or later");
  assert.match(code, /CORPUS_FROM_JSON_PATH\s*= "omega\/corpus_from\.json"/);
  assert.match(code, /FileOpen\(CORPUS_FROM_JSON_PATH, FILE_READ \| FILE_TXT \| FILE_ANSI\)/, "read only");
  assert.doesNotMatch(code, /FileOpen\(CORPUS_FROM_JSON_PATH, FILE_WRITE/, "the EA never writes the request");
  assert.doesNotMatch(code, /FileDelete/, "nor deletes it: the bridge does");
  assert.match(code, /CopyRates\(sym, PERIOD_M1, fromServer, lastClosed, rates\)/, "from the asked minute to the last closed bar");
  assert.match(code, /BACKFILL_MAX_BARS\s*= 600;/);
  assert.equal(BACKFILL_MAX_BARS, 600, "the bridge reads what the EA writes");
  assert.match(code, /fromMs < nowMs - 11 \* 3600 \* \(long\)1000\) return 0;/, "only inside the last 11 hours");
  assert.match(code, /\\"backfill_from_ms\\":%I64d/, "the echo");
  // The bridge's request file is one line the EA's reader finds; the EA's answer is read back with its echo.
  const files = new Map();
  const fs = { mkdirSync() {}, writeFileSync: (p, t) => files.set(p, t), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); }, existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p) };
  const p = writeBackfillRequest("/omega", { from_ms: 1795800000000, until_ms: 1795810000000 }, { fs, now: () => 1 });
  assert.equal(files.get(p), '{"from_ms":1795800000000,"until_ms":1795810000000}\n');
  assert.ok(/"from_ms"/.test(files.get(p)) && !files.get(p).includes(" "), "the shape the EA's StringFind reads");
  files.set("/omega/corpus.json", JSON.stringify({ server: "Feed-Server", symbol: "XAUUSD.sml", timeframe: "M1", digits: 2, utc_offset_s: 7200, written_ms: 1, backfill_from_ms: 1795800000000, bars: Array.from({ length: 600 }, (_, i) => [1795800000000 + i * 60000, 1, 2, 0.5, 1.5, 10, 20]) }));
  const all = readCorpus("/omega", { fs, maxBars: BACKFILL_MAX_BARS });
  assert.equal(all.bars.length, 600);
  assert.equal(all.backfill_from_ms, 1795800000000);
  assert.equal(readCorpus("/omega", { fs }).bars.length, 240, "the default read is unchanged");
});

test("OF-6. 1.03 time base (feed incident 2026-11-28 10:25:58Z): the corpus files only while connected, on an offset read the same on two ticks", () => {
  assert.equal(src.match(/#property version\s+"([\d.]+)"/)?.[1], "1.03");
  const fn = (name) => code.slice(code.indexOf(`void ${name}()`), code.indexOf("\n  }\n", code.indexOf(`void ${name}()`)));
  const base = fn("UpdateTimeBase");
  assert.match(base, /if\(!\(bool\)TerminalInfoInteger\(TERMINAL_CONNECTED\)\) \{ g_offsetSeen = false; g_timeBaseReady = false; return; \}/, "a disconnect clears it");
  assert.match(base, /g_timeBaseReady = g_offsetSeen && offset == g_offsetLast;/, "the same offset on two reads in a row");
  assert.match(code, /void OnTimer\(\)\n  \{\n   UpdateTimeBase\(\);/, "read once per tick, before any write");
  const corpus = fn("WriteCorpusJson"), macro = fn("WriteCorpusMacroJson"), state = fn("WriteStateJson");
  assert.match(corpus, /^void WriteCorpusJson\(\)\n  \{\n   if\(!g_timeBaseReady\) return;/, "the gold corpus waits for the time base");
  assert.match(macro, /if\(!MacroEnabled \|\| !g_timeBaseReady\) return;/, "so does the macro corpus");
  for (const f of [corpus, macro]) {
    assert.match(f, /int offset = g_timeBaseOffset;/, "the confirmed offset, not a fresh read");
    assert.doesNotMatch(f, /ServerUtcOffsetSeconds\(\)/);
  }
  assert.doesNotMatch(state, /g_timeBaseReady/, "state.json is written as before (it carries connected)");
});
