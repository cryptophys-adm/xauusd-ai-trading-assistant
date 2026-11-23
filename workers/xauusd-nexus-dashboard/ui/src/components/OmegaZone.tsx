import OmegaWhy from "./OmegaWhy";
import { intentPlacement, intentZoneOf, isNum, knownFeedBasis, signalZoneOf, utcAndGmt7, utcClockOf, gmt7ClockOf, zoneText, zoneToBroker } from "../lib/entryZone";

// The Omega page's EZ1 pieces (owner-approved mockup, 2026-11-23), pure and null-safe so the render check
// (scripts/render-entry.tsx) renders them over GET /omega/api/overview bodies: the Details Signal card's rows (OM-LEAN:
// one price per label, on the header's scale) and the intents' Entry cell (broker scale) with where the limit came to rest.

const n = (v: unknown, d: number) => (isNum(v) ? v.toFixed(d) : "—");
const toBroker = (v: unknown, basis: number | null) => (isNum(v) && v > 0 ? (basis != null ? Math.round((v + basis) * 100) / 100 : v) : null);

/**
 * The Details Signal card's rows (OM-LEAN): the decision's entry, zone, stop and target on the header's scale (the
 * broker's: the signal's feed prices + basis) with two decimals; while the basis is unknown, the feed's, marked "feed".
 * Then R:R, confidence, issued and expires (UTC and GMT+7) and the signal id.
 */
export function SignalRows({ s }: { s: any }) {
  const sig = s && typeof s === "object" ? s : {};
  const basis = knownFeedBasis(sig);
  const fz = signalZoneOf(sig);
  const zone = basis != null ? zoneToBroker(fz, basis) : fz;
  const tag = basis != null ? null : <span className="text-fg-2"> · feed</span>;
  const p = (v: unknown) => { const x = toBroker(v, basis); return x != null ? <>{x.toFixed(2)}{tag}</> : "—"; };
  const dd = "mono text-slate-200";
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
      <dt className="text-slate-500">Entry</dt><dd className={dd}>{p(sig.entry)}</dd>
      {zone && <><dt className="text-slate-500">Zone</dt><dd className={dd}>{zoneText(zone)}{tag}</dd></>}
      <dt className="text-slate-500">Stop</dt><dd className={dd}>{p(sig.stop)}</dd>
      <dt className="text-slate-500">Target</dt><dd className={dd}>{p(sig.tp1)}</dd>
      <dt className="text-slate-500">Risk : reward</dt><dd className={dd}>{sig.risk_reward ? n(sig.risk_reward, 2) : "—"}</dd>
      <dt className="text-slate-500">Confidence</dt><dd className={dd}>{isNum(sig.confidence) && sig.confidence ? `${Math.round(sig.confidence * 100)}%` : "—"}</dd>
      <dt className="text-slate-500">Issued</dt><dd className="mono text-slate-300">{utcAndGmt7(sig.issued_ms)}</dd>
      <dt className="text-slate-500">Expires</dt><dd className="mono text-slate-300">{utcAndGmt7(sig.expires_ms)}</dd>
      <dt className="text-slate-500">Signal id</dt><dd className="mono truncate text-slate-400">{typeof sig.signal_id === "string" && sig.signal_id ? sig.signal_id : "—"}</dd>
    </dl>
  );
}

/** An intent that sets no entry (a modify, a close): its Entry cell is "—" (before OM-LEAN a modify read "Market (Ask)"). */
const NO_ENTRY = /^(modify|close|partial_close|close_all|delete_order)/;

