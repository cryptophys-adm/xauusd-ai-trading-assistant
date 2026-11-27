import { useState, type FormEvent } from "react";
import { AlertTriangle, KeyRound, RadioTower } from "lucide-react";
import { Badge, Empty, Hint, Panel, PollError, Skeleton, phaseOf } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { usePoll, type Poll } from "../lib/usePoll";
import { TEXT } from "../lib/tokens";
import { buildEnvelope } from "./Omega";
import {
  FEEDS_READS, canControlOf, disconnectFeed, errorWords, feedsOf, loginOf, loginWhen, oldKey, readFeeds, submitFeedLogin, syncOf, terminalOf,
  type Feed, type FeedForm, type WriteResult
} from "../lib/feeds";

// F4: the Data feeds page (Live › Data feeds, #/feeds; owner 2026-11-27: "tempatkan di nexus > live"). One card, "Data
// feeds", over the Omega overview's broker.feeds (F1, src/feed-bridge.mjs feedOverview): per data-only feed bridge its id,
// fresh or stale with the sync age, its terminal, server and symbol, its login's status and version, and a warning when
// the stored login is sealed to a key the feed no longer has. No account data exists for a feed, so none is shown. The
// owner (viewer.can_control, the gate of the Omega page's broker connection form) also gets, per feed, a login form
// sealed in this browser with the Omega page's own buildEnvelope to THAT feed's public_key and kid (never the executor
// bridge's), then POST /omega/api/feed-connection; and a disconnect with a required reason (ConfirmDialog), DELETE
// /omega/api/feed-connection. The inputs are uncontrolled: the password is never React state, never stored, never
// logged and never in a message, and every field is cleared after a submit. Others see the card read only. FeedsView is
// pure and null-safe (the page render check renders it over test/fixtures/nexus-f4/*.json, the seed's real answers).

export const CARD_HINT = "A data feed is a second MT5 terminal on the VPS that sends gold M1 bars only: it never trades, never receives an order and reports no account. The MT5 fallback reads a fresh feed first.";
export const FORM_HINT = "Encrypted in this browser to this feed bridge's own key; Omega stores only the sealed envelope and cannot read it. A data feed never trades: a demo or investor login is enough.";
export const OLD_KEY_HINT = "The feed bridge was reinstalled with a new key after its login was stored, so it gets no login until the login is entered again.";
export const DATA_ONLY = "Data feed (no trading)";

/** A feed's message after the owner's last write. */
export type FeedMsg = { kind: "saved"; version: number | null; server: string | null } | { kind: "cleared" } | { kind: "error"; code: string };
export type FeedUi = { phase?: "idle" | "sending"; msg?: FeedMsg | null };
export type FeedsViewProps = {
  /** GET /omega/api/overview's body. */
  d: any;
  /** Per bridge id: its write in flight and its last message. */
  ui?: Record<string, FeedUi>;
  onSubmit?: (feed: Feed, form: HTMLFormElement) => void;
  onDisconnect?: (feed: Feed) => void;
  /** The page's poll: the panel's stale tag after a failed refresh. */
  poll?: Poll;
};

const INPUT = "mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-hidden";

function Row({ k, children, className = "text-slate-200" }: { k: string; children: string; className?: string }) {
  return <><dt className="text-slate-500">{k}</dt><dd className={`mono min-w-0 wrap-break-word ${className}`}>{children}</dd></>;
}

function Message({ msg }: { msg: FeedMsg }) {
  if (msg.kind === "saved") return <p className="text-[11.5px] text-ok">Saved{msg.version ? ` v${msg.version}` : ""}{msg.server ? ` for ${msg.server}` : ""}; applied at the feed&apos;s next sync.</p>;
  if (msg.kind === "cleared") return <p className="text-[11.5px] text-ok">Disconnected; the feed gets no login from its next sync.</p>;
  return (
    <p role="alert" className="text-[11.5px] text-fault">
      <span className="mono break-all">Refused: {msg.code}</span><span className="text-fg-2"> · {errorWords(msg.code)}</span>
    </p>
  );
}

