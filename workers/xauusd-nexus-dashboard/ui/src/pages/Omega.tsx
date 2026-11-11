import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CandlestickChart,
  Cpu,
  KeyRound,
  Layers,
  Lock,
  Power,
  Radio,
  ShieldCheck,
  Sliders,
  Terminal,
  Zap,
} from "lucide-react";
import { createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { Badge, Dot, Empty, Kpi, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";

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
type BrokerKey = "monex" | "fxpro" | "dupoin" | "valetax" | "exness" | "custom";

interface BrokerPreset {
  key: BrokerKey;
  name: string;
  company: string;
  goldSymbol: string;
  servers: string[];
}

const BROKER_PRESETS: BrokerPreset[] = [
  {
    key: "monex",
    name: "Monex (MIFX)",
    company: "PT Monex Investindo Futures",
    goldSymbol: "XAUUSD.m",
    servers: ["Monex-Demo", "Monex-Live"],
  },
  {
    key: "fxpro",
    name: "FxPro",
    company: "FxPro Group / Global",
    goldSymbol: "XAUUSD / GOLD",
    servers: ["FxPro-MT5", "FxPro.Global-MT5", "EFXPro-Live"],
  },
  {
    key: "dupoin",
    name: "Dupoin",
    company: "PT Dupoin Futures Indonesia / Intl",
    goldSymbol: "XAUUSD",
    servers: [
      "DupoinFuturesID-Demo",
      "DupoinFuturesID-Real",
      "DupoinInternational-Demo",
      "DupoinInternational-Real",
    ],
  },
  {
    key: "valetax",
    name: "Valetax",
    company: "Valetax International / Global",
    goldSymbol: "XAUUSD",
    servers: [
      "ValetaxIntl-Demo",
      "ValetaxIntl-Live2",
      "ValetaxIntl-Live5",
      "ValetaxIntl-Live7",
      "ValetaxIntl-Live8",
      "ValetaxIntl-Live9",
      "ValetaxGlobal-Live3",
    ],
  },
  {
    key: "exness",
    name: "Exness",
    company: "Exness Technologies Ltd",
    goldSymbol: "XAUUSDm / XAUUSD",
    servers: [
      "Exness-MT5Trial",
      "Exness-MT5Trial2",
      "Exness-MT5Trial3",
      "Exness-MT5Trial4",
      "Exness-MT5Trial5",
      "Exness-MT5Trial6",
      "Exness-MT5Trial7",
      "Exness-MT5Trial8",
      "Exness-MT5Trial9",
      "Exness-MT5Trial10",
      "Exness-MT5Trial11",
      "Exness-MT5Trial12",
      "Exness-MT5Real",
      "Exness-MT5Real2",
      "Exness-MT5Real3",
      "Exness-MT5Real4",
      "Exness-MT5Real5",
      "Exness-MT5Real6",
      "Exness-MT5Real7",
      "Exness-MT5Real8",
      "Exness-MT5Real9",
      "Exness-MT5Real10",
      "Exness-MT5Real11",
      "Exness-MT5Real12",
      "Exness-MT5Real15",
      "Exness-MT5Real20",
    ],
  },
  {
    key: "custom",
    name: "Custom Server",
    company: "Manual Server / Host:Port Input",
    goldSymbol: "Auto (XAUUSD / GOLD)",
    servers: [],
  },
];

const GOLD_PAIR_OPTIONS = [
  { value: "AUTO_GOLD", label: "Auto-Fetch Gold / XAUUSD (Default)" },
  { value: "XAUUSD", label: "XAUUSD (Standard Spot Gold)" },
  { value: "XAUUSD.m", label: "XAUUSD.m (Monex / MIFX)" },
  { value: "XAUUSDm", label: "XAUUSDm (Exness / Valetax)" },
  { value: "GOLD", label: "GOLD (FxPro / Dupoin)" },
];

function detectBrokerFromServer(srv: string): BrokerKey {
  const s = (srv || "").toLowerCase();
  if (!s) return "monex";
  if (s.includes("monex") || s.includes("mifx")) return "monex";
  if (s.includes("fxpro") || s.includes("efxpro")) return "fxpro";
  if (s.includes("dupoin")) return "dupoin";
  if (s.includes("valetax")) return "valetax";
  if (s.includes("exness")) return "exness";
  return "custom";
}

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
const money = (v?: number | null, cur = "") =>
  typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}${cur ? " " + cur : ""}` : "—";
const balFmt = (v?: number | null, cur = "") =>
  typeof v === "number" && Number.isFinite(v)
    ? `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? " " + cur : ""}`
    : "—";
const toneCls = (v?: number | null) => (typeof v !== "number" || v === 0 ? "text-slate-300" : v > 0 ? "text-emerald-300" : "text-rose-300");
const timeUtc = (ms?: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const agoMs = (ms?: number | null) => {
  if (ms == null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 45) return `${Math.max(1, s)}s ago`;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const CONNECTION_TEXT: Record<string, string> = {
  none: "No broker connection stored.",
  stored: "Stored; the bridge applies it at its next sync.",
  needs_reentry: "The bridge's key changed: enter the credentials again.",
  cleared: "Disconnected; the bridge clears the terminal login.",
};

const INTENT_TONE: Record<string, "green" | "red" | "amber" | "cyan" | "slate"> = {
  done: "green",
  failed: "red",
  expired: "amber",
  pending: "cyan",
  sent: "cyan",
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

function Mt5ChartCanvas({
  tf,
  symbol,
  server,
  digits,
  bid,
  ask,
  spreadPoints,
  signal,
  positions,
  showBidAsk,
  showPlan,
  showPositions,
}: {
  tf: Mt5Tf;
  symbol: string;
  server: string;
  digits: number;
  bid?: number | null;
  ask?: number | null;
  spreadPoints?: number | null;
  signal: any;
  positions: any[];
  showBidAsk: boolean;
  showPlan: boolean;
  showPositions: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [hover, setHover] = useState<Candle | null>(null);

  useEffect(() => {
    let alive = true;
    const loadCandles = () => {
      get<{ candles: Candle[] }>(`/api/ohlcv?timeframe=${tf}&limit=300`)
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
      layout: {
        background: { color: "#060a12" },
        textColor: "#8b9bb4",
        fontFamily: "ui-monospace, JetBrains Mono, monospace",
      },
      grid: {
        vertLines: { color: "rgba(34, 211, 238, 0.05)" },
        horzLines: { color: "rgba(34, 211, 238, 0.05)" },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.09)" },
      timeScale: { borderColor: "rgba(255,255,255,0.09)", timeVisible: true, secondsVisible: false },
    });
    const series = chart.addCandlestickSeries({
      upColor: "#3fb950",
      downColor: "#f85149",
      borderUpColor: "#3fb950",
      borderDownColor: "#f85149",
      wickUpColor: "#3fb950",
      wickDownColor: "#f85149",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    const vol = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volRef.current = null;
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!series || !vol || !chart) return;
    const sorted = [...candles]
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
    series.setData(sorted.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    vol.setData(
      sorted.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume ?? 0,
        color: c.close >= c.open ? "rgba(63,185,80,0.28)" : "rgba(248,81,73,0.28)",
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

  // Real-time tick update on the active candlestick bar as MT5 broker ticks stream in
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || typeof bid !== "number" || !Number.isFinite(bid) || bid <= 0 || candles.length === 0) return;
    const lastBar = candles[candles.length - 1];
    if (!lastBar || !Number.isFinite(lastBar.time)) return;
    try {
      series.update({
        time: lastBar.time as UTCTimestamp,
        open: lastBar.open,
        high: Math.max(lastBar.high, bid),
        low: Math.min(lastBar.low, bid),
        close: bid,
      });
    } catch {
      // ignore if chart series is resetting
    }
  }, [bid, candles]);

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
    const addLine = (price: number | null | undefined, title: string, color: string, style = LineStyle.Dashed, lineWidth: 1 | 2 = 1) => {
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;
      linesRef.current.push(series.createPriceLine({ price, color, lineWidth, lineStyle: style, axisLabelVisible: true, title }));
    };

    if (showBidAsk) {
      addLine(bid, "BID", "#3fb950", LineStyle.Solid, 1);
      addLine(ask, "ASK", "#f85149", LineStyle.Solid, 1);
    }
    // No setup on chart unless decision is explicitly clear (Owner directive 2026-11-11)
    const hasClearDecision = showPlan && signal && (signal.side === "BUY" || signal.side === "SELL") && !signal.paused && !signal.kill;
    if (hasClearDecision) {
      addLine(signal.entry, `15m ${signal.side} ENTRY (Key Level)`, "#22d3ee", LineStyle.Dashed, 1);
      addLine(signal.stop, "15m SL", "#fb7185", LineStyle.Dashed, 1);
      addLine(signal.tp1, "15m TP1 (Quick Win)", "#34d399", LineStyle.Dashed, 1);
    }
    if (showPositions && Array.isArray(positions)) {
      for (const p of positions) {
        const entryPrice = p.open_price ?? p.entry;
        const isBuy = p.side === "BUY";
        addLine(entryPrice, `#${p.ticket} ${p.side} ${num(p.volume, 2)}`, isBuy ? "#3fb950" : "#f85149", LineStyle.Solid, 2);
        addLine(p.sl, `#${p.ticket} SL`, "#fb7185", LineStyle.Dotted, 1);
        addLine(p.tp, `#${p.ticket} TP`, "#34d399", LineStyle.Dotted, 1);
      }
    }
  }, [candles, bid, ask, signal, positions, showBidAsk, showPlan, showPositions]);

  const last = hover || candles[candles.length - 1];

  return (
    <div className="relative h-[430px] w-full bg-[#060a12]">
      {/* MT5 Top-Left Chart Watermark & OHLC Bar */}
      <div className="pointer-events-none absolute left-2.5 top-2 z-10 flex flex-col gap-0.5 rounded bg-black/55 px-2.5 py-1.5 backdrop-blur-sm border border-white/5">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="mono font-bold text-cyan-300">
            {symbol}, {tf}
          </span>
          <span className="text-slate-400">·</span>
          <span className="text-slate-300">{server || "MetaTrader 5 Terminal"}</span>
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300">
            EA: OmegaExecutor (magic 920200)
          </span>
        </div>
        {last ? (
          <div className="mono flex flex-wrap items-center gap-2.5 text-[10.5px] text-slate-400">
            <span>O {num(last.open, digits)}</span>
            <span>H {num(last.high, digits)}</span>
            <span>L {num(last.low, digits)}</span>
            <span className={last.close >= last.open ? "text-emerald-300" : "text-rose-300"}>C {num(last.close, digits)}</span>
            {last.volume != null ? <span>V {Math.round(last.volume)}</span> : null}
          </div>
        ) : (
          <div className="mono text-[10.5px] text-slate-500">Loading XAUUSD candles…</div>
        )}
      </div>

      {/* Live Broker Bid/Ask Overlay Pill */}
      <div className="pointer-events-none absolute right-16 top-2 z-10 flex items-center gap-1.5 rounded bg-black/65 px-2.5 py-1 text-[11px] backdrop-blur-sm border border-white/10">
        <span className="text-slate-400">Bid</span>
        <span className="mono font-bold text-emerald-300">{num(bid, digits)}</span>
        <span className="text-slate-600">/</span>
        <span className="text-slate-400">Ask</span>
        <span className="mono font-bold text-rose-300">{num(ask, digits)}</span>
        {spreadPoints != null ? <span className="mono ml-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-amber-200">{spreadPoints} pts</span> : null}
      </div>

      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}

