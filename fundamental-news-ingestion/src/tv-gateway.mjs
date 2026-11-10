// Narrow TradingView MCP gateway for OHLCV market data.
//
// The news-ingestion Worker is the single owner of the TradingView MCP OAuth
// grant (one client_id/redirect URI, one rotating refresh token) and of the
// account-wide MCP quota cooldown. Other internal Workers (the local engine
// market-data adapter) obtain OHLCV through this endpoint instead of running a
// second OAuth flow, so refresh tokens are never rotated by two owners and a
// quota suspension stops every caller at once.

export const OHLCV_GATEWAY_CONTRACT = "cryptophys.tv-ohlcv-gateway.v1";
export const OHLCV_TOOL_NAME_DEFAULT = "mcp-tv-get-ohlcv";
// The pull adapter's series (market-data-ingestion SERIES): gold, GMI's DXY, USDT and USOIL, and the
// Nexus correlations' context series US10Y and silver (2026-11-08: they were missing, so a batch that
// carried them was rejected whole, gold included).
export const DEFAULT_GATEWAY_SYMBOLS = Object.freeze(["OANDA:XAUUSD", "TVC:DXY", "CRYPTOCAP:USDT", "TVC:USOIL", "TVC:US10Y", "OANDA:XAGUSD"]);
export const GATEWAY_INTERVALS = Object.freeze(["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W"]);
const MAX_REQUESTS_PER_CALL = 12;
const MAX_COUNT = 8000; // MCP limit for format=columns
const QUOTA_PATTERN = /TOOL_QUOTA_EXCEEDED|tool call quota exceeded|access to MCP is suspended/i;

const asString = (value) => (typeof value === "string" ? value : "");
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  return diff === 0;
}

/** The default symbols plus any TV_GATEWAY_SYMBOLS adds (comma or whitespace separated). */
function allowedSymbols(env) {
  const configured = asString(env.TV_GATEWAY_SYMBOLS).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_GATEWAY_SYMBOLS, ...configured]);
}

/** Validates one OHLCV request. Returns { value } or { error }. */
export function validateOhlcvRequest(raw, env = {}) {
  if (!isRecord(raw)) return { error: "request_must_be_object" };
  const symbol = asString(raw.symbol).trim();
  if (!/^[A-Z0-9_]+:[A-Z0-9_.!]+$/.test(symbol)) return { error: "invalid_symbol" };
  if (!allowedSymbols(env).has(symbol)) return { error: "symbol_not_allowed" };
  const interval = asString(raw.interval).trim();
  if (!GATEWAY_INTERVALS.includes(interval)) return { error: "invalid_interval" };
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return { error: "invalid_count" };
  const value = { symbol, interval, count, format: "columns" };
  if (raw.date_to !== undefined && raw.date_to !== null) {
    const dateTo = asString(raw.date_to).trim();
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/.test(dateTo) || !Number.isFinite(Date.parse(dateTo))) {
      return { error: "invalid_date_to" };
    }
    value.date_to = dateTo;
  }
  return { value };
}

/** Extracts the tool's JSON object from an MCP tools/call JSON-RPC response. */
export function parseToolResult(payload) {
  const result = isRecord(payload?.result) ? payload.result : null;
  if (!result) return null;
  if (isRecord(result.structuredContent)) return result.structuredContent;
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (item?.type === "text" && typeof item.text === "string") {
      try {
        const parsed = JSON.parse(item.text);
        if (isRecord(parsed)) return parsed;
      } catch { /* try the next content item */ }
    }
  }
  return null;
}

/**
 * Normalizes get_ohlcv output to columns of equal length. Accepts both the
 * documented rows layout and the columns layout. Rejects malformed numbers
 * instead of coercing them; null volume stays null.
 */
