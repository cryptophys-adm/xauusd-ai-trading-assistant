// The pull adapter's daily TradingView budget is the account's provider quota (owner 2026-11-14: "sesuaikan
// batas dengan kuota TV agar sama"). Was 800 against a provider quota of 500: it never held.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROVIDER_DAILY_LIMIT } from "../fundamental-news-ingestion/src/provider-usage.mjs";
import { SERIES_INTERNALS } from "../market-data-ingestion/src/tradingview-source.mjs";

const varOf = (path, name) => {
  const m = readFileSync(new URL(path, import.meta.url), "utf8").match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : null;
};

test("the pull adapter's budget, its default and the news Worker's provider quota are one number", () => {
  const quota = Number(varOf("../fundamental-news-ingestion/wrangler.jsonc", "TV_PROVIDER_DAILY_LIMIT") ?? PROVIDER_DAILY_LIMIT);
  assert.equal(Number(varOf("../market-data-ingestion/wrangler.jsonc", "TV_DAILY_CALL_BUDGET")), quota);
  assert.equal(SERIES_INTERNALS.dailyBudget({}, Date.parse("2026-11-16T10:00:00Z")), quota, "the code default too");
  assert.equal(varOf("../market-data-ingestion/wrangler.jsonc", "TV_DAILY_CALL_BUDGET_OVERRIDE"), null, "no stale one-day override");
});