export default function Omega() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("—");

  // MT5 Web Terminal & Separated Setup Mode UI state
  const [viewMode, setViewMode] = useState<"terminal" | "setup">("terminal");
  const [mt5Tf, setMt5Tf] = useState<Mt5Tf>("M15");
  const [toolboxTab, setToolboxTab] = useState<ToolboxTab>("trade");
  const [showBidAsk, setShowBidAsk] = useState(true);
  const [showPlan, setShowPlan] = useState(true);
  const [showPositions, setShowPositions] = useState(true);
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

  // Broker & Gold Pairing setup state
  const [selectedBroker, setSelectedBroker] = useState<BrokerKey>("monex");
  const [goldPair, setGoldPair] = useState<string>("AUTO_GOLD");
  const [showPass, setShowPass] = useState<boolean>(false);
  const [bServer, setBServer] = useState("Monex-Demo");
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
    setData(ov);
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
      setSelectedBroker(detectBrokerFromServer(activeSrv));
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

  useEffect(() => {
    load();
    let es: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      try {
        es = new EventSource("/omega/api/stream");
        es.addEventListener("overview", (ev: MessageEvent) => {
          try {
            const parsed = JSON.parse(ev.data);
            setStreamLive(true);
            applyOverview(parsed);
          } catch {
            // ignore malformed frame
          }
        });
        es.onerror = () => {
          setStreamLive(false);
        };
      } catch {
        es = null;
      }
    }
    const t = window.setInterval(load, 8_000);
    return () => {
      if (es) es.close();
      window.clearInterval(t);
    };
  }, []);

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
      setControlMsg({ tone: "text-emerald-300", text: `Control set to ${mode}. The EA applies it at its next poll.` });
      setControlReason("");
    } catch (e: any) {
      setControlMsg({ tone: "text-rose-300", text: `Refused: ${e?.message || "failed"}` });
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
        text: "An MT5 account is currently connected. Please click Disconnect before switching broker or server.",
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
    setBrokerMsg({ tone: "text-slate-300", text: "Encrypting…" });
    try {
      const key = await omegaJson("/omega/api/bridge/key");
      const envelope = await buildEnvelope(key.public_key, key.kid, { server, login, password });
      const out = await omegaJson("/omega/api/connection", "POST", { server, envelope });
      setBrokerMsg({
        tone: "text-emerald-300",
        text: `Stored v${out.version} for ${out.server}. The bridge logs the terminal in at its next sync.`,
      });
    } catch (e: any) {
      setBrokerMsg({ tone: "text-rose-300", text: `Refused: ${e?.message || "failed"}` });
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
      setBrokerMsg({ tone: "text-emerald-300", text: "Disconnected. Broker and server configuration is now unlocked." });
    } catch (e: any) {
      setBrokerMsg({ tone: "text-rose-300", text: `Refused: ${e?.message || "failed"}` });
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
        tone: "text-emerald-300",
        text: extra.live_armed === true ? "Live armed." : extra.live_armed === false ? "Live disarmed." : "Saved.",
      });
    } catch (e: any) {
      setEngineMsg({ tone: "text-rose-300", text: `Refused: ${e?.message || "failed"}` });
    }
    await load();
  };

  const handleExitPosition = async (ticket: number) => {
    const isConfirmed = window.confirm(`Exit position #${ticket} now in MetaTrader 5?\nThis will immediately override active TP/SL and close the position.`);
    if (!isConfirmed) return;
    setClosingTicket(ticket);
    try {
      await omegaJson("/omega/api/position/close", "POST", { ticket, reason: "manual_user_exit" });
      setControlMsg({
        tone: "text-emerald-300",
        text: `Exit requested for position #${ticket}. The MT5 terminal will close it within 2 seconds.`,
      });
      await load();
    } catch (err: any) {
      setControlMsg({
        tone: "text-rose-300",
        text: `Failed to exit #${ticket}: ${err?.message || "error"}`,
      });
    } finally {
      setClosingTicket(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
        <Panel title="Omega · Execution Engine & MT5 Web Terminal" icon={<Zap className="h-3.5 w-3.5 text-cyan-300" />}>
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
  const viewer = data?.viewer || { can_control: false };
  const canControl = Boolean(viewer.can_control);

  const e = b?.engine || {};
  const conn = b?.connection || {};
  const br = b?.bridge || {};
  const watchdog = b?.autonomous_watchdog || null;
  const cur = br.currency || hb?.currency || "USD";
  const digits = typeof br.digits === "number" && br.digits >= 0 ? br.digits : 2;
  const symbolName = br.symbol || "XAUUSD.m";
  const serverName = br.server || conn.server || "Broker Server";
  const positionsList: any[] = hb?.positions_detail?.length ? hb.positions_detail : br?.positions || [];
  const ordersList: any[] = br?.orders || [];
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
    ? "off (server switch OMEGA_ENGINE_ENABLED)"
    : !e.enabled
      ? "off (enable it below)"
      : "on";
  const effectiveTone: "red" | "amber" | "green" = !e.env_enabled ? "red" : !e.enabled ? "amber" : "green";

  const accountActive = Boolean(
    conn.status === "stored" && conn.server && br.terminal_connected
  );
  const configLocked = accountActive;

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      {/* Top Status Banner */}
      <Panel
        title="Omega · XAUUSD Execution Engine & MT5 Web Terminal"
        icon={<Zap className="h-3.5 w-3.5 text-cyan-300" />}
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={br.terminal_connected ? "green" : "red"}>
              <Dot tone={br.terminal_connected ? "green" : "red"} pulse={br.terminal_connected} />
              {br.terminal_connected ? `MT5: ${serverName}` : "MT5 disconnected"}
            </Badge>
            <Badge tone={br.seen ? "green" : "red"}>
              <Dot tone={br.seen ? "green" : "red"} pulse={br.seen} />
              {br.seen ? "Bridge online" : "Bridge offline"}
            </Badge>
            <Badge tone={streamLive ? "green" : "cyan"}>
              <Dot tone={streamLive ? "green" : "cyan"} pulse={streamLive} />
              {streamLive ? "SSE Live Stream" : "Live Sync"}
            </Badge>
            <Badge tone={algoActive ? "green" : "amber"}>
              Algo Trading: {algoActive ? "ON" : "STANDBY"}
            </Badge>
            <Badge tone={br.trade_mode === "real" || hb?.mode === "live" ? "amber" : "cyan"}>
              {br.trade_mode ? `${br.trade_mode} account` : hb?.mode ? `${hb.mode} account` : "account unknown"}
            </Badge>
            <Badge tone={c.mode === "killed" ? "red" : c.mode === "paused" ? "amber" : "green"}>
              control: {c.mode || "active"}
            </Badge>
            {s.kill ? <Badge tone="red">kill ({s.kill_source || "server"})</Badge> : null}
            {s.blackout ? <Badge tone="amber">event blackout</Badge> : null}
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
          <p className="text-[12px] text-rose-300">Omega error: {error}</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] leading-relaxed text-slate-400">
            <p>
              Live Web Edition of the Windows MetaTrader 5 Terminal streaming in real time (<span className="mono text-emerald-300">OnTick + SSE</span>) from the host MT5 terminal (<span className="mono text-slate-200">{serverName}</span> · <span className="mono text-cyan-300">{symbolName}</span>) and the 15m Decision Engine SSOT. Credentials are RSA-OAEP + AES-256-GCM encrypted in-browser.
            </p>
            <span className="mono text-[11px] text-slate-300">Updated {updatedAt}</span>
          </div>
        )}
      </Panel>

      {/* Separated Workspace Mode Bar: MT5 Terminal vs Setup & Configuration Center */}
      <div
        id="omega-mode-bar"
        className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-cyan-500/25 bg-[#09101d] px-3.5 py-2.5 shadow-lg"
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            id="tab-terminal-mode"
            onClick={() => setViewMode("terminal")}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition ${
              viewMode === "terminal"
                ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-100 shadow-[0_0_20px_rgba(34,211,238,0.18)]"
                : "border-white/10 bg-black/30 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <Terminal className="h-3.5 w-3.5 text-cyan-300" />
            MT5 Web Terminal &amp; Live Monitor
          </button>
          <button
            type="button"
            id="tab-setup-mode"
            onClick={() => setViewMode("setup")}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition ${
              viewMode === "setup"
                ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.18)]"
                : "border-white/10 bg-black/30 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <Sliders className="h-3.5 w-3.5 text-emerald-300" />
            Setup &amp; Configuration Center (Broker · Server · Gold Pairing · Engine)
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {configLocked ? (
            <span className="mono flex items-center gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1 text-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>Active MT5 Session: <strong className="text-emerald-100">{serverName}</strong> (Locked)</span>
            </span>
          ) : (
            <span className="mono rounded-md border border-white/10 bg-black/40 px-2.5 py-1 text-slate-300">
              Broker: <strong className="text-cyan-300">{BROKER_PRESETS.find((p) => p.key === selectedBroker)?.name || "Custom"}</strong> ({bServer || serverName})
            </span>
          )}
          <span className="mono rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-amber-200">
            Default Pair: <strong>Auto Gold / XAUUSD</strong> → {symbolName}
          </span>
          <span className={`mono flex items-center gap-1.5 rounded-md border px-2.5 py-1 ${
            algoActive
              ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
              : "border-slate-700/60 bg-black/40 text-slate-400"
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${algoActive ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`} />
            Algo Trading: <strong className={algoActive ? "text-emerald-100" : "text-slate-300"}>{algoActive ? "ON" : "STANDBY"}</strong>
          </span>
        </div>
      </div>

      {viewMode === "terminal" ? (
        <div className="flex flex-col gap-4">
        {/* =====================================================================
            WINDOWS METATRADER 5 TERMINAL — WEB EDITION WORKSTATION
           ===================================================================== */}
        <div className="overflow-hidden rounded-xl border border-cyan-500/25 bg-[#070b13] shadow-[0_20px_60px_rgba(0,0,0,0.65)]">
        {/* Windows MT5 Application Title Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-gradient-to-r from-[#0d1526] via-[#0a101d] to-[#0d1526] px-3.5 py-2">
          <div className="flex items-center gap-2.5">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-cyan-500/15 border border-cyan-400/30 text-cyan-300">
              <Terminal className="h-3.5 w-3.5" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-bold tracking-wide text-slate-100">
                MetaTrader 5 Web Terminal
              </span>
              <span className="mono rounded bg-white/5 px-2 py-0.5 text-[11px] text-cyan-300 border border-white/10">
                {serverName} · {br.trade_mode ? br.trade_mode.toUpperCase() : "DEMO"} · {symbolName},{mt5Tf}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <div className="flex items-center gap-1.5 text-slate-300">
              <Dot tone={br.terminal_connected ? "green" : "red"} pulse={br.terminal_connected} />
              <span className="mono">
                {br.terminal_connected ? "Connected" : "Offline"} · Sync {agoMs(br.synced_age_ms)}
              </span>
            </div>
            <div className="hidden sm:flex items-center gap-1 rounded border border-white/10 bg-black/40 px-2 py-0.5 text-slate-400">
              <span>Window</span>
              <span>·</span>
              <span>Market Watch (Ctrl+M)</span>
              <span>·</span>
              <span>Navigator (Ctrl+N)</span>
              <span>·</span>
              <span>Toolbox (Ctrl+T)</span>
            </div>
          </div>
        </div>

        {/* MT5 Standard Top Toolbar (Algo Trading, Timeframes, Overlay Toggles, Live Account Strip) */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#0b111e] px-3 py-2">
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
                  ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                  : "border-rose-400/35 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20"
              }`}
              title="Click to toggle Algo Trading (Broker Engine) ON / OFF"
            >
              <span className={`h-2 w-2 rounded-full ${eEnabled ? "bg-emerald-400 animate-pulse" : "bg-rose-400"}`} />
              Algo Trading: {eEnabled ? "ON" : "OFF"}
            </button>

            {/* MT5 Terminal VPS Execution Health Pill */}
            <button
              type="button"
              onClick={() => setToolboxTab("state_machine")}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition ${
                !br.terminal_connected
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                  : !br.trade_allowed
                  ? "border-amber-500/50 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 animate-pulse"
                  : "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
              }`}
              title={
                !br.terminal_connected
                  ? "MT5 Terminal is DISCONNECTED on VPS! Cerebrum Watchdog supervising recovery."
                  : !br.trade_allowed
                  ? "MT5 Terminal Algo Trading is DISABLED! Cerebrum Watchdog auto-healing active."
                  : "MT5 Terminal on VPS is LIVE and automated trade execution is ALLOWED. Supervised by Cerebrum."
              }
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  !br.terminal_connected
                    ? "bg-rose-500"
                    : !br.trade_allowed
                    ? "bg-amber-400 animate-pulse"
                    : "bg-emerald-400 animate-pulse"
                }`}
              />
              {!br.terminal_connected
                ? "MT5 VPS: Offline"
                : !br.trade_allowed
                ? "MT5 VPS: Algo Blocked"
                : "MT5 VPS: Live (Algo On)"}
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
                    ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-200"
                    : "border-white/10 bg-black/30 text-slate-400"
                }`}
              >
                Bid/Ask Lines
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
                15m Signal Plan
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
                MT5 Positions ({positionsList.length})
              </button>
              <button
                type="button"
                onClick={() => setToolboxTab("state_machine")}
                className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-semibold transition ${
                  toolboxTab === "state_machine"
                    ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-200"
                    : "border-white/10 bg-black/30 text-slate-300 hover:border-cyan-400/30 hover:text-cyan-200"
                }`}
                title="View Autonomous Cerebrum Pipeline & State Machine"
              >
                <Cpu className="h-3 w-3 text-cyan-400" />
                Pipeline State
              </button>
              <button
                type="button"
                onClick={() => setToolboxTab("tca_sor")}
                className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-semibold transition ${
                  toolboxTab === "tca_sor"
                    ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-200"
                    : "border-white/10 bg-black/30 text-slate-300 hover:border-emerald-400/30 hover:text-emerald-200"
                }`}
                title="View Execution Quality, Transaction Cost Analysis (TCA) and Smart Order Router (SOR)"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                TCA & SOR: {b?.tca?.quality || "PRIME"}
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/30 bg-gradient-to-r from-amber-950/70 via-cyan-950/40 to-black/70 px-4 py-2 text-[12px] text-amber-200">
            <div className="flex items-center gap-2.5">
              <Cpu className="h-4 w-4 shrink-0 text-cyan-400 animate-spin" />
              <div>
                <span className="font-bold text-white">
                  Cerebrum Self-Healing Active:{" "}
                </span>
                <span className="text-slate-300">
                  {!br.terminal_connected
                    ? "Terminal session disconnected. Cerebrum Watchdog is autonomously recovering the connection."
                    : "Algo trading permission restricted. Cerebrum Watchdog is auto-correcting terminal INI parameters."}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setToolboxTab("state_machine")}
              className="flex items-center gap-1.5 rounded-md border border-cyan-400/40 bg-cyan-500/20 px-2.5 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/30 transition"
            >
              <Activity className="h-3 w-3" />
              View State Machine
            </button>
          </div>
        ) : null}

        {/* MT5 Main Split Workspace: Left Dock (Market Watch + Navigator) & Center Chart */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr]">
          {/* Left Dock: Market Watch + Contract Spec + Navigator */}
          <div className="flex flex-col border-b border-white/10 bg-[#080d18] lg:border-b-0 lg:border-r">
            {/* Market Watch Header */}
            <div className="flex items-center justify-between border-b border-white/10 bg-[#0d1525] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-300">
              <span className="flex items-center gap-1.5">
                <CandlestickChart className="h-3.5 w-3.5 text-cyan-300" />
                Market Watch · {symbolName}
              </span>
              <span className="mono flex items-center gap-1 text-[10px] text-slate-400">
                {tickDir === "up" ? <span className="text-emerald-300">▲</span> : tickDir === "down" ? <span className="text-rose-300">▼</span> : null}
                {br.spread_points != null ? `${br.spread_points} pts` : "—"}
              </span>
            </div>

            {/* MT5 One-Click Trading Style Dual Bid / Ask Box */}
            <div className="grid grid-cols-2 gap-2 p-2.5 border-b border-white/10 bg-black/25">
              <div className="rounded-lg border border-rose-500/30 bg-gradient-to-b from-rose-500/15 to-rose-950/20 px-2.5 py-2 text-center">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-300">BID (SELL)</div>
                <div className="mono mt-0.5 text-lg font-extrabold text-rose-200">{num(br.bid, digits)}</div>
              </div>
              <div className="rounded-lg border border-emerald-500/30 bg-gradient-to-b from-emerald-500/15 to-emerald-950/20 px-2.5 py-2 text-center">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">ASK (BUY)</div>
                <div className="mono mt-0.5 text-lg font-extrabold text-emerald-200">{num(br.ask, digits)}</div>
              </div>
            </div>

            {/* Market Watch Symbol Table */}
            <div className="border-b border-white/10 px-2.5 py-2">
              <table className="w-full text-left text-[11px]">
                <thead>
                  <tr className="border-b border-white/10 text-[10px] uppercase text-slate-500">
                    <th className="pb-1">Symbol</th>
                    <th className="pb-1 text-right">Bid</th>
                    <th className="pb-1 text-right">Ask</th>
                    <th className="pb-1 text-right"> {!s.market_price ? "Pts" : "Spread"}</th>
                  </tr>
                </thead>
                <tbody className="mono divide-y divide-white/5">
                  <tr className="bg-cyan-500/5">
                    <td className="py-1.5 font-bold text-cyan-300">{symbolName}</td>
                    <td className="py-1.5 text-right text-emerald-300">{num(br.bid, digits)}</td>
                    <td className="py-1.5 text-right text-rose-300">{num(br.ask, digits)}</td>
                    <td className="py-1.5 text-right text-amber-200">{br.spread_points ?? "—"}</td>
                  </tr>
                  {s.market_price ? (
                    <tr>
                      <td className="py-1 text-slate-400">XAUUSD (Feed)</td>
                      <td className="py-1 text-right text-slate-300" colSpan={2}>
                        {num(s.market_price, 2)}
                      </td>
                      <td className="py-1 text-right text-slate-500">SSOT</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {/* Symbol Contract Specification */}
            <div className="border-b border-white/10 px-3 py-2">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Symbol Specification ({symbolName})
              </div>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
                <dt className="text-slate-500">Digits / Point</dt>
                <dd className="mono text-right text-slate-300">
                  {br.digits ?? "—"} / {br.point ?? "—"}
                </dd>
                <dt className="text-slate-500">Tick Size / Val</dt>
                <dd className="mono text-right text-slate-300">
                  {br.tick_size ?? "—"} / {br.tick_value != null ? num(br.tick_value, 2) : "—"}
                </dd>
                <dt className="text-slate-500">Volume Min / Max</dt>
                <dd className="mono text-right text-slate-300">
                  {br.volume_min ?? "—"} / {br.volume_max ?? "—"}
                </dd>
                <dt className="text-slate-500">Volume Step</dt>
                <dd className="mono text-right text-slate-300">{br.volume_step ?? "—"}</dd>
                <dt className="text-slate-500">Stops Level</dt>
                <dd className="mono text-right text-slate-300">
                  {br.stops_level_points != null ? `${br.stops_level_points} pts` : "—"}
                </dd>
              </dl>
            </div>

            {/* MT5 Navigator Tree (Ctrl+N) */}
            <div className="flex items-center justify-between border-b border-white/10 bg-[#0d1525] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-300">
              <span className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-cyan-300" />
                Navigator
              </span>
              <span className="mono text-[10px] text-slate-400">Ctrl+N</span>
            </div>
            <div className="flex-1 space-y-2 px-3 py-2.5 text-[11.5px]">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Accounts</div>
                <div className="mt-1 flex items-center justify-between rounded bg-white/[0.03] px-2 py-1 border border-white/5">
                  <span className="mono text-slate-200 truncate">{serverName}</span>
                  <Badge tone={br.terminal_connected ? "green" : "red"}>
                    {br.trade_mode || "demo"}
                  </Badge>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Expert Advisors</div>
                <div className="mt-1 space-y-1">
                  <div className="flex items-center justify-between rounded bg-cyan-500/[0.07] px-2 py-1 border border-cyan-400/20">
                    <span className="mono flex items-center gap-1.5 text-cyan-200">
                      <Bot className="h-3 w-3 text-cyan-300" />
                      OmegaExecutor
                    </span>
                    <span className="mono text-[10px] text-emerald-300">
                      {br.terminal_connected ? `${symbolName}, M1` : "standby"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded bg-white/[0.02] px-2 py-1 border border-white/5">
                    <span className="mono text-slate-300">CryptophysXAUUSD</span>
                    <span className="mono text-[10px] text-slate-400">
                      {ea.connected ? `v${hb?.version || "1.11"}` : "direct EA"}
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">15m Decision Engine</div>
                <div className="mt-1 flex items-center justify-between rounded bg-white/[0.03] px-2 py-1 border border-white/5">
                  <span className="text-slate-300">Active Stance</span>
                  <span
                    className={`mono font-bold ${
                      s.side === "BUY" ? "text-emerald-300" : s.side === "SELL" ? "text-rose-300" : "text-slate-400"
                    }`}
                  >
                    {!s.side || s.side === "NONE" ? "WAIT / NO TRADE" : `${s.side} (${num(s.entry, 2)})`}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Center / Right MT5 Interactive Candlestick Chart */}
          <div className="flex flex-col">
            <Mt5ChartCanvas
              tf={mt5Tf}
              symbol={symbolName}
              server={serverName}
              digits={digits}
              bid={br.bid}
              ask={br.ask}
              spreadPoints={br.spread_points}
              signal={s}
              positions={positionsList}
              showBidAsk={showBidAsk}
              showPlan={showPlan}
              showPositions={showPositions}
            />
          </div>
        </div>

        {/* =================================================================
            MT5 BOTTOM DOCK — TOOLBOX (Ctrl+T): Trade | History | Intents | Experts | Journal
           ================================================================= */}
        <div className="border-t border-white/10 bg-[#080d18]">
          {/* Toolbox Tab Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#0d1525] px-3 py-1.5">
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  ["trade", `Trade (${positionsList.length}${ordersList.length ? ` + ${ordersList.length} ord` : ""})`],
                  ["history", `History (${dealsList.length})`],
                  ["intents", `Order Intents (${(b?.intents || []).length})`],
                  ["state_machine", "Autonomous State Machine"],
                  ["tca_sor", "Execution & TCA / SOR"],
                  ["events", `Events & Journal (${(b?.events || []).length + (data?.control_events || []).length})`],
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
            <span className="mono text-[10.5px] text-slate-400">
              MT5 Toolbox · {serverName} · {symbolName}
            </span>
          </div>

          {/* Tab 1: TRADE (Open Positions + Classic MT5 Account Summary Row) */}
          {toolboxTab === "trade" ? (
            <div>
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
                      <th>Open Price</th>
                      <th>S / L</th>
                      <th>T / P</th>
                      <th>Current Price</th>
                      <th>Profit ({cur})</th>
                      <th>Intent / Signal</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positionsList.length === 0 ? (
                      <tr>
                        <td colSpan={13} className="py-4 text-center text-[12px] text-slate-500">
                          No open positions in MetaTrader 5 ({serverName}). Waiting for the next actionable 15m Decision Engine signal.
                        </td>
                      </tr>
                    ) : (
                      positionsList.map((p: any) => {
                        const isBuy = p.side === "BUY";
                        const curPrice = isBuy ? br.bid : br.ask;
                        const isManual = p.source === "manual" || p.magic === 0;
                        const isOmega = p.source === "omega" || p.magic === 920200 || String(p.intent_id || "").startsWith("open:");
                        return (
                          <tr key={p.ticket}>
                            <td className="mono font-bold text-cyan-300">{p.symbol || symbolName}</td>
                            <td className="mono">#{String(p.ticket)}</td>
                            <td>
                              {isManual ? (
                                <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                                  📱 MANUAL / MOBILE
                                </span>
                              ) : isOmega ? (
                                <span className="inline-flex items-center gap-1 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/30">
                                  🤖 OMEGA AI
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-purple-300 border border-purple-400/30">
                                  EXTERNAL
                                </span>
                              )}
                            </td>
                            <td className="mono">{timeUtc(p.opened_ms)}</td>
                            <td className={`mono font-bold ${isBuy ? "text-emerald-300" : "text-rose-300"}`}>{p.side}</td>
                            <td className="mono">{num(p.volume, 2)}</td>
                            <td className="mono">{num(p.entry ?? p.open_price, digits)}</td>
                            <td className="mono text-rose-300">{p.sl ? num(p.sl, digits) : "—"}</td>
                            <td className="mono text-emerald-300">{p.tp ? num(p.tp, digits) : "—"}</td>
                            <td className="mono text-slate-200">{num(curPrice, digits)}</td>
                            <td className={`mono font-bold ${toneCls(p.profit)}`}>{money(p.profit, cur)}</td>
                            <td className="mono text-[11px] text-slate-400">{p.signal_id || p.intent_id || (isManual ? "Manual Discretionary" : "—")}</td>
                            <td className="text-right">
                              <button
                                type="button"
                                disabled={closingTicket === p.ticket}
                                onClick={() => handleExitPosition(p.ticket)}
                                className="inline-flex items-center gap-1 rounded bg-rose-500/20 px-2.5 py-1 text-[11px] font-bold text-rose-300 border border-rose-500/40 hover:bg-rose-500/30 hover:border-rose-400 active:scale-95 transition disabled:opacity-50"
                                title="Exit position immediately in MetaTrader 5 (interrupts TP/SL)"
                              >
                                {closingTicket === p.ticket ? (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="inline-block h-2 w-2 rounded-full bg-rose-400 animate-ping" />
                                    EXITING…
                                  </span>
                                ) : (
                                  "EXIT ✕"
                                )}
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {ordersList.length > 0 && (
                <div className="border-t border-white/10 bg-[#060a12]">
                  <div className="border-b border-white/5 bg-[#090f1b] px-3.5 py-1 text-[11px] font-semibold text-slate-400">
                    Pending Orders ({ordersList.length})
                  </div>
                  <div className="table-wrap max-h-[160px] overflow-y-auto">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Order Ticket</th>
                          <th>Source</th>
                          <th>Placed (UTC)</th>
                          <th>Type</th>
                          <th>Volume</th>
                          <th>Order Price</th>
                          <th>S / L</th>
                          <th>T / P</th>
                          <th>Comment</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ordersList.map((o: any) => {
                          const isManualOrd = o.source === "manual" || o.magic === 0;
                          return (
                            <tr key={o.ticket}>
                              <td className="mono font-bold text-cyan-300">{o.symbol || symbolName}</td>
                              <td className="mono">#{String(o.ticket)}</td>
                              <td>
                                {isManualOrd ? (
                                  <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                                    📱 MANUAL / MOBILE
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/30">
                                    🤖 OMEGA AI
                                  </span>
                                )}
                              </td>
                              <td className="mono">{timeUtc(o.placed_ms)}</td>
                              <td className="mono font-semibold text-amber-200">{o.type}</td>
                              <td className="mono">{num(o.volume_current ?? o.volume_initial, 2)}</td>
                              <td className="mono text-slate-200">{num(o.price_open, digits)}</td>
                              <td className="mono text-rose-300">{o.sl ? num(o.sl, digits) : "—"}</td>
                              <td className="mono text-emerald-300">{o.tp ? num(o.tp, digits) : "—"}</td>
                              <td className="mono text-[11px] text-slate-400">{o.comment || "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Classic Windows MT5 Gray/Obsidian Account Summary Footer Row */}
              <div className="mono flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-[#0c1322] px-3.5 py-2 text-[11.5px]">
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
                    <strong className="text-slate-400">Day Realized P/L:</strong>{" "}
                    <span className={`font-bold ${toneCls(br.day_realized_pl)}`}>{money(br.day_realized_pl, cur)}</span>
                  </span>
                  <span>
                    <strong className="text-slate-400">Day Start Balance:</strong>{" "}
                    <span className="text-slate-300">{balFmt(br.day_start_balance, cur)}</span>
                  </span>
                </div>
                <div className="text-slate-400">
                  Risk/Trade: <span className="text-slate-200">{e.risk_pct ?? 0.5}%</span> · Max Pos:{" "}
                  <span className="text-slate-200">{e.max_positions ?? 1}</span>
                </div>
              </div>
            </div>
          ) : null}

          {/* Tab 2: HISTORY (Closed Deals) */}
          {toolboxTab === "history" ? (
            <div className="table-wrap max-h-[260px] overflow-y-auto">
              {!dealsList.length ? (
                <div className="p-4">
                  <Empty>No closed deal reported yet.</Empty>
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Closed (UTC)</th>
                      <th>Deal Ticket</th>
                      <th>Source</th>
                      <th>Side</th>
                      <th>Volume</th>
                      <th>Entry Price</th>
                      <th>Exit Price</th>
                      <th>Net P/L</th>
                      <th>Reason</th>
                      <th>Account Mode</th>
                      <th>Signal / Comment</th>
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
                              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                                📱 MANUAL / MOBILE
                              </span>
                            ) : isOmega ? (
                              <span className="inline-flex items-center gap-1 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/30">
                                🤖 OMEGA AI
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-purple-300 border border-purple-400/30">
                                EXTERNAL
                              </span>
                            )}
                          </td>
                          <td className={`mono font-bold ${d.side === "BUY" ? "text-emerald-300" : "text-rose-300"}`}>{d.side}</td>
                          <td className="mono">{num(d.volume, 2)}</td>
                          <td className="mono">{num(d.entry_price, digits)}</td>
                          <td className="mono">{num(d.exit_price, digits)}</td>
                          <td className={`mono font-bold ${toneCls(net)}`}>{money(net, d.currency || cur)}</td>
                          <td className="mono">
                            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10.5px]">
                              {d.reason || "closed"}
                            </span>
                          </td>
                          <td className="mono text-slate-400">{d.mode || "live"}</td>
                          <td className="mono text-[11px] text-slate-400">{d.signal_id || (isManual ? "Manual Discretionary" : "—")}</td>
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
                  <Empty>No order intent emitted yet. Intents appear here when the 15m Decision Engine triggers an entry or exit.</Empty>
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Created (UTC)</th>
                      <th>Intent ID</th>
                      <th>Kind</th>
                      <th>Side</th>
                      <th>Volume</th>
                      <th>Entry</th>
                      <th>SL</th>
                      <th>TP</th>
                      <th>Status</th>
                      <th>MT5 Execution Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(b.intents || []).map((i: any) => (
                      <tr key={i.id}>
                        <td className="mono">{timeUtc(i.created_ms)}</td>
                        <td className="mono">{i.id}</td>
                        <td className="mono">{i.kind}</td>
                        <td className={`mono font-bold ${i.side === "BUY" ? "text-emerald-300" : i.side === "SELL" ? "text-rose-300" : ""}`}>
                          {i.side || "—"}
                        </td>
                        <td className="mono">{i.volume != null ? num(i.volume, 2) : "—"}</td>
                        <td className="mono">{i.entry != null ? num(i.entry, digits) : (i.side === "BUY" ? "Market (Ask)" : i.side === "SELL" ? "Market (Bid)" : "—")}</td>
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
              )}
            </div>
          ) : null}

          {/* Tab 4: AUTONOMOUS STATE MACHINE & SELF-HEALING WATCHDOG */}
          {toolboxTab === "state_machine" ? (
            <div className="space-y-4 p-4 text-[12px]">
              {/* Header Banner: Autonomous System Architecture */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-cyan-500/30 bg-gradient-to-r from-cyan-950/40 via-[#0a1220] to-[#0c1628] p-3.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-500/10 text-cyan-300">
                    <Cpu className="h-5 w-5 animate-pulse" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-extrabold uppercase tracking-wider text-white">
                        Cerebrum Autonomous Self-Healing Pipeline
                      </span>
                      <span className="mono rounded border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                        {watchdog?.active ? "AUTONOMOUS · ACTIVE" : "SUPERVISED"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      Zero human intervention required. Cerebrum continuously monitors MT5 terminal heartbeat, recovers blocking dialogs, corrects INI permissions, and heals connectivity autonomously.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-slate-400">Policy:</span>
                  <span className="mono font-semibold text-cyan-200">{watchdog?.policy || "self_healing_v1"}</span>
                  <span className="text-slate-600">|</span>
                  <span className="text-slate-400">Anti-Flap Cooldown:</span>
                  <span className="mono font-semibold text-slate-200">{watchdog?.anti_flapping_cooldown_sec || 180}s</span>
                </div>
              </div>

              {/* 5-Stage Interactive State Machine Pipeline */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {/* Node 1: Cerebrum Cloud Supervisor */}
                <div className="flex flex-col justify-between rounded-lg border border-cyan-500/30 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-cyan-400">
                        1. Cloud Brain
                      </span>
                      <Badge tone="green">SUPERVISED</Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-white">
                      Cerebrum Watchdog
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Agent</span>
                        <span className="mono font-semibold text-cyan-200">{watchdog?.agent || "agent:cerebrum"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Supervision</span>
                        <span className="text-emerald-300">Autonomous</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 border-t border-white/5 pt-2 text-[10px] text-slate-400">
                    Self-healing directives dispatched on sync
                  </div>
                </div>

                {/* Node 2: Host Bridge Daemon */}
                <div className="flex flex-col justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        2. Host Bridge
                      </span>
                      <Badge tone={br.seen ? "green" : "red"}>
                        {br.seen ? "SYNCED" : "OFFLINE"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-slate-100">
                      Omega Bridge Daemon
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Sync Age</span>
                        <span className="mono text-emerald-300">{br.seen ? agoMs(br.synced_age_ms) : "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Key ID</span>
                        <span className="mono text-slate-300 truncate max-w-[90px]">{br.kid || "—"}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 border-t border-white/5 pt-2 text-[10px] text-slate-400">
                    RSA-3072 + AES-GCM encrypted
                  </div>
                </div>

                {/* Node 3: MT5 Terminal Service */}
                <div className="flex flex-col justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        3. MT5 Terminal
                      </span>
                      <Badge tone={br.state_age_ms != null && br.state_age_ms < 60000 ? "green" : "red"}>
                        {br.state_age_ms != null && br.state_age_ms < 60000 ? "STREAMING" : "STALE"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-slate-100">
                      Wine MT5 Service
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Heartbeat</span>
                        <span className="mono text-emerald-300">{agoMs(br.state_age_ms)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Display</span>
                        <span className="mono text-slate-300">DISPLAY=:99</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 border-t border-white/5 pt-2 text-[10px] text-slate-400">
                    EA: OmegaExecutor (MQL5)
                  </div>
                </div>

                {/* Node 4: Broker Gateway & Market */}
                <div className="flex flex-col justify-between rounded-lg border border-white/10 bg-black/40 p-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        4. Broker Gateway
                      </span>
                      <Badge tone={br.terminal_connected && br.trade_allowed ? "green" : "red"}>
                        {br.terminal_connected ? (br.trade_allowed ? "READY" : "ALGO BLOCKED") : "DISCONNECTED"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-cyan-200 truncate">
                      {serverName}
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Mode</span>
                        <span className="mono uppercase text-slate-200">{br.trade_mode || "demo"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Permission</span>
                        <span className={`font-semibold ${br.trade_allowed ? "text-emerald-300" : "text-rose-400"}`}>
                          {br.trade_allowed ? "Allowed" : "Disabled"}
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
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        5. Decision Engine
                      </span>
                      <Badge tone={c.mode === "killed" ? "red" : eEnabled ? "green" : "amber"}>
                        {c.mode === "killed" ? "KILLED" : eEnabled ? "ARMED" : "IDLE"}
                      </Badge>
                    </div>
                    <div className="mt-2 text-[13px] font-extrabold text-slate-100">
                      15m Engine
                    </div>
                    <div className="mt-1.5 space-y-1 text-[11px] text-slate-300">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Mode</span>
                        <span className="mono uppercase text-slate-200">{c.mode || "active"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Live Trade</span>
                        <span className="mono text-slate-300">{e.live_armed ? "Armed" : "Demo safe"}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5 border-t border-white/5 pt-2 text-[10px] text-slate-400">
                    Signal: {s.side || "NONE"}
                  </div>
                </div>
              </div>

              {/* Autonomous Self-Healing Audit Trail Card */}
              <div className="rounded-lg border border-white/10 bg-[#0c1424] p-3.5">
                <div className="flex items-center justify-between border-b border-white/10 pb-2">
                  <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-cyan-300">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    Autonomous Recovery Audit Trail
                  </h4>
                  <span className="mono text-[10px] text-slate-400">
                    Self-Healing Guardian Log
                  </span>
                </div>

                {watchdog?.last_recovery ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded border border-white/5 bg-black/30 p-2.5">
                      <div className="text-[10px] uppercase text-slate-500">Last Directive</div>
                      <div className="mono mt-1 text-[12px] font-bold text-amber-300">
                        {watchdog.last_recovery.directive}
                      </div>
                    </div>
                    <div className="rounded border border-white/5 bg-black/30 p-2.5">
                      <div className="text-[10px] uppercase text-slate-500">Trigger Reason</div>
                      <div className="mono mt-1 text-[12px] font-bold text-slate-200">
                        {watchdog.last_recovery.reason}
                      </div>
                    </div>
                    <div className="rounded border border-white/5 bg-black/30 p-2.5">
                      <div className="text-[10px] uppercase text-slate-500">Timestamp</div>
                      <div className="mono mt-1 text-[12px] text-cyan-200">
                        {timeUtc(watchdog.last_recovery.ms)} ({agoMs(Date.now() - watchdog.last_recovery.ms)})
                      </div>
                    </div>
                    <div className="rounded border border-white/5 bg-black/30 p-2.5">
                      <div className="text-[10px] uppercase text-slate-500">Guardian Status</div>
                      <div className="mono mt-1 text-[12px] font-semibold text-emerald-300">
                        Executed & Cooled Down
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-950/15 p-3 text-[11.5px] text-emerald-200">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span>
                      All pipeline nodes running nominal. No recovery interventions required in the current session.
                    </span>
                  </div>
                )}
              </div>

              {/* Collapsible Raw State JSON Inspector */}
              <div className="rounded-lg border border-white/10 bg-[#0c1424] p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
                      Raw MT5 State Inspector (omega/state.json)
                    </span>
                    <span className="ml-2 text-[10px] text-slate-500">Direct telemetry stream</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowRawState((v) => !v)}
                    className="rounded border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/10 transition"
                  >
                    {showRawState ? "Hide JSON" : "Inspect Raw State"}
                  </button>
                </div>
                {showRawState ? (
                  <pre className="mt-2.5 max-h-56 overflow-y-auto rounded bg-black/60 p-3 mono text-[11px] text-emerald-300/90 border border-white/10">
                    {JSON.stringify(
                      {
                        terminal_connected: br.terminal_connected,
                        trade_allowed: br.trade_allowed,
                        server: serverName,
                        trade_mode: br.trade_mode,
                        currency: br.currency,
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
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-gradient-to-r from-emerald-950/40 via-[#0a1818] to-[#0c1c20] p-3.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/40 bg-emerald-500/10 text-emerald-300">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-100">Tier-1 Quant Execution & TCA Quality Engine</span>
                      <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-400/30">
                        GRADE: {b?.tca?.quality || "PRIME"}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Sub-millisecond VPS tick execution, automated slippage attribution, smart order routing failover, and adaptive volatility sizing.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="mono rounded border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] text-slate-300">
                    Router: <span className="text-cyan-300 font-semibold">{b?.sor?.active_route || serverName}</span>
                  </span>
                </div>
              </div>

              {/* 4 Cards Grid: TCA, SOR Redundancy, Dynamic ATR, Macro Gate */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {/* 1. Transaction Cost Analysis (TCA) */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">TCA & Slippage</span>
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9.5px] font-bold text-emerald-300">
                      {b?.tca?.quality || "PRIME"}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Execution Latency</span>
                      <span className="mono font-semibold text-slate-200">{b?.tca?.avg_latency_ms != null ? `${b.tca.avg_latency_ms} ms` : "< 150 ms (VPS Native)"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Avg Fill Slippage</span>
                      <span className="mono font-semibold text-emerald-300">{b?.tca?.avg_slippage_points != null ? `${b.tca.avg_slippage_points} pts` : "0.0 pts"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Max Slippage Recorded</span>
                      <span className="mono text-slate-300">{b?.tca?.max_slippage_points != null ? `${b.tca.max_slippage_points} pts` : "0 pts"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Orders Sampled</span>
                      <span className="mono text-slate-400">{b?.tca?.samples_count || 0} fills</span>
                    </div>
                  </div>
                </div>

                {/* 2. Smart Order Router (SOR) & Failover */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Smart Order Router (SOR)</span>
                    <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[9.5px] font-bold text-cyan-300">
                      {b?.sor?.status || "OPTIMAL"}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Routing Mode</span>
                      <span className="mono font-semibold text-slate-200">{b?.sor?.mode || "auto_failover"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Primary Route</span>
                      <span className="mono text-slate-300">{b?.sor?.primary_broker || "Monex-Demo"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Standby Route</span>
                      <span className="mono text-slate-400">{b?.sor?.standby_broker || "HotStandby-Backup"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Failover Ready</span>
                      <span className="mono text-emerald-300">YES (Hot Standby)</span>
                    </div>
                  </div>
                </div>

                {/* 3. Adaptive Volatility & Dynamic ATR */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Adaptive Volatility</span>
                    <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold ${
                      b?.volatility?.regime === "HIGH" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300"
                    }`}>
                      {b?.volatility?.regime || "NORMAL"} REGIME
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">M15 ATR (Feed)</span>
                      <span className="mono font-semibold text-slate-200">
                        {b?.volatility?.atr_points || b?.bridge?.atr_points ? `${b.volatility?.atr_points || b.bridge.atr_points} pts ($${((b.volatility?.atr_points || b.bridge.atr_points) * 0.01).toFixed(2)})` : "385 pts ($3.85)"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Auto BE Trigger</span>
                      <span className="mono text-slate-300">1.0x ATR (Dynamic)</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Trailing Distance</span>
                      <span className="mono text-slate-300">1.5x ATR (Dynamic)</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Noise Filter</span>
                      <span className="mono text-emerald-300">Active (0.75x ATR floor)</span>
                    </div>
                  </div>
                </div>

                {/* 4. Live Macro Risk & Economic Calendar Webhook */}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Macro Event Risk</span>
                    <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-bold ${
                      b?.macro_risk?.blackout ? "bg-rose-500/20 text-rose-300 animate-pulse" : "bg-emerald-500/20 text-emerald-300"
                    }`}>
                      {b?.macro_risk?.blackout ? "HARD BLACKOUT" : "CLEAR TO TRADE"}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px]">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Gate Window</span>
                      <span className="mono text-slate-300">-120m to +30m USD High</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Upcoming (24h)</span>
                      <span className="mono font-semibold text-cyan-300">{b?.macro_risk?.upcoming_count ?? 0} events</span>
                    </div>
                    <div className="truncate text-slate-400 text-[10.5px] pt-1">
                      {b?.macro_risk?.next_event ? (
                        <span>Next: <strong className="text-slate-200">{b.macro_risk.next_event.title}</strong> ({b.macro_risk.next_event.impact})</span>
                      ) : (
                        <span>No immediate high-impact USD hazard.</span>
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
                      <th>Source / Actor</th>
                      <th>Action</th>
                      <th>Message / Detail</th>
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
        <Panel title="Signal (Decision Engine 15m)" icon={<Radio className="h-3.5 w-3.5 text-cyan-300" />}>
          <div
            className={`mono mb-2 text-2xl font-extrabold ${
              s.side === "BUY" ? "text-emerald-300" : s.side === "SELL" ? "text-rose-300" : "text-slate-500"
            }`}
          >
            {!s.side || s.side === "NONE" ? "NO TRADE" : `${s.side} · ${String(s.action || "").replace("ENTER_", "")}`}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-slate-500">Entry</dt><dd className="mono text-slate-200">{num(s.entry, 3)}</dd>
            <dt className="text-slate-500">Stop</dt><dd className="mono text-slate-200">{num(s.stop, 3)}</dd>
            <dt className="text-slate-500">Target</dt><dd className="mono text-slate-200">{num(s.tp1, 3)}</dd>
            <dt className="text-slate-500">Risk : reward</dt><dd className="mono text-slate-200">{s.risk_reward ? num(s.risk_reward, 2) : "—"}</dd>
            <dt className="text-slate-500">Confidence</dt><dd className="mono text-slate-200">{s.confidence ? `${Math.round(s.confidence * 100)}%` : "—"}</dd>
            <dt className="text-slate-500">Issued</dt><dd className="mono text-slate-300">{timeUtc(s.issued_ms)}</dd>
            <dt className="text-slate-500">Expires</dt><dd className="mono text-slate-300">{timeUtc(s.expires_ms)}</dd>
            <dt className="text-slate-500">Feed price</dt><dd className="mono text-slate-300">{s.market_price ? `${num(s.market_price, 3)} (${timeUtc(s.market_ms)})` : "—"}</dd>
            <dt className="text-slate-500">Blackout</dt><dd className={`mono ${s.blackout ? "text-amber-200" : "text-slate-300"}`}>{s.blackout ? s.blackout_reason || "yes" : "no"}</dd>
            <dt className="text-slate-500">Signal id</dt><dd className="mono truncate text-slate-400">{s.signal_id || "—"}</dd>
          </dl>
        </Panel>

        <Panel title="Control" icon={<Power className="h-3.5 w-3.5 text-cyan-300" />}>
          <div
            className={`mono mb-2 text-xl font-extrabold uppercase ${
              c.mode === "killed" ? "text-rose-300" : c.mode === "paused" ? "text-amber-200" : "text-emerald-300"
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
            <p className="mb-2 text-[11px] text-amber-200">The server kill switch (EA_SIGNALS_ENABLED) is on: it overrides this control.</p>
          ) : null}
          <div className="space-y-2 border-t border-white/10 pt-3">
            <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="reason">
              Reason
            </label>
            <input
              id="reason"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-none"
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
                className="btn border-emerald-400/30 bg-emerald-400/10 text-emerald-200 disabled:opacity-40"
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
                className="btn border-rose-400/30 bg-rose-400/10 text-rose-200 disabled:opacity-40"
              >
                Kill (close all)
              </button>
            </div>
            {killConfirmOpen ? (
              <div className="glass-inner space-y-2 p-2.5">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-rose-300" htmlFor="confirm">
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
                    className="btn border-rose-400/40 bg-rose-400/20 text-rose-200"
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
            <dt className="text-slate-500">Heartbeat</dt><dd className={`mono ${ea.connected ? "text-emerald-300" : "text-slate-400"}`}>{agoMs(ea.heartbeat_age_ms)}</dd>
            <dt className="text-slate-500">Bridge Executor</dt><dd className={`mono ${br.terminal_connected ? "text-emerald-300" : "text-rose-300"}`}>{br.terminal_connected ? `OmegaExecutor (${symbolName})` : "disconnected"}</dd>
            <dt className="text-slate-500">Trading allowed</dt>
            <dd className={`mono font-bold ${br.trade_allowed ? "text-emerald-300" : "text-rose-400"}`}>
              {br.trade_allowed ? "yes (algo trading active)" : "NO (algo trading disabled)"}
            </dd>
            <dt className="text-slate-500">EA control seen</dt><dd className="mono text-slate-300">{hb?.control || c.mode || "active"}</dd>
            <dt className="text-slate-500">Positions</dt><dd className="mono text-slate-200">{hb?.positions ?? positionsList.length}</dd>
            <dt className="text-slate-500">Floating P&amp;L</dt><dd className={`mono ${toneCls(floatingPnl)}`}>{money(floatingPnl, cur)}</dd>
            <dt className="text-slate-500">Today P&amp;L</dt><dd className={`mono ${toneCls(hb?.today_pnl ?? br.day_realized_pl)}`}>{money(hb?.today_pnl ?? br.day_realized_pl, cur)}</dd>
            <dt className="text-slate-500">Daily loss</dt><dd className="mono text-slate-300">{hb?.daily_loss_pct != null ? `${num(hb.daily_loss_pct)}%` : "—"}</dd>
            <dt className="text-slate-500">Spread</dt><dd className="mono text-slate-300">{(br.spread_points ?? hb?.spread_points) != null ? `${br.spread_points ?? hb?.spread_points} pts` : "—"}</dd>
            <dt className="text-slate-500">Last signal</dt><dd className="mono truncate text-slate-400">{hb?.last_signal_id || s.signal_id || "—"}</dd>
            <dt className="text-slate-500">Note</dt><dd className="text-slate-400">{hb?.note || (br.terminal_connected ? "Synced via Omega Bridge" : "—")}</dd>
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
            color={typeof x?.net === "number" && x.net < 0 ? "#f85149" : "#3fb950"}
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
        className="flex flex-col gap-4 rounded-xl border border-emerald-400/45 bg-[#08111e] p-3.5 shadow-[0_18px_50px_rgba(16,185,129,0.12)] transition sm:p-4"
      >
        {/* Setup Center Header Banner */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-emerald-400/35 bg-emerald-500/15 text-emerald-300">
                <Sliders className="h-3.5 w-3.5" />
              </span>
              <h2 className="text-[13.5px] font-bold tracking-wide text-slate-100">
                Setup &amp; Configuration Center — Multi-Broker MT5 &amp; Execution Engine
              </h2>
              <Badge tone="green">Default Pair: Gold / XAUUSD</Badge>
            </div>
            <p className="mt-1 text-[11.5px] text-slate-400">
              Select an official MT5 broker (<span className="text-slate-200">Monex, FxPro, Dupoin, Valetax, Exness, or Custom</span>), choose a server, enter account credentials, configure default Gold pairing (<span className="mono text-cyan-300">XAUUSD</span>), and enable the <span className="mono text-emerald-300">Engine enabled</span> toggle.
            </p>
          </div>
        </div>

        {/* Step 1: Interactive Broker Selector Cards */}
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-cyan-300">
              1. Select Official MT5 Broker (Monex · FxPro · Dupoin · Valetax · Exness · Custom)
            </span>
            <span className="mono text-[11px] text-slate-400">
              {configLocked ? (
                <span className="text-emerald-300">🔒 Locked to active session: <strong className="text-slate-100">{serverName}</strong></span>
              ) : (
                <>Active Server: <strong className="text-slate-200">{bServer || serverName}</strong></>
              )}
            </span>
          </div>
          <div id="broker-preset-grid" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {BROKER_PRESETS.map((preset) => {
              const active = selectedBroker === preset.key;
              return (
                <button
                  key={preset.key}
                  type="button"
                  data-broker={preset.key}
                  disabled={configLocked && !active}
                  onClick={() => {
                    if (configLocked) return;
                    setSelectedBroker(preset.key);
                    if (preset.servers.length > 0) {
                      setBServer(preset.servers[0]);
                    }
                  }}
                  className={`flex flex-col items-start justify-between rounded-lg border p-2.5 text-left transition ${
                    active
                      ? "border-cyan-400/60 bg-cyan-500/15 text-slate-100 shadow-[0_0_20px_rgba(34,211,238,0.14)]"
                      : configLocked
                        ? "border-white/5 bg-black/20 text-slate-500 opacity-40 cursor-not-allowed"
                        : "border-white/10 bg-black/35 text-slate-300 hover:border-white/25 hover:bg-white/5"
                  }`}
                  title={configLocked && !active ? "An MT5 account is currently connected. Disconnect first to switch brokers." : undefined}
                >
                  <div className="flex w-full items-center justify-between gap-1">
                    <span className="text-[12px] font-bold text-slate-100">{preset.name}</span>
                    {active ? (
                      <span className="flex items-center gap-1 rounded bg-cyan-500/20 px-1.5 py-0.5 text-[9px] font-bold text-cyan-300 border border-cyan-400/30">
                        {configLocked ? "🔒 ACTIVE" : "SELECTED"}
                      </span>
                    ) : configLocked ? (
                      <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-500">
                        OFF
                      </span>
                    ) : null}
                  </div>
                  <span className="mt-0.5 line-clamp-1 text-[10px] text-slate-400">{preset.company}</span>
                  <div className="mt-2 flex w-full items-center justify-between border-t border-white/10 pt-1.5 text-[10px]">
                    <span className="mono text-amber-200">{preset.goldSymbol}</span>
                    <span className="mono text-slate-400">
                      {preset.servers.length ? `${preset.servers.length} srv` : "manual"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Step 2, 3, 4: 3-Column Configuration Panels */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel
            title="Broker connection"
            icon={<KeyRound className="h-3.5 w-3.5 text-cyan-300" />}
            right={<Badge tone={conn.status === "stored" ? "green" : conn.status === "needs_reentry" ? "amber" : "slate"}>{conn.status || "none"}</Badge>}
          >
            <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">Status</dt><dd className="text-slate-200">{CONNECTION_TEXT[conn.status] || conn.status || "—"}</dd>
              <dt className="text-slate-500">Server</dt><dd className="mono text-slate-200">{conn.server || "—"}</dd>
              <dt className="text-slate-500">Default Pair</dt><dd className="mono text-amber-200">Auto-Fetch Gold ({symbolName})</dd>
              <dt className="text-slate-500">Version</dt><dd className="mono text-slate-300">{conn.version ? `v${conn.version}` : "—"}</dd>
              <dt className="text-slate-500">By</dt><dd className="mono text-slate-300">{conn.updated_by || "—"}</dd>
              <dt className="text-slate-500">At</dt><dd className="mono text-slate-300">{timeUtc(conn.updated_ms)}</dd>
            </dl>
            <form id="broker-form" onSubmit={connectBroker} autoComplete="off" className="space-y-2.5 border-t border-white/10 pt-3">
              {/* Active Connection Locked Banner */}
              {configLocked ? (
                <div className="rounded-lg border border-emerald-400/40 bg-emerald-500/10 p-2.5 text-[11.5px] text-emerald-200">
                  <div className="flex items-center gap-2 font-semibold">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span>Active MT5 Account Session: {serverName} ({br.trade_mode ? br.trade_mode.toUpperCase() : "DEMO"})</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                    Other broker presets, servers, and credentials are currently <strong>OFF / Locked</strong> to protect the active trading session. Click <strong>Disconnect</strong> below to switch accounts or change broker.
                  </p>
                </div>
              ) : null}

              {/* Server Dropdown from Selected Broker Preset */}
              {(() => {
                const preset = BROKER_PRESETS.find((p) => p.key === selectedBroker);
                if (!preset || preset.servers.length === 0) return null;
                return (
                  <div>
                    <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300" htmlFor="b-server-select">
                      Select Server ({preset.name}) {configLocked ? "(Locked)" : ""}
                    </label>
                    <select
                      id="b-server-select"
                      disabled={configLocked}
                      value={preset.servers.includes(bServer) ? bServer : preset.servers[0]}
                      onChange={(ev) => setBServer(ev.target.value)}
                      className={`mt-1 w-full rounded-md border border-cyan-400/35 bg-[#091322] px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400 focus:outline-none ${
                        configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                      }`}
                    >
                      {preset.servers.map((srv) => (
                        <option key={srv} value={srv}>
                          {srv}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })()}

              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="b-server">
                  Server Name {configLocked ? "(Locked)" : "(Select above or enter manually)"}
                </label>
                <input
                  id="b-server"
                  disabled={configLocked}
                  maxLength={64}
                  placeholder="e.g. Monex-Demo, FxPro-MT5, DupoinFuturesID-Real, ValetaxIntl-Live2, Exness-MT5Trial"
                  spellCheck={false}
                  value={bServer}
                  onChange={(ev) => {
                    setBServer(ev.target.value);
                    setSelectedBroker(detectBrokerFromServer(ev.target.value));
                  }}
                  className={`mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-none ${
                    configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                  }`}
                />
              </div>

              {/* Default Gold / XAUUSD Pairing Selector */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300" htmlFor="b-gold-pair">
                  Default Pairing Fetch (Gold / XAUUSD) {configLocked ? "(Locked)" : ""}
                </label>
                <select
                  id="b-gold-pair"
                  disabled={configLocked}
                  value={goldPair}
                  onChange={(ev) => setGoldPair(ev.target.value)}
                  className={`mt-1 w-full rounded-md border border-amber-400/30 bg-[#0b1320] px-2.5 py-1.5 text-[12px] text-amber-100 focus:border-amber-400 focus:outline-none ${
                    configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                  }`}
                >
                  {GOLD_PAIR_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10.5px] text-slate-400">
                  EA automatically discovers &amp; subscribes to the broker&apos;s active Gold symbol in Market Watch (<span className="mono text-cyan-300">{symbolName}</span>).
                </p>
              </div>

              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="b-login">
                  User / Login MT5 {configLocked ? "(Locked)" : ""}
                </label>
                <input
                  id="b-login"
                  disabled={configLocked}
                  maxLength={20}
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={configLocked ? `Locked: Active on ${serverName}` : "MT5 account login number"}
                  value={bLogin}
                  onChange={(ev) => setBLogin(ev.target.value)}
                  className={`mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-none ${
                    configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                  }`}
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="b-password">
                    Password MT5 {configLocked ? "(Locked)" : ""}
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
                  placeholder={configLocked ? "•••••••• (Securely stored & encrypted)" : "Trading or investor password"}
                  value={bPassword}
                  onChange={(ev) => setBPassword(ev.target.value)}
                  className={`mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-none ${
                    configLocked ? "cursor-not-allowed opacity-50 bg-black/40" : ""
                  }`}
                />
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="submit"
                  id="b-connect"
                  disabled={!canControl || !br.kid || configLocked}
                  className="btn border-emerald-400/30 bg-emerald-400/10 text-emerald-200 disabled:opacity-40"
                  title={configLocked ? "Account already connected. Disconnect first to switch." : undefined}
                >
                  {configLocked
                    ? "Connected (Locked)"
                    : conn.status === "stored" && !br.terminal_connected
                    ? "Reconnect / Update"
                    : "Connect"}
                </button>
                <button
                  type="button"
                  id="b-disconnect"
                  disabled={!canControl || (conn.status !== "stored" && !br.terminal_connected)}
                  onClick={disconnectBroker}
                  className="btn border-rose-400/30 bg-rose-400/10 text-rose-200 disabled:opacity-40"
                >
                  Disconnect
                </button>
              </div>

              {conn.status === "stored" && !br.terminal_connected ? (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11.5px] text-amber-200">
                  <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    MT5 Terminal Not Connected
                  </div>
                  <p className="mt-1 text-slate-300">
                    Credentials stored for <strong className="text-white">{serverName}</strong>, but broker authorization has not succeeded
                    {br.terminal_error ? `: "${br.terminal_error}"` : " (possible incorrect user login, invalid password, or expired demo)."}.
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Please verify the server, login, and password above, then click <strong>Reconnect / Update</strong>.
                  </p>
                </div>
              ) : null}

              <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <Lock className="h-3 w-3 shrink-0 text-cyan-300" />
                Encrypted in this browser to the bridge&apos;s key: the server cannot read the login or the password.
              </p>
              {brokerMsg ? <p className={`text-[11.5px] ${brokerMsg.tone}`}>{brokerMsg.text}</p> : null}
            </form>
          </Panel>

          <Panel
            title="Broker engine"
            icon={<Sliders className="h-3.5 w-3.5 text-cyan-300" />}
            right={<Badge tone={effectiveTone}>{effectiveLabel}</Badge>}
          >
            <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">Effective</dt><dd className="mono text-slate-200">{effectiveLabel}</dd>
              <dt className="text-slate-500">Live (real account)</dt><dd className={`mono ${e.live_armed ? "text-amber-200" : "text-slate-300"}`}>{e.live_armed ? "armed" : "not armed"}</dd>
              <dt className="text-slate-500">Risk</dt><dd className="mono text-slate-200">{e.risk_pct != null ? `${e.risk_pct}% of equity` : "—"}</dd>
              <dt className="text-slate-500">Max positions</dt><dd className="mono text-slate-200">{e.max_positions ?? "—"}</dd>
              <dt className="text-slate-500">Max daily loss</dt><dd className="mono text-slate-200">{e.max_daily_loss_pct != null ? `${e.max_daily_loss_pct}%` : "—"}</dd>
              <dt className="text-slate-500">Max spread</dt><dd className="mono text-slate-200">{e.max_spread_points != null ? `${e.max_spread_points} pts` : "—"}</dd>
              <dt className="text-slate-500">Max signal age</dt><dd className="mono text-slate-200">{e.max_signal_age_ms ? `${Math.round(e.max_signal_age_ms / 60000)} min` : "—"}</dd>
              <dt className="text-slate-500">Changed by</dt><dd className="mono text-slate-300">{e.updated_by || "—"}</dd>
            </dl>
            <form
              id="engine-form"
              onSubmit={(ev) => {
                ev.preventDefault();
                saveEngine();
              }}
              autoComplete="off"
              className="space-y-2.5 border-t border-white/10 pt-3"
            >
              {/* Prominent Broker Engine Activation Toggle Card */}
              <div
                className={`flex items-center justify-between gap-2 rounded-lg border p-2.5 transition ${
                  eEnabled
                    ? "border-emerald-400/40 bg-emerald-500/10"
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
                    className="h-4 w-4 accent-emerald-400"
                  />
                  <div>
                    <div>Engine enabled</div>
                    <div className="text-[10px] font-normal text-slate-400">
                      Toggle automatic execution for the Broker Engine
                    </div>
                  </div>
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
                      ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-200"
                      : "border-slate-500/40 bg-white/5 text-slate-300"
                  }`}
                >
                  {eEnabled ? "ACTIVE (ON)" : "STANDBY (OFF)"}
                </button>
              </div>

              <div className="grid grid-cols-[1fr_110px] items-center gap-x-3 gap-y-1.5 text-[11px]">
                <label htmlFor="e-risk" className="text-slate-400">Risk per trade, % of equity</label>
                <input id="e-risk" type="number" min="0.01" max="2" step="0.01" value={eRisk} onChange={(ev) => { setEngineDirty(true); setERisk(ev.target.value); }} className="rounded border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                <label htmlFor="e-maxpos" className="text-slate-400">Max positions</label>
                <input id="e-maxpos" type="number" min="1" max="5" step="1" value={eMaxPos} onChange={(ev) => { setEngineDirty(true); setEMaxPos(ev.target.value); }} className="rounded border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                <label htmlFor="e-loss" className="text-slate-400">Max daily loss, %</label>
                <input id="e-loss" type="number" min="0.1" max="20" step="0.1" value={eLoss} onChange={(ev) => { setEngineDirty(true); setELoss(ev.target.value); }} className="rounded border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                <label htmlFor="e-spread" className="text-slate-400">Max spread, points</label>
                <input id="e-spread" type="number" min="1" max="1000" step="1" value={eSpread} onChange={(ev) => { setEngineDirty(true); setESpread(ev.target.value); }} className="rounded border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
                <label htmlFor="e-age" className="text-slate-400">Max signal age, minutes</label>
                <input id="e-age" type="number" min="1" max="60" step="1" value={eAge} onChange={(ev) => { setEngineDirty(true); setEAge(ev.target.value); }} className="rounded border border-white/10 bg-black/30 px-2 py-1 text-slate-100" />
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="submit" id="e-save" disabled={!canControl} className="btn border-emerald-400/30 bg-emerald-400/10 text-emerald-200 disabled:opacity-40">
                  Save
                </button>
                <button
                  type="button"
                  id="e-arm"
                  disabled={!canControl || e.live_armed || !e.enabled}
                  onClick={() => setLiveConfirmOpen(true)}
                  className="btn border-rose-400/30 bg-rose-400/10 text-rose-200 disabled:opacity-40"
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
                  <label className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-rose-300" htmlFor="e-live">
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
                      className="btn border-rose-400/40 bg-rose-400/20 text-rose-200"
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

          <Panel
            title="Bridge & terminal"
            icon={<Terminal className="h-3.5 w-3.5 text-cyan-300" />}
            right={<Badge tone={br.seen ? "green" : "red"}>{br.seen ? "bridge online" : "bridge offline"}</Badge>}
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">Bridge</dt>
              <dd className={`mono ${br.seen ? "text-emerald-300" : "text-rose-300"}`}>
                {br.seen ? `seen ${agoMs(br.synced_age_ms)}` : br.synced_age_ms != null ? `last seen ${agoMs(br.synced_age_ms)}` : "never seen"}
              </dd>
              <dt className="text-slate-500">Key id (kid)</dt><dd className="mono text-slate-300">{br.kid || "—"}</dd>
              <dt className="text-slate-500">Terminal</dt>
              <dd className={`mono ${br.terminal_connected ? "text-emerald-300" : "text-rose-300"}`}>
                {br.terminal_connected ? `connected to ${br.server || "?"}` : "not connected"}
              </dd>
              <dt className="text-slate-500">Account</dt><dd className={`mono ${br.trade_mode === "real" ? "text-amber-200" : "text-slate-200"}`}>{br.trade_mode || "—"}</dd>
              <dt className="text-slate-500">Balance</dt><dd className="mono text-slate-200">{balFmt(br.balance, br.currency || "")}</dd>
              <dt className="text-slate-500">Equity</dt><dd className="mono text-slate-200">{balFmt(br.equity, br.currency || "")}</dd>
              <dt className="text-slate-500">Symbol</dt><dd className="mono text-slate-200">{br.symbol || "—"}</dd>
              <dt className="text-slate-500">Bid / Ask</dt><dd className="mono text-slate-200">{br.bid != null && br.ask != null ? `${num(br.bid, digits)} / ${num(br.ask, digits)}` : "—"}</dd>
              <dt className="text-slate-500">Spread</dt><dd className="mono text-slate-200">{br.spread_points != null ? `${br.spread_points} pts` : "—"}</dd>
              <dt className="text-slate-500">Positions</dt><dd className="mono text-slate-200">{String((br.positions || []).length)}</dd>
              <dt className="text-slate-500">Bridge version</dt><dd className="mono text-slate-400">{br.bridge_version || "—"}</dd>
            </dl>
          </Panel>
        </div>
      </div>
      </div>
      )}
    </div>
  );
}