export function normalizeOhlcvColumns(tool) {
  if (!isRecord(tool) || tool.success === false) throw Object.assign(new Error("get_ohlcv reported failure"), { code: "tool_failed" });
  let cols;
  if (Array.isArray(tool.bars)) {
    cols = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (const bar of tool.bars) for (const k of Object.keys(cols)) cols[k].push(bar?.[k] ?? null);
  } else if (isRecord(tool.bars)) {
    cols = { t: tool.bars.t, o: tool.bars.o, h: tool.bars.h, l: tool.bars.l, c: tool.bars.c, v: tool.bars.v ?? [] };
  } else {
    throw Object.assign(new Error("get_ohlcv returned no bars"), { code: "invalid_ohlcv_payload" });
  }
  const n = Array.isArray(cols.t) ? cols.t.length : -1;
  for (const k of ["t", "o", "h", "l", "c"]) {
    if (!Array.isArray(cols[k]) || cols[k].length !== n) throw Object.assign(new Error(`column ${k} length mismatch`), { code: "invalid_ohlcv_payload" });
    if (!cols[k].every((x) => typeof x === "number" && Number.isFinite(x))) throw Object.assign(new Error(`column ${k} has non-finite values`), { code: "invalid_ohlcv_payload" });
  }
  const v = Array.isArray(cols.v) && cols.v.length === n ? cols.v.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : null)) : Array(n).fill(null);
  return { t: cols.t, o: cols.o, h: cols.h, l: cols.l, c: cols.c, v };
}

async function callOhlcvTool(env, endpoint, accessToken, args, deps) {
  const toolName = asString(env.TV_MCP_OHLCV_TOOL_NAME || OHLCV_TOOL_NAME_DEFAULT);
  const tool = await callMcpTool(env, endpoint, accessToken, toolName, args, deps, "get_ohlcv");
  const columns = normalizeOhlcvColumns(tool);
  return {
    symbol: asString(tool.symbol) || args.symbol,
    interval: asString(tool.interval) || args.interval,
    count: columns.t.length,
    has_more: tool.has_more === true,
    next_date_to: asString(tool.next_date_to) || null,
    bars: columns
  };
}

/** One MCP tools/call; returns the tool's JSON object or throws with the quota and rate-limit codes. */
async function callMcpTool(env, endpoint, accessToken, toolName, args, deps, label) {
  const response = await deps.fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": asString(env.NEWS_INGEST_USER_AGENT || "XAUUSD-Fundamental-News-Ingestion/2.0")
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: deps.requestId(), method: "tools/call", params: { name: toolName, arguments: args } }),
    signal: AbortSignal.timeout(25000)
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  const upstreamMessage = payload ? deps.extractMcpErrorText(payload) : text;
  const toolError = payload?.error || payload?.result?.isError === true;
  if (!response.ok || toolError) {
    const quota = QUOTA_PATTERN.test(upstreamMessage || "");
    const rateLimited = !quota && response.status === 429;
    const retryAfterSeconds = Number.parseInt(String(response.headers?.get?.("retry-after") || ""), 10);
    const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : null;
    throw Object.assign(new Error(
      quota ? "TradingView MCP tool quota exceeded" : rateLimited ? "TradingView MCP rate limited (HTTP 429)" : `TradingView MCP ${label} failed`
    ), {
      code: quota ? "mcp_quota_exceeded" : rateLimited ? "mcp_rate_limited" : (response.ok ? "mcp_tool_error" : "mcp_upstream_error"),
      status: quota ? 429 : (response.ok ? 502 : response.status),
      quota_cooldown_until: quota
        ? deps.parseQuotaCooldownUntil(upstreamMessage)
        : rateLimited ? deps.rateLimitCooldownUntil(retryAfterMs) : null
    });
  }
  const tool = parseToolResult(payload) ?? parseToolArray(payload);
  if (!tool) throw Object.assign(new Error(`${label} returned no parsable content`), { code: label === "get_ohlcv" ? "invalid_ohlcv_payload" : "invalid_tool_payload", status: 502 });
  return tool;
}