/** One feed bridge: its status, and for the owner its login form and disconnect. */
export function FeedCard({ f, canControl, ui = {}, onSubmit, onDisconnect }: { f: Feed; canControl: boolean; ui?: FeedUi; onSubmit?: FeedsViewProps["onSubmit"]; onDisconnect?: FeedsViewProps["onDisconnect"] }) {
  const sync = syncOf(f), term = terminalOf(f), login = loginOf(f);
  const sending = ui.phase === "sending";
  const id = `feed-${f.bridge_id}`;
  const submit = (ev: FormEvent<HTMLFormElement>) => { ev.preventDefault(); if (!sending) onSubmit?.(f, ev.currentTarget); };
  return (
    <section id={id} aria-label={`Data feed ${f.bridge_id}`} className="glass-inner min-w-0 p-3.5">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="mono break-all text-[13px] font-semibold text-fg">{f.bridge_id}</span>
          <Badge tone="off">{DATA_ONLY}</Badge>
        </div>
        <Badge tone={sync.tone}>{sync.label}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
        <Row k="Sync" className={TEXT[sync.tone]}>{sync.text}</Row>
        <Row k="Terminal" className={TEXT[term.tone]}>{term.text}</Row>
        <Row k="Server">{f.server ?? "—"}</Row>
        <Row k="Symbol">{f.symbol ?? "—"}</Row>
        <Row k="Login" className={TEXT[login.tone]}>{login.text}</Row>
        <Row k="Login set" className="text-slate-300">{loginWhen(f)}</Row>
        <Row k="Key ID" className="text-slate-300">{f.kid ?? "—"}</Row>
        <Row k="Bridge version" className="text-slate-400">{f.bridge_version ?? "—"}</Row>
      </dl>
      {oldKey(f) ? (
        <div role="status" className="mt-2.5 rounded-md border border-late-fill/35 bg-late-fill/10 p-2.5 text-[11.5px] text-late">
          <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Login sealed to an old key<Hint text={OLD_KEY_HINT} /></div>
          <p className="mt-1 text-slate-300">The feed gets no login until it is entered again.</p>
        </div>
      ) : null}
      {canControl ? (
        <form id={`${id}-form`} onSubmit={submit} autoComplete="off" className="mt-3 space-y-2.5 border-t border-white/10 pt-3" aria-label={`Login for data feed ${f.bridge_id}`}>
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-fg"><KeyRound className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />Feed login · data only<Hint text={FORM_HINT} /></div>
          <div className="grid gap-2.5 sm:grid-cols-3">
            <div className="min-w-0">
              <label className="block text-[11px] font-medium text-muted" htmlFor={`${id}-login`}>Login</label>
              <input id={`${id}-login`} name="login" maxLength={20} inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="Account number" disabled={sending} className={INPUT} />
            </div>
            <div className="min-w-0">
              <label className="block text-[11px] font-medium text-muted" htmlFor={`${id}-password`}>Password</label>
              <input id={`${id}-password`} name="password" type="password" maxLength={64} autoComplete="new-password" spellCheck={false} placeholder="Investor password" disabled={sending} className={INPUT} />
            </div>
            <div className="min-w-0">
              <label className="block text-[11px] font-medium text-muted" htmlFor={`${id}-server`}>Server</label>
              <input id={`${id}-server`} name="server" maxLength={64} autoComplete="off" spellCheck={false} placeholder={f.server ?? "As MT5 shows it"} disabled={sending} className={INPUT} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" id={`${id}-save`} disabled={sending || !f.public_key || !f.kid} className="btn btn-approve">{sending ? "Encrypting…" : "Save feed login"}</button>
            <button type="button" id={`${id}-disconnect`} disabled={sending || f.connection.status !== "stored"} onClick={() => onDisconnect?.(f)} className="btn btn-danger">Disconnect</button>
          </div>
          {ui.msg ? <Message msg={ui.msg} /> : null}
        </form>
      ) : ui.msg ? <div className="mt-2"><Message msg={ui.msg} /></div> : null}
    </section>
  );
}

