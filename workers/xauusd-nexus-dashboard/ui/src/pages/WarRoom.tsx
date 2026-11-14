import PriceChart from "../components/PriceChart";
import Roster from "../components/Roster";
import SystemIssues from "../components/SystemIssues";
import ThreadsPanel from "../components/ThreadsPanel";
import PriorityQueue from "../components/PriorityQueue";
import AssistantPanel from "../components/AssistantPanel";
import GlobalDecision from "../components/GlobalDecision";
import OrganismCard from "../components/OrganismCard";
import FeedFallbackCard from "../components/FeedFallbackCard";
import ShadowSwitchCard from "../components/ShadowSwitchCard";
import { MarketProvider } from "../lib/market";
import { TabProvider } from "../lib/tab";

/**
 * Owner decision 2026-11-06:
 * - Left: the Digital Organism card (top), the MT5 fallback switch (2026-11-11), Priority Queue (health alerts), system issues (only when a
 *   lane is amber or red) and the agents of the room in the active tab.
 * - Center: the chart, and under it the living War Rooms of every timeframe in one tabbed card
 *   (News | 15m | 1H | 4H | D1, opening on News); each tab starts with its conclusion.
 * - Right: the trading assistant as charts: the Global Conclusion (all timeframes and news), then
 *   sentiment, trend by timeframe, the level ladder and regime radar of the active tab's chart,
 *   agent consensus, macro drivers and the session clock; sticky and scrolling inside itself.
 * On narrower screens the side panels move under the center instead of hiding.
 */
export default function WarRoom() {
  return (
    <MarketProvider>
      <TabProvider>
      <div className="mx-auto flex max-w-[1680px] gap-5 px-3 py-3 sm:px-6 sm:py-5">
        <aside className="hidden w-[260px] shrink-0 flex-col gap-4 xl:flex">
          <OrganismCard />
          <FeedFallbackCard />
          <ShadowSwitchCard />
          <PriorityQueue />
          <SystemIssues />
          <Roster />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-4 xl:hidden"><OrganismCard /><FeedFallbackCard /><ShadowSwitchCard /><PriorityQueue /><SystemIssues /></div>
          <PriceChart />
          <div className="lg:hidden">
            <GlobalDecision />
          </div>
          <ThreadsPanel className="h-[78vh] min-h-[480px]" />
          <AssistantPanel className="lg:hidden" hideGlobalDecision />
          <div className="xl:hidden"><Roster /></div>
        </main>
        <aside className="hidden w-[360px] shrink-0 lg:block">
          <AssistantPanel className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pr-1" />
        </aside>
      </div>
      </TabProvider>
    </MarketProvider>
  );
}
