import OmegaProfile from "../components/OmegaProfile";
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { usePushMany } from "../lib/push";
import { AlertTriangle, ChevronRight, KeyRound, Sliders, Terminal } from "lucide-react";
import { createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type TickMarkType, type Time, type UTCTimestamp } from "lightweight-charts";
import { Badge, Dot, Empty, Hint, Panel, Skeleton } from "../components/ui";
import { ExitConfirmModal, type ExitTargetPosition } from "../components/ExitConfirmModal";
import OmegaWhy, { omegaReason } from "../components/OmegaWhy";
import { CHART_READ, get } from "../lib/api";
import { CANDLE, T, tagText } from "../lib/tokens";
import { appliedNotes, engineDefaultsFor } from "../lib/engineDefaults";
import { ZonesPrimitive, type ChartZone } from "../lib/zones-primitive";
import { CreatedCell, IntentCards, IntentEntry, SignalRows } from "../components/OmegaZone";
import { brokerToFeed, chartZoneLabel, gmt7Crosshair, gmt7Tick, isNum, knownFeedBasis, limitTitle, positionLines, restingLimit, signalZoneOf, utcClockOf, zoneText, zoneToFeed, type Zone } from "../lib/entryZone";
import { amount, atStops, connState, dailyLoss, isLiveAccount, lastActions, orderAsPosition, orderKind, riskToSl, scaleNote, shortAge, signalLine, signedMoney, signedPct, sourceOf, stateChip, verdict, type Risk } from "../lib/omegaLean";

/**
 * The Omega page inside the Nexus SPA (owner 2026-11-09: nexus.cryptophys.work/omega/ and /#/omega behind Cloudflare
 * Access). OM-LEAN (owner-approved mockup 1795450033-0f25, 2026-11-23: "Setuju, bangun (Rekomendasi)"): the Terminal
 * view is one screen that answers four questions (running and connected? what is open or resting, and its risk? the
 * signal and what Omega did, in one line? the last few actions?), with everything else behind one Details disclosure;
 * the MT5 window imitation, Market Watch, the Navigator and the Expert Advisor panel are gone. Setup is unchanged.
 * Calls same-origin /omega/api/* routes forwarded to xauusd-omega (OMEGA_PAGE) and, with Details open, /api/ohlcv for
 * the chart's candles.
 */

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

