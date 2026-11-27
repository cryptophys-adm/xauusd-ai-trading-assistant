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