/** A tool result whose text content is a JSON array, wrapped as { events }. */
function parseToolArray(payload) {
  for (const item of Array.isArray(payload?.result?.content) ? payload.result.content : []) {
    if (item?.type === "text" && typeof item.text === "string") {
      try { const parsed = JSON.parse(item.text); if (Array.isArray(parsed)) return { events: parsed }; } catch { /* next */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------- economic calendar (2026-11-10)
// Owner 2026-11-10: the Calendar Agent needs the released value. The ForexFactory export has only the
// forecast and the previous value; TradingView's economic calendar has the actual too, past windows
// included (data since 2003-09-01). Same OAuth grant, same account-wide quota cooldown.

export const CALENDAR_GATEWAY_CONTRACT = "cryptophys.tv-calendar-gateway.v1";
export const CALENDAR_TOOL_NAME_DEFAULT = "mcp-tv-get-economic-calendar";
const CALENDAR_MAX_SPAN_MS = 35 * 86_400_000;
const CALENDAR_EARLIEST = Date.parse("2003-09-01T00:00:00Z");
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/;

/** Validates one calendar request: an RFC3339 or YYYY-MM-DD window of at most 35 days, USD by default. */
export function validateCalendarRequest(raw) {
  if (!isRecord(raw)) return { error: "request_must_be_object" };
  const from = asString(raw.date_from).trim(), to = asString(raw.date_to).trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return { error: "invalid_date" };
  const a = Date.parse(from), b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || b - a > CALENDAR_MAX_SPAN_MS || a < CALENDAR_EARLIEST) return { error: "invalid_window" };
  const currencies = asString(raw.currencies || "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}(,[A-Z]{3})*$/.test(currencies)) return { error: "invalid_currencies" };
  const imp = raw.min_importance == null ? 1 : Number(raw.min_importance);
  if (![-1, 0, 1].includes(imp)) return { error: "invalid_min_importance" };
  return { value: { date_from: from, date_to: to, currencies, min_importance: imp } };
}

const numOf = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const m = v.trim().replace(/,/g, "").match(/^([+-]?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()] ?? 1;
  return Number.isFinite(n) ? n * mult : null;
};
const firstNum = (...vs) => { for (const v of vs) { const n = numOf(v); if (n != null) return n; } return null; };

/** Normalizes the calendar tool's events (field names vary): only events with a title and a time. */
export function normalizeCalendarEvents(tool) {
  const list = Array.isArray(tool?.events) ? tool.events : Array.isArray(tool?.data) ? tool.data : Array.isArray(tool?.result) ? tool.result : Array.isArray(tool?.items) ? tool.items : [];
  const out = [];
  for (const e of list) {
    if (!isRecord(e)) continue;
    const title = asString(e.title || e.indicator || e.name || e.event).trim().slice(0, 140);
    const t = Date.parse(asString(e.date || e.time || e.datetime || e.release_time || e.timestamp));
    if (!title || !Number.isFinite(t)) continue;
    out.push({
      id: asString(e.id || e.event_id).slice(0, 64) || null, title, time: new Date(t).toISOString(),
      country: asString(e.country).toUpperCase().slice(0, 4) || null, currency: asString(e.currency).toUpperCase().slice(0, 4) || null,
      importance: Number.isFinite(Number(e.importance)) ? Number(e.importance) : null,
      actual: firstNum(e.actualRaw, e.actual_raw, e.actual), forecast: firstNum(e.forecastRaw, e.forecast_raw, e.forecast), previous: firstNum(e.previousRaw, e.previous_raw, e.previous),
      unit: asString(e.unit).slice(0, 16) || null, scale: asString(e.scale).slice(0, 8) || null, period: asString(e.period).slice(0, 24) || null
    });
  }
  return out.sort((x, y) => x.time.localeCompare(y.time));
}

/** The economic calendar of one window through the TvGateway, under the same quota cooldown as OHLCV. */
export async function runEconomicCalendar(env, raw, deps) {
  const check = validateCalendarRequest(raw);
  if (check.error) return { status: 400, body: { contract: CALENDAR_GATEWAY_CONTRACT, error: check.error } };
  const cooldown = await deps.readQuotaCooldown(env);
  if (cooldown) return { status: 503, body: { contract: CALENDAR_GATEWAY_CONTRACT, error: "mcp_quota_cooldown_active", quota_cooldown_until: cooldown.until } };
  let metadata, accessToken;
  try {
    metadata = await deps.fetchOAuthMetadata(env);
    accessToken = await deps.getValidAccessToken(env, metadata);
  } catch (error) {
    return { status: 503, body: { contract: CALENDAR_GATEWAY_CONTRACT, error: asString(error?.code) || "oauth_unavailable" } };
  }
  try {
    const tool = await callMcpTool(env, asString(metadata.mcp_endpoint), accessToken, asString(env.TV_MCP_CALENDAR_TOOL_NAME || CALENDAR_TOOL_NAME_DEFAULT), check.value, deps, "get_economic_calendar");
    return { status: 200, body: { contract: CALENDAR_GATEWAY_CONTRACT, fetched_at: new Date().toISOString(), request: check.value, events: normalizeCalendarEvents(tool) } };
  } catch (error) {
    if (error?.code === "mcp_quota_exceeded" || error?.code === "mcp_rate_limited") {
      try { await deps.writeQuotaCooldown(env, error.quota_cooldown_until, error.code === "mcp_rate_limited" ? "provider_rate_limited" : "provider_quota_exceeded"); } catch { /* best effort */ }
      return { status: 429, body: { contract: CALENDAR_GATEWAY_CONTRACT, error: error.code, quota_cooldown_until: error.quota_cooldown_until } };
    }
    return { status: 502, body: { contract: CALENDAR_GATEWAY_CONTRACT, error: asString(error?.code) || "mcp_request_failed" } };
  }
}

/**
 * Runs a batch of get_ohlcv requests with the shared OAuth grant and quota
 * cooldown. Reachable only through the `TvGateway` RPC entrypoint (Service
 * Binding with entrypoint "TvGateway"): RPC methods are not exposed over
 * public HTTP, so no shared secret is needed.
 * Returns { status, body } where status mirrors HTTP semantics.
 */
export async function runOhlcvRequests(env, raw, deps) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REQUESTS_PER_CALL) {
    return { status: 400, body: { contract: OHLCV_GATEWAY_CONTRACT, error: "requests_must_be_1_to_12" } };
  }
  // Each request is validated on its own: an invalid one is answered with its error in its slot and
  // never sinks the valid ones beside it (2026-11-08: one unknown symbol rejected the whole batch, gold
  // included). Only a batch with no valid request is refused before OAuth or MCP.
  const checks = raw.map((item) => validateOhlcvRequest(item, env));
  const firstValid = checks.findIndex((c) => !c.error);
  if (firstValid < 0) return { status: 400, body: { contract: OHLCV_GATEWAY_CONTRACT, error: checks[0].error, index: 0 } };

  const cooldown = await deps.readQuotaCooldown(env);
  if (cooldown) return { status: 503, body: { contract: OHLCV_GATEWAY_CONTRACT, error: "mcp_quota_cooldown_active", quota_cooldown_until: cooldown.until } };

  let metadata, accessToken;
  try {
    metadata = await deps.fetchOAuthMetadata(env);
    accessToken = await deps.getValidAccessToken(env, metadata);
  } catch (error) {
    return { status: 503, body: { contract: OHLCV_GATEWAY_CONTRACT, error: asString(error?.code) || "oauth_unavailable" } };
  }
  const endpoint = asString(metadata.mcp_endpoint);

  const results = [];
  for (const [index, check] of checks.entries()) {
    if (check.error) { results.push({ ok: false, request: raw[index], error: check.error }); continue; }
    const args = check.value;
    try {
      results.push({ ok: true, request: args, ...(await callOhlcvTool(env, endpoint, accessToken, args, deps)) });
    } catch (error) {
      if (error?.code === "mcp_quota_exceeded" || error?.code === "mcp_rate_limited") {
        const reason = error.code === "mcp_rate_limited" ? "provider_rate_limited" : "provider_quota_exceeded";
        try { await deps.writeQuotaCooldown(env, error.quota_cooldown_until, reason); } catch { /* best effort */ }
        // Stop immediately: every further call would also be rejected and count against the account.
        results.push({ ok: false, request: args, error: error.code });
        return { status: 429, body: { contract: OHLCV_GATEWAY_CONTRACT, error: error.code, quota_cooldown_until: error.quota_cooldown_until, results } };
      }
      results.push({ ok: false, request: args, error: asString(error?.code) || "mcp_request_failed", upstream_status: Number.isInteger(error?.status) ? error.status : null });
    }
  }
  return { status: 200, body: { contract: OHLCV_GATEWAY_CONTRACT, fetched_at: new Date().toISOString(), results } };
}