type ChartTf = "M5" | "M15" | "H1" | "H4" | "D1";
type DetailsTab = "history" | "intents" | "journal";
// The account's gold symbol (owner 2026-11-19, universal): found automatically by OmegaExecutor 1.19 on any broker, by its
// contract and its price against the reference gold price; a typed name is only a hint tried first, under the same checks.
const GOLD_PAIR_OPTIONS = [
  { value: "AUTO_GOLD", label: "Automatic (found by contract and price)" },
  { value: "OTHER", label: "Hint: type a symbol name" },
];
// The same rule as src/gold-symbol.mjs TRADE_SYMBOL_RE.
const TRADE_SYMBOL_RE = /^[A-Za-z0-9._#+-]{1,32}$/;

const CHART_TFS: ChartTf[] = ["M5", "M15", "H1", "H4", "D1"];

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

async function buildEnvelope(publicKeySpkiBase64: string, kid: string, creds: { server: string; login: string; password: string }) {
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
const balFmt = (v?: number | null, cur = "") =>
  typeof v === "number" && Number.isFinite(v)
    ? `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? " " + cur : ""}`
    : "—";
const timeUtc = (ms?: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const agoMs = (ms?: number | null) => {
  if (ms == null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 45) return `${Math.max(1, s)}s ago`;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const arr = (v: unknown): any[] => (Array.isArray(v) ? v.filter((x) => x != null && typeof x === "object") : []);
const obj = (v: unknown): any => (v != null && typeof v === "object" && !Array.isArray(v) ? v : {});
/** "11-19 13:53" (UTC), for the Details tables. */
const dayClock = (ms: unknown) => (isNum(ms) && ms > 0 ? new Date(ms).toISOString().slice(5, 16).replace("T", " ") : "—");

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

// A reported leverage this high is a broker's "unlimited" (FxPro demo: 1:2,000,000,000), not a real ratio.
const LEVERAGE_UNLIMITED_FROM = 100_000;

// ---------------------------------------------------------------- shared classes (the mockup's .btn, .st, .panel)

const PANEL = "rounded-xl border border-white/10 bg-panel/90";
const BTN_BASE = "inline-flex h-[44px] items-center justify-center gap-[8px] whitespace-nowrap rounded-[7px] border bg-white/3 px-[12px] text-[13px] font-semibold transition hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-45 lg:h-[34px] lg:text-[12px]";
const BTN_SM_BASE = "inline-flex h-[44px] items-center justify-center whitespace-nowrap rounded-[7px] border bg-white/3 px-[10px] text-[13px] font-semibold transition hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-45 lg:h-[30px] lg:text-[12px]";
const BTN_TONE = { plain: "border-white/14 text-fg hover:border-white/25", fault: "border-fault-fill/45 text-fault hover:border-fault-fill/70", late: "border-late-fill/50 text-late hover:border-late-fill/70", ok: "border-ok-fill/45 text-ok hover:border-ok-fill/70" } as const;
/** The mockup's .btn (34 px at 1440, 44 px on a phone) and .btn.sm, in one tone: plain, or a status tone for a destructive or arming step. */
const btn = (tone: keyof typeof BTN_TONE = "plain", ...more: (string | false | null | undefined)[]) => clsx(BTN_BASE, BTN_TONE[tone], ...more);
const btnSm = (tone: keyof typeof BTN_TONE = "plain", ...more: (string | false | null | undefined)[]) => clsx(BTN_SM_BASE, BTN_TONE[tone], ...more);
const TONE_TEXT: Record<string, string> = { ok: "text-ok", late: "text-late", fault: "text-fault", off: "text-off" };
const TONE_BORDER: Record<string, string> = { ok: "border-ok-fill/45", late: "border-late-fill/50", fault: "border-fault-fill/50", off: "border-off-fill/40" };
const SideWord = ({ side }: { side: unknown }) =>
  side === "BUY" ? <b className="font-sans font-semibold text-bull">BUY</b> : side === "SELL" ? <b className="font-sans font-semibold text-bear">SELL</b> : null;

/**
 * The Details chart (OM-LEAN): the feed's candles in GMT+7 and only Omega's own lines (its open positions' entry, SL and
 * TP, its resting limit and that limit's entry zone), each labelled with one price on the axis' scale (the feed: broker −
 * basis); without a basis the lines stay at the broker's prices, labelled "broker". The caption states the basis once.
 */
function OmegaChart({ digits, bid, positions, feedBasis, limit, signal }: {
  digits: number;
  bid?: number | null;
  positions: any[];
  /** EZ1: the signal's broker − feed basis (signal.feed_basis when feed_basis_known), else null. */
  feedBasis: number | null;
  /** Omega's resting limit (broker scale), its ticket and the entry zone its intent carries (broker). */
  limit: { price: number; side: "BUY" | "SELL" | null; zone: Zone | null; ticket: number | null } | null;
  signal: any;
}) {
  const [tf, setTf] = useState<ChartTf>("M15");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const lastLineRef = useRef<IPriceLine | null>(null);
  // The entry zone as a band with its label at the left (zones-primitive's anchored mode).
  const ezRef = useRef<ZonesPrimitive | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  // The prices of Omega's lines, so the price scale keeps them in view (a stop below the candles still shows).
  const linePricesRef = useRef<number[]>([]);

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
      // No library logo: it injects a <style> element, which the page's CSP (style-src 'self') refuses; the caption credits TradingView.
      layout: { background: { color: T.ground }, textColor: T.fg2, fontFamily: "ui-monospace, JetBrains Mono, monospace", attributionLogo: false },
      grid: { vertLines: { color: "rgba(255,255,255,0.03)" }, horzLines: { color: "rgba(255,255,255,0.03)" } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.09)" },
      // The time axis in the owner's GMT+7; the candles stay the feed's.
      timeScale: { borderColor: "rgba(255,255,255,0.09)", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t: Time, type: TickMarkType) => gmt7Tick(t, type) },
      localization: { timeFormatter: (t: Time) => gmt7Crosshair(t) },
    });
    // The last price is our own price line (setLastLine), so its axis tag carries dark text on the green and red fills.
    const series = chart.addCandlestickSeries({
      ...CANDLE, lastValueVisible: false, priceLineVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      autoscaleInfoProvider: (base: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = base();
        const ps = linePricesRef.current;
        if (!r || !ps.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...ps), maxValue: Math.max(r.priceRange.maxValue, ...ps) } };
      },
    });
    const ez = new ZonesPrimitive("anchored");
    series.attachPrimitive(ez);
    ezRef.current = ez;
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
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
    if (!series) return;
    const sorted = [...candles].filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.close)).sort((a, b) => a.time - b.time);
    series.setData(sorted.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    const lastBar = sorted[sorted.length - 1];
    if (lastBar) setLastLine(series, lastBar.open, lastBar.close);
  }, [candles]);

  // The broker's live bid in the last candle, on the feed scale (bid − feed_basis), and not at all while the basis is unknown.
  useEffect(() => {
    const series = seriesRef.current;
    const feedBid = brokerToFeed(bid, feedBasis, digits);
    if (!series || feedBid == null || candles.length === 0) return;
    const lastBar = candles[candles.length - 1];
    if (!lastBar || !Number.isFinite(lastBar.time)) return;
    try {
      series.update({ time: lastBar.time as UTCTimestamp, open: lastBar.open, high: Math.max(lastBar.high, feedBid), low: Math.min(lastBar.low, feedBid), close: feedBid });
      setLastLine(series, lastBar.open, feedBid);
    } catch {
      // ignore if chart series is resetting
    }
  }, [bid, candles, feedBasis, digits]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) {
      try { series.removePriceLine(l); } catch { /* ignore removed line */ }
    }
    linesRef.current = [];
    linePricesRef.current = [];
    const addLine = (price: number | null | undefined, title: string, color: string, style = LineStyle.Dashed, lineWidth: 1 | 2 = 1) => {
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;
      linePricesRef.current.push(price);
      linesRef.current.push(series.createPriceLine({ price, color, lineWidth, lineStyle: style, axisLabelVisible: true, axisLabelTextColor: tagText(color), title }));
    };
    const known = feedBasis != null;
    // The entry zone: the resting limit's own (its intent's, broker), else the clear signal's (feed); one price per label.
    const clear = signal && (signal.side === "BUY" || signal.side === "SELL") && !signal.paused && !signal.kill;
    const zoneFeed = limit?.zone ? (known ? zoneToFeed(limit.zone, feedBasis) : limit.zone) : clear ? signalZoneOf(signal) : null;
    const labels: ChartZone[] = zoneFeed ? [{ low: zoneFeed.low, high: zoneFeed.high, color: T.fg, alpha: 0.07, text: T.fg, label: chartZoneLabel(zoneFeed, known || !limit?.zone, digits) }] : [];
    ezRef.current?.setZones(labels);
    if (limit) {
      const at = known ? brokerToFeed(limit.price, feedBasis, digits) : limit.price;
      if (at != null) addLine(at, limitTitle(limit.ticket, at, known, digits), limit.side === "SELL" ? T.bearFill : T.bullFill, LineStyle.Dashed, 1);
    }
    // The open positions: entry, SL and TP through positionLines, on the feed with a basis (labelled broker without one).
    for (const p of Array.isArray(positions) ? positions : []) {
      const isBuy = p?.side === "BUY";
      for (const l of positionLines(p, feedBasis, digits)) {
        if (l.kind === "entry") addLine(l.price, l.title, isBuy ? T.bullFill : T.bearFill, LineStyle.Solid, 2);
        else addLine(l.price, l.title, l.kind === "sl" ? T.bearFill : T.bullFill, LineStyle.Solid, 1);
      }
    }
    // Re-fit the price scale with the lines in view (autoscaleInfoProvider above).
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  }, [candles, signal, positions, feedBasis, limit, digits]);

  return (
    <section className={clsx(PANEL, "px-[14px] py-[12px] lg:px-[16px]")} aria-label="Chart">
      <div className="mb-[10px] flex items-center justify-between gap-[8px]">
        <h2 className="text-[12px] font-semibold text-slate-300">Chart</h2>
        <div className="flex overflow-hidden rounded-[7px] border border-white/12" role="group" aria-label="Timeframe">
          {CHART_TFS.map((k) => (
            <button key={k} type="button" aria-pressed={tf === k} onClick={() => setTf(k)}
              className={clsx("h-[36px] px-[12px] text-[12px] font-medium lg:h-[30px]", tf === k ? "bg-white/8 text-fg" : "text-fg-2 hover:text-fg")}>{k}</button>
          ))}
        </div>
      </div>
      <div className="relative h-[300px] overflow-hidden rounded-lg bg-ground lg:h-[350px]">
        <div ref={hostRef} className="absolute inset-0" />
      </div>
      <p className="mono mt-[8px] text-[11px] text-fg-2">
        {feedBasis != null
          ? `Feed prices (OANDA): broker ${feedBasis >= 0 ? "−" : "+"} ${Math.abs(feedBasis).toFixed(2)}. Times GMT+7. Only Omega's own lines.`
          : "Feed candles (OANDA); Omega's lines at broker prices, the basis is unknown. Times GMT+7. Only Omega's own lines."}
        {" "}<a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="text-fg-2 underline decoration-white/20 hover:text-fg">Charts by TradingView</a>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- the actions the lean view calls

/** What the Terminal view can do; the render check passes no-ops (NOOP_ACTIONS). Each returns whether it went through. */
export type OmegaActions = {
  canControl: boolean;
  busy: boolean;
  hitlBusy: boolean;
  closingTicket: number | null;
  sendControl: (mode: "active" | "paused" | "killed", reason: string, confirm?: string) => Promise<boolean>;
  setEngine: (on: boolean) => void;
  armLive: () => Promise<boolean>;
  disarmLive: () => void;
  saveModify: (row: EditRow) => Promise<boolean>;
  delegate: (ticket: number, on: boolean) => void;
  delegateMode: (on: boolean) => void;
  requestClose: (pos: ExitTargetPosition) => void;
  setView: (v: "terminal" | "setup") => void;
};
export type EditRow = { target: "position" | "order"; ticket: number; sl: string; tp: string; price: string };
const yes = async () => true;
export const NOOP_ACTIONS: OmegaActions = {
  canControl: true, busy: false, hitlBusy: false, closingTicket: null,
  sendControl: yes, setEngine: () => {}, armLive: yes, disarmLive: () => {}, saveModify: yes, delegate: () => {}, delegateMode: () => {}, requestClose: () => {}, setView: () => {},
};

/** Everything the lean view reads, derived once from one overview body (null-safe: the render check nulls each path). */
function derive(d: any, now: number) {
  const data = obj(d);
  const s = obj(data.signal);
  const c = obj(data.control);
  const hb = data.heartbeat != null && typeof data.heartbeat === "object" ? data.heartbeat : null;
  const b = obj(data.broker);
  const e = obj(b.engine);
  const br = obj(b.bridge);
  const st = obj(data.stats);
  const accounts = arr(b.accounts);
  const account = accounts.find((a) => a?.connected === true) ?? null;
  const entryOrder = obj(b.entry_order);
  const limitByTicket: Record<string, any> = Object.fromEntries(arr(entryOrder.pending).map((x: any) => [String(x.ticket), x]));
  const delegation = b.delegation != null && typeof b.delegation === "object" ? b.delegation : null;
  const loosened = arr([]).concat(Array.isArray(b.pm_loosen?.loosened) ? b.pm_loosen.loosened : []).map(Number);
  const positions = arr(hb?.positions_detail).length ? arr(hb.positions_detail) : arr(br.positions);
  const orders = arr(br.orders);
  const intents = arr(b.intents);
  const deals = arr(data.deals).length > 0 ? arr(data.deals) : arr(br.deals);
  const digits = isNum(br.digits) && br.digits >= 0 && br.digits <= 8 ? br.digits : 2;
  const inUsd = Number(account?.money?.units_per_usd) > 0;
  const cur = inUsd ? "USD" : str(br.currency) || str(hb?.currency) || "USD";
  const feedBasis = knownFeedBasis(s);
  const resting = restingLimit(orders, intents);
  const floating = isNum(hb?.floating_pnl) ? hb.floating_pnl : isNum(br.equity) && isNum(br.balance) ? br.equity - br.balance : positions.reduce((acc, p) => acc + (isNum(p.profit) ? p.profit : 0), 0);
  const capOf = (k: "risk" | "positions" | "daily") => (account && account.profile !== "custom" ? PROFILE_CAPS[str(account.profile)]?.[k] : undefined);
  const applied = (v: unknown, k: "risk" | "positions" | "daily") => (isNum(v) ? appliedLimit(v, capOf(k)) : null);
  const appliedRisk = applied(e.risk_pct, "risk"), appliedPositions = applied(e.max_positions, "positions"), appliedDaily = applied(e.max_daily_loss_pct, "daily");
  const codes = Array.isArray(b.planner?.codes) ? b.planner.codes.filter((x: unknown) => typeof x === "string") : [];
  const conn = connState(br);
  const chip = stateChip(c.mode, e, s);
  const brokerName = str(br.broker) || "MT5 broker";
  const brokerLabel = account?.spec_status === "validated" ? brokerName : "broker unknown";
  const daily = dailyLoss({ codes, dayPct: account?.day_pl_pct, cap: appliedDaily, blockReason: account?.upgrade_block_reason, blockUntil: account?.upgrade_block_until_ms, now });
  return { data, s, c, hb, b, e, br, st, account, entryOrder, limitByTicket, delegation, loosened, positions, orders, intents, deals, digits, cur, feedBasis, resting, floating, appliedRisk, appliedPositions, appliedDaily, codes, conn, chip, brokerName, brokerLabel, daily };
}
type Derived = ReturnType<typeof deriveAll>;

/** A control change's who, when and why: owner, 13:10 UTC: "reason". */
function controlMeta(c: any): string {
  const at = Date.parse(str(c.at));
  const who = str(c.actor);
  const why = str(c.reason);
  return [[who, Number.isFinite(at) ? `${utcClockOf(at)} UTC` : ""].filter(Boolean).join(", "), why ? `"${why}"` : ""].filter(Boolean).join(": ");
}

// ---------------------------------------------------------------- 1. the header: running and connected?

/** A small popover under a header button: a reason (and a typed confirmation) before a control goes out. */
function Popover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="dialog" aria-label={label} className="absolute right-0 top-full z-30 mt-[8px] flex w-[min(320px,calc(100vw-40px))] flex-col gap-[8px] rounded-[10px] border border-white/18 bg-bar p-[12px] text-[12px] shadow-[0_12px_40px_rgba(0,0,0,0.6)]">
      {children}
    </div>
  );
}
const INPUT = "h-[44px] w-full rounded-md border border-white/14 bg-black/35 px-[10px] text-[13px] text-fg focus:border-cyan-400/50 focus:outline-hidden lg:h-[32px] lg:text-[12px]";

