import { MessagesSquare } from "lucide-react";
import { Badge, Dot, Panel, Skeleton } from "./ui";
import { Post, calibrationText } from "./Post";
import { useWarRoom } from "../lib/warroom";
import { utc } from "../lib/format";

/** The latest Live War Room 15m: the communication bus, then the debate (no history). */
export default function LiveWarRoom() {
  const { room, loading, error } = useWarRoom();
  const cal: Record<string, unknown> = {};
  for (const a of room?.roster ?? []) cal[a.id] = a.calibration;
  const phase = !room ? null : room.phase === "closed" ? "Debate closed · conclusion above" : room.phase === "debate" ? `Debate open (at most ${Math.round((room.debate_window_seconds || 180) / 60)} minutes)` : "Openings on the communication bus";
  return (
    <Panel title="Live War Room 15m" icon={<MessagesSquare className="h-3.5 w-3.5 text-violet-300" />}
      right={<div className="flex items-center gap-2">{room && <Badge tone="cyan">{utc(room.bar_time)}</Badge>}<Dot tone={error ? "red" : "green"} pulse={!error} /></div>}>
      {loading && !room ? <Skeleton rows={4} /> : !room ? <p className="text-[12px] text-slate-500">Waiting for the next 15m candle close…</p> : (
        <>
          <p className="mb-3 text-[11px] text-slate-500">{phase} · every agent opens on the bus, then debates for at most 3 minutes · discussion only, no orders</p>
          <div className="eyebrow mb-2 text-[10px]">Communication bus · {room.openings?.length ?? 0} agents</div>
          <div className="space-y-1.5">{(room.openings ?? []).map((m: any) => <Post key={m.id} m={m} text={m.claim} calibration={calibrationText(cal[m.id])} />)}</div>
          {!!room.debate?.length && (
            <>
              <div className="eyebrow mb-2 mt-4 text-[10px]">Debate</div>
              <div className="space-y-1.5">{room.debate.map((m: any) => <Post key={m.id} m={m} text={m.argument} />)}</div>
            </>
          )}
        </>
      )}
    </Panel>
  );
}
