import { useEffect, useState } from "react";
import AppShell from "./components/AppShell";
import WarRoom from "./pages/WarRoom";
import Shadow from "./pages/Shadow";
import Scorecards from "./pages/Scorecards";

const parse = (hash: string) => hash.replace(/^#\/?/, "").split("/").filter(Boolean)[0] ?? "";

export default function App() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parse(window.location.hash)); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const current = route === "shadow" || route === "scorecards" ? route : "";
  return <AppShell current={current}>{current === "shadow" ? <Shadow /> : current === "scorecards" ? <Scorecards /> : <WarRoom />}</AppShell>;
}
