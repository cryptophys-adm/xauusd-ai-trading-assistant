import PriceChart from "../components/PriceChart";
import WarRoomConclusion from "../components/WarRoomConclusion";
import LiveWarRoom from "../components/LiveWarRoom";
import Roster from "../components/Roster";
import WorkerStatus from "../components/WorkerStatus";
import ThreadsPanel from "../components/ThreadsPanel";

/**
 * Left: the War Room agents and the Worker status. Center: chart, War Room conclusion and the
 * Live War Room 15m. Right: the Threads card (D1 | 4H | 1H | 15m | News), sticky and scrolling
 * inside itself. On narrower screens the side panels move under the center instead of hiding.
 */
export default function WarRoom() {
  return (
    <div className="mx-auto flex max-w-[1680px] gap-5 px-3 py-3 sm:px-6 sm:py-5">
      <aside className="hidden w-[260px] shrink-0 flex-col gap-4 xl:flex">
        <Roster />
        <WorkerStatus />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col gap-4">
        <PriceChart />
        <WarRoomConclusion />
        <ThreadsPanel className="max-h-[80vh] lg:hidden" />
        <LiveWarRoom />
        <div className="grid gap-4 md:grid-cols-2 xl:hidden"><Roster /><WorkerStatus /></div>
      </main>
      <aside className="hidden w-[400px] shrink-0 lg:block">
        <ThreadsPanel className="sticky top-4 h-[calc(100vh-7rem)]" />
      </aside>
    </div>
  );
}
