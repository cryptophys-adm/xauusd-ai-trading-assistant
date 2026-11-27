import { AlertTriangle } from "lucide-react";
import { Badge, Hint } from "./ui";
import { TEXT } from "../lib/tokens";
import { whenText } from "../lib/pmLines";
import {
  RECOVERY_HELD_HINT, SERVER_CHECK_HINT, recoveryHeldFacts, serverCheckReading,
  type ConnectionMsg, type RecoveryHeld, type SaveWarning, type ServerCheck
} from "../lib/omegaStatus";

// OS1: the quiet status lines inside the Omega page's existing cards (lib/omegaStatus.ts reads them). Pure and null-safe,
// the same for the owner and a viewer: status only, no action or form here. Every backend sentence is rendered as text.

/** A server name exactly as the API sent it: mono, spaces kept (whitespace-pre), in a faint box so an edge space shows. */
export function ExactName({ name }: { name: string }) {
  return <code className="mono whitespace-pre rounded-sm border border-white/10 bg-black/30 px-1 text-[11.5px] text-slate-100">{name}</code>;
}

/** "did you mean <name>?" (the Omega page only). */
function DidYouMean({ name }: { name: string }) {
  return <span className="text-slate-300">did you mean <ExactName name={name} />?</span>;
}

/** Broker connection card: whether the terminal has logged into the stored server; nothing with no stored connection. */
export function ServerCheckLine({ sc }: { sc: ServerCheck | null }) {
  if (!sc) return null;
  const r = serverCheckReading(sc);
  return (
    <div id="server-check" role="status" className="mb-3 space-y-1 text-[11.5px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-slate-500">Server check</span>
        <Badge tone={r.tone}>{r.label}</Badge>
        <Hint text={SERVER_CHECK_HINT} />
      </div>
      <p className={sc.status === "not_seen" ? TEXT.fault : "text-slate-400"}>{r.text}</p>
      {sc.didYouMean ? <p><DidYouMean name={sc.didYouMean} /></p> : null}
    </div>
  );
}

/** The Save's near-match warning, inline under the success line. */
export function SaveWarningLine({ w }: { w: SaveWarning }) {
  return (
    <div role="status" className="flex gap-1.5 text-[11.5px] text-late">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        {w.message ? <p>{w.message}</p> : <p>A near match of a server seen before; saved as entered.</p>}
        {w.didYouMean ? <p><DidYouMean name={w.didYouMean} /></p> : null}
      </div>
    </div>
  );
}

/** The connection form's message: its line and, after a saved near match, the warning. */
export function ConnectionMessage({ msg }: { msg: ConnectionMsg | null }) {
  if (!msg) return null;
  return (
    <div className="space-y-1">
      <p className={`text-[11.5px] ${msg.tone}`}>{msg.text}</p>
      {msg.warning ? <SaveWarningLine w={msg.warning} /> : null}
    </div>
  );
}

/** The watchdog's Last recovery card's chip (header). */
export function RecoveryHeldChip({ held }: { held: RecoveryHeld | null }) {
  if (!held) return null;
  return <span className="flex items-center gap-1.5"><Badge tone="late">recovery held</Badge><Hint text={RECOVERY_HELD_HINT} /></span>;
}

/** The hold's message and facts, under the card's header. */
export function RecoveryHeldLine({ held }: { held: RecoveryHeld | null }) {
  if (!held) return null;
  const facts = [...recoveryHeldFacts(held), ...(held.ms ? [`since ${whenText(held.ms)}`] : [])];
  return (
    <div id="recovery-held" role="status" className="mt-3 rounded-md border border-late-fill/35 bg-late-fill/10 p-2.5 text-[11.5px]">
      {held.message ? <p className="text-slate-200">{held.message}</p> : <p className="text-slate-200">No more terminal restarts for now.</p>}
      {facts.length ? <p className="mono mt-1 text-late">{facts.join(" · ")}</p> : null}
    </div>
  );
}
