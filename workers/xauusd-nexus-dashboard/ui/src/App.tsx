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
import Status from "./pages/Status";
import Aether from "./pages/Aether";
import Omega from "./pages/Omega";
import Model from "./pages/Model";

const first = (s: string) => s.split("/").filter(Boolean)[0] ?? "";
// A hash route (#/shadow) wins; without a hash, the path names the page (nexus.cryptophys.work/omega/ or /aether).
const parse = (hash: string) => (hash ? first(hash.replace(/^#\/?/, "")) : first(window.location.pathname));

export default function App() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parse(window.location.hash)); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    window.addEventListener("popstate", on);
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener("popstate", on);
    };
  }, []);
  const PAGES: Record<string, () => JSX.Element> = { shadow: Shadow, scorecards: Scorecards, performance: Performance, correlations: Correlations, calendar: Calendar, alerts: Alerts, audit: Audit, status: Status, aether: Aether, omega: Omega, model: Model };
  const current = route in PAGES ? route : "";
  const Page = PAGES[current] ?? WarRoom;
  return <AppShell current={current}><Page /></AppShell>;
}
