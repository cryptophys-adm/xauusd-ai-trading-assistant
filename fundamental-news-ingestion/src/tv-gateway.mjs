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
export const DEFAULT_GATEWAY_SYMBOLS = Object.freeze(["OANDA:XAUUSD", "TVC:DXY", "CRYPTOCAP:USDT", "TVC:USOIL"]);
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

function allowedSymbols(env) {
  const configured = asString(env.TV_GATEWAY_SYMBOLS).split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_GATEWAY_SYMBOLS);
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
      quota ? "TradingView MCP tool quota exceeded" : rateLimited ? "TradingView MCP rate limited (HTTP 429)" : "TradingView MCP get_ohlcv failed"
    ), {
      code: quota ? "mcp_quota_exceeded" : rateLimited ? "mcp_rate_limited" : (response.ok ? "mcp_tool_error" : "mcp_upstream_error"),
      status: quota ? 429 : (response.ok ? 502 : response.status),
      quota_cooldown_until: quota
        ? deps.parseQuotaCooldownUntil(upstreamMessage)
        : rateLimited ? deps.rateLimitCooldownUntil(retryAfterMs) : null
    });
  }
  const tool = parseToolResult(payload);
  if (!tool) throw Object.assign(new Error("get_ohlcv returned no parsable content"), { code: "invalid_ohlcv_payload", status: 502 });
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
  const requests = [];
  for (const [index, item] of raw.entries()) {
    const checked = validateOhlcvRequest(item, env);
    if (checked.error) return { status: 400, body: { contract: OHLCV_GATEWAY_CONTRACT, error: checked.error, index } };
    requests.push(checked.value);
  }

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
  for (const args of requests) {
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
