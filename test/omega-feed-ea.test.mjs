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
  assert.equal(src.match(/#property version\s+"([\d.]+)"/)?.[1], "1.01");
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
