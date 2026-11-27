import OmegaProfile from "../components/OmegaProfile";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { usePushMany } from "../lib/push";
import {
  Activity,
  AlertTriangle,
  Bot,
  CandlestickChart,
  Cpu,
  KeyRound,
  Layers,
  Power,
  Radio,
  ShieldCheck,
  Sliders,
  Terminal,
  Zap,
} from "lucide-react";
import { createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type TickMarkType, type Time, type UTCTimestamp } from "lightweight-charts";
import { Badge, ChartCredit, Dot, Empty, Hint, Kpi, Panel, Skeleton } from "../components/ui";
import { ExitConfirmModal, type ExitTargetPosition } from "../components/ExitConfirmModal";
import OmegaWhy from "../components/OmegaWhy";
import PmLines from "../components/PmLines";
import { CHART_READ, get } from "../lib/api";
import { C } from "../components/charts";
import { CANDLE, T, tagText, volumeColor } from "../lib/tokens";
import { nearestCandidates, withAlpha, type KeyZone } from "../lib/keyZones";
import { KeyZoneBands } from "../lib/keyZoneBands";
import { appliedNotes, engineDefaultsFor } from "../lib/engineDefaults";
import { ZonesPrimitive, type ChartZone } from "../lib/zones-primitive";
import { CreatedCell, IntentCards, IntentEntry, SignalRows } from "../components/OmegaZone";
import { brokerToFeed, CHART_LABEL, chartScaleCaption, gmt7Crosshair, gmt7Tick, knownFeedBasis, positionLines, restingLimit, signalZoneOf, zoneToFeed, type Zone } from "../lib/entryZone";

/**
 * Omega Execution Engine & Windows MetaTrader 5 Web Terminal inside the Nexus SPA
 * (owner 2026-11-09: integrated into the Nexus left sidebar navigation at
 * nexus.cryptophys.work/omega/ and /#/omega behind Cloudflare Access, upgraded with a
 * full Windows MT5 Terminal — Web Edition workstation).
 * Calls same-origin /omega/api/* routes forwarded to xauusd-omega (OMEGA_PAGE binding)
 * and /api/ohlcv for the MT5 terminal candlestick chart.
 */

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

type Mt5Tf = "M5" | "M15" | "H1" | "H4" | "D1";
type ToolboxTab = "trade" | "history" | "intents" | "state_machine" | "tca_sor" | "events";
// The account's gold symbol (owner 2026-11-19, universal): found automatically by OmegaExecutor 1.19 on any broker, by its
// contract and its price against the reference gold price; a typed name is only a hint tried first, under the same checks.
const GOLD_PAIR_OPTIONS = [
  { value: "AUTO_GOLD", label: "Automatic (found by contract and price)" },
  { value: "OTHER", label: "Hint: type a symbol name" },
];
// The same rule as src/gold-symbol.mjs TRADE_SYMBOL_RE.
const TRADE_SYMBOL_RE = /^[A-Za-z0-9._#+-]{1,32}$/;

const MT5_TFS: { key: Mt5Tf; label: string }[] = [
  { key: "M5", label: "M5" },
  { key: "M15", label: "M15" },
  { key: "H1", label: "H1" },
  { key: "H4", label: "H4" },
  { key: "D1", label: "D1" },
];

const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function keyId(publicKeySpkiBase64: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64(publicKeySpkiBase64)));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildEnvelope(publicKeySpkiBase64: string, kid: string, creds: { server: string; login: string; password: string }) {
  if ((await keyId(publicKeySpkiBase64)) !== kid) throw new Error("the bridge key does not match its id");
  const publicKey = await crypto.subtle.importKey("spki", unb64(publicKeySpkiBase64), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(creds));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, await crypto.subtle.exportKey("raw", aesKey));
  return { v: 1, kid, wrapped_key: b64(wrapped), iv: b64(iv), ciphertext: b64(ciphertext) };
}