function OmegaHeader({ x, view, act, now, error, attention }: { x: Derived; view: "terminal" | "setup"; act: OmegaActions; now: number; error: string | null; attention: string }) {
  const [open, setOpen] = useState<"pause" | "kill" | "live" | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const { c, e, br, s, account, conn, chip } = x;
  const live = isLiveAccount(br.trade_mode);
  const mode = c.mode === "paused" || c.mode === "killed" ? c.mode : "active";
  const serverKill = s.kill === true && s.kill_source === "env";
  const close = () => { setOpen(null); setReason(""); setTyped(""); setMsg(null); };
  const toggle = (k: "pause" | "kill" | "live") => (open === k ? close() : (setOpen(k), setReason(""), setTyped(""), setMsg(null)));
  const go = async (m: "paused" | "killed") => {
    if (!reason.trim()) { setMsg("Write a reason first."); return; }
    if (m === "killed" && typed.trim() !== "KILL") { setMsg("Type KILL exactly."); return; }
    if (await act.sendControl(m, reason, m === "killed" ? "KILL" : undefined)) close();
  };
  const arm = async () => {
    if (typed.trim() !== "LIVE") { setMsg("Type LIVE exactly."); return; }
    if (await act.armLive()) close();
  };
  const at = x.atStopsText;
  const disconnected = conn.key === "disconnected";
  const asOf = disconnected && isNum(br.synced_age_ms) ? `as of ${utcClockOf(now - br.synced_age_ms)} UTC` : null;
  const limitsLabel = account ? `${str(account.profile_label) || "Profile"}:` : "Limits:";
  const pct = (v: unknown) => (v == null || v === "—" ? "—" : `${v}%`);
  const capTone = x.daily.reached ? "text-fault" : "";
  const until = x.daily.blockedUntil != null ? ` · upgrades blocked until ${utcClockOf(x.daily.blockedUntil)} UTC` : "";
  const today = isNum(account?.day_pl_pct) ? signedPct(account.day_pl_pct) : null;
  const longLimits = <>risk {pct(x.appliedRisk)} · max {x.appliedPositions ?? "—"} positions · <span className={capTone}>daily loss cap {pct(x.appliedDaily)}{x.daily.reached ? " reached" : ""}{today ? `, today ${today}` : ""}</span>{today && !x.daily.reached ? <span className="text-fg-2"> (equity vs day start)</span> : null}<span className={capTone}>{until}</span></>;
  const shortLimits = <>{str(account?.profile_label) || "Limits"} {pct(x.appliedRisk)} · max {x.appliedPositions ?? "—"} · <span className={capTone}>loss cap {pct(x.appliedDaily)}{x.daily.reached ? " reached" : ""}{today ? `, day ${today}` : ""}</span></>;
  const money = (
    <>
      <span><span className="text-fg-2">Equity</span> {amount(br.equity)} <span className="text-fg-2">{x.cur}</span></span>
      <span><span className="text-fg-2">Floating</span> {signedMoney(x.floating)}</span>
      {!disconnected ? <span><span className="text-fg-2">Day realized</span> {signedMoney(br.day_realized_pl)}</span> : null}
      <span><span className="text-fg-2">At stops</span> {at}</span>
      {!disconnected ? <span><span className="text-fg-2">Bid</span> {num(br.bid, x.digits)}</span> : null}
      {!disconnected ? <span><span className="text-fg-2">{"Spread "}</span>{isNum(br.spread_points) ? `${br.spread_points} pts` : "—"}</span> : null}
      {asOf ? <span className="text-fg-2">{asOf}</span> : null}
    </>
  );
  return (
    <section className={clsx(PANEL, "flex flex-col gap-[10px] px-[12px] py-[12px] lg:px-[16px] lg:py-[14px]")} aria-label="Omega status">
      <div className="flex flex-col gap-[10px] lg:flex-row lg:items-center lg:justify-between lg:gap-[16px]">
        <div className="flex flex-col gap-[8px] lg:flex-row lg:items-center lg:gap-[14px]">
          <div className="flex items-center justify-between gap-[12px]">
            <h1 className="m-0 text-[16px] font-semibold">Omega</h1>
            <div className="flex overflow-hidden rounded-[7px] border border-white/12" role="group" aria-label="View">
              <button type="button" id="tab-terminal-mode" aria-pressed={view === "terminal"} onClick={() => act.setView("terminal")}
                className={clsx("h-[36px] px-[12px] text-[12px] font-medium lg:h-[30px]", view === "terminal" ? "bg-white/8 text-fg" : "text-fg-2 hover:text-fg")}>Terminal</button>
              <button type="button" id="tab-setup-mode" aria-pressed={view === "setup"} onClick={() => act.setView("setup")}
                className={clsx("inline-flex h-[36px] items-center gap-[6px] px-[12px] text-[12px] font-medium lg:h-[30px]", view === "setup" ? "bg-white/8 text-fg" : "text-fg-2 hover:text-fg")}>
                Setup
                {attention ? <span id="setup-attention" className="rounded-full bg-amber-400 px-[6px] text-[10px] font-bold text-black" title={attention}>1</span> : null}
              </button>
            </div>
          </div>
          <div className="mono flex flex-wrap items-center gap-x-[8px] gap-y-0 text-[12px] leading-[16px] lg:flex-nowrap lg:gap-0 lg:overflow-hidden lg:rounded-lg lg:border lg:border-white/10">
            <span className="flex items-center gap-[8px] whitespace-nowrap lg:min-h-[34px] lg:px-[12px]" aria-label="Connection">
              <Dot tone={conn.tone} /><span className={TONE_TEXT[conn.tone]}>{conn.label}</span><span className="text-fg-2">{conn.detail}</span>
            </span>
            <span className="flex items-center gap-[8px] whitespace-nowrap lg:min-h-[34px] lg:border-l lg:border-white/10 lg:px-[12px]" aria-label="Account">
              <span>{x.brokerLabel}</span>
              {live ? <b className="font-semibold text-late">LIVE</b> : br.trade_mode === "demo" ? <span className="text-fg-2">demo</span> : null}
              <span>{str(br.symbol) || "—"}</span>
              {live ? <span className={x.e.live_armed === true ? "text-late" : "text-fg-2"}>{x.e.live_armed === true ? "armed" : "not armed"}</span> : null}
            </span>
          </div>
        </div>
        <div className="relative flex flex-wrap items-center gap-[8px] lg:flex-nowrap">
          <span className={clsx("inline-flex h-[44px] items-center gap-[6px] whitespace-nowrap rounded-[7px] border px-[10px] text-[13px] font-semibold lg:h-[34px] lg:px-[12px] lg:text-[12px]", TONE_BORDER[chip.tone], TONE_TEXT[chip.tone])} aria-label="State">{chip.label}</span>
          {s.blackout === true ? <span className={clsx("inline-flex h-[44px] items-center whitespace-nowrap rounded-[7px] border px-[10px] text-[12px] font-semibold lg:h-[34px]", TONE_BORDER.late, TONE_TEXT.late)} title={str(s.blackout_reason) || undefined}>Event blackout</span> : null}
          <button type="button" role="switch" aria-checked={e.enabled === true} aria-label="Engine" disabled={!act.canControl} onClick={() => act.setEngine(!(e.enabled === true))}
            className={btn("plain", "flex-1 lg:flex-none")} title={e.env_enabled === false ? "The server switch OMEGA_ENGINE_ENABLED is off; this switch is the page's own." : "Omega's engine switch (saved at once)"}>
            Engine
            <span className={clsx("relative inline-block h-[16px] w-[30px] rounded-full", e.enabled === true ? "bg-ok-fill/35" : "bg-off-fill/25")}>
              <i className={clsx("absolute top-[2px] h-[12px] w-[12px] rounded-full", e.enabled === true ? "right-[2px] bg-ok" : "left-[2px] bg-off")} />
            </span>
          </button>
          {live ? (
            x.e.live_armed === true
              ? <button type="button" id="lean-disarm" disabled={!act.canControl} onClick={act.disarmLive} className={btn()}>Disarm live</button>
              : <button type="button" id="lean-arm" disabled={!act.canControl || e.enabled !== true} onClick={() => toggle("live")} aria-expanded={open === "live"}
                  className={btn("late")} title={e.enabled !== true ? "Turn the engine on first" : undefined}>Arm live…</button>
          ) : null}
          {mode !== "active" ? (
            <>
              <span className="mono order-last w-full text-[11.5px] text-fg-2 lg:order-none lg:w-auto lg:max-w-[260px] lg:truncate" title={controlMeta(c)}>{controlMeta(c)}</span>
              <button type="button" disabled={act.busy || !act.canControl || serverKill} onClick={() => act.sendControl("active", "")} className={btn("ok")}
                title={serverKill ? "The server kill switch (EA_SIGNALS_ENABLED) overrides this control" : undefined}>Resume</button>
            </>
          ) : (
            <button type="button" id="lean-pause" disabled={act.busy || !act.canControl} onClick={() => toggle("pause")} aria-expanded={open === "pause"} className={btn("plain", "flex-1 lg:flex-none")}><span className="lg:hidden">Pause…</span><span className="hidden lg:inline">Pause entries…</span></button>
          )}
          {mode !== "killed" ? <button type="button" id="lean-kill" disabled={act.busy || !act.canControl} onClick={() => toggle("kill")} aria-expanded={open === "kill"} className={btn("fault")}>Kill…</button> : null}
          {!act.canControl ? <span className="text-[11px] text-fg-2">read only</span> : null}
          {open === "pause" ? (
            <Popover label="Pause entries">
              <label className="text-[11.5px] text-slate-300" htmlFor="lean-reason">Reason (required)</label>
              <input id="lean-reason" className={INPUT} maxLength={200} value={reason} onChange={(ev) => setReason(ev.target.value)} />
              {msg ? <p className="text-[11.5px] text-late">{msg}</p> : null}
              <div className="flex justify-end gap-[8px]">
                <button type="button" className={btnSm()} onClick={close}>Cancel</button>
                <button type="button" id="lean-pause-go" className={btnSm("late")} disabled={act.busy} onClick={() => go("paused")}>Pause entries</button>
              </div>
            </Popover>
          ) : null}
          {open === "kill" ? (
            <Popover label="Kill">
              <label className="text-[11.5px] text-slate-300" htmlFor="lean-kill-reason">Reason (required)</label>
              <input id="lean-kill-reason" className={INPUT} maxLength={200} value={reason} onChange={(ev) => setReason(ev.target.value)} />
              <label className="text-[11.5px] text-fault" htmlFor="confirm">Type KILL to close every EA position and stop the EA</label>
              <input id="confirm" className={clsx(INPUT, "lg:w-[112px]")} maxLength={8} value={typed} onChange={(ev) => setTyped(ev.target.value)} />
              {msg ? <p className="text-[11.5px] text-late">{msg}</p> : null}
              <div className="flex justify-end gap-[8px]">
                <button type="button" id="kill-cancel" className={btnSm()} onClick={close}>Cancel</button>
                <button type="button" id="kill-go" className={btnSm("fault")} disabled={act.busy} onClick={() => go("killed")}>Confirm kill</button>
              </div>
            </Popover>
          ) : null}
          {open === "live" ? (
            <Popover label="Arm live">
              <label className="text-[11.5px] text-fault" htmlFor="lean-live">Type LIVE to let Omega trade a real account</label>
              <input id="lean-live" className={clsx(INPUT, "lg:w-[112px]")} maxLength={8} value={typed} onChange={(ev) => setTyped(ev.target.value)} />
              {msg ? <p className="text-[11.5px] text-late">{msg}</p> : null}
              <div className="flex justify-end gap-[8px]">
                <button type="button" className={btnSm()} onClick={close}>Cancel</button>
                <button type="button" id="lean-live-go" className={btnSm("late")} onClick={arm}>Arm live</button>
              </div>
            </Popover>
          ) : null}
        </div>
      </div>
      <div className="mono grid grid-cols-2 gap-x-[12px] gap-y-0 text-[12px] leading-[16px] lg:flex lg:flex-wrap lg:gap-x-[22px]" aria-label="Money">{money}</div>
      <div className="mono flex flex-col gap-0 text-[11.5px] leading-[16px] lg:flex-row lg:text-[12px] lg:items-baseline lg:justify-between lg:gap-[16px]">
        <span aria-label="Limits"><span className="hidden lg:inline"><span className="text-fg-2">{limitsLabel}</span> {longLimits}</span><span className="lg:hidden">{shortLimits}</span></span>
        <span className="text-fg-2">{scaleNote(x.feedBasis)}</span>
      </div>
      {error ? <p className="text-[12px] text-fault">Error: {error}</p> : null}
    </section>
  );
}