/** An intent's Entry cell (broker scale): the price, how a zone limit came to rest, and the zone. "Market" without a price. */
export function IntentEntry({ i, digits = 2 }: { i: any; digits?: number }) {
  const how = intentPlacement(i);
  const zone = intentZoneOf(i);
  if (!isNum(i?.entry)) return <>{NO_ENTRY.test(typeof i?.kind === "string" ? i.kind : "") ? "—" : i?.side === "BUY" ? "Market (Ask)" : i?.side === "SELL" ? "Market (Bid)" : "—"}</>;
  return (
    <>
      <span className="block text-fg">{i.entry.toFixed(digits)}</span>
      {how && <span className="block text-[10.5px] text-fg-2">{how}</span>}
      {zone && <span className="block text-[10.5px] text-muted">zone {zoneText(zone, digits)}</span>}
    </>
  );
}

/** A creation time in UTC with GMT+7 under it: "14:07:12 UTC" / "21:07:12 GMT+7". */
export function CreatedCell({ ms }: { ms: unknown }) {
  if (!isNum(ms) || ms <= 0) return <>—</>;
  return <>{utcClockOf(ms, true)} UTC<span className="block text-[10.5px] text-fg-2">{gmt7ClockOf(ms, true)} GMT+7</span></>;
}

/** The intents on a phone (the table from sm up): one card each, every price on the broker scale. */
export function IntentCards({ intents, digits = 2 }: { intents: any[]; digits?: number }) {
  return (
    <div className="flex flex-col gap-2 p-2 sm:hidden">
      {(intents ?? []).map((i: any, k: number) => {
        const how = intentPlacement(i);
        const zone = intentZoneOf(i);
        const extra = [zone ? `zone ${zoneText(zone, digits)}` : null, isNum(i?.sl) ? `SL ${i.sl.toFixed(digits)}` : null, isNum(i?.tp) ? `TP ${i.tp.toFixed(digits)}` : null].filter(Boolean).join(" · ");
        return (
          <div key={typeof i?.id === "string" ? i.id : k} className="glass-inner mono px-3 py-2.5 text-[11.5px] text-slate-300">
            <div className="flex justify-between gap-2">
              <span>{i?.kind ?? "—"} <span className={i?.side === "BUY" ? "text-bull" : i?.side === "SELL" ? "text-bear" : ""}>{i?.side ?? ""}</span> {isNum(i?.lot) ? i.lot.toFixed(2) : isNum(i?.volume) ? i.volume.toFixed(2) : ""}</span>
              <span className="text-right text-fg-2">{isNum(i?.created_ms) && i.created_ms > 0 ? `${utcClockOf(i.created_ms, true)} UTC · ${gmt7ClockOf(i.created_ms)} GMT+7` : "—"}</span>
            </div>
            <div className="mt-1 text-fg">{isNum(i?.entry) ? <>{i.entry.toFixed(digits)} <span className="text-fg-2">broker{how ? ` · ${how}` : ""}</span></> : NO_ENTRY.test(typeof i?.kind === "string" ? i.kind : "") ? "—" : "market"}</div>
            {extra && <div className="mt-0.5 text-[10.5px] text-muted">{extra} · broker</div>}
            <div className="mt-0.5 text-[10.5px] text-fg-2">{typeof i?.status === "string" ? i.status : "—"}{i?.result ? ` · ${i.result.ok ? `ticket ${i.result.ticket ?? "?"}` : i.result.error || "failed"}` : ""}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Signal card's EZ1 parts over one /omega/api/overview body (the render check's view): the rows and the Entry status
 * (OmegaWhy with the planner's codes and details), and the intents' Entry cells.
 */
export function OmegaSignalView({ d }: { d: any }) {
  const b = d?.broker ?? null;
  const intents: any[] = Array.isArray(b?.intents) ? b.intents : [];
  return (
    <div aria-label="Omega signal">
      <SignalRows s={d?.signal} />
      <OmegaWhy codes={Array.isArray(b?.planner?.codes) ? b.planner.codes : null} sinceMs={isNum(b?.planner?.since_ms) ? b.planner.since_ms : null} details={b?.planner?.details ?? null} envEnabled={b?.engine?.env_enabled} />
      <IntentCards intents={intents} />
      {intents.map((i, k) => <div key={k}><IntentEntry i={i} /></div>)}
    </div>
  );
}