const num = (v?: number | null, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const money = (v?: number | null, cur = "") =>
  typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}${cur ? " " + cur : ""}` : "—";
/** A P&L in its direction's colour: a loss red, a gain green, zero in the text colour; no value (its "—") muted. */
const pnlColor = (v?: number | null) => (typeof v !== "number" || !Number.isFinite(v) ? T.muted : v < 0 ? T.bear : v > 0 ? T.bull : T.fg);
const balFmt = (v?: number | null, cur = "") =>
  typeof v === "number" && Number.isFinite(v)
    ? `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? " " + cur : ""}`
    : "—";
const toneCls = (v?: number | null) => (typeof v !== "number" || v === 0 ? "text-slate-300" : v > 0 ? "text-bull" : "text-bear");
const timeUtc = (ms?: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const agoMs = (ms?: number | null) => {
  if (ms == null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 45) return `${Math.max(1, s)}s ago`;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const CONNECTION_TEXT: Record<string, string> = {
  none: "Not connected.",
  stored: "Stored; applied at next bridge sync.",
  needs_reentry: "Bridge key changed; re-enter credentials.",
  cleared: "Disconnected.",
};

const INTENT_TONE: Record<string, "ok" | "fault" | "late" | "cyan" | "slate"> = {
  done: "ok",
  failed: "fault",
  expired: "late",
  pending: "late",
  sent: "late",
};

async function omegaJson(path: string, method = "GET", body?: unknown) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const KEY_ROLE_COLOR: Record<string, string> = { support: C.bullFill, resistance: C.bearFill, "at price": C.cyan };
/** The zone labels (9.5 px) in the text tokens at full strength: the bear fill at 85% was 4.0 to 1 on the ground. */
const KEY_ROLE_TEXT: Record<string, string> = { support: T.bull, resistance: T.bear, "at price": T.ok };
const KEY_ROLE_SHORT: Record<string, string> = { support: "S", resistance: "R", "at price": "at price" };
// Transparent blocks (owner 2026-11-12): the fill's opacity by strength, the label's readable.
const KEY_STRENGTH_FILL: Record<string, number> = { strong: 0.2, medium: 0.13, weak: 0.08 };

/** The War Room's key-level zones (GET /api/conclusion/global → strategy.key_levels), refreshed every 60 s. */
function useKeyZones(): KeyZone[] {
  const [zones, setZones] = useState<KeyZone[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      get<any>("/api/conclusion/global")
        .then((r) => { if (alive) setZones(nearestCandidates(r?.global?.strategy?.key_levels, 6)); })
        .catch(() => { if (alive) setZones([]); });
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  return zones;
}

/** The Omega chart (exported for test/nexus-chart-attribution.test.mjs CA2, which renders its caption). */
export function Mt5ChartCanvas({
  tf,
  symbol,
  server,
  digits,
  bid,
  ask,
  signal,
  positions,
  showBidAsk,
  showPlan,
  showPositions,
  keyZones,
  showKeyLevels,
  feedBasis,
  limit,
}: {
  tf: Mt5Tf;
  symbol: string;
  server: string;
  digits: number;
  bid?: number | null;
  ask?: number | null;
  signal: any;
  positions: any[];
  showBidAsk: boolean;
  showPlan: boolean;
  showPositions: boolean;
  keyZones: KeyZone[];
  showKeyLevels: boolean;
  /** EZ1: the signal's broker − feed basis (signal.feed_basis when feed_basis_known), else null. */
  feedBasis: number | null;
  /** EZ1: Omega's resting limit (broker scale) and the entry zone its intent carries (broker). */
  limit: { price: number; side: "BUY" | "SELL" | null; zone: Zone | null } | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const lastLineRef = useRef<IPriceLine | null>(null);
  const bandsRef = useRef<KeyZoneBands | null>(null);
  // EZ1: the entry zone and the bid/ask labels, each label next to its own line (zones-primitive's anchored mode).
  const ezRef = useRef<ZonesPrimitive | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [hover, setHover] = useState<Candle | null>(null);

  useEffect(() => {
    let alive = true;
    const loadCandles = () => {
      get<{ candles: Candle[] }>(`/api/ohlcv?timeframe=${tf}&limit=300`, CHART_READ)
        .then((r) => {
          if (alive) setCandles(r.candles || []);
        })
        .catch(() => {
          if (alive) setCandles([]);
        });
    };
    loadCandles();
    const id = window.setInterval(loadCandles, 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [tf]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      // No library logo (its <style> is blocked by the CSP): the caption's "Charts by TradingView" link is the attribution.
      layout: {
        background: { color: T.ground },
        textColor: T.fg2,
        fontFamily: "ui-monospace, JetBrains Mono, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(34, 211, 238, 0.05)" },
        horzLines: { color: "rgba(34, 211, 238, 0.05)" },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.09)" },
      // The time axis in the owner's GMT+7 (the EZ1 mockup); the candles stay the feed's.
      timeScale: { borderColor: "rgba(255,255,255,0.09)", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t: Time, type: TickMarkType) => gmt7Tick(t, type) },
      localization: { timeFormatter: (t: Time) => gmt7Crosshair(t) },
    });
    // The last price is our own price line (setLastLine), so its axis tag carries dark text on the green and red fills:
    // the library's own tag is white there (2.3 to 1 on the bull fill).
    const series = chart.addCandlestickSeries({
      ...CANDLE,
      lastValueVisible: false,
      priceLineVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    const vol = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const bands = new KeyZoneBands();
    series.attachPrimitive(bands);
    bandsRef.current = bands;
    const ez = new ZonesPrimitive("anchored");
    series.attachPrimitive(ez);
    ezRef.current = ez;
    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volRef.current = null;
      bandsRef.current = null;
      ezRef.current = null;
      linesRef.current = [];
      lastLineRef.current = null;
    };
  }, []);

  /** The last price's line and axis tag, in the candle's colour with dark text. */
  const setLastLine = (series: ISeriesApi<"Candlestick">, open: number, close: number) => {
    const color = close >= open ? T.bullFill : T.bearFill;
    const opts = { price: close, color, axisLabelTextColor: tagText(color) };
    if (lastLineRef.current) lastLineRef.current.applyOptions(opts);
    else lastLineRef.current = series.createPriceLine({ ...opts, title: "", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true });
  };

  useEffect(() => {
    const series = seriesRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!series || !vol || !chart) return;
    const sorted = [...candles]
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
    series.setData(sorted.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    const lastBar = sorted[sorted.length - 1];
    if (lastBar) setLastLine(series, lastBar.open, lastBar.close);
    vol.setData(
      sorted.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume ?? 0,
        color: volumeColor(c.close >= c.open, 0.28),
      }))
    );

    const sub = (param: any) => {
      if (!param?.time) {
        setHover(null);
        return;
      }
      const found = sorted.find((c) => c.time === param.time);
      setHover(found || null);
    };
    chart.subscribeCrosshairMove(sub);
    return () => chart.unsubscribeCrosshairMove(sub);
  }, [candles]);

  // Real-time tick update on the active candlestick bar as MT5 broker ticks stream in. EZ1 (the reviewer's ruling 4):
  // the candles are the feed's, so the broker's bid is painted on the feed scale (bid − feed_basis), and not at all
  // while the basis is unknown.
  useEffect(() => {
    const series = seriesRef.current;
    const feedBid = brokerToFeed(bid, feedBasis, digits);
    if (!series || feedBid == null || candles.length === 0) return;
    const lastBar = candles[candles.length - 1];
    if (!lastBar || !Number.isFinite(lastBar.time)) return;
    try {
      series.update({
        time: lastBar.time as UTCTimestamp,
        open: lastBar.open,
        high: Math.max(lastBar.high, feedBid),
        low: Math.min(lastBar.low, feedBid),
        close: feedBid,
      });
      setLastLine(series, lastBar.open, feedBid);
    } catch {
      // ignore if chart series is resetting
    }
  }, [bid, candles, feedBasis, digits]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) {
      try {
        series.removePriceLine(l);
      } catch {
        // ignore removed line
      }
    }
    linesRef.current = [];
    const addLine = (price: number | null | undefined, title: string, color: string, style = LineStyle.Dashed, lineWidth: 1 | 2 = 1, axis = true) => {
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;
      linesRef.current.push(series.createPriceLine({ price, color, lineWidth, lineStyle: style, axisLabelVisible: axis, axisLabelTextColor: tagText(color), title }));
    };

    // Key levels from the War Room (owner 2026-11-12): the Key Level Agent's six candidate zones nearest to price, as
    // transparent blocks from low to high behind the candles, coloured by role and shaded by strength, never as lines,
    // each labelled above with its role, strength and price range (owner 2026-11-12),
    // so every line on the chart is the bid, ask, plan or a position. They are on the feed's prices (OANDA via
    // TradingView), like the candles; the broker's bid, ask and positions may differ by a few cents.
    bandsRef.current?.setZones(showKeyLevels ? keyZones.map((z) => {
      const base = KEY_ROLE_COLOR[z.role ?? ""] ?? C.muted;
      return { low: z.low, high: z.high, fill: withAlpha(base, KEY_STRENGTH_FILL[z.strength ?? ""] ?? 0.1), text: KEY_ROLE_TEXT[z.role ?? ""] ?? T.fg2, label: `KL ${KEY_ROLE_SHORT[z.role ?? ""] ?? "zone"} · ${z.strength ?? "—"} · ${z.low === z.high ? num(z.low, digits) : `${num(z.low, digits)}–${num(z.high, digits)}`}` };
    }) : []);
    // EZ1 (the reviewer's ruling 4): the terminal's bid, ask, resting limit and entry zone on the feed chart, converted
    // (MT5 − feed_basis). Each line carries one short label (CHART_LABEL) and its price only on the axis tag; the
    // caption says the scale once (owner 2026-11-23: less cosmetic text on the chart). The bid and ask lines carry no
    // text (owner 2026-11-23: "Bid ask sudah ada di side panel, tidak perlu lagi text di chart"): converted, without an
    // axis tag (the bid's feed price is the last price's tag, the axis keeps the limit's); while the basis is unknown at
    // the terminal's prices with their own axis tags.
    const labels: ChartZone[] = [];
    const feedBid = brokerToFeed(bid, feedBasis, digits), feedAsk = brokerToFeed(ask, feedBasis, digits);
    if (showBidAsk) {
      if (feedBasis != null) {
        addLine(feedBid, "", T.bullFill, LineStyle.Solid, 1, false);
        addLine(feedAsk, "", T.bearFill, LineStyle.Solid, 1, false);
      } else {
        addLine(bid, "", T.bullFill, LineStyle.Solid, 1);
        addLine(ask, "", T.bearFill, LineStyle.Solid, 1);
      }
    }
    // No setup on chart unless decision is explicitly clear (Owner directive 2026-11-11)
    const hasClearDecision = showPlan && signal && (signal.side === "BUY" || signal.side === "SELL") && !signal.paused && !signal.kill;
    if (hasClearDecision) {
      addLine(signal.entry, CHART_LABEL.plan, T.okFill, LineStyle.Dashed, 1);
      addLine(signal.stop, CHART_LABEL.planSl, T.bearFill, LineStyle.Dashed, 1);
      addLine(signal.tp1, CHART_LABEL.planTp, T.bullFill, LineStyle.Dashed, 1);
    }
    // The entry zone: the resting limit's own (broker, converted), else the clear decision's (signal, feed).
    const limitFeed = limit ? brokerToFeed(limit.price, feedBasis, digits) : null;
    const zoneFeed = limit?.zone ? zoneToFeed(limit.zone, feedBasis) : hasClearDecision ? signalZoneOf(signal) : null;
    if (showPlan && zoneFeed) labels.unshift({ low: zoneFeed.low, high: zoneFeed.high, color: T.okFill, alpha: 0.16, text: T.ok, label: CHART_LABEL.zone });
    if (showPositions && limit && limitFeed != null) addLine(limitFeed, CHART_LABEL.limit, limit.side === "SELL" ? T.bearFill : T.bullFill, LineStyle.Dashed, 1);
    ezRef.current?.setZones(labels);
    // The open positions (broker scale): entry, SL and TP converted to the feed as the bid and ask are, labelled
    // "BUY 0.10", "SL" and "TP"; without a basis at the broker's prices (lib/entryZone.ts positionLines).
    if (showPositions && Array.isArray(positions)) {
      for (const p of positions) {
        const isBuy = p?.side === "BUY";
        for (const l of positionLines(p, feedBasis, digits)) {
          if (l.kind === "entry") addLine(l.price, l.title, isBuy ? T.bullFill : T.bearFill, LineStyle.Solid, 2);
          else addLine(l.price, l.title, l.kind === "sl" ? T.bearFill : T.bullFill, LineStyle.Dotted, 1);
        }
      }
    }
  }, [candles, bid, ask, signal, positions, showBidAsk, showPlan, showPositions, feedBasis, limit, keyZones, showKeyLevels, digits]);

  const last = hover || candles[candles.length - 1];

  return (
    // Fills the whole chart column (owner 2026-11-12: "tidak ada space kosong dibawah sumbu waktu"); at least 430 px.
    <div className="relative flex h-full min-h-[430px] w-full flex-1 flex-col bg-ground">
      {/* MT5 Top-Left Chart Watermark & OHLC Bar */}
      <div className="pointer-events-none absolute left-2.5 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-col gap-0.5 rounded-sm bg-black/55 px-2.5 py-1.5 backdrop-blur-xs border border-white/5">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="mono font-bold text-cyan-300">
            {symbol}, {tf}
          </span>
          <span className="text-slate-400">·</span>
          <span className="text-slate-300">{server || "MT5"}</span>
        </div>
        {last ? (
          <div className="mono flex flex-wrap items-center gap-2.5 text-[10.5px] text-slate-400">
            <span>O {num(last.open, digits)}</span>
            <span>H {num(last.high, digits)}</span>
            <span>L {num(last.low, digits)}</span>
            <span className={last.close >= last.open ? "text-bull" : "text-bear"}>C {num(last.close, digits)}</span>
          </div>
        ) : (
          <div className="mono text-[10.5px] text-slate-500">Loading…</div>
        )}
      </div>

      {/* EZ1: every price on the chart's axis is the feed's (the caption says so, once), its times GMT+7. */}
      <div className="relative min-h-[380px] flex-1">
        <div ref={hostRef} className="absolute inset-0" />
        <span className="mono pointer-events-none absolute bottom-1 right-1 z-10 text-[9.5px] text-fg-2">GMT+7</span>
      </div>
      {/* The scale, said once (owner 2026-11-23: less cosmetic text on the chart; no "broker": Omega's data is the
          terminal's), and the library's credit. The bid and ask are the side panel's (Market Watch). */}
      <div className="mono flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t border-white/5 px-2.5 py-1.5 text-[10.5px] text-muted">
        <span>{chartScaleCaption(feedBasis)}</span>
        <span><ChartCredit /></span>
      </div>
    </div>
  );
}

// The profiles' caps (src/account-spec.mjs PROFILES): risk per trade (target), max positions, daily loss.
const PROFILE_CAPS: Record<string, { risk: number; positions: number; daily: number }> = {
  safe: { risk: 1, positions: 1, daily: 3 },
  conservative: { risk: 2, positions: 2, daily: 6 },
  aggressive: { risk: 5, positions: 3, daily: 10 },
};
const appliedLimit = (setting: unknown, cap: number | undefined) => {
  const v = Number(setting);
  if (!Number.isFinite(v)) return cap ?? "—";
  return cap == null ? v : Math.min(v, cap);
};

// Total open risk per profile (src/account-spec.mjs PROFILES open_risk_pct), for the header's tooltip.
const PROFILE_TOTAL_OPEN: Record<string, number> = { safe: 2, conservative: 5, aggressive: 10 };

/**
 * Pure: a position's money at its stop (owner 2026-11-18). The loss to the SL in money and % of equity, or, once the
 * stop is at or beyond the entry (break-even or a lock), the profit it locks. Null without a stop or a tick value.
 */
function riskToSl(p: any, br: any): { locked: boolean; amount: number; pct: number | null } | null {
  const open = Number(p?.entry ?? p?.open_price), sl = Number(p?.sl), vol = Number(p?.volume);
  const tick = Number(br?.tick_size), value = Number(br?.tick_value);
  if (!(open > 0) || !(sl > 0) || !(vol > 0) || !(tick > 0) || !(value > 0)) return null;
  const dist = p?.side === "BUY" ? open - sl : sl - open; // > 0: the stop loses; <= 0: the stop locks profit
  const amount = Math.round((Math.abs(dist) / tick) * value * vol * 100) / 100;
  const eq = Number(br?.equity);
  return dist > 0 ? { locked: false, amount, pct: eq > 0 ? Math.round((amount / eq) * 1000) / 10 : null } : { locked: true, amount, pct: null };
}

// A reported leverage this high is a broker's "unlimited" (FxPro demo: 1:2,000,000,000), not a real ratio.
const LEVERAGE_UNLIMITED_FROM = 100_000;

export default function Omega() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("—");

  // MT5 Web Terminal & Separated Setup Mode UI state
  // A deep link (the profile agent's Telegram line): #setup/profile opens Setup → Risk profile.
  const hashTab = typeof window !== "undefined" ? (window.location.hash.match(/^#setup(?:\/(engine|profile|connection))?$/) ?? null) : null;
  const [viewMode, setViewMode] = useState<"terminal" | "setup">(hashTab ? "setup" : "terminal");
  const [setupTab, setSetupTab] = useState<"engine" | "profile" | "connection">((hashTab?.[1] as "engine" | "profile" | "connection" | undefined) ?? "engine");
  // On a phone the Market Watch column folds above the chart (owner 2026-11-18: MT5 layout, no horizontal scroll).
  const [dockOpen, setDockOpen] = useState(false);
  const [mt5Tf, setMt5Tf] = useState<Mt5Tf>("M15");
  const [toolboxTab, setToolboxTab] = useState<ToolboxTab>("trade");
  const [showBidAsk, setShowBidAsk] = useState(true);
  const [showPlan, setShowPlan] = useState(true);
  const [showPositions, setShowPositions] = useState(true);
  const [showKeyLevels, setShowKeyLevels] = useState(true);
  const keyZones = useKeyZones();
  const [streamLive, setStreamLive] = useState(false);
  const [tickDir, setTickDir] = useState<"up" | "down" | null>(null);
  const lastBidRef = useRef<number | null>(null);
  const engineDirtyRef = useRef(false);
  const serverInitRef = useRef(false);

  // Raw state inspector
  const [showRawState, setShowRawState] = useState(false);

  // Control state
  const [controlReason, setControlReason] = useState("");
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [killConfirmText, setKillConfirmText] = useState("");
  const [controlMsg, setControlMsg] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [closingTicket, setClosingTicket] = useState<number | null>(null);
  // Human-AI interaction (owner 2026-11-19): the owner's edit of a position or pending order, and delegation to Omega.
  const [editRow, setEditRow] = useState<{ target: "position" | "order"; ticket: number; sl: string; tp: string; price: string } | null>(null);
  const [hitlBusy, setHitlBusy] = useState(false);
  const [hitlMsg, setHitlMsg] = useState<{ tone: string; text: string } | null>(null);
  const [exitModalPosition, setExitModalPosition] = useState<ExitTargetPosition | null>(null);

  // Broker & Gold Pairing setup state
  // No broker preselected: the connected server picks it (2026-11-18: labels follow the broker, never a default name).
  const [goldPair, setGoldPair] = useState<string>("AUTO_GOLD");
  const [goldOther, setGoldOther] = useState<string>("");
  // Units of the account currency per US dollar, only for an account not in USD that has not traded yet (e.g. 100 for cents).
  const [unitsPerUsd, setUnitsPerUsd] = useState<string>("");
  const [showPass, setShowPass] = useState<boolean>(false);
  const [bServer, setBServer] = useState("");
  const [bLogin, setBLogin] = useState("");
  const [bPassword, setBPassword] = useState("");
  const [brokerMsg, setBrokerMsg] = useState<{ tone: string; text: string } | null>(null);

  // Engine settings form state
  const [engineDirty, setEngineDirty] = useState(false);
  const [eEnabled, setEEnabled] = useState(false);
  const [eRisk, setERisk] = useState("");
  const [eMaxPos, setEMaxPos] = useState("");
  const [eLoss, setELoss] = useState("");
  const [eSpread, setESpread] = useState("");
  const [eAge, setEAge] = useState("");
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [liveConfirmText, setLiveConfirmText] = useState("");
  const [engineMsg, setEngineMsg] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => {
    engineDirtyRef.current = engineDirty;
  }, [engineDirty]);

  const applyOverview = (ov: any) => {
    // A pushed overview carries no viewer (one snapshot for every page): the last read's viewer stays.
    setData((prev: any) => (ov?.viewer ? ov : { ...ov, viewer: prev?.viewer }));
    setError(null);
    setLoading(false);
    setUpdatedAt(new Date().toISOString().slice(11, 19) + " UTC");
    const newBid = ov?.broker?.bridge?.bid;
    if (typeof newBid === "number" && Number.isFinite(newBid)) {
      if (lastBidRef.current != null && newBid !== lastBidRef.current) {
        setTickDir(newBid > lastBidRef.current ? "up" : "down");
      }
      lastBidRef.current = newBid;
    }
    const activeSrv = ov?.broker?.connection?.server || ov?.broker?.bridge?.server;
    if (activeSrv && !serverInitRef.current) {
      serverInitRef.current = true;
      setBServer(activeSrv);
    }
    const eng = ov?.broker?.engine;
    if (eng && !engineDirtyRef.current) {
      setEEnabled(eng.enabled === true);
      setERisk(eng.risk_pct != null ? String(eng.risk_pct) : "");
      setEMaxPos(eng.max_positions != null ? String(eng.max_positions) : "");
      setELoss(eng.max_daily_loss_pct != null ? String(eng.max_daily_loss_pct) : "");
      setESpread(eng.max_spread_points != null ? String(eng.max_spread_points) : "");
      setEAge(eng.max_signal_age_ms ? String(Math.round(eng.max_signal_age_ms / 60000)) : "");
    }
  };

  const load = async () => {
    try {
      const ov = await omegaJson("/omega/api/overview");
      applyOverview(ov);
    } catch (e: any) {
      setError(e?.message || "Failed to load Omega overview");
    } finally {
      setLoading(false);
    }
  };

  // ADR-0015 phase 1 (owner 2026-11-14: "lanjut"): the overview is pushed after each bridge sync through
  // Omega's own route (it checks the Access identity), once for every open page; it replaces the 0.5-second
  // overview stream. The read stays every 8 s until the first push, then every 60 s as a fallback.
  const push = usePushMany(["omega-overview"], "/omega/api/push");
  const pushed = push.snap["omega-overview"]?.data;
  useEffect(() => { if (pushed) applyOverview(pushed); }, [pushed]);
  useEffect(() => { setStreamLive(push.live); }, [push.live]);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const t = window.setInterval(load, push.live ? 60_000 : 8_000);
    return () => window.clearInterval(t);
  }, [push.live]);

  const sendControl = async (mode: string, confirm?: string) => {
    const reason = controlReason.trim();
    if (mode !== "active" && !reason) {
      setControlMsg({ tone: "text-amber-200", text: "Write a reason first." });
      return;
    }
    setBusy(true);
    setControlMsg({ tone: "text-slate-300", text: "Sending…" });
    try {
      await omegaJson("/omega/api/control", "POST", { mode, reason, confirm });
      setControlMsg({ tone: "text-ok", text: `Control set to ${mode}; applied at next EA poll.` });
      setControlReason("");
    } catch (e: any) {
      setControlMsg({ tone: "text-fault", text: `Refused: ${e?.message || "failed"}` });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const connectBroker = async (ev: FormEvent) => {
    ev.preventDefault();
    const isLocked = Boolean(
      data?.broker?.connection?.status === "stored" &&
      data?.broker?.connection?.server &&
      data?.broker?.bridge?.terminal_connected
    );
    if (isLocked) {
      setBrokerMsg({
        tone: "text-amber-200",
        text: "Disconnect the current account first.",
      });
      return;
    }
    const server = bServer.trim();
    const login = bLogin.trim();
    const password = bPassword;
    if (!server || !login || !password) {
      setBrokerMsg({ tone: "text-amber-200", text: "Fill in the server, login and password." });
      return;
    }
    // The account's gold symbol: Automatic sends none (the EA finds gold by its contract and price); a typed name is a hint.
    const tradeSymbol = goldPair === "OTHER" && goldOther.trim() ? goldOther.trim() : null;
    const units = unitsPerUsd.trim() === "" ? null : Number(unitsPerUsd);
    if (units !== null && !(Number.isFinite(units) && units > 0)) {
      setBrokerMsg({ tone: "text-amber-200", text: "Units per US dollar must be a positive number (e.g. 100 for a cent account), or empty." });
      return;
    }
    if (tradeSymbol !== null && !TRADE_SYMBOL_RE.test(tradeSymbol)) {
      setBrokerMsg({ tone: "text-amber-200", text: "Type the gold symbol exactly as Market Watch shows it (letters, digits, . _ - # +)." });
      return;
    }
    setBrokerMsg({ tone: "text-slate-300", text: "Encrypting…" });
    try {
      const key = await omegaJson("/omega/api/bridge/key");
      const envelope = await buildEnvelope(key.public_key, key.kid, { server, login, password });
      const out = await omegaJson("/omega/api/connection", "POST", { server, envelope, trade_symbol: tradeSymbol, units_per_usd: units });
      setBrokerMsg({
        tone: "text-ok",
        text: `Saved v${out.version} for ${out.server}${out.trade_symbol ? ` (gold symbol ${out.trade_symbol})` : ""}; applied at next bridge sync.`,
      });
    } catch (e: any) {
      setBrokerMsg({ tone: "text-fault", text: `Refused: ${e?.message || "failed"}` });
    } finally {
      setBLogin("");
      setBPassword("");
      await load();
    }
  };

  const disconnectBroker = async () => {
    const reason = "disconnect requested from nexus dashboard";
    setBrokerMsg({ tone: "text-slate-300", text: "Disconnecting…" });
    try {
      await omegaJson(`/omega/api/connection?disconnect=1&reason=${encodeURIComponent(reason)}`, "GET");
      setBrokerMsg({ tone: "text-ok", text: "Disconnected." });
    } catch (e: any) {
      setBrokerMsg({ tone: "text-fault", text: `Refused: ${e?.message || "failed"}` });
    }
    await load();
  };

  const saveEngine = async (extra: Record<string, unknown> = {}) => {
    const toNum = (v: string) => (v.trim() === "" ? undefined : Number(v));
    const body = {
      enabled: eEnabled,
      risk_pct: toNum(eRisk),
      max_positions: toNum(eMaxPos),
      max_daily_loss_pct: toNum(eLoss),
      max_spread_points: toNum(eSpread),
      max_signal_age_min: toNum(eAge),
      ...extra,
    };
    try {
      await omegaJson("/omega/api/settings", "POST", body);
      setEngineDirty(false);
      setEngineMsg({
        tone: "text-ok",
        text: extra.live_armed === true ? "Live armed." : extra.live_armed === false ? "Live disarmed." : "Saved.",
      });
    } catch (e: any) {
      setEngineMsg({ tone: "text-fault", text: `Refused: ${e?.message || "failed"}` });
    }
    await load();
  };

  const requestExitPosition = (pos: ExitTargetPosition) => {
    setExitModalPosition(pos);
  };

  const lvl = (v: string) => (v.trim() === "" ? null : Number(v));
  const saveModify = async () => {
    if (!editRow) return;
    const body = { target: editRow.target, ticket: editRow.ticket, sl: lvl(editRow.sl), tp: lvl(editRow.tp), ...(editRow.target === "order" ? { price: lvl(editRow.price) } : {}) };
    if ([body.sl, body.tp, (body as any).price].some((v) => v != null && !(Number.isFinite(v) && v >= 0))) { setHitlMsg({ tone: "text-fault", text: "Prices only (empty removes a level)." }); return; }
    setHitlBusy(true);
    try {
      await omegaJson("/omega/api/position/modify", "POST", body);
      setHitlMsg({ tone: "text-ok", text: `Modify sent for #${editRow.ticket}; the EA applies it at the next sync.` });
      setEditRow(null);
      await load();
    } catch (err: any) {
      setHitlMsg({ tone: "text-fault", text: `Modify refused for #${editRow.ticket}: ${err?.message || "error"}` });
    } finally { setHitlBusy(false); }
  };
  const delegate = async (ticket: number, on: boolean) => {
    setHitlBusy(true);
    try {
      await omegaJson("/omega/api/position/delegate", "POST", { ticket, on });
      setHitlMsg({ tone: "text-ok", text: on ? `#${ticket} delegated: Omega manages it from the next sync.` : `#${ticket} is yours again: Omega no longer manages it.` });
      await load();
    } catch (err: any) {
      setHitlMsg({ tone: "text-fault", text: `Delegation failed for #${ticket}: ${err?.message || "error"}` });
    } finally { setHitlBusy(false); }
  };
  const delegateMode = async (on: boolean) => {
    setHitlBusy(true);
    try {
      await omegaJson("/omega/api/delegate-mode", "POST", { on });
      setHitlMsg({ tone: "text-ok", text: on ? "Your next manual entries go to Omega until you turn this off." : "New manual entries stay yours." });
      await load();
    } catch (err: any) {
      setHitlMsg({ tone: "text-fault", text: `Delegate toggle failed: ${err?.message || "error"}` });
    } finally { setHitlBusy(false); }
  };

  const confirmExitPosition = async (ticket: number) => {
    setClosingTicket(ticket);
    try {
      await omegaJson("/omega/api/position/close", "POST", { ticket, reason: "manual_user_exit" });
      setControlMsg({
        tone: "text-ok",
        text: `Close sent for #${ticket}.`,
      });
      setExitModalPosition(null);
      await load();
    } catch (err: any) {
      setControlMsg({
        tone: "text-fault",
        text: `Close failed for #${ticket}: ${err?.message || "error"}`,
      });
    } finally {
      setClosingTicket(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
        <Panel title="Omega" icon={<Zap className="h-3.5 w-3.5 text-cyan-300" />}>
          <Skeleton rows={5} />
        </Panel>
      </div>
    );
  }

  const s = data?.signal || {};
  const c = data?.control || {};
  const hb = data?.heartbeat || null;
  const ea = data?.ea || {};
  const st = data?.stats || {};
  const b = data?.broker || null;
  // Delegation and the owner's edits (owner 2026-11-19, src/omega-hitl.mjs).
  const delegation: any = b?.delegation ?? null;
  // ADR-0020 Amendment 8: the owner's switch and the positions whose stop the council loosened (once each).
  const pmLoosen: any = b?.pm_loosen ?? null;
  const viewer = data?.viewer || { can_control: false };
  const canControl = Boolean(viewer.can_control);

  const e = b?.engine || {};
  const conn = b?.connection || {};
  const br = b?.bridge || {};
  // Limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md): the switch, and Omega's resting limit by order ticket.
  const entryOrder: any = b?.entry_order || {};
  const limitByTicket: Record<string, any> = Object.fromEntries((entryOrder.pending || []).map((x: any) => [String(x.ticket), x]));
  // The connected account's row, as the server marks it (the live login's own reference, never the first account on
  // the same server: owner 2026-11-19, "harus bisa membedakan mana akun sen dan usd"). No connected account: none.
  const accounts: any[] = Array.isArray(b?.accounts) ? b.accounts : [];
  const account = accounts.find((a) => a?.connected === true) ?? null;
  // Phase 4: the trading mode for new orders, Auto (council) or pinned by the owner.
  const tm = b?.trading_mode ?? null;
  const tradingModeLabel = tm?.mode ? `${String(tm.mode).charAt(0).toUpperCase()}${String(tm.mode).slice(1)} (${tm.auto ? "auto" : "pinned"})` : "";
  // A proposal waiting for the owner, or a downgrade waiting for the council: a badge on Setup and on its Risk profile tab.
  const profileAttention = account?.pending_upgrade?.to && !(account.pending_upgrade.expires_ms && account.pending_upgrade.expires_ms <= Date.now())
    ? `The profile agent proposes ${account.pending_upgrade.to}` : account?.pending_downgrade?.to ? "A downgrade is waiting for the profile council" : "";
  const watchdog = b?.autonomous_watchdog || null;
  // Every amount is in US dollars once the account's units per dollar are known (USD, measured or the owner's value:
  // the backend converted them once); otherwise the amounts are the account's own and carry its currency (owner
  // 2026-11-19: no currency code decides).
  const inUsd = Number(account?.money?.units_per_usd) > 0;
  const cur = inUsd ? "USD" : (br.currency || hb?.currency || "USD");
  const acctCur = inUsd ? "USD" : (br.currency || "");
  const digits = typeof br.digits === "number" && br.digits >= 0 ? br.digits : 2;
  const symbolName = br.symbol || "symbol not reported";
  const serverName = br.server || conn.server || "no server";
  const positionsList: any[] = hb?.positions_detail?.length ? hb.positions_detail : br?.positions || [];
  const ordersList: any[] = br?.orders || [];
  // EZ1 (owner-approved mockup, 2026-11-23): the signal's broker − feed basis (signal.feed_basis, when the server knows
  // it) converts the broker's prices to the feed chart; Omega's resting limit and the entry zone its intent carries.
  const feedBasis = knownFeedBasis(s);
  const signalZone = signalZoneOf(s);
  const resting = restingLimit(ordersList, b?.intents || []);
  const dealsList: any[] = (Array.isArray(data?.deals) && data.deals.length > 0)
    ? data.deals
    : (Array.isArray(br?.deals) ? br.deals : []);
  const floatingPnl =
    typeof hb?.floating_pnl === "number"
      ? hb.floating_pnl
      : (typeof br?.equity === "number" && typeof br?.balance === "number")
        ? br.equity - br.balance
        : positionsList.reduce((acc, p) => acc + (typeof p.profit === "number" ? p.profit : 0), 0);
  const algoActive = Boolean(e.env_enabled && e.enabled && c.mode !== "paused" && c.mode !== "killed");

  const effectiveLabel = !e.env_enabled
    ? "off (server switch)"
    : !e.enabled
      ? "off"
      : "on";
  const effectiveTone: "fault" | "late" | "ok" = !e.env_enabled ? "fault" : !e.enabled ? "late" : "ok";

  const accountActive = Boolean(
    conn.status === "stored" && conn.server && br.terminal_connected
  );
  const configLocked = accountActive;
  // The broker as the terminal names itself (OmegaExecutor 1.19 ACCOUNT_COMPANY), once the account's spec is validated
  // (owner 2026-11-19: nothing named after a server; "broker unknown" otherwise), the account mode, and the risk that
  // applies under the profile.
  const brokerName: string = br.broker || "MT5 broker";
  const brokerLabel = account?.spec_status === "validated" ? brokerName : "broker unknown";
  // The connected account as the terminal describes it (currency, cent or not, gold symbol): never a server or an id.
  const accountLabel: string = account?.identity?.label || (br.terminal_connected ? "MT5 account" : "no account");
  const tradeTag = br.trade_mode === "real" ? "LIVE" : br.trade_mode === "demo" ? "DEMO" : br.trade_mode === "contest" ? "CONTEST" : "—";
  const capOf = (k: "risk" | "positions" | "daily") => (account && account.profile !== "custom" ? PROFILE_CAPS[account.profile]?.[k] : undefined);
  const appliedRisk = e.risk_pct != null ? appliedLimit(e.risk_pct, capOf("risk")) : null;
  const appliedPositions = e.max_positions != null ? appliedLimit(e.max_positions, capOf("positions")) : null;
  const appliedDaily = e.max_daily_loss_pct != null ? appliedLimit(e.max_daily_loss_pct, capOf("daily")) : null;
  // The Engine form (owner 2026-11-20, "Follow the active profile"): a field above what the profile applies says so, and
  // Default fills the profile's values (OMEGA_DEFAULTS without an active profile); Save still writes them.
  const formNotes = appliedNotes({ risk_pct: eRisk, max_positions: eMaxPos, max_daily_loss_pct: eLoss }, account?.profile_limits ?? null, account?.profile_label ?? null);
  const engineDefaults = engineDefaultsFor(account?.profile_limits ?? null, b?.engine_defaults ?? null);
  // A Custom profile sets no values to follow, so Default stays off there rather than filling Omega's lower defaults
  // over the owner's own numbers.
  const customProfile = !!account?.profile_limits && account.profile_limits.target_risk_pct == null && account.profile_limits.max_positions == null && account.profile_limits.daily_loss_pct == null;
  const fillEngineDefaults = () => {
    const d = engineDefaults;
    setEngineDirty(true);
    setERisk(String(d.risk_pct));
    setEMaxPos(String(d.max_positions));
    setELoss(String(d.max_daily_loss_pct));
    setESpread(String(d.max_spread_points));
    setEAge(String(d.max_signal_age_min));
    setEngineMsg({ tone: "text-cyan-200", text: `${account?.profile_label ? `${account.profile_label} defaults` : "Omega defaults"} filled; press Save to apply.` });
  };

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      {/* Top Status Banner */}
      <Panel
        title="Omega"
        icon={<Zap className="h-3.5 w-3.5 text-cyan-300" />}
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={br.terminal_connected ? "ok" : "fault"}>
              <Dot tone={br.terminal_connected ? "ok" : "fault"} pulse={br.terminal_connected} />
              {br.terminal_connected ? "MT5 connected" : "MT5 disconnected"}
            </Badge>
            <Badge tone={br.seen ? "ok" : "fault"}>
              <Dot tone={br.seen ? "ok" : "fault"} pulse={br.seen} />
              {br.seen ? "Bridge online" : "Bridge offline"}
            </Badge>
            <Badge tone={streamLive ? "ok" : "plain"}>
              <Dot tone={streamLive ? "ok" : "off"} pulse={streamLive} />
              {streamLive ? "Streaming" : "Polling"}
            </Badge>
            <Badge tone={tradeTag === "LIVE" ? "late" : "cyan"}>
              <span>{brokerLabel} · {tradeTag} · {br.symbol || "—"}</span>
            </Badge>
            {account ? (
              <Badge tone="cyan">
                <span title={`Applied now: risk ${appliedRisk ?? "—"}% per trade, ${appliedPositions ?? "—"} positions, daily loss ${appliedDaily ?? "—"}%${account.profile !== "custom" && PROFILE_CAPS[account.profile] ? `, total open risk ${PROFILE_TOTAL_OPEN[account.profile]}%` : ""}. Each is the smaller of the setting and the profile's cap.`}>
                  {account.profile_label} · {appliedRisk ?? "—"}%{tradingModeLabel ? ` · ${tradingModeLabel}` : ""}
                </span>
              </Badge>
            ) : null}
            <Badge tone={c.mode === "killed" ? "fault" : c.mode === "paused" ? "late" : "ok"}>
              control: {c.mode || "active"}
            </Badge>
            {s.kill ? <Badge tone="fault">kill ({s.kill_source || "server"})</Badge> : null}
            {s.blackout ? <Badge tone="late">event blackout</Badge> : null}
            {viewer.subject ? (
              <Badge tone="slate">
                {viewer.subject}
                {canControl ? "" : " · read only"}
              </Badge>
            ) : null}
          </div>
        }
      >
        {error ? (
          <p className="text-[12px] text-fault">Error: {error}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
            <span className="mono">Updated {updatedAt}</span>
          </div>
        )}
      </Panel>

      {/* Separated Workspace Mode Bar: MT5 Terminal vs Setup & Configuration Center */}
      <div
        id="omega-mode-bar"
        className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-cyan-500/25 bg-panel px-3.5 py-2.5 shadow-lg"
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            id="tab-terminal-mode"
            onClick={() => setViewMode("terminal")}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition ${
              viewMode === "terminal"
                ? "border-white/30 bg-white/8 text-fg"
                : "border-white/10 bg-black/30 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <Terminal className="h-3.5 w-3.5 text-fg-2" />
            Terminal
          </button>
          <button
            type="button"
            id="tab-setup-mode"
            onClick={() => setViewMode("setup")}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition ${
              viewMode === "setup"
                ? "border-white/30 bg-white/8 text-fg"
                : "border-white/10 bg-black/30 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <Sliders className="h-3.5 w-3.5 text-fg-2" />
            Setup
            {profileAttention ? <span id="setup-attention" className="rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-black" title={profileAttention}>1</span> : null}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {configLocked ? (
            <span className="mono flex items-center gap-1.5 rounded-md border border-ok-fill/40 bg-ok-fill/15 px-2.5 py-1 text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-ok-fill animate-pulse" />
              <span>Session: <strong className="text-ok">{brokerName}</strong> · locked</span>
            </span>
          ) : (
            <span className="mono rounded-md border border-white/10 bg-black/40 px-2.5 py-1 text-slate-300">
              Server: <strong className="text-cyan-300">{bServer || serverName || "—"}</strong>
            </span>
          )}
        </div>
      </div>

      {viewMode === "terminal" ? (
        <div className="flex flex-col gap-4">
        {/* =====================================================================
            WINDOWS METATRADER 5 TERMINAL — WEB EDITION WORKSTATION
           ===================================================================== */}
        <div className="overflow-hidden rounded-xl border border-cyan-500/25 bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.65)]">
        {/* Windows MT5 Application Title Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-bar px-3.5 py-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-cyan-500/15 border border-cyan-400/30 text-cyan-300">
              <Terminal className="h-3.5 w-3.5" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-bold text-slate-100">
                MT5 Terminal
              </span>
              <span className="mono rounded-sm bg-white/5 px-2 py-0.5 text-[11px] text-cyan-300 border border-white/10">
                {symbolName},{mt5Tf}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <div className="flex items-center gap-1.5 text-slate-300">
              <Dot tone={br.terminal_connected ? "ok" : "fault"} pulse={br.terminal_connected} />
              <span className="mono">
                {br.terminal_connected ? "Connected" : "Offline"} · Sync {agoMs(br.synced_age_ms)}
              </span>
            </div>
          </div>
        </div>

        {/* MT5 Standard Top Toolbar (Algo Trading, Timeframes, Overlay Toggles, Live Account Strip) */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-bar px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Algo Trading Master Direct Toggle Button */}
            <button
              type="button"
              disabled={!canControl}
              onClick={() => {
                const next = !eEnabled;
                setEEnabled(next);
                saveEngine({ enabled: next });
              }}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition disabled:opacity-40 ${
                eEnabled
                  ? "border-ok-fill/40 bg-ok-fill/15 text-ok hover:bg-ok-fill/25"
                  : "border-off-fill/35 bg-off-fill/8 text-off hover:bg-off-fill/15"
              }`}
              title="Toggle algo trading"
            >
              <span className={`h-2 w-2 rounded-full ${eEnabled ? "bg-ok-fill animate-pulse" : "bg-off-fill"}`} />
              Algo Trading: {eEnabled ? "ON" : "OFF"}
            </button>

            {/* MT5 Terminal VPS Execution Health Pill */}
            <button
              type="button"
              onClick={() => setToolboxTab("state_machine")}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition ${
                !br.terminal_connected
                  ? "border-fault-fill/40 bg-fault-fill/15 text-fault hover:bg-fault-fill/25"
                  : !br.trade_allowed
                  ? "border-amber-500/50 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 animate-pulse"
                  : "border-ok-fill/40 bg-ok-fill/15 text-ok hover:bg-ok-fill/25"
              }`}
              title={
                !br.terminal_connected
                  ? "Terminal disconnected; watchdog is recovering"
                  : !br.trade_allowed
                  ? "Algo trading disabled on the terminal; watchdog is correcting"
                  : "Terminal live; algo trading allowed"
              }
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  !br.terminal_connected
                    ? "bg-fault-fill"
                    : !br.trade_allowed
                    ? "bg-amber-400 animate-pulse"
                    : "bg-ok-fill animate-pulse"
                }`}
              />
              {!br.terminal_connected
                ? "Terminal: Offline"
                : !br.trade_allowed
                ? "Terminal: Algo blocked"
                : "Terminal: Live"}
            </button>

            <div className="h-4 w-px bg-white/10" />

            {/* Timeframe Selector */}
            <div className="flex items-center gap-1 rounded-md border border-white/10 bg-black/40 p-0.5">
              {MT5_TFS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setMt5Tf(t.key)}
                  className={`mono rounded px-2 py-0.5 text-[11px] font-semibold transition ${
                    mt5Tf === t.key
                      ? "bg-cyan-500/25 text-cyan-200 border border-cyan-400/40"
                      : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="h-4 w-px bg-white/10" />

            {/* Chart Layer Toggles */}
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setShowBidAsk((v) => !v)}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  showBidAsk
                    ? "border-ok-fill/35 bg-ok-fill/10 text-ok"
                    : "border-white/10 bg-black/30 text-slate-400"
                }`}
              >
                Bid/Ask
              </button>
              <button
                type="button"
                onClick={() => setShowPlan((v) => !v)}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  showPlan
                    ? "border-cyan-400/35 bg-cyan-500/10 text-cyan-200"
                    : "border-white/10 bg-black/30 text-slate-400"
                }`}
              >
                Plan
              </button>
              <button
                type="button"
                onClick={() => setShowPositions((v) => !v)}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  showPositions
                    ? "border-amber-400/35 bg-amber-500/10 text-amber-200"
                    : "border-white/10 bg-black/30 text-slate-400"
                }`}
              >
                Positions ({positionsList.length})
              </button>
              <button
                type="button"
                onClick={() => setShowKeyLevels((v) => !v)}
                // The legend lives here, not over the chart's volume (owner 2026-11-12: "hilangkan label yang menutupi volume").
                title="Six nearest key-level zones: green support, red resistance, cyan at price; on feed prices (OANDA); broker prices may differ"
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  showKeyLevels
                    ? "border-violet-400/35 bg-violet-500/10 text-violet-200"
                    : "border-white/10 bg-black/30 text-slate-400"
                }`}
              >
                Key Levels ({keyZones.length})
              </button>
              <button
                type="button"
                onClick={() => setToolboxTab("state_machine")}
                className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-semibold transition ${
                  toolboxTab === "state_machine"
                    ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-200"
                    : "border-white/10 bg-black/30 text-slate-300 hover:border-cyan-400/30 hover:text-cyan-200"
                }`}
                title="Watchdog"
              >
                <Cpu className="h-3 w-3 text-cyan-400" />
                Watchdog
              </button>
              <button
                type="button"
                onClick={() => setToolboxTab("tca_sor")}
                className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-semibold transition ${
                  toolboxTab === "tca_sor"
                    ? "border-ok-fill/50 bg-ok-fill/20 text-ok"
                    : "border-white/10 bg-black/30 text-slate-300 hover:border-ok-fill/30 hover:text-ok"
                }`}
                title="Execution quality"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-ok-fill" />
                Execution: {b?.tca?.quality || "—"}
              </button>
            </div>
          </div>

          {/* Right Quick Account Readout */}
          <div className="mono flex flex-wrap items-center gap-3 text-[11.5px]">
            <div>
              <span className="text-slate-500">Balance: </span>
              <span className="font-bold text-slate-100">{balFmt(br.balance, cur)}</span>
            </div>
            <div>
              <span className="text-slate-500">Equity: </span>
              <span className="font-bold text-cyan-300">{balFmt(br.equity, cur)}</span>
            </div>
            <div>
              <span className="text-slate-500">Floating: </span>
              <span className={`font-bold ${toneCls(floatingPnl)}`}>{money(floatingPnl, cur)}</span>
            </div>
          </div>
        </div>

        {/* Autonomous Cerebrum Watchdog Self-Healing Banner */}
        {conn.status === "stored" && (!br.terminal_connected || !br.trade_allowed) ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                {!br.terminal_connected
                  ? "Terminal disconnected. Watchdog is reconnecting."
                  : "Algo trading disabled on the terminal. Watchdog is correcting it."}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setToolboxTab("state_machine")}
              className="flex items-center gap-1.5 rounded-md border border-cyan-400/40 bg-cyan-500/20 px-2.5 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/30 transition"
            >
              <Activity className="h-3 w-3" />
              Details
            </button>
          </div>
        ) : null}

        {/* MT5 Main Split Workspace: Left Dock (Market Watch + Navigator) & Center Chart */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr]">
          {/* Left Dock: Market Watch + Contract Spec + Navigator */}
          <button type="button" onClick={() => setDockOpen((v) => !v)} aria-expanded={dockOpen} id="omega-dock-toggle"
            className="flex items-center justify-between border-b border-white/10 bg-bar px-3 py-1.5 lg:hidden text-[11px] font-semibold text-fg-2">
            <span>Market Watch · {symbolName}</span><span>{dockOpen ? "▴" : "▾"}</span>
          </button>
          <div className={`${dockOpen ? "flex" : "hidden"} flex-col border-b border-white/10 bg-panel lg:flex lg:border-b-0 lg:border-r`}>
            {/* Market Watch Header */}
            <div className="flex items-center justify-between border-b border-white/10 bg-bar px-3 py-1.5 text-[11px] font-semibold text-fg-2">
              <span className="flex items-center gap-1.5">
                <CandlestickChart className="h-3.5 w-3.5 text-cyan-300" />
                Market Watch · {symbolName}
              </span>
              <span className="mono flex items-center gap-1 text-[10px] text-slate-400">
                {tickDir === "up" ? <span className="text-bull">▲</span> : tickDir === "down" ? <span className="text-bear">▼</span> : null}
                {br.spread_points != null ? `${br.spread_points} pts` : "—"}
              </span>
            </div>

            {/* MT5 One-Click Trading Style Dual Bid / Ask Box */}
            <div className="grid grid-cols-2 gap-2 p-2.5 border-b border-white/10 bg-black/25">
              <div className="rounded-lg border border-bear-fill/30 bg-linear-to-b from-bear-fill/15 to-bear-fill/5 px-2.5 py-2 text-center">
                <div className="text-[11px] font-medium text-bear">BID (SELL)</div>
                <div className="mono mt-0.5 text-lg font-extrabold text-bear">{num(br.bid, digits)}</div>
              </div>
              <div className="rounded-lg border border-bull-fill/30 bg-linear-to-b from-bull-fill/15 to-bull-fill/5 px-2.5 py-2 text-center">
                <div className="text-[11px] font-medium text-bull">ASK (BUY)</div>
                <div className="mono mt-0.5 text-lg font-extrabold text-bull">{num(br.ask, digits)}</div>
              </div>
            </div>

            {/* Market Watch Symbol Table */}
            <div className="border-b border-white/10 px-2.5 py-2">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="border-b border-white/10 text-[11px] font-medium text-muted">
                    <th className="pb-1">Symbol</th>
                    <th className="pb-1 text-right">Bid</th>
                    <th className="pb-1 text-right">Ask</th>
                    <th className="pb-1 text-right"> {!s.market_price ? "Pts" : "Spread"}</th>
                  </tr>
                </thead>
                <tbody className="mono divide-y divide-white/5">
                  <tr className="bg-cyan-500/5">
                    <td className="py-1.5 font-bold text-cyan-300">{symbolName}</td>
                    <td className="py-1.5 text-right text-bull">{num(br.bid, digits)}</td>
                    <td className="py-1.5 text-right text-bear">{num(br.ask, digits)}</td>
                    <td className="py-1.5 text-right text-amber-200">{br.spread_points ?? "—"}</td>
                  </tr>
                  {s.market_price ? (
                    <tr>
                      <td className="py-1 text-slate-400">XAUUSD feed</td>
                      <td className="py-1 text-right text-slate-300" colSpan={2}>
                        {num(s.market_price, 2)}
                      </td>
                      <td className="py-1 text-right text-slate-500">—</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {/* Symbol Contract Specification */}
            <div className="border-b border-white/10 px-3 py-2">
              <div className="mb-1.5 text-[11px] font-medium text-muted">
                Specification
              </div>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
                <dt className="text-slate-500">Digits / point</dt>
                <dd className="mono text-right text-slate-300">
                  {br.digits ?? "—"} / {br.point ?? "—"}
                </dd>
                <dt className="text-slate-500">Tick size / val</dt>
                <dd className="mono text-right text-slate-300">
                  {br.tick_size ?? "—"} / {br.tick_value != null ? num(br.tick_value, 2) : "—"}
                </dd>
                <dt className="text-slate-500">Volume min / max</dt>
                <dd className="mono text-right text-slate-300">
                  {br.volume_min ?? "—"} / {br.volume_max ?? "—"}
                </dd>
                <dt className="text-slate-500">Volume step</dt>
                <dd className="mono text-right text-slate-300">{br.volume_step ?? "—"}</dd>
                <dt className="text-slate-500">Stops level</dt>
                <dd className="mono text-right text-slate-300">
                  {br.stops_level_points != null ? `${br.stops_level_points} pts` : "—"}
                </dd>
                <dt className="text-slate-500">Profit ccy / contract</dt>
                <dd className="mono text-right text-slate-300">
                  {br.symbol_check?.currency_profit ?? "—"} / {br.symbol_check?.contract_size != null ? `${br.symbol_check.contract_size} oz` : "—"}
                </dd>
                <dt className="text-slate-500">Chart symbol</dt>
                <dd className="mono text-right text-slate-300">
                  {br.symbol_check?.chart_symbol ?? "—"}
                  {br.symbol_check?.resolution?.status ? ` (${br.symbol_check.resolution.status})` : ""}
                </dd>
              </dl>
              {/* USD gold only (PR #405): a refused symbol opens nothing and is never silent. */}
              {br.symbol_check ? (
                <p
                  className={`mt-1.5 text-[11px] ${br.symbol_check.ok ? "text-ok" : "text-fault"}`}
                  aria-label="Trade symbol check"
                >
                  {br.symbol_check.ok ? `Symbol verified: ${br.symbol_check.text}` : br.symbol_check.text}
                </p>
              ) : null}
              {/* Account Profiles phase 1 (docs/RFC_ACCOUNT_PROFILES.md): the broker spec gate and the stored profile. */}
              <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]" aria-label="Account spec">
                <dt className="text-slate-500">Leverage / margin</dt>
                <dd className="mono text-right text-slate-300">
                  {br.leverage == null
                    ? "—"
                    : Number(br.leverage) >= LEVERAGE_UNLIMITED_FROM
                      ? <span title={`The broker reports 1:${Number(br.leverage).toLocaleString("en-US")}: unlimited or unknown leverage. Sizing never uses leverage; the margin is the broker's OrderCheck answer.`}>unlimited</span>
                      : `1:${Number(br.leverage).toLocaleString("en-US")}`} / {br.margin_mode ?? "—"}
                </dd>
                <dt className="text-slate-500">Margin / lot</dt>
                <dd className="mono text-right text-slate-300">{br.margin_per_lot != null ? num(br.margin_per_lot, 2) : "—"}</dd>
                <dt className="text-slate-500">Freeze / trade mode</dt>
                <dd className="mono text-right text-slate-300">
                  {br.freeze_level_points != null ? `${br.freeze_level_points} pts` : "—"} / {br.symbol_trade_mode ?? "—"}
                </dd>
              </dl>
              {/* Spec and EA gate as two badges; the detail is in the tooltip (owner 2026-11-18: no prose here). */}
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px]">
                {account ? (
                  <span aria-label="Broker spec check" title={account.spec_text}
                    className={`rounded-sm border px-1.5 py-0.5 ${account.spec_status === "validated" ? "border-ok-fill/30 text-ok" : "border-amber-400/30 text-amber-300"}`}>
                    spec {account.spec_status === "validated" ? "✓" : account.spec_status}
                  </span>
                ) : null}
                {br.ea_version_gate ? (
                  <span aria-label="EA version gate" title={`EA version gate ${br.ea_version_gate.on ? "on" : "off"}: new entries need OmegaExecutor ${br.ea_version_gate.min_version} or later.`}
                    className={`rounded-sm border px-1.5 py-0.5 ${br.ea_version_gate.met ? "border-ok-fill/30 text-ok" : "border-fault-fill/30 text-fault"}`}>
                    EA {br.executor?.version ?? "?"} {br.ea_version_gate.met ? "✓" : `< ${br.ea_version_gate.min_version}`}
                  </span>
                ) : null}
              </div>
            </div>

            {/* MT5 Navigator Tree (Ctrl+N) */}
            <div className="flex items-center justify-between border-b border-white/10 bg-bar px-3 py-1.5 text-[11px] font-semibold text-fg-2">
              <span className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-cyan-300" />
                Navigator
              </span>
            </div>
            <div className="flex-1 space-y-2 px-3 py-2.5 text-[11.5px]">
              <div>
                <div className="text-[11px] font-medium text-muted">Accounts</div>
                <div className="mt-1 flex items-center justify-between rounded-sm bg-white/3 px-2 py-1 border border-white/5">
                  <span className="mono text-slate-200 truncate">{accountLabel}</span>
                  <Badge tone={br.terminal_connected ? "ok" : "fault"}>
                    {br.trade_mode || "unknown"}
                  </Badge>
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium text-muted">Expert Advisors</div>
                <div className="mt-1 space-y-1">
                  <div className="flex items-center justify-between rounded-sm bg-cyan-500/[0.07] px-2 py-1 border border-cyan-400/20">
                    <span className="mono flex items-center gap-1.5 text-cyan-200">
                      <Bot className="h-3 w-3 text-cyan-300" />
                      OmegaExecutor
                    </span>
                    <span className="mono text-[10px] text-ok">
                      {br.terminal_connected ? `${symbolName}, M1` : "standby"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-sm bg-white/2 px-2 py-1 border border-white/5">
                    <span className="mono text-slate-300">CryptophysXAUUSD</span>
                    <span className="mono text-[10px] text-slate-400">
                      {ea.connected ? (hb?.version ? `v${hb.version}` : "—") : "direct EA"}
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[11px] font-medium text-muted">Decision Engine</div>
                <div className="mt-1 flex items-center justify-between rounded-sm bg-white/3 px-2 py-1 border border-white/5">
                  <span className="text-slate-300">Signal</span>
                  <span
                    className={`mono font-bold ${
                      s.side === "BUY" ? "text-bull" : s.side === "SELL" ? "text-bear" : "text-slate-400"
                    }`}
                  >
                    {!s.side || s.side === "NONE" ? "WAIT" : `${s.side} (${num(s.entry, 2)} feed)`}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Center / Right MT5 Interactive Candlestick Chart: stretches to the row's height (the sidebar's) */}
          <div className="flex min-h-[430px] flex-col">
            <Mt5ChartCanvas
              tf={mt5Tf}
              symbol={symbolName}
              server={serverName}
              digits={digits}
              bid={br.bid}
              ask={br.ask}
              signal={s}
              positions={positionsList}
              showBidAsk={showBidAsk}
              showPlan={showPlan}
              showPositions={showPositions}
              keyZones={keyZones}
              showKeyLevels={showKeyLevels}
              feedBasis={feedBasis}
              limit={resting}
            />
          </div>
        </div>

        {/* =================================================================
            MT5 BOTTOM DOCK — TOOLBOX (Ctrl+T): Trade | History | Intents | Experts | Journal
           ================================================================= */}
        <div className="border-t border-white/10 bg-panel">
          {/* Toolbox Tab Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-bar px-3 py-1.5">
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  ["trade", `Trade (${positionsList.length}${ordersList.length ? ` + ${ordersList.length} ord` : ""})`],
                  ["history", `History (${dealsList.length})`],
                  ["intents", `Intents (${(b?.intents || []).length})`],
                  ["state_machine", "Watchdog"],
                  ["tca_sor", "Execution"],
                  ["events", `Journal (${(b?.events || []).length + (data?.control_events || []).length})`],
                ] as [ToolboxTab, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setToolboxTab(key)}
                  className={`rounded px-2.5 py-1 text-[11.5px] font-semibold transition ${
                    toolboxTab === key
                      ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/35"
                      : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Tab 1: TRADE (Open Positions + Classic MT5 Account Summary Row) */}
          {toolboxTab === "trade" ? (
            <div>
              {/* Delegate (owner 2026-11-19): manual positions handed to Omega, one by one or every new one. */}
              <div className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-bar px-3.5 py-1.5 text-[11px]">
                <label className="inline-flex items-center gap-2 text-slate-300" title="Every manual position opened while this is on is handed to Omega: a stop from the plan when it has none, break-even, the TP ladder, the Position Manager and the closes on an opposite signal. Omega never adds to it or reverses it.">
                  <input type="checkbox" className="accent-cyan-400" disabled={hitlBusy || !delegation?.supported} checked={delegation?.mode?.on === true} onChange={(e) => delegateMode(e.target.checked)} />
                  Delegate my next manual entries to Omega
                </label>
                {delegation?.mode?.on && delegation?.mode?.since_ms ? <span className="text-slate-500">on since {timeUtc(delegation.mode.since_ms)}</span> : null}
                {delegation && delegation.supported === false ? <span className="text-amber-300">Modify and Delegate need OmegaExecutor {delegation.ea_min_version ?? "1.18"} on the terminal.</span> : null}
                {hitlMsg ? <span className={hitlMsg.tone}>{hitlMsg.text}</span> : null}
              </div>
              <div className="table-wrap max-h-[240px] overflow-y-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Ticket</th>
                      <th>Source</th>
                      <th>Time (UTC)</th>
                      <th>Type</th>
                      <th>Volume</th>
                      <th>Price</th>
                      <th>S/L</th>
                      <th>T/P</th>
                      <th>Current</th>
                      <th>Profit ({cur})</th>
                      <th title="Loss at the stop in money and % of equity; once the stop is at or beyond the entry, the profit it locks">Risk @ SL</th>
                      <th>Intent</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positionsList.length === 0 ? (
                      <tr>
                        <td colSpan={14} className="py-4 text-center text-[12px] text-slate-500">
                          No open positions.
                        </td>
                      </tr>
                    ) : (
                      positionsList.map((p: any) => {
                        const isBuy = p.side === "BUY";
                        const curPrice = isBuy ? br.bid : br.ask;
                        const isManual = p.source === "manual" || p.magic === 0;
                        const isOmega = p.source === "omega" || p.magic === 920200 || String(p.intent_id || "").startsWith("open:");
                        const isDelegated = isManual && (delegation?.tickets ?? []).map(Number).includes(Number(p.ticket));
                        const loosenedOnce = (pmLoosen?.loosened ?? []).map(Number).includes(Number(p.ticket));
                        const editing = editRow?.target === "position" && editRow.ticket === Number(p.ticket);
                        return (
                          <Fragment key={p.ticket}>
                          <tr>
                            <td className="mono font-bold text-cyan-300">{p.symbol || symbolName}</td>
                            <td className="mono">#{String(p.ticket)}</td>
                            <td>
                              {isDelegated ? (
                                <span className="inline-flex items-center gap-1 rounded-sm bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-200 border border-cyan-400/40" title="A manual position you delegated: Omega manages it like its own.">
                                  MANUAL → OMEGA
                                </span>
                              ) : isManual ? (
                                <span className="inline-flex items-center gap-1 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                                  MANUAL
                                </span>
                              ) : isOmega ? (
                                <span className="inline-flex items-center gap-1 rounded-sm bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/30">
                                  OMEGA
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-sm bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-purple-300 border border-purple-400/30">
                                  EXTERNAL
                                </span>
                              )}
                              {loosenedOnce ? (
                                <span className="ml-1 inline-flex items-center gap-1 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200 border border-amber-400/40" title="The Position Council loosened this position's stop once (ADR-0020 Amendment 8). It counts as unprotected again and is never loosened a second time.">
                                  LOOSENED ONCE
                                </span>
                              ) : null}
                            </td>
                            <td className="mono">{timeUtc(p.opened_ms)}</td>
                            <td className={`mono font-bold ${isBuy ? "text-bull" : "text-bear"}`}>{p.side}</td>
                            <td className="mono">
                              {num(p.volume, 2)}
                              {/* The exposure in USD (owner 2026-11-18): a lot alone is ambiguous across brokers and cent accounts. */}
                              {p.exposure?.usd_per_dollar != null ? (
                                <div className="text-[10px] font-normal text-slate-400" title="What a $1 move in gold does to this position, and its loss at the stop">
                                  ≈ ${num(p.exposure.usd_per_dollar, 2)}/$1
                                  {p.exposure.risk_at_sl_usd != null ? ` · SL −$${num(p.exposure.risk_at_sl_usd, 2)}${p.exposure.risk_at_sl_pct != null ? ` (${p.exposure.risk_at_sl_pct}%)` : ""}` : ""}
                                </div>
                              ) : null}
                            </td>
                            <td className="mono">{num(p.entry ?? p.open_price, digits)}</td>
                            <td className={`mono ${p.sl ? "text-bear" : "text-muted"}`}>{p.sl ? num(p.sl, digits) : "—"}</td>
                            <td className={`mono ${p.tp ? "text-bull" : "text-muted"}`}>{p.tp ? num(p.tp, digits) : "—"}</td>
                            <td className="mono text-slate-200">{num(curPrice, digits)}</td>
                            <td className={`mono font-bold ${toneCls(p.profit)}`}>{money(p.profit, cur)}</td>
                            {(() => {
                              const r = riskToSl(p, br);
                              if (!r) return <td className="mono text-slate-500">—</td>;
                              return r.locked
                                ? <td className="mono text-bull">locked +{money(r.amount, cur).replace(/^\+/, "")}</td>
                                : <td className="mono text-bear">SL −{money(r.amount, cur).replace(/^[-+]/, "")} · {r.pct}%</td>;
                            })()}
                            <td className="mono text-[11px] text-slate-400">{p.signal_id || p.intent_id || (isManual ? "Manual" : "—")}</td>
                            <td className="text-right whitespace-nowrap">
                              <button
                                type="button"
                                disabled={hitlBusy || !delegation?.supported}
                                onClick={() => setEditRow(editing ? null : { target: "position", ticket: Number(p.ticket), sl: p.sl ? String(p.sl) : "", tp: p.tp ? String(p.tp) : "", price: "" })}
                                className="mr-1 inline-flex items-center rounded-sm bg-cyan-500/15 px-2 py-1 text-[11px] font-bold text-cyan-200 border border-cyan-400/40 hover:bg-cyan-500/25 disabled:opacity-40"
                                title={delegation?.supported ? "Change this position's stop and target" : "Needs OmegaExecutor 1.18"}
                              >
                                {editing ? "CANCEL" : "MODIFY"}
                              </button>
                              {isManual ? (
                                <button
                                  type="button"
                                  disabled={hitlBusy || (!isDelegated && !delegation?.supported)}
                                  onClick={() => delegate(Number(p.ticket), !isDelegated)}
                                  className="mr-1 inline-flex items-center rounded-sm bg-violet-500/15 px-2 py-1 text-[11px] font-bold text-violet-200 border border-violet-400/40 hover:bg-violet-500/25 disabled:opacity-40"
                                  title={isDelegated ? "Take this position back: Omega stops managing it" : "Hand this manual position to Omega: it manages it like its own (never adds to it or reverses it)"}
                                >
                                  {isDelegated ? "TAKE BACK" : "DELEGATE"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                disabled={closingTicket === p.ticket}
                                onClick={() =>
                                  requestExitPosition({
                                    ticket: p.ticket,
                                    symbol: p.symbol || symbolName,
                                    side: p.side,
                                    volume: p.volume,
                                    open_price: p.entry ?? p.open_price,
                                    profit: p.profit,
                                    sl: p.sl,
                                    tp: p.tp,
                                    currency: cur,
                                  })
                                }
                                className="inline-flex items-center gap-1 rounded-sm bg-fault-fill/20 px-2.5 py-1 text-[11px] font-bold text-fault border border-fault-fill/40 hover:bg-fault-fill/30 hover:border-fault-fill active:scale-95 transition disabled:opacity-50"
                                title="Close at market"
                              >
                                {closingTicket === p.ticket ? (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="inline-block h-2 w-2 rounded-full bg-fault-fill animate-ping" />
                                    CLOSING…
                                  </span>
                                ) : (
                                  "CLOSE"
                                )}
                              </button>
                            </td>
                          </tr>
                          {editing ? (
                            <tr>
                              <td colSpan={14} className="bg-cyan-500/5">
                                <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-[11px]">
                                  <span className="text-slate-400">Modify #{String(p.ticket)} {p.side}:</span>
                                  <label className="text-bear">S/L <input inputMode="decimal" className="mono ml-1 w-24 rounded-sm border border-white/15 bg-black/40 px-1.5 py-0.5 text-slate-100" value={editRow!.sl} onChange={(e) => setEditRow({ ...editRow!, sl: e.target.value })} placeholder="none" /></label>
                                  <label className="text-bull">T/P <input inputMode="decimal" className="mono ml-1 w-24 rounded-sm border border-white/15 bg-black/40 px-1.5 py-0.5 text-slate-100" value={editRow!.tp} onChange={(e) => setEditRow({ ...editRow!, tp: e.target.value })} placeholder="none" /></label>
                                  <button type="button" disabled={hitlBusy} onClick={saveModify} className="rounded-sm bg-cyan-500/25 px-2.5 py-1 font-bold text-cyan-100 border border-cyan-400/50 hover:bg-cyan-500/35 disabled:opacity-40">SEND</button>
                                  <span className="text-slate-500">Empty removes a level. {isOmega || isDelegated ? "Omega keeps managing it and may move the stop again." : ""}</span>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                          </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {ordersList.length > 0 && (
                <div className="border-t border-white/10 bg-ground">
                  <div className="border-b border-white/5 bg-bar px-3.5 py-1 text-[11px] font-semibold text-slate-400">
                    Pending Orders ({ordersList.length})
                  </div>
                  <div className="table-wrap max-h-[160px] overflow-y-auto">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Ticket</th>
                          <th>Source</th>
                          <th>Placed (UTC)</th>
                          <th>Type</th>
                          <th>Volume</th>
                          <th>Price</th>
                          <th>S/L</th>
                          <th>T/P</th>
                          <th>Comment</th>
                          <th>Status</th>
                          <th>Expires (UTC)</th>
                          <th className="text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ordersList.map((o: any) => {
                          const isManualOrd = o.source === "manual" || o.magic === 0;
                          const editingOrd = editRow?.target === "order" && editRow.ticket === Number(o.ticket);
                          const modifiable = ["BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"].includes(o.type);
                          return (
                            <Fragment key={o.ticket}>
                            <tr>
                              <td className="mono font-bold text-cyan-300">{o.symbol || symbolName}</td>
                              <td className="mono">#{String(o.ticket)}</td>
                              <td>
                                {isManualOrd ? (
                                  <span className="inline-flex items-center gap-1 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                                    MANUAL
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded-sm bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/30">
                                    OMEGA
                                  </span>
                                )}
                              </td>
                              <td className="mono">{timeUtc(o.placed_ms)}</td>
                              <td className="mono font-semibold text-amber-200">{o.type}</td>
                              <td className="mono">{num(o.volume_current ?? o.volume_initial, 2)}</td>
                              <td className="mono text-slate-200">{num(o.price_open, digits)}</td>
                              <td className={`mono ${o.sl ? "text-bear" : "text-muted"}`}>{o.sl ? num(o.sl, digits) : "—"}</td>
                              <td className={`mono ${o.tp ? "text-bull" : "text-muted"}`}>{o.tp ? num(o.tp, digits) : "—"}</td>
                              <td className="mono text-[11px] text-slate-400">{o.comment || "—"}</td>
                              <td className="mono text-[11px] text-slate-300" title={limitByTicket[String(o.ticket)]?.reason || undefined}>
                                {limitByTicket[String(o.ticket)]?.status || (isManualOrd ? "—" : "resting")}
                                {limitByTicket[String(o.ticket)]?.reason ? <span className="block max-w-[220px] truncate text-slate-500">{limitByTicket[String(o.ticket)].reason}</span> : null}
                              </td>
                              <td className="mono text-[11px]">{limitByTicket[String(o.ticket)]?.expiry_ms ? timeUtc(limitByTicket[String(o.ticket)].expiry_ms) : "—"}</td>
                              <td className="text-right">
                                <button
                                  type="button"
                                  disabled={hitlBusy || !modifiable || !delegation?.supported}
                                  onClick={() => setEditRow(editingOrd ? null : { target: "order", ticket: Number(o.ticket), price: o.price_open ? String(o.price_open) : "", sl: o.sl ? String(o.sl) : "", tp: o.tp ? String(o.tp) : "" })}
                                  className="inline-flex items-center rounded-sm bg-cyan-500/15 px-2 py-1 text-[11px] font-bold text-cyan-200 border border-cyan-400/40 hover:bg-cyan-500/25 disabled:opacity-40"
                                  title={!modifiable ? "Only limit and stop orders" : delegation?.supported ? "Change this order's price, stop and target" : "Needs OmegaExecutor 1.18"}
                                >
                                  {editingOrd ? "CANCEL" : "MODIFY"}
                                </button>
                              </td>
                            </tr>
                            {editingOrd ? (
                              <tr>
                                <td colSpan={13} className="bg-cyan-500/5">
                                  <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-[11px]">
                                    <span className="text-slate-400">Modify order #{String(o.ticket)} {o.type}:</span>
                                    <label className="text-slate-200">Price <input inputMode="decimal" className="mono ml-1 w-24 rounded-sm border border-white/15 bg-black/40 px-1.5 py-0.5 text-slate-100" value={editRow!.price} onChange={(e) => setEditRow({ ...editRow!, price: e.target.value })} /></label>
                                    <label className="text-bear">S/L <input inputMode="decimal" className="mono ml-1 w-24 rounded-sm border border-white/15 bg-black/40 px-1.5 py-0.5 text-slate-100" value={editRow!.sl} onChange={(e) => setEditRow({ ...editRow!, sl: e.target.value })} placeholder="none" /></label>
                                    <label className="text-bull">T/P <input inputMode="decimal" className="mono ml-1 w-24 rounded-sm border border-white/15 bg-black/40 px-1.5 py-0.5 text-slate-100" value={editRow!.tp} onChange={(e) => setEditRow({ ...editRow!, tp: e.target.value })} placeholder="none" /></label>
                                    <button type="button" disabled={hitlBusy} onClick={saveModify} className="rounded-sm bg-cyan-500/25 px-2.5 py-1 font-bold text-cyan-100 border border-cyan-400/50 hover:bg-cyan-500/35 disabled:opacity-40">SEND</button>
                                    <span className="text-slate-500">{isManualOrd ? "Your order." : "Omega's order."} Empty S/L or T/P removes it.</span>
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {entryOrder.mode && entryOrder.mode !== "market" && entryOrder.recent?.length ? (
                <div className="border-t border-white/10 bg-ground px-3.5 py-1.5 text-[11px] text-slate-400" aria-label="Omega limit events">
                  <span className="font-semibold text-slate-300">Limit ({entryOrder.mode}):</span>{" "}
                  {entryOrder.recent.slice(0, 4).map((x: any, i: number) => (
                    <span key={`${x.ms}-${i}`} className="mono mr-3">{timeUtc(x.ms).slice(11)} {x.action}{x.ticket ? ` #${x.ticket}` : ""}{x.reason ? ` · ${x.reason}` : ""}{x.gap_r != null ? ` · gap ${x.gap_r}R` : ""}</span>
                  ))}
                </div>
              ) : null}

              {/* Classic Windows MT5 Gray/Obsidian Account Summary Footer Row */}
              <div className="mono flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-bar px-3.5 py-2 text-[11.5px]">
                <div className="flex flex-wrap items-center gap-4">
                  <span>
                    <strong className="text-slate-400">Balance:</strong>{" "}
                    <span className="font-bold text-slate-100">{balFmt(br.balance, cur)}</span>
                  </span>
                  <span>
                    <strong className="text-slate-400">Equity:</strong>{" "}
                    <span className="font-bold text-cyan-300">{balFmt(br.equity, cur)}</span>
                  </span>
                  <span>
                    <strong className="text-slate-400">Floating P/L:</strong>{" "}
                    <span className={`font-bold ${toneCls(floatingPnl)}`}>{money(floatingPnl, cur)}</span>
                  </span>
                  <span>
                    <strong className="text-slate-400">Day P/L:</strong>{" "}
                    <span className={`font-bold ${toneCls(br.day_realized_pl)}`}>{money(br.day_realized_pl, cur)}</span>
                  </span>
                  <span>
                    <strong className="text-slate-400">Day start:</strong>{" "}
                    <span className="text-slate-300">{balFmt(br.day_start_balance, cur)}</span>
                  </span>
                </div>
                <div className="text-slate-400">
                  {/* What applies, not the raw setting: the smaller of the setting and the profile's cap. */}
                  Risk/Trade: <span className="text-slate-200" title="Applied: the smaller of the setting and the profile's cap">{appliedRisk != null ? `${appliedRisk}%` : "—"}</span> · Max Pos:{" "}
                  <span className="text-slate-200">{appliedPositions ?? "—"}</span>
                </div>
              </div>
            </div>
          ) : null}

          {/* Tab 2: HISTORY (Closed Deals) */}
          {toolboxTab === "history" ? (
            <div className="table-wrap max-h-[260px] overflow-y-auto">
              {!dealsList.length ? (
                <div className="p-4">
                  <Empty>No closed deals.</Empty>
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Closed (UTC)</th>
                      <th>Deal</th>
                      <th>Source</th>
                      <th>Side</th>
                      <th>Volume</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>Net P/L</th>
                      <th>Reason</th>
                      <th>Mode</th>
                      <th>Signal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dealsList.map((d: any, idx: number) => {
                      const net = (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0);
                      const isManual = d.source === "manual" || d.magic === 0;
                      const isOmega = d.source === "omega" || d.magic === 920200 || String(d.signal_id || "").startsWith("open:");
                      return (
                        <tr key={d.deal_ticket ?? idx}>
                          <td className="mono">{timeUtc(d.closed_ms)}</td>
                          <td className="mono font-semibold">#{d.deal_ticket ?? "—"}</td>
                          <td>
                            {isManual ? (
                              <span className="inline-flex items-center gap-1 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                                MANUAL
                              </span>
                            ) : isOmega ? (
                              <span className="inline-flex items-center gap-1 rounded-sm bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/30">
                                OMEGA
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-sm bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-purple-300 border border-purple-400/30">
                                EXTERNAL
                              </span>
                            )}
                          </td>
                          <td className={`mono font-bold ${d.side === "BUY" ? "text-bull" : "text-bear"}`}>{d.side}</td>
                          <td className="mono">{num(d.volume, 2)}</td>
                          <td className="mono">{num(d.entry_price, digits)}</td>
                          <td className="mono">{num(d.exit_price, digits)}</td>
                          <td className={`mono font-bold ${toneCls(net)}`}>{money(net, d.currency || cur)}</td>
                          <td className="mono">
                            <span className="rounded-sm bg-white/5 px-1.5 py-0.5 text-[10.5px]">
                              {d.reason || "closed"}
                            </span>
                          </td>
                          <td className="mono text-slate-400">{d.mode || "live"}</td>
                          <td className="mono text-[11px] text-slate-400">{d.signal_id || (isManual ? "Manual" : "—")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}

          {/* Tab 3: ORDER INTENTS (Engine -> Bridge Queue) */}
          {toolboxTab === "intents" ? (
            <div className="table-wrap max-h-[260px] overflow-y-auto">
              {!(b?.intents || []).length ? (
                <div className="p-4">
                  <Empty>No intents yet.</Empty>
                </div>
              ) : (
                <>
                {/* EZ1 (the approved mockup): on a phone one card per intent; from sm up the table. Every price is the broker's. */}
                <IntentCards intents={b.intents || []} digits={digits} />
                <table className="tbl hidden sm:table">
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Intent</th>
                      <th>Kind</th>
                      <th>Side</th>
                      <th>Volume</th>
                      <th>Entry · broker</th>
                      <th>SL · broker</th>
                      <th>TP · broker</th>
                      <th>Status</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(b.intents || []).map((i: any) => (
                      <tr key={i.id}>
                        <td className="mono"><CreatedCell ms={i.created_ms} /></td>
                        <td className="mono">{i.id}</td>
                        <td className="mono">{i.kind}</td>
                        <td className={`mono font-bold ${i.side === "BUY" ? "text-bull" : i.side === "SELL" ? "text-bear" : ""}`}>
                          {i.side || "—"}
                        </td>
                        <td className="mono">{typeof i.lot === "number" ? num(i.lot, 2) : i.volume != null ? num(i.volume, 2) : "—"}</td>
                        <td className="mono"><IntentEntry i={i} digits={digits} /></td>
                        <td className="mono">{i.sl != null ? num(i.sl, digits) : "—"}</td>
                        <td className="mono">{i.tp != null ? num(i.tp, digits) : "—"}</td>
                        <td>
                          <Badge tone={INTENT_TONE[i.status] || "slate"}>{i.status}</Badge>
                        </td>
                        <td className="mono text-[11px]">
                          {i.result ? (i.result.ok ? `ticket ${i.result.ticket ?? "?"}` : i.result.error || "failed") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </>
              )}
            </div>
          ) : null}

          {/* Tab 4: AUTONOMOUS STATE MACHINE & SELF-HEALING WATCHDOG */}
          {toolboxTab === "state_machine" ? (
            <div className="space-y-4 p-4 text-[12px]">
              {/* Header Banner: Autonomous System Architecture */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-fg">Terminal watchdog</span>
                  <Hint text="On each bridge sync the watchdog checks the terminal and sends a recovery directive when it is stuck, then waits the cooldown." />
                  <Badge tone={watchdog?.active ? "ok" : "slate"}>{watchdog?.active ? "ACTIVE" : "IDLE"}</Badge>
                </div>

                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-slate-400">Policy:</span>
                  <span className="mono font-semibold text-cyan-200">{watchdog?.policy || "self_healing_v1"}</span>
                  <span className="text-slate-600">|</span>
                  <span className="text-slate-400">Cooldown:</span>
                  <span className="mono font-semibold text-slate-200">{watchdog?.anti_flapping_cooldown_sec || 180}s</span>
                </div>
              </div>

              {/* 5-Stage Interactive State Machine Pipeline */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {/* Node 1: Cerebrum Cloud Supervisor */}
                <div className="flex flex-col justify-between rounded-lg border border-cyan-500/30 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted">
                        Watchdog
                      </span>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-white">
                      Cerebrum
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Agent</span>
                        <span className="mono font-semibold text-cyan-200">{watchdog?.agent || "agent:cerebrum"}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Node 2: Host Bridge Daemon */}
                <div className="flex flex-col justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted">
                        Bridge
                      </span>
                      <Badge tone={br.seen ? "ok" : "fault"}>
                        {br.seen ? "SYNCED" : "OFFLINE"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-slate-100">
                      Omega bridge
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Last sync</span>
                        <span className="mono text-ok">{br.seen ? agoMs(br.synced_age_ms) : "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Key ID</span>
                        <span className="mono text-slate-300 truncate max-w-[90px]">{br.kid || "—"}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Node 3: MT5 Terminal Service */}
                <div className="flex flex-col justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted">
                        Terminal
                      </span>
                      <Badge tone={br.state_age_ms != null && br.state_age_ms < 60000 ? "ok" : "fault"}>
                        {br.state_age_ms != null && br.state_age_ms < 60000 ? "STREAMING" : "STALE"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-slate-100">
                      MT5
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Heartbeat</span>
                        <span className="mono text-ok">{agoMs(br.state_age_ms)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Terminal</span>
                        <span className={`mono ${br.terminal_connected ? "text-ok" : "text-fault"}`}>{br.terminal_connected ? "connected" : "not connected"}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Node 4: Broker Gateway & Market */}
                <div className="flex flex-col justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted">
                        Broker
                      </span>
                      <Badge tone={br.terminal_connected && br.trade_allowed ? "ok" : "fault"}>
                        {br.terminal_connected ? (br.trade_allowed ? "READY" : "ALGO BLOCKED") : "DISCONNECTED"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-cyan-200 truncate">
                      {brokerName} · {accountLabel}
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Mode</span>
                        <span className="mono uppercase text-slate-200">{br.trade_mode || "unknown"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Permission</span>
                        <span className={`font-semibold ${br.trade_allowed ? "text-ok" : "text-fault"}`}>
                          {br.trade_allowed ? "Allowed" : "Disabled"}
                        </span>
                      </div>
                      {/* OmegaExecutor 1.12+ reports its version and whether it still moves stops beside Omega. */}
                      <div className="flex justify-between" title={br.executor?.note ?? ""}>
                        <span className="text-slate-500">EA</span>
                        <span className={`font-semibold ${br.executor?.status === "ok" ? "text-ok" : br.executor?.status === "local_management" ? "text-fault" : "text-amber-300"}`}>
                          {br.executor?.version ? `v${br.executor.version}` : "v?"} · {br.executor?.status === "ok" ? "stops by Omega" : br.executor?.status === "local_management" ? "local trailing ON" : br.executor?.status === "outdated" ? "update EA" : "not reported"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 border-t border-white/5 pt-2 text-[10px] text-slate-400">
                    {symbolName} · Spread {br.spread_points ?? 0} pts
                  </div>
                </div>

                {/* Node 5: Cloud Decision Engine */}
                <div className="flex flex-col justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted">
                        Engine
                      </span>
                      <Badge tone={c.mode === "killed" ? "fault" : eEnabled ? "ok" : "off"}>
                        {c.mode === "killed" ? "KILLED" : eEnabled ? "ARMED" : "IDLE"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-slate-100">
                      Decision Engine
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Mode</span>
                        <span className="mono uppercase text-slate-200">{c.mode || "active"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Live</span>
                        <span className="mono text-slate-300">{e.live_armed ? "Armed" : "Not armed"}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 border-t border-white/5 pt-2 text-[10px] text-slate-400">
                    Signal: {s.side || "NONE"}
                  </div>
                </div>
              </div>

              {/* Autonomous Self-Healing Audit Trail Card */}
              <div className="rounded-lg border border-white/10 bg-bar p-3.5">
                <div className="flex items-center justify-between border-b border-white/10 pb-2">
                  <h4 className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
                    <ShieldCheck className="h-4 w-4 text-ok" />
                    Last recovery
                  </h4>
                </div>

                {watchdog?.last_recovery ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-sm border border-white/5 bg-black/30 p-2.5">
                      <div className="text-[11px] font-medium text-muted">Directive</div>
                      <div className="mono mt-1 text-[12px] font-bold text-amber-300">
                        {watchdog.last_recovery.directive}
                      </div>
                    </div>
                    <div className="rounded-sm border border-white/5 bg-black/30 p-2.5">
                      <div className="text-[11px] font-medium text-muted">Reason</div>
                      <div className="mono mt-1 text-[12px] font-bold text-slate-200">
                        {watchdog.last_recovery.reason}
                      </div>
                    </div>
                    <div className="rounded-sm border border-white/5 bg-black/30 p-2.5">
                      <div className="text-[11px] font-medium text-muted">Time</div>
                      <div className="mono mt-1 text-[12px] text-cyan-200">
                        {timeUtc(watchdog.last_recovery.ms)} ({agoMs(Date.now() - watchdog.last_recovery.ms)})
                      </div>
                    </div>
                    <div className="rounded-sm border border-white/5 bg-black/30 p-2.5">
                      <div className="text-[11px] font-medium text-muted">Status</div>
                      <div className="mono mt-1 text-[12px] font-semibold text-ok">
                        {Date.now() - watchdog.last_recovery.ms > (watchdog.anti_flapping_cooldown_sec ?? 180) * 1000 ? "Done" : "Cooling down"}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 rounded-sm border border-ok-fill/20 bg-ok-fill/5 p-3 text-[11.5px] text-ok">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-ok" />
                    <span>
                      No recoveries.{br.state_age_ms != null && br.state_age_ms < 60000 ? " Terminal streaming." : " Terminal not streaming."}
                    </span>
                  </div>
                )}
              </div>

              {/* Collapsible Raw State JSON Inspector */}
              <div className="rounded-lg border border-white/10 bg-bar p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[12px] font-semibold text-fg">
                      Raw state
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowRawState((v) => !v)}
                    className="rounded-sm border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/10 transition"
                  >
                    {showRawState ? "Hide" : "Show"}
                  </button>
                </div>
                {showRawState ? (
                  <pre className="mt-2.5 max-h-56 overflow-y-auto rounded-sm bg-black/60 p-3 mono text-[11px] text-ok/90 border border-white/10">
                    {JSON.stringify(
                      {
                        terminal_connected: br.terminal_connected,
                        trade_allowed: br.trade_allowed,
                        server: serverName,
                        trade_mode: br.trade_mode,
                        currency: br.currency,
                        cent: br.cent === true,
                        balance: br.balance,
                        equity: br.equity,
                        day_start_balance: br.day_start_balance,
                        day_realized_pl: br.day_realized_pl,
                        symbol: {
                          name: symbolName,
                          bid: br.bid,
                          ask: br.ask,
                          spread_points: br.spread_points,
                          digits: br.digits,
                          point: br.point,
                          tick_size: br.tick_size,
                          tick_value: br.tick_value,
                          volume_min: br.volume_min,
                          volume_max: br.volume_max,
                          volume_step: br.volume_step,
                          stops_level_points: br.stops_level_points,
                        },
                        positions: positionsList,
                        state_age_ms: br.state_age_ms,
                        bridge_sync_age_ms: br.synced_age_ms,
                        kid: br.kid,
                        autonomous_watchdog: watchdog,
                      },
                      null,
                      2
                    )}
                  </pre>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Tab: EXECUTION QUALITY, TCA & SMART ORDER ROUTER (SOR) */}
          {toolboxTab === "tca_sor" ? (
            <div className="space-y-4 p-4 text-[12px]">
              {/* Header Banner: Institutional Execution & TCA Quality */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-fg">Execution quality</span>
                  <Hint text="Measured on Omega's fills: intent-to-fill latency and slippage against the requested price." />
                  <Badge tone={b?.tca?.samples_count ? "ok" : "slate"}>{b?.tca?.samples_count ? b.tca.quality : "NO FILLS"}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="mono rounded-sm border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] text-slate-300">
                    Route: <span className="text-cyan-300 font-semibold">{b?.route?.active_route ?? "no connection"}</span>
                  </span>
                </div>
              </div>

              {/* 4 Cards Grid: TCA, SOR Redundancy, Dynamic ATR, Macro Gate */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {/* 1. Transaction Cost Analysis (TCA) */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-medium text-muted">Slippage</span>
                    <span className="rounded-sm bg-ok-fill/20 px-1.5 py-0.5 text-[9.5px] font-bold text-ok">
                      {b?.tca?.samples_count ? b.tca.quality : "—"}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Latency</span>
                      <span className="mono font-semibold text-slate-200">{b?.tca?.avg_latency_ms != null ? `${b.tca.avg_latency_ms} ms` : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Avg slippage</span>
                      <span className="mono font-semibold text-ok">{b?.tca?.avg_slippage_points != null ? `${b.tca.avg_slippage_points} pts` : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Max slippage</span>
                      <span className="mono text-slate-300">{b?.tca?.max_slippage_points != null ? `${b.tca.max_slippage_points} pts` : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Samples</span>
                      <span className="mono text-slate-400">{b?.tca?.samples_count || 0} fills</span>
                    </div>
                  </div>
                </div>

                {/* 2. Smart Order Router (SOR) & Failover */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-medium text-muted">Order route</span>
                    <span className={`rounded-sm px-1.5 py-0.5 text-[9.5px] font-bold ${b?.route?.status === "trading" ? "bg-ok-fill/20 text-ok" : "bg-amber-500/20 text-amber-300"}`}>
                      {String(b?.route?.status ?? "unknown").replace(/_/g, " ").toUpperCase()}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Active route</span>
                      <span className="mono font-semibold text-slate-200">{b?.route?.active_route ?? "none"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Failover</span>
                      <span className="mono text-slate-300">{b?.route?.failover ?? "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Last sync</span>
                      <span className="mono text-slate-400">{b?.route?.bridge_sync_age_ms != null ? `${Math.round(b.route.bridge_sync_age_ms / 1000)} s ago` : "never"}</span>
                    </div>
                  </div>
                </div>

                {/* 3. Adaptive Volatility & Dynamic ATR */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
                      Volatility &amp; stops
                      {b?.management ? <Hint text={`${b.management.key_levels}. ${b.management.fallback}; ${b.management.scale_out}.`} /> : null}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold ${
                      b?.volatility?.regime === "HIGH" ? "bg-amber-500/20 text-amber-300" : "bg-ok-fill/20 text-ok"
                    }`}>
                      {b?.volatility?.regime || "NORMAL"} REGIME
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">ATR (broker)</span>
                      <span className="mono font-semibold text-slate-200">
                        {b?.volatility?.atr_points != null ? `${b.volatility.atr_points} pts${b.volatility.atr_value != null ? ` (${b.volatility.atr_value})` : ""}` : "not reported"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Break-even</span>
                      <span className="mono text-slate-300">{b?.management?.break_even_r != null ? `at ${b.management.break_even_r}R` : "off (key-level SL+)"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Noise filter</span>
                      <span className={`mono ${b?.management?.adaptive_stop ? "text-ok" : "text-slate-500"}`}>{b?.management?.adaptive_stop ? "on (0.75 ATR)" : "off"}</span>
                    </div>
                  </div>
                </div>

                {/* 4. Live Macro Risk & Economic Calendar Webhook */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-medium text-muted">Event risk</span>
                    <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold ${
                      b?.macro_risk?.blackout ? "bg-fault-fill/20 text-fault animate-pulse" : "bg-ok-fill/20 text-ok"
                    }`}>
                      {b?.macro_risk?.blackout ? "BLACKOUT" : "CLEAR"}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Window</span>
                      <span className="mono text-slate-300">{b?.macro_risk?.window_minutes ? `−${b.macro_risk.window_minutes.before}m / +${b.macro_risk.window_minutes.after}m (USD high)` : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Upcoming (24h)</span>
                      <span className="mono font-semibold text-cyan-300">{b?.macro_risk?.upcoming_24h ?? "—"} events</span>
                    </div>
                    <div className="truncate text-slate-400 text-[10.5px] pt-1">
                      {b?.macro_risk?.next_event ? (
                        <span>Next: <strong className="text-slate-200">{b.macro_risk.next_event.title}</strong> ({b.macro_risk.next_event.impact})</span>
                      ) : (
                        <span>No high-impact USD event.</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Tab 5: EVENTS & AUDIT JOURNAL */}
          {toolboxTab === "events" ? (
            <div className="table-wrap max-h-[260px] overflow-y-auto">
              {!(b?.events || []).length && !(data?.control_events || []).length ? (
                <div className="p-4">
                  <Empty>No events logged yet.</Empty>
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Time (UTC)</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(b?.events || []).map((x: any, idx: number) => (
                      <tr key={`m-e-${idx}`}>
                        <td className="mono">{timeUtc(x.ms)}</td>
                        <td className="mono font-semibold text-slate-300">{x.actor}</td>
                        <td className="mono text-cyan-300">{x.action}</td>
                        <td className="mono text-[11px] text-slate-300">
                          {x.detail ? JSON.stringify(x.detail).slice(0, 160) : "—"}
                        </td>
                      </tr>
                    ))}
                    {(data?.control_events || []).map((ev: any, idx: number) => (
                      <tr key={`m-c-${idx}`}>
                        <td className="mono">{timeUtc(Date.parse(ev.at))}</td>
                        <td className="mono font-semibold text-slate-300">{ev.actor}</td>
                        <td className="mono text-amber-200">{`${ev.previous_mode} → ${ev.mode}`}</td>
                        <td className="text-[11px] text-slate-300">{ev.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* =====================================================================
          SIGNAL, CONTROL & EXPERT ADVISOR DECK
         ===================================================================== */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Signal" icon={<Radio className="h-3.5 w-3.5 text-cyan-300" />}>
          <div
            className={`mono mb-2 text-2xl font-extrabold ${
              s.side === "BUY" ? "text-bull" : s.side === "SELL" ? "text-bear" : "text-slate-500"
            }`}
          >
            {!s.side || s.side === "NONE" ? "NO TRADE" : `${s.side} · ${String(s.action || "").replace("ENTER_", "")}`}
          </div>
          <SignalRows s={s} />
          {/* Why Omega is or is not entering now (owner 2026-11-13: "pastikan semua ada visualisasi") */}
          <div className="mt-3 border-t border-white/5 pt-3">
            <div className="mb-1.5 text-[11px] font-medium text-muted">Entry status</div>
            <OmegaWhy codes={b?.planner?.codes} sinceMs={b?.planner?.since_ms} details={b?.planner?.details} envEnabled={e.env_enabled} />
          </div>
        </Panel>

        <Panel title="Control" icon={<Power className="h-3.5 w-3.5 text-cyan-300" />}>
          <div
            className={`mono mb-2 text-xl font-extrabold uppercase ${
              c.mode === "killed" ? "text-fault" : c.mode === "paused" ? "text-amber-200" : "text-ok"
            }`}
          >
            {c.mode || "active"}
          </div>
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-slate-500">Since</dt><dd className="mono text-slate-300">{c.at ? timeUtc(Date.parse(c.at)) : "—"}</dd>
            <dt className="text-slate-500">By</dt><dd className="mono text-slate-300">{c.actor || "—"}</dd>
            <dt className="text-slate-500">Reason</dt><dd className="text-slate-300">{c.reason || "—"}</dd>
          </dl>
          {s.kill_source === "env" ? (
            <p className="mb-2 text-[11px] text-amber-200">Server kill switch is on; it overrides this control.</p>
          ) : null}
          <div className="space-y-2 border-t border-white/10 pt-3">
            <label className="block text-[11px] font-medium text-muted" htmlFor="reason">
              Reason
            </label>
            <input
              id="reason"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-hidden"
              maxLength={200}
              placeholder="Required to pause or kill"
              value={controlReason}
              onChange={(ev) => setControlReason(ev.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !canControl || (c.mode || "active") === "active"}
                onClick={() => sendControl("active")}
                className="btn border-ok-fill/30 bg-ok-fill/10 text-ok disabled:opacity-40"
              >
                Resume
              </button>
              <button
                type="button"
                disabled={busy || !canControl || c.mode === "paused"}
                onClick={() => sendControl("paused")}
                className="btn disabled:opacity-40"
              >
                Pause entries
              </button>
              <button
                type="button"
                disabled={busy || !canControl || c.mode === "killed"}
                onClick={() => setKillConfirmOpen(true)}
                className="btn border-fault-fill/30 bg-fault-fill/10 text-fault disabled:opacity-40"
              >
                Kill (close all)
              </button>
            </div>
            {killConfirmOpen ? (
              <div className="glass-inner space-y-2 p-2.5">
                <label className="block text-[11px] font-medium text-fault" htmlFor="confirm">
                  Type KILL to close every EA position and stop the EA
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="confirm"
                    maxLength={8}
                    value={killConfirmText}
                    onChange={(ev) => setKillConfirmText(ev.target.value)}
                    className="w-28 rounded-md border border-white/10 bg-black/40 px-2.5 py-1 text-[12px] text-slate-100"
                  />
                  <button
                    type="button"
                    id="kill-go"
                    onClick={() => {
                      if (killConfirmText.trim() !== "KILL") {
                        setControlMsg({ tone: "text-amber-200", text: "Type KILL exactly." });
                        return;
                      }
                      setKillConfirmOpen(false);
                      setKillConfirmText("");
                      sendControl("killed", "KILL");
                    }}
                    className="btn border-fault-fill/40 bg-fault-fill/20 text-fault"
                  >
                    Confirm kill
                  </button>
                  <button
                    type="button"
                    id="kill-cancel"
                    onClick={() => {
                      setKillConfirmOpen(false);
                      setKillConfirmText("");
                    }}
                    className="btn"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {controlMsg ? <p className={`text-[11.5px] ${controlMsg.tone}`}>{controlMsg.text}</p> : null}
          </div>
        </Panel>

        <Panel title="Expert Advisor" icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            {/* The older EA's heartbeat (ea.heartbeat_age_ms), null with OmegaExecutor: "—", not "never" (from OM-LEAN #553). */}
            <dt className="text-slate-500">Heartbeat</dt><dd className={`mono ${ea.connected ? "text-ok" : "text-slate-400"}`}>{ea.heartbeat_age_ms == null ? "—" : agoMs(ea.heartbeat_age_ms)}</dd>
            <dt className="text-slate-500">Executor</dt><dd className={`mono ${br.terminal_connected ? "text-ok" : "text-fault"}`}>{br.terminal_connected ? `OmegaExecutor (${symbolName})` : "disconnected"}</dd>
            <dt className="text-slate-500">Trading allowed</dt>
            <dd className={`mono font-bold ${br.trade_allowed ? "text-ok" : "text-fault"}`}>
              {br.trade_allowed ? "yes" : "NO"}
            </dd>
            <dt className="text-slate-500">EA control</dt><dd className="mono text-slate-300">{hb?.control || c.mode || "active"}</dd>
            <dt className="text-slate-500">Positions</dt><dd className="mono text-slate-200">{hb?.positions ?? positionsList.length}</dd>
            <dt className="text-slate-500">Floating P&amp;L</dt><dd className={`mono ${toneCls(floatingPnl)}`}>{money(floatingPnl, cur)}</dd>
            <dt className="text-slate-500">Today P&amp;L</dt><dd className={`mono ${toneCls(hb?.today_pnl ?? br.day_realized_pl)}`}>{money(hb?.today_pnl ?? br.day_realized_pl, cur)}</dd>
            <dt className="text-slate-500">Daily loss</dt><dd className="mono text-slate-300">{hb?.daily_loss_pct != null ? `${num(hb.daily_loss_pct)}%` : "—"}</dd>
            <dt className="text-slate-500">Spread</dt><dd className="mono text-slate-300">{(br.spread_points ?? hb?.spread_points) != null ? `${br.spread_points ?? hb?.spread_points} pts` : "—"}</dd>
            <dt className="text-slate-500">Last signal</dt><dd className="mono truncate text-slate-400">{hb?.last_signal_id || s.signal_id || "—"}</dd>
            <dt className="text-slate-500">Note</dt><dd className="text-slate-400">{hb?.note || (br.terminal_connected ? "via bridge" : "—")}</dd>
          </dl>
        </Panel>
      </div>

      {/* Statistics KPIs */}
      <div className="grid gap-3 sm:grid-cols-3">
        {([
          ["Today (UTC)", st.today],
          ["7 days", st.week],
          ["30 days", st.month],
        ] as [string, any][]).map(([label, x]) => (
          <Kpi
            key={label}
            label={label}
            value={money(x?.net, cur)}
            sub={`${x?.trades ?? 0} trade${x?.trades === 1 ? "" : "s"} · win rate ${
              x?.win_rate != null ? Math.round(x.win_rate * 100) + "%" : "—"
            } · PF ${x?.profit_factor ?? "—"} · max DD ${num(x?.max_drawdown)}`}
            color={pnlColor(x?.net)}
            icon={<Activity className="h-3 w-3" />}
          />
        ))}
      </div>
      </div>
      ) : (
      <div className="flex flex-col gap-4">
      {/* =====================================================================
          SEPARATED SETUP & CONFIGURATION CENTER
          (Broker Selection, Server List, Auto-Fetch Gold/XAUUSD, Login & Engine Toggle)
         ===================================================================== */}
      <div
        id="setup-center-section"
        className="flex flex-col gap-4 rounded-xl border border-white/10 bg-panel p-3.5 transition sm:p-4"
      >
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Setup sections">
          {([["engine", "Engine"], ["profile", "Risk profile"], ["connection", "Connection & EA"]] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={setupTab === key} id={`setup-tab-${key}`} onClick={() => setSetupTab(key)}
              className={`rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition ${setupTab === key ? "border-white/30 bg-white/8 text-fg" : "border-white/10 bg-black/30 text-fg-2 hover:text-fg"}`}>
              {label}
              {key === "profile" && profileAttention ? <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-black">1</span> : null}
            </button>
          ))}
        </div>

        {/* The connected server (owner 2026-11-19, universal: no broker presets; the broker is what the terminal reports). */}
        {setupTab === "connection" ? (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-fg">Broker</span>
            <span className="mono text-[11px] text-slate-400">
              {configLocked ? (
                <span className="text-ok">Locked: <strong className="text-slate-100">{serverName}</strong></span>
              ) : (
                <>Server: <strong className="text-slate-200">{bServer || serverName || "—"}</strong></>
              )}
            </span>
          </div>
        ) : null}

        {/* Step 2, 3, 4: 3-Column Configuration Panels */}
        <div className={`grid gap-4 ${setupTab === "connection" ? "md:grid-cols-2" : "max-w-xl"}`}>
          {setupTab === "connection" ? (
          <Panel
            title="Broker connection"
            icon={<KeyRound className="h-3.5 w-3.5 text-cyan-300" />}
            hint="Credentials are encrypted in this browser with the bridge's key; the server cannot read them."
            right={<Badge tone={conn.status === "stored" ? "ok" : conn.status === "needs_reentry" ? "late" : "slate"}>{conn.status || "none"}</Badge>}
          >
            <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">Status</dt><dd className="text-slate-200">{CONNECTION_TEXT[conn.status] || conn.status || "—"}</dd>
              <dt className="text-slate-500">Server</dt><dd className="mono text-slate-200">{conn.server || "—"}</dd>
              <dt className="text-slate-500">Symbol</dt><dd className="mono text-amber-200">{symbolName}</dd>
              <dt className="text-slate-500">Version</dt><dd className="mono text-slate-300">{conn.version ? `v${conn.version}` : "—"}</dd>
              <dt className="text-slate-500">By</dt><dd className="mono text-slate-300">{conn.updated_by || "—"}</dd>
              <dt className="text-slate-500">At</dt><dd className="mono text-slate-300">{timeUtc(conn.updated_ms)}</dd>
            </dl>
            <form id="broker-form" onSubmit={connectBroker} autoComplete="off" className="space-y-2.5 border-t border-white/10 pt-3">
              {/* Active Connection Locked Banner */}
              {configLocked ? (
                <div className="rounded-lg border border-ok-fill/40 bg-ok-fill/10 p-2.5 text-[11.5px] text-ok">
                  <div className="flex items-center gap-2 font-semibold">
                    <span className="h-2 w-2 rounded-full bg-ok-fill animate-pulse" />
                    <span>Connected: {brokerName} · {accountLabel} ({br.trade_mode ? br.trade_mode.toUpperCase() : "UNKNOWN"})</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-300">Disconnect to change broker or account.</p>
                </div>
              ) : null}

              <div>
                <label className="block text-[11px] font-medium text-muted" htmlFor="b-server">
                  Server {configLocked ? "(locked)" : ""}
                </label>
                <input
                  id="b-server"
                  disabled={configLocked}
                  maxLength={64}
                  placeholder="the server name exactly as MT5 shows it"
                  spellCheck={false}
                  value={bServer}
                  onChange={(ev) => setBServer(ev.target.value)}
                  className={`mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-hidden ${
                    configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                  }`}
                />
              </div>

              {/* Default Gold / XAUUSD Pairing Selector */}
              <div>
                <div className="flex items-center gap-1.5">
                  <label className="block text-[11px] font-medium text-muted" htmlFor="b-gold-pair">
                    Symbol {configLocked ? "(locked)" : ""}
                  </label>
                  <Hint text="Any broker, any symbol name: the EA scans every symbol on the server and keeps the one priced in USD, 1 to 100 oz a lot, within 2% of the reference gold price. A typed name is only tried first, under the same checks." />
                </div>
                <select
                  id="b-gold-pair"
                  disabled={configLocked}
                  value={goldPair}
                  onChange={(ev) => setGoldPair(ev.target.value)}
                  className={`mt-1 w-full rounded-md border border-amber-400/30 bg-black/20 px-2.5 py-1.5 text-[12px] text-amber-100 focus:border-amber-400 focus:outline-hidden ${
                    configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                  }`}
                >
                  {GOLD_PAIR_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {goldPair === "OTHER" && (
                  <input
                    id="b-gold-other"
                    aria-label="Gold symbol name"
                    disabled={configLocked}
                    maxLength={32}
                    spellCheck={false}
                    placeholder="e.g. GoldOne"
                    value={goldOther}
                    onChange={(ev) => setGoldOther(ev.target.value)}
                    className="mt-1 w-full rounded-md border border-amber-400/30 bg-black/30 px-2.5 py-1.5 text-[12px] text-amber-100 focus:border-amber-400 focus:outline-hidden"
                  />
                )}
                {conn?.trade_symbol ? (
                  <div className="mt-1 text-[10px] text-slate-400">Stored with the connection: <strong className="text-amber-200">{conn.trade_symbol}</strong></div>
                ) : null}
              </div>

              <div>
                <div className="flex items-center gap-1.5">
                  <label className="block text-[11px] font-medium text-muted" htmlFor="b-units-usd">
                    Units per US dollar {configLocked ? "(locked)" : "(optional)"}
                  </label>
                  <Hint text="Leave empty for a USD account. For an account in another currency that has not traded yet, how many of its units make one US dollar (e.g. 100 for a cent account). Once it trades, its own trades measure it; a disagreement opens nothing." />
                </div>
                <input
                  id="b-units-usd"
                  disabled={configLocked}
                  inputMode="decimal"
                  maxLength={12}
                  placeholder="empty, or e.g. 100"
                  value={unitsPerUsd}
                  onChange={(ev) => setUnitsPerUsd(ev.target.value)}
                  className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-hidden"
                />
                {account?.money_text ? <div className="mt-1 text-[10px] text-slate-400">Account money: <strong className="text-slate-200">{account.money_text}</strong></div> : null}
              </div>

              <div>
                <label className="block text-[11px] font-medium text-muted" htmlFor="b-login">
                  Login {configLocked ? "(locked)" : ""}
                </label>
                <input
                  id="b-login"
                  disabled={configLocked}
                  maxLength={20}
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={configLocked ? "Locked" : "Account number"}
                  value={bLogin}
                  onChange={(ev) => setBLogin(ev.target.value)}
                  className={`mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-hidden ${
                    configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                  }`}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-[11px] font-medium text-muted" htmlFor="b-password">
                    Password {configLocked ? "(locked)" : ""}
                  </label>
                  {!configLocked ? (
                    <button
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      className="text-[10px] text-cyan-300 hover:underline"
                    >
                      {showPass ? "Hide" : "Show"}
                    </button>
                  ) : null}
                </div>
                <input
                  id="b-password"
                  disabled={configLocked}
                  type={showPass ? "text" : "password"}
                  maxLength={64}
                  autoComplete="new-password"
                  placeholder={configLocked ? "••••••••" : "Trading or investor password"}
                  value={bPassword}
                  onChange={(ev) => setBPassword(ev.target.value)}
                  className={`mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-hidden ${
                    configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                  }`}
                />
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="submit"
                  id="b-connect"
                  disabled={!canControl || !br.kid || configLocked}
                  className="btn border-ok-fill/30 bg-ok-fill/10 text-ok disabled:opacity-40"
                  title={configLocked ? "Disconnect first to switch." : undefined}
                >
                  {configLocked
                    ? "Connected"
                    : conn.status === "stored" && !br.terminal_connected
                    ? "Reconnect"
                    : "Connect"}
                </button>
                <button
                  type="button"
                  id="b-disconnect"
                  disabled={!canControl || (conn.status !== "stored" && !br.terminal_connected)}
                  onClick={disconnectBroker}
                  className="btn border-fault-fill/30 bg-fault-fill/10 text-fault disabled:opacity-40"
                >
                  Disconnect
                </button>
              </div>

              {conn.status === "stored" && !br.terminal_connected ? (
                <div className="rounded-sm border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11.5px] text-amber-200">
                  <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Terminal not connected
                  </div>
                  <p className="mt-1 text-slate-300">
                    Login failed on <strong className="text-white">{serverName}</strong>{br.terminal_error ? `: "${br.terminal_error}"` : ""}. Check server, login and password, then Reconnect.
                  </p>
                </div>
              ) : null}

              {brokerMsg ? <p className={`text-[11.5px] ${brokerMsg.tone}`}>{brokerMsg.text}</p> : null}
            </form>
          </Panel>
          ) : null}

          {setupTab === "engine" ? (
          <Panel
            title="Broker engine"
            icon={<Sliders className="h-3.5 w-3.5 text-cyan-300" />}
            right={<Badge tone={effectiveTone}>{effectiveLabel}</Badge>}
          >
            <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">Effective</dt><dd className="mono text-slate-200">{effectiveLabel}</dd>
              <dt className="text-slate-500">Live</dt><dd className={`mono ${e.live_armed ? "text-amber-200" : "text-slate-300"}`}>{e.live_armed ? "armed" : "not armed"}</dd>
              <dt className="text-slate-500">Risk</dt><dd className="mono text-slate-200">{e.risk_pct != null ? `${e.risk_pct}% of equity` : "—"}</dd>
              <dt className="text-slate-500">Max positions</dt><dd className="mono text-slate-200">{e.max_positions ?? "—"}</dd>
              <dt className="text-slate-500">Max daily loss</dt><dd className="mono text-slate-200">{e.max_daily_loss_pct != null ? `${e.max_daily_loss_pct}%` : "—"}</dd>
              <dt className="text-slate-500">Max spread</dt><dd className="mono text-slate-200">{e.max_spread_points != null ? `${e.max_spread_points} pts` : "—"}</dd>
              <dt className="text-slate-500">Max signal age</dt><dd className="mono text-slate-200">{e.max_signal_age_ms ? `${Math.round(e.max_signal_age_ms / 60000)} min` : "—"}</dd>
              <dt className="text-slate-500">Entry order</dt><dd className="mono text-slate-200">{entryOrder.mode || e.entry_order || "market"}</dd>
              <dt className="text-slate-500">Changed by</dt><dd className="mono text-slate-300">{e.updated_by || "—"}</dd>
              {/* Reversal probation (owner 2026-11-18): counter-trend sweep reversals at half risk, one at a time. */}
              <dt className="text-slate-500" title="Counter-trend sweep reversals before their record passes: half risk and half the hard cap, one at a time, never hedged, only after a change of structure on a closed H1 or H4 candle. A cell whose last 5 probation trades average under 0R stops.">Reversal probation</dt>
              <dd className="mono text-slate-200">
                {b?.probation?.enabled === false ? "off" : "on (½ risk)"}
                {b?.probation?.reverted && Object.keys(b.probation.reverted).length ? <span className="text-amber-200"> · reverted: {Object.keys(b.probation.reverted).join(", ")}</span> : null}
                {canControl ? (
                  <button
                    type="button"
                    className="btn ml-2 px-2 py-0.5 text-[11px]"
                    onClick={async () => {
                      const enabled = b?.probation?.enabled === false;
                      try {
                        await omegaJson("/omega/api/probation", "POST", { enabled });
                        setEngineMsg({ tone: "text-ok", text: enabled ? "Reversal probation on." : "Reversal probation off." });
                      } catch (err: any) {
                        setEngineMsg({ tone: "text-fault", text: `Refused: ${err?.message || "failed"}` });
                      }
                      await load();
                    }}
                  >
                    {b?.probation?.enabled === false ? "Turn on" : "Turn off"}
                  </button>
                ) : null}
              </dd>
            </dl>
            {/* C5: the Position Manager lines (B5), one block under Reversal probation; its own read and the owner's Turn back on. */}
            <PmLines canControl={canControl} />
            <form
              id="engine-form"
              onSubmit={(ev) => {
                ev.preventDefault();
                saveEngine();
              }}
              autoComplete="off"
              // The server checks every value and says why it refuses (2026-11-18: the browser's own range check
              // silently cancelled a save above an input's max, so the fields looked locked).
              noValidate
              className="space-y-2.5 border-t border-white/10 pt-3"
            >
              {/* Prominent Broker Engine Activation Toggle Card */}
              <div
                className={`flex items-center justify-between gap-2 rounded-lg border p-2.5 transition ${
                  eEnabled
                    ? "border-ok-fill/40 bg-ok-fill/10"
                    : "border-white/10 bg-black/35"
                }`}
              >
                <label className="flex cursor-pointer items-center gap-2.5 text-[12px] font-semibold text-slate-100">
                  <input
                    type="checkbox"
                    id="e-enabled"
                    checked={eEnabled}
                    onChange={(ev) => {
                      setEngineDirty(true);
                      setEEnabled(ev.target.checked);
                    }}
                    className="h-4 w-4 accent-ok-fill"
                  />
                  <span>Engine enabled</span>
                </label>
                <button
                  type="button"
                  id="e-quick-toggle"
                  disabled={!canControl}
                  onClick={() => {
                    const next = !eEnabled;
                    setEEnabled(next);
                    saveEngine({ enabled: next });
                  }}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-bold transition disabled:opacity-40 ${
                    eEnabled
                      ? "border-ok-fill/50 bg-ok-fill/20 text-ok"
                      : "border-slate-500/40 bg-white/5 text-slate-300"
                  }`}
                >
                  {eEnabled ? "ON" : "OFF"}
                </button>
              </div>

              <div className="grid grid-cols-[1fr_110px] items-center gap-x-3 gap-y-1.5 text-[11px]">
                <label htmlFor="e-risk" className="text-slate-400">Risk / trade (%)</label>
                <input id="e-risk" type="number" min="0.01" max="10" step="0.01" value={eRisk} onChange={(ev) => { setEngineDirty(true); setERisk(ev.target.value); }} className="rounded-sm border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                {formNotes.risk_pct ? <p className="col-span-2 -mt-1 text-right text-[10px] text-amber-200">{formNotes.risk_pct}</p> : null}
                <label htmlFor="e-maxpos" className="text-slate-400">Max positions</label>
                <input id="e-maxpos" type="number" min="1" max="5" step="1" value={eMaxPos} onChange={(ev) => { setEngineDirty(true); setEMaxPos(ev.target.value); }} className="rounded-sm border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                {formNotes.max_positions ? <p className="col-span-2 -mt-1 text-right text-[10px] text-amber-200">{formNotes.max_positions}</p> : null}
                <label htmlFor="e-loss" className="text-slate-400">Max daily loss (%)</label>
                <input id="e-loss" type="number" min="0.1" max="20" step="0.1" value={eLoss} onChange={(ev) => { setEngineDirty(true); setELoss(ev.target.value); }} className="rounded-sm border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                {formNotes.max_daily_loss_pct ? <p className="col-span-2 -mt-1 text-right text-[10px] text-amber-200">{formNotes.max_daily_loss_pct}</p> : null}
                <label htmlFor="e-spread" className="text-slate-400">Max spread (pts)</label>
                <input id="e-spread" type="number" min="1" max="1000" step="1" value={eSpread} onChange={(ev) => { setEngineDirty(true); setESpread(ev.target.value); }} className="rounded-sm border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                <label htmlFor="e-age" className="text-slate-400">Max signal age (min)</label>
                <input id="e-age" type="number" min="1" max="60" step="1" value={eAge} onChange={(ev) => { setEngineDirty(true); setEAge(ev.target.value); }} className="rounded-sm border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                {/* Limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md): the owner's switch; limit and council need OmegaExecutor 1.21. */}
                <label htmlFor="e-entry-order" className="text-slate-400" title="Market enters at the broker's price (today's path). Limit rests the plan's level as a pending order, placed only on the entry council's consensus; a missed limit is a missed trade. Council lets the entry council choose market, limit or no entry per signal; a silent council is the market entry.">Entry order</label>
                <select
                  id="e-entry-order"
                  disabled={!canControl}
                  value={entryOrder.mode || "market"}
                  onChange={(ev) => saveEngine({ entry_order: ev.target.value })}
                  className="rounded-sm border border-white/10 bg-black/30 px-2 py-1 text-slate-100 disabled:opacity-40"
                >
                  {(entryOrder.options?.length ? entryOrder.options : [{ value: "market", enabled: true, reason: null }]).map((o: any) => (
                    <option key={o.value} value={o.value} disabled={!o.enabled} title={o.reason || undefined}>
                      {o.value}{!o.enabled && o.reason ? ` (${o.reason})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              {/* ADR-0020 Amendment 8: the owner's switch, off by default (the settings write is owner only). */}
              <label className="flex cursor-pointer items-start gap-2 text-[11px] text-slate-300" htmlFor="e-pm-loosen">
                <input
                  type="checkbox"
                  id="e-pm-loosen"
                  disabled={!canControl}
                  checked={e.pm_loosen_enabled === true}
                  onChange={(ev) => saveEngine({ pm_loosen_enabled: ev.target.checked })}
                  className="mt-0.5 h-3.5 w-3.5 accent-amber-400 disabled:opacity-40"
                />
                <span>
                  <span className="font-semibold text-slate-100">Council may loosen a stop (A8)</span>: once per position, with a measured reason, the Position Council may move a tightened stop part of the way back toward the original entry stop (never past it, never back into loss from break-even) and move a take profit nearer or further.
                </span>
              </label>
              {/* The Positioning & Liquidity analyst's rollback switches (owner 2026-11-20, breakglass live): on by default; off, the lens contributes nothing. */}
              {([
                ["positioning_enabled", "e-lens-positioning", "Positioning lens (CFTC)", "the POSITIONING witness of the Decision Engine (a small, capped lean from managed money's weekly positioning) and its line in the 4H and 1D rooms."],
                ["liquidity_enabled", "e-lens-liquidity", "Liquidity lens (broker M1)", "the spread-spike entry gate, the 10-minute stop and target deferral during a spike, the liquidity key levels and the councils' liquidity reasons. It never opens a position."]
              ] as const).map(([key, id, label, what]) => (
                <label key={key} className="flex cursor-pointer items-start gap-2 text-[11px] text-slate-300" htmlFor={id}>
                  <input
                    type="checkbox"
                    id={id}
                    disabled={!canControl}
                    checked={e[key] !== false}
                    onChange={(ev) => saveEngine({ [key]: ev.target.checked })}
                    className="mt-0.5 h-3.5 w-3.5 accent-cyan-400 disabled:opacity-40"
                  />
                  <span><span className="font-semibold text-slate-100">{label}</span>: {what}</span>
                </label>
              ))}
              {entryOrder.ea_ok === false ? (
                <p className="text-[11px] text-amber-200" aria-label="Entry order needs EA 1.21">Limit and council need OmegaExecutor {entryOrder.ea_min_version ?? "1.21"}; the terminal reports {entryOrder.ea_version ?? "no version"}.</p>
              ) : null}
              {/* What the profile applies now (phase 2): the smaller of each setting and the profile's cap. */}
              {account ? (
                <p className="text-[11px] text-cyan-200" aria-label="Limits applied by the profile"
                  title="Each applied limit is the smaller of the setting and the profile's cap. Ranges: risk 0.01-10%, positions 1-5, daily loss 0.1-20%, spread 1-1000 pts, signal age 1-60 min.">
                  Applied ({account.profile_label}): {account.profile === "custom"
                    ? `${e.risk_pct ?? "—"}% · ${e.max_positions ?? "—"} pos · ${e.max_daily_loss_pct ?? "—"}% day`
                    : `${appliedLimit(e.risk_pct, PROFILE_CAPS[account.profile]?.risk)}% · ${appliedLimit(e.max_positions, PROFILE_CAPS[account.profile]?.positions)} pos · ${appliedLimit(e.max_daily_loss_pct, PROFILE_CAPS[account.profile]?.daily)}% day`}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="submit" id="e-save" disabled={!canControl} className="btn border-ok-fill/30 bg-ok-fill/10 text-ok disabled:opacity-40">
                  Save
                </button>
                {/* Fills the form only (never enabled, Arm or the profile); Save writes it through the audited settings path. */}
                <button
                  type="button"
                  id="e-default"
                  disabled={!canControl || customProfile}
                  onClick={fillEngineDefaults}
                  title={customProfile ? "The Custom profile sets no values to follow: set them by hand." : `Fill ${engineDefaults.risk_pct}% risk, ${engineDefaults.max_positions} positions, ${engineDefaults.max_daily_loss_pct}% daily loss, ${engineDefaults.max_spread_points} pts spread and ${engineDefaults.max_signal_age_min} min signal age (${account?.profile_label ? `the ${account.profile_label} profile` : "Omega's defaults"}). Press Save to apply.`}
                  className="btn border-cyan-400/30 bg-cyan-400/10 text-cyan-200 disabled:opacity-40"
                >
                  Default
                </button>
                <button
                  type="button"
                  id="e-arm"
                  disabled={!canControl || e.live_armed || !e.enabled}
                  onClick={() => setLiveConfirmOpen(true)}
                  className="btn border-fault-fill/30 bg-fault-fill/10 text-fault disabled:opacity-40"
                >
                  Arm live
                </button>
                <button
                  type="button"
                  id="e-disarm"
                  disabled={!canControl || !e.live_armed}
                  onClick={() => saveEngine({ live_armed: false })}
                  className="btn disabled:opacity-40"
                >
                  Disarm live
                </button>
              </div>
              {liveConfirmOpen ? (
                <div className="glass-inner space-y-2 p-2.5">
                  <label className="block text-[11px] font-medium text-fault" htmlFor="e-live">
                    Type LIVE to let Omega trade a real account
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="e-live"
                      maxLength={8}
                      value={liveConfirmText}
                      onChange={(ev) => setLiveConfirmText(ev.target.value)}
                      className="w-28 rounded-md border border-white/10 bg-black/40 px-2.5 py-1 text-[12px] text-slate-100"
                    />
                    <button
                      type="button"
                      id="e-live-go"
                      onClick={() => {
                        if (liveConfirmText.trim() !== "LIVE") {
                          setEngineMsg({ tone: "text-amber-200", text: "Type LIVE exactly." });
                          return;
                        }
                        setLiveConfirmOpen(false);
                        setLiveConfirmText("");
                        saveEngine({ live_armed: true, confirm: "LIVE" });
                      }}
                      className="btn border-fault-fill/40 bg-fault-fill/20 text-fault"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      id="e-live-cancel"
                      onClick={() => {
                        setLiveConfirmOpen(false);
                        setLiveConfirmText("");
                      }}
                      className="btn"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {engineMsg ? <p className={`text-[11.5px] ${engineMsg.tone}`}>{engineMsg.text}</p> : null}
            </form>
          </Panel>
          ) : null}

          {setupTab === "profile" ? (
          <Panel
            title="Risk profile"
            icon={<Sliders className="h-3.5 w-3.5 text-cyan-300" />}
            hint="Downgrades run at once: the kill switch or the daily loss to Safe, a 20% drawdown, 4 losses in a row, extreme volatility. Upgrades: one step on evidence, never above the ceiling or with a position or order open, at most one per 7 days."
            right={account ? <Badge tone="cyan">{account.profile_label}</Badge> : null}
          >
            {account?.account_ref ? <OmegaProfile account={account} onChanged={load} /> : <p className="text-[11px] text-slate-500">No account is connected now. The controls act on the connected account only.</p>}
          </Panel>
          ) : null}

          {setupTab === "connection" ? (
          <Panel
            title="Bridge & terminal"
            icon={<Terminal className="h-3.5 w-3.5 text-cyan-300" />}
            right={<Badge tone={br.seen ? "ok" : "fault"}>{br.seen ? "bridge online" : "bridge offline"}</Badge>}
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">Bridge</dt>
              <dd className={`mono ${br.seen ? "text-ok" : "text-fault"}`}>
                {br.seen ? `seen ${agoMs(br.synced_age_ms)}` : br.synced_age_ms != null ? `last seen ${agoMs(br.synced_age_ms)}` : "never seen"}
              </dd>
              <dt className="text-slate-500">Key ID</dt><dd className="mono text-slate-300">{br.kid || "—"}</dd>
              <dt className="text-slate-500">Terminal</dt>
              <dd className={`mono ${br.terminal_connected ? "text-ok" : "text-fault"}`}>
                {br.terminal_connected ? `connected to ${brokerName}` : "not connected"}
              </dd>
              <dt className="text-slate-500">Account</dt><dd className={`mono ${br.trade_mode === "real" ? "text-amber-200" : "text-slate-200"}`}>{br.trade_mode || "—"}{account?.money_text && account?.money?.source !== "usd" ? ` · ${account.money_text}; shown in USD` : ""}</dd>
              <dt className="text-slate-500">Balance</dt><dd className="mono text-slate-200">{balFmt(br.balance, acctCur)}</dd>
              <dt className="text-slate-500">Equity</dt><dd className="mono text-slate-200">{balFmt(br.equity, acctCur)}</dd>
              <dt className="text-slate-500">Symbol</dt><dd className="mono text-slate-200">{br.symbol || "—"}</dd>
              <dt className="text-slate-500">Bid / ask</dt><dd className="mono text-slate-200">{br.bid != null && br.ask != null ? `${num(br.bid, digits)} / ${num(br.ask, digits)}` : "—"}</dd>
              <dt className="text-slate-500">Spread</dt><dd className="mono text-slate-200">{br.spread_points != null ? `${br.spread_points} pts` : "—"}</dd>
              <dt className="text-slate-500">Positions</dt><dd className="mono text-slate-200">{String((br.positions || []).length)}</dd>
              <dt className="text-slate-500">Bridge version</dt><dd className="mono text-slate-400">{br.bridge_version || "—"}</dd>
            </dl>
          </Panel>
          ) : null}
        </div>
      </div>
      </div>
      )}

      {/* Styled Obsidian/Nexus Confirmation Modal for Market Exit */}
      <ExitConfirmModal
        position={exitModalPosition}
        isOpen={Boolean(exitModalPosition)}
        onClose={() => setExitModalPosition(null)}
        onConfirm={confirmExitPosition}
        isSubmitting={closingTicket !== null}
      />
    </div>
  );
}
