import PriceChart from "../components/PriceChart";
import Roster from "../components/Roster";
import WorkerStatus from "../components/WorkerStatus";
import ThreadsPanel from "../components/ThreadsPanel";
import PriorityQueue from "../components/PriorityQueue";
import AssistantPanel from "../components/AssistantPanel";
import { MarketProvider } from "../lib/market";

/**
 * Owner decision 2026-11-06:
 * - Left: the Priority Queue (health alerts), the War Room agents and the Worker status.
 * - Center: the chart, and under it the living War Rooms of every timeframe in one tabbed card
 *   (News | 15m | 1H | 4H | D1, opening on News). The separate 15m conclusion and 15m room cards are
 *   gone: they repeated the 15m tab.
 * - Right: the trading assistant as charts (sentiment, trend by timeframe, H1 decision,
 *   agent consensus, macro drivers, session clock), sticky and scrolling inside itself.
 * On narrower screens the side panels move under the center instead of hiding.
 */
export default function WarRoom() {
  return (
    <MarketProvider>
      <div className="mx-auto flex max-w-[1680px] gap-5 px-3 py-3 sm:px-6 sm:py-5">
        <aside className="hidden w-[260px] shrink-0 flex-col gap-4 xl:flex">
          <PriorityQueue />
          <Roster />
          <WorkerStatus />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="xl:hidden"><PriorityQueue /></div>
          <PriceChart />
          <ThreadsPanel className="h-[78vh] min-h-[480px]" />
          <AssistantPanel className="lg:hidden" />
          <div className="grid gap-4 md:grid-cols-2 xl:hidden"><Roster /><WorkerStatus /></div>
        </main>
        <aside className="hidden w-[360px] shrink-0 lg:block">
          <AssistantPanel className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pr-1" />
        </aside>
      </div>
    </MarketProvider>
  );
}