/** The card over one read of the overview (pure, null-safe). */
export function FeedsView({ d, ui = {}, onSubmit, onDisconnect, poll }: FeedsViewProps) {
  const feeds = feedsOf(d);
  const canControl = canControlOf(d);
  return (
    <Panel title="Data feeds" icon={<RadioTower className="h-3.5 w-3.5 text-cyan-300" />} hint={CARD_HINT} poll={poll}
      right={<span className="text-[11px] text-muted">{canControl ? "owner" : "read only"}</span>}>
      {!feeds ? (
        <Empty when="The Omega overview sent no feed list.">No feed data</Empty>
      ) : !feeds.length ? (
        <Empty when="A feed bridge shows here after its first sync from the VPS.">No feed bridge has connected yet</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {feeds.map((f) => <FeedCard key={f.bridge_id} f={f} canControl={canControl} ui={ui[f.bridge_id]} onSubmit={onSubmit} onDisconnect={onDisconnect} />)}
        </div>
      )}
    </Panel>
  );
}

/** The disconnect's confirm box: a reason is required before the button works. */
export function DisconnectDialog({ feed, onDone }: { feed: Pick<Feed, "bridge_id">; onDone: (ok: boolean, reason?: string) => void }) {
  return (
    <ConfirmDialog
      options={{
        title: `Disconnect the ${feed.bridge_id} feed?`,
        body: <>The feed bridge gets no login from its next sync, and its new bars are refused until a login is saved again. Bars already stored stay. Trading is not affected: this is a data feed.</>,
        confirmLabel: "Disconnect",
        tone: "fault",
        reason: { label: "Reason (required)", placeholder: "e.g. rotate the feed login" }
      }}
      onDone={onDone}
    />
  );
}

/** The browser form as submitFeedLogin reads it: the named inputs' values, and its reset (every field empty). */
const formOf = (form: HTMLFormElement): FeedForm => ({
  value: (name) => { const el = form.elements.namedItem(name); return el instanceof HTMLInputElement ? el.value : ""; },
  reset: () => form.reset()
});

const msgOf = (r: WriteResult, cleared = false): FeedMsg => (r.ok ? (cleared ? { kind: "cleared" } : { kind: "saved", version: r.version, server: r.server }) : { kind: "error", code: r.error });

/**
 * The page: its one read (GET /omega/api/overview from lib/feeds.ts FEEDS_READS, every 30 s), the card, the login
 * submit and the disconnect. A failed first read is the shared error box with Retry now; a failed refresh keeps the
 * feeds under the panel's stale tag.
 */
export default function Feeds() {
  const poll = usePoll(readFeeds, FEEDS_READS.overview.everyMs);
  const [ui, setUi] = useState<Record<string, FeedUi>>({});
  const [asking, setAsking] = useState<Feed | null>(null);
  const set = (id: string, v: FeedUi) => setUi((u) => ({ ...u, [id]: v }));
  const submit = async (feed: Feed, form: HTMLFormElement) => {
    set(feed.bridge_id, { phase: "sending", msg: null });
    const r = await submitFeedLogin(feed, formOf(form), { seal: buildEnvelope });
    set(feed.bridge_id, { phase: "idle", msg: msgOf(r) });
    if (r.ok) await poll.refresh();
  };
  const done = async (ok: boolean, reason?: string) => {
    const feed = asking;
    setAsking(null);
    if (!ok || !feed) return;
    set(feed.bridge_id, { phase: "sending", msg: null });
    const r = await disconnectFeed(feed, reason ?? "");
    set(feed.bridge_id, { phase: "idle", msg: msgOf(r, true) });
    if (r.ok) await poll.refresh();
  };
  const ph = phaseOf(poll);
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      {ph === "error" ? (
        <Panel title="Data feeds" icon={<RadioTower className="h-3.5 w-3.5 text-cyan-300" />} hint={CARD_HINT}><PollError poll={poll} /></Panel>
      ) : ph === "loading" || poll.data == null ? (
        <Panel title="Data feeds" icon={<RadioTower className="h-3.5 w-3.5 text-cyan-300" />} hint={CARD_HINT}><Skeleton rows={3} /></Panel>
      ) : (
        <FeedsView d={poll.data} ui={ui} onSubmit={submit} onDisconnect={(f) => setAsking(f)} poll={poll} />
      )}
      {asking ? <DisconnectDialog feed={asking} onDone={done} /> : null}
    </div>
  );
}