/** The alert line under the header when the terminal is not OK, or the server's kill switch overrides the control. */
function OmegaAlerts({ x }: { x: Derived }) {
  const { conn, br, s } = x;
  const lines: { tone: "fault" | "late"; text: ReactNode; aside?: string }[] = [];
  if (conn.key === "disconnected") {
    const err = str(br.terminal_error);
    lines.push({ tone: "fault", text: err ? `Terminal: ${err}` : `Bridge offline: no sync ${isNum(br.synced_age_ms) ? `for ${shortAge(br.synced_age_ms)}` : "yet"}.`, aside: "rows below are as of the last sync" });
  } else if (conn.key === "algo_off") {
    lines.push({ tone: "late", text: "Algo trading is off in the MT5 terminal: no order can be sent. Turn on Algo Trading in the terminal." });
  }
  if (s.kill === true && s.kill_source === "env") lines.push({ tone: "fault", text: "Server kill switch is on; it overrides this control." });
  if (!lines.length) return null;
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} role="status" className={clsx("flex flex-wrap items-center gap-x-[10px] gap-y-[4px] rounded-[10px] border px-[14px] py-[8px] text-[12.5px]", l.tone === "fault" ? "border-fault-fill/40 bg-fault-fill/8 text-fault" : "border-late-fill/40 bg-late-fill/8 text-late")}>
          <Dot tone={l.tone} /><span className="min-w-0 flex-1">{l.text}</span>{l.aside ? <span className="mono text-[11px] text-fg-2">{l.aside}</span> : null}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- 2. open and resting

const GRID = "lg:grid lg:grid-cols-[118px_100px_80px_44px_80px_80px_80px_70px_minmax(0,1fr)_230px] lg:items-center lg:gap-x-[12px]";

function riskCell(r: Risk | null, sl: unknown, closing: boolean) {
  if (closing) return <span className="text-late">closing</span>;
  if (!(Number(sl) > 0)) return <span className="text-fg-2">no stop</span>;
  if (!r) return <span className="text-fg-2">—</span>;
  if (r.locked) return <>locked +{r.amount.toFixed(2)}</>;
  return <>{r.amount.toFixed(2)}{r.pct != null ? <span className="text-fg-2"> {r.pct}%</span> : null}</>;
}

function ModifyForm({ row, set, act, note }: { row: EditRow; set: (r: EditRow | null) => void; act: OmegaActions; note: string }) {
  const field = (k: "price" | "sl" | "tp", label: string) => (
    <label className="flex items-center gap-[6px] text-fg-2">{label}
      <input inputMode="decimal" className="mono h-[36px] w-[96px] rounded-sm border border-white/15 bg-black/40 px-[6px] text-slate-100 lg:h-[28px]" value={row[k]} placeholder={k === "price" ? undefined : "none"} onChange={(ev) => set({ ...row, [k]: ev.target.value })} />
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-[8px] border-t border-white/6 bg-white/2 px-[14px] py-[8px] text-[11.5px] lg:px-[16px]">
      <span className="text-fg-2">Modify #{row.ticket}:</span>
      {row.target === "order" ? field("price", "Price") : null}
      {field("sl", "S/L")}
      {field("tp", "T/P")}
      <button type="button" disabled={act.hitlBusy} onClick={async () => { if (await act.saveModify(row)) set(null); }} className={btnSm("ok")}>Send</button>
      <span className="text-fg-2">{note}</span>
    </div>
  );
}

