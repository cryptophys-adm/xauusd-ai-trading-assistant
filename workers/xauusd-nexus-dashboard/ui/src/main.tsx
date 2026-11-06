import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import NeuralMeshBackground from "./components/NeuralMeshBackground";
import { WarRoomProvider } from "./lib/warroom";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NeuralMeshBackground />
    <WarRoomProvider><App /></WarRoomProvider>
  </StrictMode>
);
