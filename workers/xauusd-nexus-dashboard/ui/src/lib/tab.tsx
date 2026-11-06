import { createContext, useContext, useState, type ReactNode } from "react";

/** Owner decision 2026-11-06: News first, then the rooms from the fastest timeframe up. */
export const TABS = [["NEWS", "News"], ["M15", "15m"], ["H1", "1H"], ["H4", "4H"], ["D1", "D1"]] as const;
export type Tab = (typeof TABS)[number][0];

/** HUD snapshot timeframe of a tab (News reads the 1-hour chart). */
export const TAB_HUD_TF: Record<Tab, string> = { NEWS: "60", M15: "15", H1: "60", H4: "240", D1: "1D" };
export const tabLabel = (t: Tab) => TABS.find(([k]) => k === t)?.[1] ?? t;

const TabContext = createContext<{ tab: Tab; setTab: (t: Tab) => void }>({ tab: "NEWS", setTab: () => {} });

/**
 * The active War Room tab, shared by the tab card under the chart, the agents panel on the left
 * and the timeframe charts on the right. Not remembered: every page load opens on News.
 */
export function TabProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<Tab>("NEWS");
  return <TabContext.Provider value={{ tab, setTab }}>{children}</TabContext.Provider>;
}

export const useTab = () => useContext(TabContext);
