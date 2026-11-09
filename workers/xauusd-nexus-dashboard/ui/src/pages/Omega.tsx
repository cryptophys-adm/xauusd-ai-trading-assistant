import { useEffect, useState, type FormEvent } from "react";
import { Activity, Cpu, KeyRound, Lock, Power, Radio, Server, ShieldAlert, Sliders, Terminal, Zap } from "lucide-react";
import { Badge, Dot, Empty, Kpi, Panel, Skeleton } from "../components/ui";

/**
 * Omega Execution Engine & Broker Bridge page inside the Nexus SPA (owner 2026-11-09:
 * integrated into the Nexus left sidebar navigation at nexus.cryptophys.work/omega/ and /#/omega
 * so every page sits behind the same Cloudflare Access login).
 * Calls same-origin /omega/api/* routes forwarded to xauusd-omega (OMEGA_PAGE binding).
 */

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
const toneCls = (v?: number | null) => (typeof v !== "number" || v === 0 ? "text-slate-300" : v > 0 ? "text-emerald-300" : "text-rose-300");
const timeUtc = (ms?: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const agoMs = (ms?: number | null) => {
  if (ms == null) return "never";
  const m = Math.round(ms / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
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

export default function Omega() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>("—");

  // Control state
  const [controlReason, setControlReason] = useState("");
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [killConfirmText, setKillConfirmText] = useState("");
  const [controlMsg, setControlMsg] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Broker credentials form state
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

  const load = async () => {
    try {
      const ov = await omegaJson("/omega/api/overview");
      setData(ov);
      setError(null);
      setUpdatedAt(new Date().toISOString().slice(11, 19) + " UTC");
      const eng = ov?.broker?.engine;
      if (eng && !engineDirty) {
        setEEnabled(eng.enabled === true);
        setERisk(eng.risk_pct != null ? String(eng.risk_pct) : "");
        setEMaxPos(eng.max_positions != null ? String(eng.max_positions) : "");
        setELoss(eng.max_daily_loss_pct != null ? String(eng.max_daily_loss_pct) : "");
        setESpread(eng.max_spread_points != null ? String(eng.max_spread_points) : "");
        setEAge(eng.max_signal_age_ms ? String(Math.round(eng.max_signal_age_ms / 60000)) : "");
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load Omega overview");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [engineDirty]);

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
    const reason = window.prompt("Reason to disconnect the broker account?");
    if (!reason || !reason.trim()) return;
    try {
      await omegaJson("/omega/api/connection", "DELETE", { reason: reason.trim() });
      setBrokerMsg({ tone: "text-emerald-300", text: "Disconnected." });
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

  if (loading && !data) {
    return (
      <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
        <Panel title="Omega · Execution Engine" icon={<Zap className="h-3.5 w-3.5 text-cyan-300" />}>
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
  const cur = hb?.currency || "";

  const e = b?.engine || {};
  const conn = b?.connection || {};
  const br = b?.bridge || {};
  const effectiveLabel = !e.env_enabled
    ? "off (server switch OMEGA_ENGINE_ENABLED)"
    : !e.enabled
      ? "off (enable it below)"
      : "on";
  const effectiveTone: "red" | "amber" | "green" = !e.env_enabled ? "red" : !e.enabled ? "amber" : "green";

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel
        title="Omega · XAUUSD Execution Engine"
        icon={<Zap className="h-3.5 w-3.5 text-cyan-300" />}
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={ea.connected ? "green" : "red"}>
              <Dot tone={ea.connected ? "green" : "red"} pulse={ea.connected} />
              {ea.connected ? "EA connected" : "EA offline"}
            </Badge>
            <Badge tone={hb?.mode === "live" ? "amber" : "cyan"}>
              {hb?.mode ? `${hb.mode} account` : "account unknown"}
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
          <p className="text-[12px] leading-relaxed text-slate-400">
            Omega monitors and controls the MT5 EA and, when enabled, plans and sizes trades from the Decision Engine&apos;s 15m decision and executes them through the outbound bridge on the MT5 host. Broker credentials are encrypted in this browser to the bridge&apos;s RSA-3072 public key. Updated <span className="mono text-slate-300">{updatedAt}</span>.
          </p>
        )}
      </Panel>

      {/* Signal, Control, Expert Advisor */}
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
            <dt className="text-slate-500">Heartbeat</dt><dd className={`mono ${ea.connected ? "text-emerald-300" : "text-rose-300"}`}>{agoMs(ea.heartbeat_age_ms)}</dd>
            <dt className="text-slate-500">Version</dt><dd className="mono text-slate-300">{hb?.version || "—"}</dd>
            <dt className="text-slate-500">Trading allowed</dt><dd className={`mono ${hb && !hb.trading_allowed ? "text-amber-200" : "text-slate-300"}`}>{hb ? (hb.trading_allowed ? "yes" : "no") : "—"}</dd>
            <dt className="text-slate-500">EA control seen</dt><dd className="mono text-slate-300">{hb?.control || "—"}</dd>
            <dt className="text-slate-500">Positions</dt><dd className="mono text-slate-200">{hb?.positions ?? "—"}</dd>
            <dt className="text-slate-500">Floating P&amp;L</dt><dd className={`mono ${toneCls(hb?.floating_pnl)}`}>{money(hb?.floating_pnl, cur)}</dd>
            <dt className="text-slate-500">Today P&amp;L</dt><dd className={`mono ${toneCls(hb?.today_pnl)}`}>{money(hb?.today_pnl, cur)}</dd>
            <dt className="text-slate-500">Daily loss</dt><dd className="mono text-slate-300">{hb?.daily_loss_pct != null ? `${num(hb.daily_loss_pct)}%` : "—"}</dd>
            <dt className="text-slate-500">Spread</dt><dd className="mono text-slate-300">{hb?.spread_points != null ? `${hb.spread_points} pts` : "—"}</dd>
            <dt className="text-slate-500">Last signal</dt><dd className="mono truncate text-slate-400">{hb?.last_signal_id || "—"}</dd>
            <dt className="text-slate-500">Note</dt><dd className="text-slate-400">{hb?.note || "—"}</dd>
          </dl>
        </Panel>
      </div>

      {/* Statistics KPIs */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ["Today (UTC)", st.today],
          ["7 days", st.week],
          ["30 days", st.month],
        ].map(([label, x]: [string, any]) => (
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

      {/* Broker Engine Section */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Broker connection"
          icon={<KeyRound className="h-3.5 w-3.5 text-cyan-300" />}
          right={<Badge tone={conn.status === "stored" ? "green" : conn.status === "needs_reentry" ? "amber" : "slate"}>{conn.status || "none"}</Badge>}
        >
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-slate-500">Status</dt><dd className="text-slate-200">{CONNECTION_TEXT[conn.status] || conn.status || "—"}</dd>
            <dt className="text-slate-500">Server</dt><dd className="mono text-slate-200">{conn.server || "—"}</dd>
            <dt className="text-slate-500">Version</dt><dd className="mono text-slate-300">{conn.version ? `v${conn.version}` : "—"}</dd>
            <dt className="text-slate-500">By</dt><dd className="mono text-slate-300">{conn.updated_by || "—"}</dd>
            <dt className="text-slate-500">At</dt><dd className="mono text-slate-300">{timeUtc(conn.updated_ms)}</dd>
          </dl>
          <form id="broker-form" onSubmit={connectBroker} autoComplete="off" className="space-y-2 border-t border-white/10 pt-3">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="b-server">Server</label>
              <input
                id="b-server"
                maxLength={64}
                placeholder="e.g. Monex-Demo"
                spellCheck={false}
                value={bServer}
                onChange={(ev) => setBServer(ev.target.value)}
                className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="b-login">Login</label>
              <input
                id="b-login"
                maxLength={20}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                value={bLogin}
                onChange={(ev) => setBLogin(ev.target.value)}
                className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400" htmlFor="b-password">Password</label>
              <input
                id="b-password"
                type="password"
                maxLength={64}
                autoComplete="new-password"
                value={bPassword}
                onChange={(ev) => setBPassword(ev.target.value)}
                className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-none"
              />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="submit"
                id="b-connect"
                disabled={!canControl || !br.kid}
                className="btn border-emerald-400/30 bg-emerald-400/10 text-emerald-200 disabled:opacity-40"
              >
                Connect
              </button>
              <button
                type="button"
                id="b-disconnect"
                disabled={!canControl || conn.status !== "stored"}
                onClick={disconnectBroker}
                className="btn border-rose-400/30 bg-rose-400/10 text-rose-200 disabled:opacity-40"
              >
                Disconnect
              </button>
            </div>
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
            className="space-y-2 border-t border-white/10 pt-3"
          >
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-200">
              <input
                type="checkbox"
                id="e-enabled"
                checked={eEnabled}
                onChange={(ev) => {
                  setEngineDirty(true);
                  setEEnabled(ev.target.checked);
                }}
              />
              Engine enabled
            </label>
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
            <dt className="text-slate-500">Balance</dt><dd className="mono text-slate-200">{money(br.balance, br.currency || "")}</dd>
            <dt className="text-slate-500">Equity</dt><dd className="mono text-slate-200">{money(br.equity, br.currency || "")}</dd>
            <dt className="text-slate-500">Symbol</dt><dd className="mono text-slate-200">{br.symbol || "—"}</dd>
            <dt className="text-slate-500">Spread</dt><dd className="mono text-slate-200">{br.spread_points != null ? `${br.spread_points} pts` : "—"}</dd>
            <dt className="text-slate-500">Positions</dt><dd className="mono text-slate-200">{String((br.positions || []).length)}</dd>
            <dt className="text-slate-500">Bridge version</dt><dd className="mono text-slate-400">{br.bridge_version || "—"}</dd>
          </dl>
        </Panel>
      </div>

      {/* Intents and Open Positions */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Intents (broker engine → bridge)" icon={<Cpu className="h-3.5 w-3.5 text-cyan-300" />}>
          {!(b?.intents || []).length ? (
            <Empty>No intent yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Created</th><th>Id</th><th>Kind</th><th>Side</th><th>Volume</th><th>SL</th><th>TP</th><th>Status</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {(b.intents || []).map((i: any) => (
                    <tr key={i.id}>
                      <td className="mono">{timeUtc(i.created_ms)}</td>
                      <td className="mono">{i.id}</td>
                      <td className="mono">{i.kind}</td>
                      <td className={`mono ${i.side === "BUY" ? "text-emerald-300" : i.side === "SELL" ? "text-rose-300" : ""}`}>{i.side || "—"}</td>
                      <td className="mono">{i.volume != null ? num(i.volume) : "—"}</td>
                      <td className="mono">{i.sl != null ? num(i.sl, 3) : "—"}</td>
                      <td className="mono">{i.tp != null ? num(i.tp, 3) : "—"}</td>
                      <td><Badge tone={INTENT_TONE[i.status] || "slate"}>{i.status}</Badge></td>
                      <td className="mono text-[11px]">{i.result ? (i.result.ok ? `ticket ${i.result.ticket ?? "?"}` : i.result.error || "failed") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Open positions" icon={<Server className="h-3.5 w-3.5 text-cyan-300" />}>
          {!(hb?.positions_detail || br?.positions || []).length ? (
            <Empty>{hb || br?.seen ? "No open position." : "No heartbeat or bridge state from MT5 yet."}</Empty>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Ticket</th><th>Side</th><th>Volume</th><th>Entry</th><th>Stop</th><th>Target</th><th>P&amp;L</th><th>Opened</th><th>Signal / Intent</th></tr>
                </thead>
                <tbody>
                  {(hb?.positions_detail || br?.positions || []).map((p: any) => (
                    <tr key={p.ticket}>
                      <td className="mono">{String(p.ticket)}</td>
                      <td className={`mono ${p.side === "BUY" ? "text-emerald-300" : "text-rose-300"}`}>{p.side}</td>
                      <td className="mono">{num(p.volume)}</td>
                      <td className="mono">{num(p.entry ?? p.open_price, 3)}</td>
                      <td className="mono">{num(p.sl, 3)}</td>
                      <td className="mono">{num(p.tp, 3)}</td>
                      <td className={`mono ${toneCls(p.profit)}`}>{money(p.profit, cur || br?.currency || "")}</td>
                      <td className="mono">{timeUtc(p.opened_ms)}</td>
                      <td className="mono text-[11px]">{p.signal_id || p.intent_id || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* Closed Deals and Audits */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Closed deals" icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />}>
          {!(data?.deals || []).length ? (
            <Empty>No closed deal reported yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Closed</th><th>Side</th><th>Volume</th><th>Entry</th><th>Exit</th><th>Net</th><th>Reason</th><th>Mode</th><th>Signal</th></tr>
                </thead>
                <tbody>
                  {(data.deals || []).map((d: any, idx: number) => {
                    const net = (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0);
                    return (
                      <tr key={d.deal_ticket ?? idx}>
                        <td className="mono">{timeUtc(d.closed_ms)}</td>
                        <td className={`mono ${d.side === "BUY" ? "text-emerald-300" : "text-rose-300"}`}>{d.side}</td>
                        <td className="mono">{num(d.volume)}</td>
                        <td className="mono">{num(d.entry_price, 3)}</td>
                        <td className="mono">{num(d.exit_price, 3)}</td>
                        <td className={`mono ${toneCls(net)}`}>{money(net, d.currency || "")}</td>
                        <td className="mono">{d.reason}</td>
                        <td className="mono">{d.mode}</td>
                        <td className="mono text-[11px]">{d.signal_id || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Engine & control audit" icon={<ShieldAlert className="h-3.5 w-3.5 text-cyan-300" />}>
          {!(b?.events || []).length && !(data?.control_events || []).length ? (
            <Empty>No audit event yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>At</th><th>By</th><th>Action</th><th>Detail</th></tr>
                </thead>
                <tbody>
                  {(b?.events || []).map((x: any, idx: number) => (
                    <tr key={`e-${idx}`}>
                      <td className="mono">{timeUtc(x.ms)}</td>
                      <td className="mono">{x.actor}</td>
                      <td className="mono text-cyan-300">{x.action}</td>
                      <td className="mono text-[11px] text-slate-400">{x.detail ? JSON.stringify(x.detail).slice(0, 140) : "—"}</td>
                    </tr>
                  ))}
                  {(data?.control_events || []).map((ev: any, idx: number) => (
                    <tr key={`c-${idx}`}>
                      <td className="mono">{timeUtc(Date.parse(ev.at))}</td>
                      <td className="mono">{ev.actor}</td>
                      <td className="mono text-amber-200">{`${ev.previous_mode} → ${ev.mode}`}</td>
                      <td className="text-[11px] text-slate-400">{ev.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
