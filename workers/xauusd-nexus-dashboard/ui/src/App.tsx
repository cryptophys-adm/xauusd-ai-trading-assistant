import { useEffect, useState } from "react";
import AppShell from "./components/AppShell";
import WarRoom from "./pages/WarRoom";
import Shadow from "./pages/Shadow";
import Scorecards from "./pages/Scorecards";
import Performance from "./pages/Performance";
import Correlations from "./pages/Correlations";
import Calendar from "./pages/Calendar";
import Alerts from "./pages/Alerts";
import Audit from "./pages/Audit";

const parse = (hash: string) => hash.replace(/^#\/?/, "").split("/").filter(Boolean)[0] ?? "";

export default function App() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parse(window.location.hash)); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const PAGES: Record<string, () => JSX.Element> = { shadow: Shadow, scorecards: Scorecards, performance: Performance, correlations: Correlations, calendar: Calendar, alerts: Alerts, audit: Audit };
  const current = route in PAGES ? route : "";
  const Page = PAGES[current] ?? WarRoom;
  return <AppShell current={current}><Page /></AppShell>;
}