function OpenResting({ x, act, now, hitlMsg }: { x: Derived; act: OmegaActions; now: number; hitlMsg: { tone: string; text: string } | null }) {
  const [edit, setEdit] = useState<EditRow | null>(null);
  const { positions, orders, br, delegation, loosened, limitByTicket, digits } = x;
  const tickets = Array.isArray(delegation?.tickets) ? delegation.tickets : [];
  const supported = delegation?.supported === true;
  const killing = x.chip.key === "killed";
  const nPos = positions.length, nOrd = orders.length;
  const manual = positions.filter((p) => sourceOf(p, tickets) === "manual" || sourceOf(p, tickets) === "delegated").length;
  const summary = [nPos ? `${nPos}${manual === nPos ? " manual" : ""} position${nPos === 1 ? "" : "s"}` : "", nOrd ? `${nOrd} ${nOrd === 1 && orders[0]?.type?.endsWith?.("LIMIT") ? "limit" : nOrd === 1 ? "order" : "orders"}` : ""].filter(Boolean).join(" · ");
  const lastDeal = [...x.deals].filter((dd) => isNum(dd.closed_ms)).sort((a, b) => b.closed_ms - a.closed_ms)[0];
  if (!nPos && !nOrd) {
    return (
      <section className={clsx(PANEL, "flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[4px] px-[14px] py-[12px] lg:px-[16px]")} aria-label="Open and resting">
        <span className="flex items-baseline gap-[12px]"><h2 className="m-0 text-[12px] font-semibold text-slate-300">Open &amp; resting</h2><span className="text-[12px] text-fg-2">Nothing open or resting.</span></span>
        {lastDeal ? <span className="mono text-[11.5px] text-fg-2">last close {utcClockOf(lastDeal.closed_ms)} UTC, #{str(lastDeal.position_ticket) || str(lastDeal.deal_ticket)} {signedMoney((isNum(lastDeal.profit) ? lastDeal.profit : 0) + (isNum(lastDeal.commission) ? lastDeal.commission : 0) + (isNum(lastDeal.swap) ? lastDeal.swap : 0))}</span> : null}
      </section>
    );
  }
  const head = x.stops.noStop ? `${summary} · at stops ${x.stops.text}` : summary;
  return (
    <section className={PANEL} aria-label="Open and resting">
      <div className="flex items-center justify-between gap-[12px] px-[14px] pb-[6px] pt-[10px] leading-[15px] lg:px-[16px] lg:pt-[12px]"><h2 className="m-0 text-[12px] font-semibold text-slate-300">Open &amp; resting</h2><span className="mono text-[11.5px] text-fg-2">{head}</span></div>
      <div className={clsx("hidden min-h-[30px] px-[16px] text-[11px] text-muted", GRID)} aria-hidden="true">
        <span>Ticket</span><span>Source</span><span>Side</span><span>Lot</span><span>Entry</span><span>Stop</span><span>Target</span><span>P/L</span><span>Risk at stop</span><span />
      </div>
      {positions.map((p, i) => {
        const ticket = Number(p.ticket);
        const src = sourceOf(p, tickets);
        const isManual = src === "manual" || src === "delegated";
        const isDelegated = src === "delegated";
        const r = riskToSl(p, br);
        const editing = edit?.target === "position" && edit.ticket === ticket;
        const age = isNum(p.opened_ms) && p.opened_ms > 0 ? shortAge(now - p.opened_ms) : "";
        const loose = loosened.includes(ticket) ? <span className="ml-[4px] rounded-sm border border-late-fill/40 px-[4px] text-[10px] font-semibold text-late" title="The Position Council loosened this position's stop once (ADR-0020 Amendment 8). It counts as unprotected again and is never loosened a second time.">loosened once</span> : null;
        const buttons = (
          <span className="flex justify-end gap-[6px] font-sans">
            {isManual ? (
              <button type="button" disabled={act.hitlBusy || (!isDelegated && !supported)} onClick={() => act.delegate(ticket, !isDelegated)} className={btnSm()}
                title={!isDelegated && !supported ? `Needs OmegaExecutor ${str(delegation?.ea_min_version) || "1.18"}` : isDelegated ? "Take this position back: Omega stops managing it" : "Hand this manual position to Omega: it manages it like its own (never adds to it or reverses it)"}>
                {isDelegated ? "Take back" : "Delegate"}
              </button>
            ) : null}
            <button type="button" disabled={act.hitlBusy || !supported} onClick={() => setEdit(editing ? null : { target: "position", ticket, sl: p.sl ? String(p.sl) : "", tp: p.tp ? String(p.tp) : "", price: "" })} className={btnSm()}
              title={supported ? "Change this position's stop and target" : `Needs OmegaExecutor ${str(delegation?.ea_min_version) || "1.18"}`}>{editing ? "Cancel" : "Modify"}</button>
            <button type="button" disabled={act.closingTicket === ticket} className={btnSm("fault")} title="Close at market"
              onClick={() => act.requestClose({ ticket: p.ticket, symbol: str(p.symbol) || str(br.symbol), side: p.side, volume: p.volume, open_price: p.entry ?? p.open_price, profit: p.profit, sl: p.sl, tp: p.tp, currency: x.cur })}>
              {act.closingTicket === ticket ? "Closing…" : "Close"}
            </button>
          </span>
        );
        return (
          <Fragment key={`p${str(p.ticket) || i}`}>
            <div className={clsx("mono hidden min-h-[47px] border-t border-white/6 px-[16px] text-[12.5px]", GRID)} data-row="position">
              <span>#{str(p.ticket)} <span className="text-[11px] text-fg-2">{age}</span></span>
              <span className="font-sans text-fg-2">{src}{loose}</span>
              <span><SideWord side={p.side} /></span>
              <span>{num(p.volume, 2)}</span>
              <span>{num(p.entry ?? p.open_price, digits)}</span>
              <span className={p.sl ? "" : "text-muted"}>{p.sl ? num(p.sl, digits) : "—"}</span>
              <span className={p.tp ? "" : "text-muted"}>{p.tp ? num(p.tp, digits) : "—"}</span>
              <span>{signedMoney(p.profit)}</span>
              <span>{riskCell(r, p.sl, killing)}</span>
              {buttons}
            </div>
            <div className="mono flex flex-col gap-[4px] border-t border-white/6 px-[14px] py-[10px] text-[12.5px] leading-[17px] lg:hidden" data-card="position">
              <div className="flex justify-between gap-[8px]"><span>#{str(p.ticket)} <SideWord side={p.side} /> {num(p.volume, 2)} <span className="font-sans text-fg-2">{src}</span> <span className="text-fg-2">{age}</span>{loose}</span><span>{signedMoney(p.profit)}</span></div>
              <div>{num(p.entry ?? p.open_price, digits)} <span className="text-fg-2">SL</span> {p.sl ? num(p.sl, digits) : "—"} <span className="text-fg-2">TP</span> {p.tp ? num(p.tp, digits) : "—"}</div>
              <div className="flex items-center justify-between gap-[8px]"><span><span className="text-fg-2">risk </span>{riskCell(r, p.sl, killing)}</span>{buttons}</div>
            </div>
            {editing && edit ? <ModifyForm row={edit} set={setEdit} act={act} note={`Empty removes a level.${src === "Omega" || isDelegated ? " Omega keeps managing it and may move the stop again." : ""}`} /> : null}
          </Fragment>
        );
      })}
      {orders.map((o, i) => {
        const ticket = Number(o.ticket);
        const k = orderKind(o.type);
        const src = sourceOf(o, []);
        const r = riskToSl(orderAsPosition(o), br);
        const meta = limitByTicket[String(o.ticket)];
        const exp = isNum(meta?.expiry_ms) && meta.expiry_ms > 0 ? `exp ${utcClockOf(meta.expiry_ms)}` : "";
        const modifiable = ["BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"].includes(str(o.type));
        const editing = edit?.target === "order" && edit.ticket === ticket;
        const kindWord = k.kind.charAt(0).toUpperCase() + k.kind.slice(1);
        const btn = (
          <span className="flex justify-end font-sans">
            <button type="button" disabled={act.hitlBusy || !modifiable || !supported} className={btnSm()}
              onClick={() => setEdit(editing ? null : { target: "order", ticket, price: o.price_open ? String(o.price_open) : "", sl: o.sl ? String(o.sl) : "", tp: o.tp ? String(o.tp) : "" })}
              title={!modifiable ? "Only limit and stop orders" : supported ? "Change this order's price, stop and target" : `Needs OmegaExecutor ${str(delegation?.ea_min_version) || "1.18"}`}>{editing ? "Cancel" : "Modify"}</button>
          </span>
        );
        const vol = num(o.volume_current ?? o.volume_initial, 2);
        return (
          <Fragment key={`o${str(o.ticket) || i}`}>
            <div className={clsx("mono hidden min-h-[47px] border-t border-white/6 px-[16px] text-[12.5px]", GRID)} data-row="order">
              <span><span className="font-sans">{kindWord}</span> #{str(o.ticket)} <span className="text-[11px] text-fg-2">{exp}</span></span>
              <span className="font-sans text-fg-2" title={str(meta?.reason) || undefined}>{src}</span>
              <span className="font-sans"><SideWord side={k.side} /> {k.kind}</span>
              <span>{vol}</span>
              <span>{num(o.price_open, digits)}</span>
              <span className={o.sl ? "" : "text-muted"}>{o.sl ? num(o.sl, digits) : "—"}</span>
              <span className={o.tp ? "" : "text-muted"}>{o.tp ? num(o.tp, digits) : "—"}</span>
              <span className="text-muted">—</span>
              <span>{riskCell(r, o.sl, false)}</span>
              {btn}
            </div>
            <div className="mono flex flex-col gap-[4px] border-t border-white/6 px-[14px] py-[10px] text-[12.5px] leading-[17px] lg:hidden" data-card="order">
              <div className="flex justify-between gap-[8px]"><span><span className="font-sans">{kindWord}</span> #{str(o.ticket)} <SideWord side={k.side} /> {vol} <span className="font-sans text-fg-2">{src}</span></span><span className="text-fg-2">{exp}</span></div>
              <div>{num(o.price_open, digits)} <span className="text-fg-2">SL</span> {o.sl ? num(o.sl, digits) : "—"} <span className="text-fg-2">TP</span> {o.tp ? num(o.tp, digits) : "—"}</div>
              <div className="flex items-center justify-between gap-[8px]"><span><span className="text-fg-2">risk </span>{riskCell(r, o.sl, false)}</span>{btn}</div>
            </div>
            {editing && edit ? <ModifyForm row={edit} set={setEdit} act={act} note={`${src === "manual" ? "Your order." : "Omega's order."} Empty S/L or T/P removes it.`} /> : null}
          </Fragment>
        );
      })}
      {hitlMsg ? <p className={clsx("border-t border-white/6 px-[14px] py-[8px] text-[11.5px] lg:px-[16px]", hitlMsg.tone)}>{hitlMsg.text}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- 3. the signal and what Omega did

function SignalLineView({ x, now }: { x: Derived; now: number }) {
  const sl = signalLine(x.s, x.feedBasis, now);
  const v = verdict({ codes: x.codes, envEnabled: x.e.env_enabled, resting: x.resting ? { ticket: x.resting.ticket, price: x.resting.price } : null, reason: (c) => omegaReason(c, x.e.env_enabled) });
  const since = isNum(x.b.planner?.since_ms) && x.b.planner.since_ms > 0 ? `${utcClockOf(x.b.planner.since_ms)} UTC` : "";
  const aside = v.kind === "block" ? v.code : since;
  const feed = sl.scale === "feed" ? <span className="text-fg-2"> feed</span> : null;
  return (
    <section className={clsx(PANEL, "flex flex-col gap-[2px] px-[14px] py-[10px] text-[13px] leading-[20px] lg:min-h-[54px] lg:flex-row lg:items-center lg:gap-[14px] lg:px-[16px] lg:py-[8px] lg:text-[13.5px]")} aria-label="Signal">
      <span className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px] lg:shrink-0 lg:flex-nowrap lg:whitespace-nowrap">
        <span className="text-[12px] text-fg-2">Signal</span>
        {sl.side ? (
          <>
            <span><SideWord side={sl.side} /> {sl.kind} {sl.entry != null ? <span className="mono">{sl.entry.toFixed(2)}</span> : null}{sl.zone ? null : feed}</span>
            {sl.zone ? <span><span className="text-fg-2">zone</span> <span className="mono">{zoneText(sl.zone)}</span>{feed}</span> : null}
            {sl.expires ? <span className="text-fg-2">{sl.expires}</span> : null}
          </>
        ) : <b className="font-semibold text-late">WAIT</b>}
      </span>
      <span className="hidden w-px self-stretch bg-white/10 lg:my-1.5 lg:block" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 items-start gap-[8px] lg:items-center">
        <span className="mt-[6px] lg:mt-0"><Dot tone={v.tone} /></span>
        <span className="min-w-0 flex-1" title={v.code ?? undefined}>{v.text}{aside ? <span className="mono ml-[8px] text-[11px] text-fg-2 lg:hidden">{aside}</span> : null}</span>
      </span>
      {aside ? <span className="mono hidden shrink-0 text-[11.5px] text-fg-2 lg:inline">{aside}</span> : null}
    </section>
  );
}

// ---------------------------------------------------------------- 4. the last actions

function LastActions({ d }: { d: any }) {
  const acts = lastActions(d, 5);
  return (
    <section className={clsx(PANEL, "pb-[2px] lg:pb-[6px]")} aria-label="Last actions">
      <div className="flex items-center justify-between px-[14px] pb-[6px] pt-[10px] leading-[15px] lg:px-[16px] lg:pb-[8px] lg:pt-[12px]"><h2 className="m-0 text-[12px] font-semibold text-slate-300">Last actions</h2><span className="mono text-[11.5px] text-fg-2"><span>UTC</span><span className="hidden lg:inline"> · GMT+7</span></span></div>
      {!acts.length ? <p className="border-t border-white/6 px-[14px] py-[8px] text-[12px] text-fg-2 lg:px-[16px]">No actions yet.</p> : null}
      {acts.map((a, i) => (
        <div key={`${a.ms}-${i}`} className="grid grid-cols-[42px_1fr] items-baseline gap-x-[10px] border-t border-white/6 px-[14px] py-[7px] text-[12px] leading-[17px] lg:leading-[16px] lg:grid-cols-[52px_52px_130px_1fr] lg:px-[16px]">
          <span className="mono">{a.utc}</span>
          <span className="mono hidden text-fg-2 lg:inline">{a.gmt7}</span>
          <span className={clsx("hidden lg:inline", a.fault ? "text-fault" : "")}>{a.verb}</span>
          <span className="mono">
            <span className={clsx("font-sans lg:hidden", a.fault ? "text-fault" : "")}>{a.verb} </span>
            {a.ticket != null ? `#${a.ticket} ` : ""}{a.side ? <><SideWord side={a.side} />{" "}</> : null}{a.lot != null ? `${a.lot.toFixed(2)} ` : ""}{a.price != null ? `at ${a.price.toFixed(2)} ` : ""}
            {a.extra ? <span className={/^[+−]|^0\.00$/.test(a.extra) || /^(SL|TP) /.test(a.extra) ? "" : "text-fg-2"}>{a.extra}</span> : null}
          </span>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- Details

const KV = "grid grid-cols-[118px_1fr] gap-x-[10px] gap-y-[5px] text-[12px] lg:grid-cols-[150px_1fr] lg:gap-x-[12px]";
const DSEC = clsx(PANEL, "px-[14px] py-[12px] lg:px-[16px]");
const DH = "mb-[10px] flex items-center justify-between gap-[8px]";
const H2 = "m-0 text-[12px] font-semibold text-slate-300";

function Details({ x, act, now, hitlMsg }: { x: Derived; act: OmegaActions; now: number; hitlMsg: { tone: string; text: string } | null }) {
  const [tab, setTab] = useState<DetailsTab>("intents");
  const [raw, setRaw] = useState(false);
  const { data, s, c, b, br, st, account, positions, orders, intents, deals, digits, delegation, limitByTicket } = x;
  const tickets = Array.isArray(delegation?.tickets) ? delegation.tickets : [];
  const events = arr(b.events), ctlEvents = arr(data.control_events);
  const watchdog = b.autonomous_watchdog != null && typeof b.autonomous_watchdog === "object" ? b.autonomous_watchdog : null;
  const tm = obj(b.trading_mode);
  const statsRow = (label: string, v: any) => {
    const z = obj(v);
    return <><dt className="text-fg-2">{label}</dt><dd className="mono">{signedMoney(z.net)} <span className="text-fg-2">{isNum(z.trades) ? z.trades : 0} trades · win {isNum(z.win_rate) ? `${Math.round(z.win_rate * 100)}%` : "—"} · PF {isNum(z.profit_factor) ? z.profit_factor : "—"} · DD {num(z.max_drawdown)}</span></dd></>;
  };
  const exec = obj(br.executor);
  const nextEv = b.macro_risk?.next_event;
  const nextMs = Date.parse(str(nextEv?.time));
  return (
    <div className="flex flex-col gap-[14px]" aria-label="Details content">
      <OmegaChart digits={digits} bid={br.bid} positions={positions} feedBasis={x.feedBasis} limit={x.resting ? { price: x.resting.price, side: x.resting.side, zone: x.resting.zone, ticket: x.resting.ticket } : null} signal={s} />
      <div className="grid gap-[14px] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-[14px]">
          <section className={DSEC} aria-label="Positions and orders">
            <div className={clsx(DH, "flex-wrap")}>
              <h2 className={H2}>Positions and orders</h2>
              {/* Delegate (owner 2026-11-19): every new manual position handed to Omega while this is on. */}
              <label className="inline-flex items-center gap-[8px] text-[12px] text-slate-300" title="Every manual position opened while this is on is handed to Omega: a stop from the plan when it has none, break-even, the TP ladder, the Position Manager and the closes on an opposite signal. Omega never adds to it or reverses it.">
                <input type="checkbox" className="h-[16px] w-[16px] accent-cyan-400" disabled={act.hitlBusy || delegation?.supported !== true} checked={delegation?.mode?.on === true} onChange={(ev) => act.delegateMode(ev.target.checked)} />
                Delegate my next manual entries to Omega
              </label>
            </div>
            {delegation?.mode?.on === true && isNum(delegation?.mode?.since_ms) ? <p className="mb-[8px] text-[11px] text-fg-2">On since {timeUtc(delegation.mode.since_ms)}.</p> : null}
            {delegation && delegation.supported === false ? <p className="mb-[8px] text-[11px] text-late">Modify and Delegate need OmegaExecutor {str(delegation.ea_min_version) || "1.18"} on the terminal.</p> : null}
            {!positions.length && !orders.length ? <p className="text-[12px] text-fg-2">No open positions or pending orders.</p> : (
              <>
              {/* On a phone one card each (the mockup's 390 Details); from lg the table. */}
              <div className="flex flex-col lg:hidden">
                {positions.map((p, i) => (
                  <div key={`cp${i}`} className="mono border-t border-white/6 py-[10px] text-[12px] leading-[1.55]">
                    <div className="flex justify-between gap-2"><span>#{str(p.ticket)} <SideWord side={p.side} /> {num(p.volume, 2)}</span><span className="font-sans text-fg-2">{sourceOf(p, tickets)}</span></div>
                    <div className="text-fg-2">opened {dayClock(p.opened_ms)} UTC · intent {str(p.intent_id) || str(p.signal_id) || "—"}</div>
                  </div>
                ))}
                {orders.map((o, i) => { const k = orderKind(o.type); const m = limitByTicket[String(o.ticket)]; return (
                  <div key={`co${i}`} className="mono border-t border-white/6 py-[10px] text-[12px] leading-[1.55]">
                    <div className="flex justify-between gap-2"><span><span className="font-sans">{k.kind.charAt(0).toUpperCase() + k.kind.slice(1)}</span> #{str(o.ticket)} <SideWord side={k.side} /> {num(o.volume_current ?? o.volume_initial, 2)}</span><span className="font-sans text-fg-2">{sourceOf(o, [])}</span></div>
                    <div className="text-fg-2">placed {dayClock(o.placed_ms)} UTC{m ? ` · ${str(m.status) || "resting"}` : ""}{isNum(m?.expiry_ms) && m.expiry_ms > 0 ? ` · expires ${utcClockOf(m.expiry_ms)}` : ""} · intent {str(o.comment) || "—"}</div>
                  </div>
                ); })}
              </div>
              <div className="table-wrap hidden lg:block">
                <table className="tbl mono [&_td]:px-[8px] [&_th]:px-[8px]">
                  <thead><tr><th>Ticket</th><th>Source</th><th>Opened UTC</th><th>Side</th><th>Lot</th><th>Entry</th><th>Stop</th><th>Target</th><th>P/L</th><th>Risk at stop</th><th>Intent</th></tr></thead>
                  <tbody>
                    {positions.map((p, i) => (
                      <tr key={`dp${i}`}>
                        <td>#{str(p.ticket)}</td><td className="font-sans">{sourceOf(p, tickets)}</td><td>{dayClock(p.opened_ms)}</td><td><SideWord side={p.side} /></td><td>{num(p.volume, 2)}</td>
                        <td>{num(p.entry ?? p.open_price, digits)}</td><td className={p.sl ? "" : "text-muted"}>{p.sl ? num(p.sl, digits) : "—"}</td><td className={p.tp ? "" : "text-muted"}>{p.tp ? num(p.tp, digits) : "—"}</td>
                        <td>{signedMoney(p.profit)}</td><td>{riskCell(riskToSl(p, br), p.sl, false)}</td><td className="text-fg-2">{str(p.intent_id) || str(p.signal_id) || "—"}</td>
                      </tr>
                    ))}
                    {orders.map((o, i) => { const k = orderKind(o.type); return (
                      <tr key={`do${i}`}>
                        <td>#{str(o.ticket)}</td><td className="font-sans">{sourceOf(o, [])}</td><td>{dayClock(o.placed_ms)}</td><td className="font-sans"><SideWord side={k.side} /> {k.kind}</td><td>{num(o.volume_current ?? o.volume_initial, 2)}</td>
                        <td>{num(o.price_open, digits)}</td><td className={o.sl ? "" : "text-muted"}>{o.sl ? num(o.sl, digits) : "—"}</td><td className={o.tp ? "" : "text-muted"}>{o.tp ? num(o.tp, digits) : "—"}</td>
                        <td className="text-muted">—</td><td>{riskCell(riskToSl(orderAsPosition(o), br), o.sl, false)}</td><td className="text-fg-2">{str(o.comment) || "—"}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
              </div>
              </>
            )}
            {orders.filter((o) => limitByTicket[String(o.ticket)]).map((o, i) => { const m = limitByTicket[String(o.ticket)]; return (
              <p key={`n${i}`} className="mono mt-[8px] text-[11px] text-fg-2">#{str(o.ticket)} {str(m.status) || "resting"}{isNum(m.expiry_ms) && m.expiry_ms > 0 ? ` · expires ${utcClockOf(m.expiry_ms)} UTC` : ""} · {str(m.reason) || "no council note"}.</p>
            ); })}
            {hitlMsg ? <p className={clsx("mt-[8px] text-[11.5px]", hitlMsg.tone)}>{hitlMsg.text}</p> : null}
          </section>

          <section className={DSEC} aria-label="History, intents and journal">
            <div className="mb-[10px] flex overflow-hidden rounded-[7px] border border-white/12 lg:w-fit" role="tablist" aria-label="Details tables">
              {([["history", `History ${deals.length}`], ["intents", `Intents ${intents.length}`], ["journal", `Journal ${events.length + ctlEvents.length}`]] as [DetailsTab, string][]).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={clsx("h-[40px] flex-1 px-[12px] text-[12px] font-medium lg:h-[30px] lg:flex-none", tab === k ? "bg-white/8 text-fg" : "text-fg-2 hover:text-fg")}>{label}</button>
              ))}
            </div>
            {tab === "history" ? (!deals.length ? <Empty>No closed deals.</Empty> : (
              <div className="table-wrap max-h-[440px] overflow-y-auto">
                <table className="tbl mono [&_td]:px-[8px] [&_th]:px-[8px]">
                  <thead><tr><th>Closed UTC</th><th>Deal</th><th>Source</th><th>Side</th><th>Lot</th><th>Entry</th><th>Exit</th><th>Net P/L</th><th>Reason</th><th>Mode</th><th>Signal</th></tr></thead>
                  <tbody>
                    {deals.map((dd, i) => {
                      const net = (isNum(dd.profit) ? dd.profit : 0) + (isNum(dd.commission) ? dd.commission : 0) + (isNum(dd.swap) ? dd.swap : 0);
                      return (
                        <tr key={str(dd.deal_ticket) || i}>
                          <td>{dayClock(dd.closed_ms)}</td><td>#{str(dd.deal_ticket) || "—"}</td><td className="font-sans">{sourceOf({ ...dd, intent_id: dd.signal_id }, [])}</td><td><SideWord side={dd.side} /></td><td>{num(dd.volume, 2)}</td>
                          <td>{num(dd.entry_price, digits)}</td><td>{num(dd.exit_price, digits)}</td><td>{signedMoney(net)}</td><td>{str(dd.reason) || "closed"}</td><td className="text-fg-2">{str(dd.mode) || "live"}</td><td className="text-fg-2">{str(dd.signal_id) || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )) : null}
            {tab === "intents" ? (!intents.length ? <Empty>No intents yet.</Empty> : (
              <>
                {/* EZ1: on a phone one card per intent; from sm up the table. Every price is the broker's. */}
                <IntentCards intents={intents} digits={digits} />
                <div className="table-wrap hidden max-h-[440px] overflow-y-auto sm:block">
                  <table className="tbl [&_td]:px-[8px] [&_th]:px-[8px]">
                    <thead><tr><th>Created</th><th>Kind</th><th>Side</th><th>Lot</th><th>Entry · broker</th><th>SL · broker</th><th>TP · broker</th><th>Status</th><th>Result</th></tr></thead>
                    <tbody>
                      {intents.map((i, k) => (
                        <tr key={str(i.id) || k} title={str(i.id) || undefined}>
                          <td className="mono"><CreatedCell ms={i.created_ms} /></td>
                          <td className="mono">{str(i.kind) || "—"}</td>
                          <td className="mono"><SideWord side={i.side} />{i.side !== "BUY" && i.side !== "SELL" ? "—" : null}</td>
                          <td className="mono">{isNum(i.lot) ? num(i.lot, 2) : isNum(i.volume) ? num(i.volume, 2) : "—"}</td>
                          <td className="mono"><IntentEntry i={i} digits={digits} /></td>
                          <td className="mono">{isNum(i.sl) ? num(i.sl, digits) : "—"}</td>
                          <td className="mono">{isNum(i.tp) ? num(i.tp, digits) : "—"}</td>
                          <td><Badge tone={INTENT_TONE[str(i.status)] || "slate"}>{str(i.status) || "—"}</Badge></td>
                          <td className="mono text-[11px]">{i.result && typeof i.result === "object" ? (i.result.ok ? `ticket ${str(i.result.ticket) || "?"}` : str(i.result.error) || "failed") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )) : null}
            {tab === "journal" ? (!events.length && !ctlEvents.length ? <Empty>No events logged yet.</Empty> : (
              <div className="table-wrap max-h-[440px] overflow-y-auto">
                <table className="tbl">
                  <thead><tr><th>Time UTC</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
                  <tbody>
                    {events.map((ev, i) => (
                      <tr key={`e${i}`}><td className="mono">{dayClock(ev.ms)}</td><td className="mono">{str(ev.actor) || "—"}</td><td className="mono">{str(ev.action) || "—"}</td><td className="mono text-[11px] text-fg-2">{ev.detail != null ? JSON.stringify(ev.detail).slice(0, 160) : "—"}</td></tr>
                    ))}
                    {ctlEvents.map((ev, i) => (
                      <tr key={`c${i}`}><td className="mono">{dayClock(Date.parse(str(ev.at)))}</td><td className="mono">{str(ev.actor) || "—"}</td><td className="mono">{`${str(ev.previous_mode) || "—"} → ${str(ev.mode) || "—"}`}</td><td className="text-[11px] text-fg-2">{str(ev.reason) || "—"}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )) : null}
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-[14px]">
          <section className={DSEC} aria-label="Signal fields">
            <div className={DH}><h2 className={H2}>Signal</h2></div>
            <SignalRows s={s} />
            <div className="mt-[12px] border-t border-white/6 pt-[10px]">
              <OmegaWhy codes={x.codes} sinceMs={isNum(b.planner?.since_ms) ? b.planner.since_ms : null} details={b.planner?.details && typeof b.planner.details === "object" ? b.planner.details : null} envEnabled={x.e.env_enabled} />
            </div>
          </section>

          <section className={DSEC} aria-label="Account and stats">
            <div className={DH}><h2 className={H2}>Account and stats</h2><span className="mono text-[11px] text-fg-2">{x.cur}</span></div>
            <dl className={KV}>
              <dt className="text-fg-2">Balance</dt><dd className="mono">{amount(br.balance)}</dd>
              <dt className="text-fg-2">Day start</dt><dd className="mono">{amount(br.day_start_balance)}</dd>
              <dt className="text-fg-2">Trading mode</dt><dd className="mono">{str(tm.mode) ? <>{str(tm.mode).charAt(0).toUpperCase() + str(tm.mode).slice(1)} <span className="text-fg-2">{tm.auto ? "auto" : "pinned"}</span></> : "—"}</dd>
              <dt className="text-fg-2">Profile</dt><dd className="mono">{account ? <>{str(account.profile_label) || "—"} <span className="text-fg-2">risk {x.appliedRisk ?? "—"}% · {x.appliedPositions ?? "—"} positions · daily loss {x.appliedDaily ?? "—"}%</span></> : "—"}</dd>
              {statsRow("Today", st.today)}
              {statsRow("7 days", st.week)}
              {statsRow("30 days", st.month)}
              <dt className="text-fg-2">Control</dt><dd className="mono">{c.mode === "paused" ? "Paused" : c.mode === "killed" ? "Killed" : "Active"}{controlMeta(c) ? <span className="text-fg-2"> {Number.isFinite(Date.parse(str(c.at))) ? `since ${utcClockOf(Date.parse(str(c.at)))} UTC` : ""}{str(c.actor) ? `, ${str(c.actor)}` : ""}{str(c.reason) ? `: ${str(c.reason)}` : ""}</span> : null}</dd>
            </dl>
          </section>

          <section className={DSEC} aria-label="Symbol and account">
            <div className={DH}>
              <h2 className={H2}>Symbol and account</h2>
              <span className="mono text-[11px] text-fg-2">
                {account ? <span aria-label="Broker spec check" title={str(account.spec_text) || undefined} className={account.spec_status === "validated" ? "" : "text-late"}>spec {str(account.spec_status) || "unknown"}</span> : null}
                {br.ea_version_gate ? <span aria-label="EA version gate" title={`EA version gate ${br.ea_version_gate.on ? "on" : "off"}: new entries need OmegaExecutor ${str(br.ea_version_gate.min_version)} or later.`} className={br.ea_version_gate.met ? "" : "text-fault"}> · EA {str(exec.version) || "?"}{br.ea_version_gate.met ? "" : ` < ${str(br.ea_version_gate.min_version)}`}</span> : null}
              </span>
            </div>
            <dl className={KV}>
              <dt className="text-fg-2">Symbol</dt><dd className="mono">{str(br.symbol) || "—"}{br.symbol_check ? <span className={clsx("block font-sans text-[11px]", br.symbol_check.ok ? "text-fg-2" : "text-fault")} aria-label="Trade symbol check">{str(br.symbol_check.text) || (br.symbol_check.ok ? "verified" : "not verified")}{str(br.symbol_check.chart_symbol) ? ` · chart ${str(br.symbol_check.chart_symbol)}` : ""}</span> : null}</dd>
              <dt className="text-fg-2">Digits / point</dt><dd className="mono">{str(br.digits) || "—"} / {str(br.point) || "—"}</dd>
              <dt className="text-fg-2">Tick size / value</dt><dd className="mono">{str(br.tick_size) || "—"} / {isNum(br.tick_value) ? num(br.tick_value, 2) : "—"}</dd>
              <dt className="text-fg-2">Volume min / max / step</dt><dd className="mono">{str(br.volume_min) || "—"} / {str(br.volume_max) || "—"} / {str(br.volume_step) || "—"}</dd>
              <dt className="text-fg-2">Stops / freeze level</dt><dd className="mono">{str(br.stops_level_points) || "—"} / {str(br.freeze_level_points) || "—"} pts</dd>
              <dt className="text-fg-2">Profit currency / contract</dt><dd className="mono">{str(br.symbol_check?.currency_profit) || "—"} / {isNum(br.symbol_check?.contract_size) ? `${br.symbol_check.contract_size} oz` : "—"}</dd>
              <dt className="text-fg-2">Leverage / margin</dt>
              <dd className="mono">{!isNum(Number(br.leverage)) || br.leverage == null ? "—" : Number(br.leverage) >= LEVERAGE_UNLIMITED_FROM
                ? <span title={`The broker reports 1:${Number(br.leverage).toLocaleString("en-US")}: unlimited or unknown leverage. Sizing never uses leverage; the margin is the broker's OrderCheck answer.`}>unlimited</span>
                : `1:${Number(br.leverage).toLocaleString("en-US")}`} / {str(br.margin_mode) || "—"}</dd>
              <dt className="text-fg-2">Margin per lot</dt><dd className="mono">{isNum(br.margin_per_lot) ? num(br.margin_per_lot, 2) : "—"}</dd>
              <dt className="text-fg-2">Trade mode</dt><dd className="mono">{str(br.symbol_trade_mode) || "—"}</dd>
            </dl>
          </section>

          <section className={DSEC} aria-label="Diagnostics">
            <div className={DH}><h2 className={H2}>Diagnostics</h2><button type="button" onClick={() => setRaw((v) => !v)} className={btnSm()} aria-expanded={raw}>{raw ? "Hide raw state" : "Show raw state"}</button></div>
            <dl className={KV}>
              <dt className="text-fg-2">Bridge</dt><dd className="mono">{br.seen === true ? `synced ${agoMs(br.synced_age_ms)}` : isNum(br.synced_age_ms) ? `last seen ${agoMs(br.synced_age_ms)}` : "never seen"}{str(br.bridge_version) ? ` · v${str(br.bridge_version)}` : ""}</dd>
              <dt className="text-fg-2">Key id</dt><dd className="mono">{str(br.kid) || "—"}</dd>
              <dt className="text-fg-2">Terminal state</dt><dd className="mono">{isNum(br.state_age_ms) ? `${shortAge(br.state_age_ms)} old` : "none"} · {br.trade_allowed === true ? "algo allowed" : "algo off"}</dd>
              <dt className="text-fg-2">EA</dt><dd className="mono" title={str(exec.note) || undefined}>OmegaExecutor {str(exec.version) || "?"} · {exec.status === "ok" ? "stops by Omega" : exec.status === "local_management" ? "local trailing on" : exec.status === "outdated" ? "update the EA" : "not reported"}</dd>
              <dt className="text-fg-2">Last recovery</dt><dd className="mono">{watchdog?.last_recovery && isNum(watchdog.last_recovery.ms) ? `${str(watchdog.last_recovery.directive) || "recovery"} · ${str(watchdog.last_recovery.reason)} · ${timeUtc(watchdog.last_recovery.ms)}` : "none"}</dd>
              <dt className="text-fg-2">Next event</dt><dd className="mono">{nextEv && str(nextEv.title) ? `${str(nextEv.title)}${Number.isFinite(nextMs) ? ` ${utcClockOf(nextMs)} UTC` : ""}${str(nextEv.impact) ? `, ${str(nextEv.impact)}` : ""}` : "none in 24 h"}</dd>
            </dl>
            <div className="mt-[10px] border-t border-white/6 pt-[10px]">
              <p className="mb-[6px] text-[11px] text-fg-2">Config <span className="ml-[4px] rounded-sm border border-off-fill/35 px-[4px] text-[10.5px] text-off">fixed values, not measured</span></p>
              <dl className={KV}>
                <dt className="text-fg-2">Watchdog policy</dt><dd className="mono">{str(watchdog?.policy) || "—"}</dd>
                <dt className="text-fg-2">Watchdog agent</dt><dd className="mono">{str(watchdog?.agent) || "—"}</dd>
                <dt className="text-fg-2">Cooldown</dt><dd className="mono">{isNum(watchdog?.anti_flapping_cooldown_sec) ? `${watchdog.anti_flapping_cooldown_sec} s` : "—"}</dd>
                <dt className="text-fg-2">Route failover</dt><dd className="mono">{str(b.route?.failover) || "—"}</dd>
              </dl>
            </div>
            {raw ? (
              <pre className="mono mt-[10px] max-h-56 overflow-auto rounded-sm border border-white/10 bg-black/60 p-[12px] text-[11px] text-slate-300">
                {JSON.stringify({
                  terminal_connected: br.terminal_connected ?? null, trade_allowed: br.trade_allowed ?? null, terminal_error: br.terminal_error ?? null, server: br.server ?? null, trade_mode: br.trade_mode ?? null, currency: br.currency ?? null, cent: br.cent === true,
                  balance: br.balance ?? null, equity: br.equity ?? null, day_start_balance: br.day_start_balance ?? null, day_realized_pl: br.day_realized_pl ?? null,
                  symbol: { name: br.symbol ?? null, bid: br.bid ?? null, ask: br.ask ?? null, spread_points: br.spread_points ?? null, digits: br.digits ?? null, point: br.point ?? null, tick_size: br.tick_size ?? null, tick_value: br.tick_value ?? null, volume_min: br.volume_min ?? null, volume_max: br.volume_max ?? null, volume_step: br.volume_step ?? null, stops_level_points: br.stops_level_points ?? null },
                  positions, orders, state_age_ms: br.state_age_ms ?? null, bridge_sync_age_ms: br.synced_age_ms ?? null, kid: br.kid ?? null, autonomous_watchdog: watchdog,
                }, null, 2)}
              </pre>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * The Terminal view (OM-LEAN), pure over one GET /omega/api/overview body: the four blocks and the Details disclosure.
 * `now` is the clock its ages and expiries are read against; the render check passes a fixed one.
 */
export function OmegaTerminal({ x, d, act, now, initialDetails = false, hitlMsg = null }: { x: Derived; d: any; act: OmegaActions; now: number; initialDetails?: boolean; hitlMsg?: { tone: string; text: string } | null }) {
  const [open, setOpen] = useState(initialDetails);
  const nDeals = x.deals.length, nIntents = x.intents.length, nJournal = arr(x.b.events).length + arr(x.data.control_events).length;
  return (
    <>
      <OpenResting x={x} act={act} now={now} hitlMsg={hitlMsg} />
      <SignalLineView x={x} now={now} />
      <LastActions d={d} />
      <button type="button" aria-expanded={open} aria-controls="omega-details" onClick={() => setOpen((v) => !v)} id="omega-details-toggle"
        className={clsx(PANEL, "flex min-h-[48px] w-full items-center gap-[12px] px-[14px] text-left text-[12.5px] font-semibold text-fg lg:min-h-[46px] lg:px-[16px]")}>
        <ChevronRight className={clsx("h-[12px] w-[12px] shrink-0 text-fg-2 transition", open ? "rotate-90" : "")} aria-hidden="true" />
        Details
        <span className="min-w-0 truncate font-normal text-fg-2">
          {open ? "Hide" : <><span className="hidden lg:inline">chart, all positions and orders, history {nDeals}, intents {nIntents}, journal {nJournal}, signal fields, account, symbol, diagnostics</span><span className="lg:hidden">chart, tables, history, diagnostics</span></>}
        </span>
      </button>
      {open ? <div id="omega-details"><Details x={x} act={act} now={now} hitlMsg={hitlMsg} /></div> : null}
    </>
  );
}

/** Derived values with the header's "At stops" text (positions only). */
function deriveAll(d: any, now: number) {
  const x = derive(d, now);
  const stops = atStops(x.positions, x.br);
  return { ...x, stops, atStopsText: stops.text };
}

/**
 * The lean page over one overview body, for the render check (scripts/render-entry.tsx): the header, the alert lines,
 * the four blocks and, with `details`, the Details content. No request, no-op actions, a fixed clock.
 */
export function OmegaLeanView({ d, now, details = false, act = NOOP_ACTIONS }: { d: any; now: number; details?: boolean; act?: OmegaActions }) {
  const x = deriveAll(d, now);
  return (
    <div className="flex flex-col gap-[10px] lg:gap-[14px]">
      <OmegaHeader x={x} view="terminal" act={act} now={now} error={null} attention="" />
      <OmegaAlerts x={x} />
      <OmegaTerminal x={x} d={d} act={act} now={now} initialDetails={details} />
    </div>
  );
}

export default function Omega() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A deep link (the profile agent's Telegram line): #setup/profile opens Setup → Risk profile.
  const hashTab = typeof window !== "undefined" ? (window.location.hash.match(/^#setup(?:\/(engine|profile|connection))?$/) ?? null) : null;
  const [viewMode, setViewMode] = useState<"terminal" | "setup">(hashTab ? "setup" : "terminal");
  const [setupTab, setSetupTab] = useState<"engine" | "profile" | "connection">((hashTab?.[1] as "engine" | "profile" | "connection" | undefined) ?? "engine");
  const engineDirtyRef = useRef(false);
  const serverInitRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(t); }, []);

  const [busy, setBusy] = useState(false);
  const [closingTicket, setClosingTicket] = useState<number | null>(null);
  // Human-AI interaction (owner 2026-11-19): the owner's edit of a position or pending order, and delegation to Omega.
  const [hitlBusy, setHitlBusy] = useState(false);
  const [hitlMsg, setHitlMsg] = useState<{ tone: string; text: string } | null>(null);
  const [controlMsg, setControlMsg] = useState<{ tone: string; text: string } | null>(null);
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
    setNow(Date.now());
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
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const t = window.setInterval(load, push.live ? 60_000 : 8_000);
    return () => window.clearInterval(t);
  }, [push.live]);

  /** Pause, kill (typed KILL) or resume, with the reason the server requires to pause or kill. */
  const sendControl = async (mode: "active" | "paused" | "killed", reasonText: string, confirm?: string): Promise<boolean> => {
    const reason = reasonText.trim();
    if (mode !== "active" && !reason) {
      setControlMsg({ tone: "text-late", text: "Write a reason first." });
      return false;
    }
    setBusy(true);
    setControlMsg({ tone: "text-slate-300", text: "Sending…" });
    let ok = false;
    try {
      await omegaJson("/omega/api/control", "POST", { mode, reason, confirm });
      setControlMsg({ tone: "text-ok", text: `Control set to ${mode}; applied at next EA poll.` });
      ok = true;
    } catch (e: any) {
      setControlMsg({ tone: "text-fault", text: `Refused: ${e?.message || "failed"}` });
    } finally {
      setBusy(false);
      await load();
    }
    return ok;
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

  const saveEngine = async (extra: Record<string, unknown> = {}): Promise<boolean> => {
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
    let ok = false;
    try {
      await omegaJson("/omega/api/settings", "POST", body);
      setEngineDirty(false);
      setEngineMsg({
        tone: "text-ok",
        text: extra.live_armed === true ? "Live armed." : extra.live_armed === false ? "Live disarmed." : "Saved.",
      });
      ok = true;
    } catch (e: any) {
      setEngineMsg({ tone: "text-fault", text: `Refused: ${e?.message || "failed"}` });
    }
    await load();
    return ok;
  };

  const lvl = (v: string) => (v.trim() === "" ? null : Number(v));
  const saveModify = async (editRow: EditRow): Promise<boolean> => {
    const body = { target: editRow.target, ticket: editRow.ticket, sl: lvl(editRow.sl), tp: lvl(editRow.tp), ...(editRow.target === "order" ? { price: lvl(editRow.price) } : {}) };
    if ([body.sl, body.tp, (body as any).price].some((v) => v != null && !(Number.isFinite(v) && v >= 0))) { setHitlMsg({ tone: "text-fault", text: "Prices only (empty removes a level)." }); return false; }
    setHitlBusy(true);
    try {
      await omegaJson("/omega/api/position/modify", "POST", body);
      setHitlMsg({ tone: "text-ok", text: `Modify sent for #${editRow.ticket}; the EA applies it at the next sync.` });
      await load();
      return true;
    } catch (err: any) {
      setHitlMsg({ tone: "text-fault", text: `Modify refused for #${editRow.ticket}: ${err?.message || "error"}` });
      return false;
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
      setControlMsg({ tone: "text-ok", text: `Close sent for #${ticket}.` });
      setExitModalPosition(null);
      await load();
    } catch (err: any) {
      setControlMsg({ tone: "text-fault", text: `Close failed for #${ticket}: ${err?.message || "error"}` });
    } finally {
      setClosingTicket(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-2.5 py-2.5 sm:px-6 sm:py-5">
        <Panel title="Omega">
          <Skeleton rows={5} />
        </Panel>
      </div>
    );
  }

  const x = deriveAll(data, now);
  const { e, br, account, entryOrder } = x;
  const b = data?.broker || null;
  const conn = b?.connection || {};
  const canControl = Boolean(data?.viewer?.can_control);
  const digits = x.digits;
  // Every amount is in US dollars once the account's units per dollar are known; otherwise the account's own currency.
  const acctCur = Number(account?.money?.units_per_usd) > 0 ? "USD" : (br.currency || "");
  const symbolName = br.symbol || "symbol not reported";
  const serverName = br.server || conn.server || "no server";
  // A proposal waiting for the owner, or a downgrade waiting for the council: a badge on Setup and on its Risk profile tab.
  const profileAttention = account?.pending_upgrade?.to && !(account.pending_upgrade.expires_ms && account.pending_upgrade.expires_ms <= Date.now())
    ? `The profile agent proposes ${account.pending_upgrade.to}` : account?.pending_downgrade?.to ? "A downgrade is waiting for the profile council" : "";

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
  // The broker as the terminal names itself (OmegaExecutor 1.19 ACCOUNT_COMPANY): never a server's name.
  const brokerName: string = br.broker || "MT5 broker";
  // The connected account as the terminal describes it (currency, cent or not, gold symbol): never a server or an id.
  const accountLabel: string = account?.identity?.label || (br.terminal_connected ? "MT5 account" : "no account");
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

  const act: OmegaActions = {
    canControl, busy, hitlBusy, closingTicket,
    sendControl,
    // The header's Engine switch saves at once, as the old toolbar's Algo Trading button did.
    setEngine: (on) => { setEEnabled(on); saveEngine({ enabled: on }); },
    armLive: () => saveEngine({ live_armed: true, confirm: "LIVE" }),
    disarmLive: () => { saveEngine({ live_armed: false }); },
    saveModify, delegate, delegateMode,
    requestClose: (pos) => setExitModalPosition(pos),
    setView: setViewMode,
  };
  const notice = controlMsg ?? (engineMsg && viewMode === "terminal" ? engineMsg : null);

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-[10px] px-[10px] pb-[10px] pt-[7px] sm:px-6 sm:py-5 lg:gap-[14px] lg:px-[24px] lg:pb-[22px] lg:pt-[21px]">
      <OmegaHeader x={x} view={viewMode} act={act} now={now} error={error} attention={profileAttention} />
      {notice ? <p role="status" className={clsx("px-1 text-[11.5px]", notice.tone)}>{notice.text}</p> : null}
      <OmegaAlerts x={x} />
      {viewMode === "terminal" ? (
        <OmegaTerminal x={x} d={data} act={act} now={now} hitlMsg={hitlMsg} />
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
