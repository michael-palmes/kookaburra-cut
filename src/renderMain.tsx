// Hidden Tauri window (label "render"): the background renderer. Never shown; it serves capture and thumbnail jobs without touching the editor's canvas or clock. bootTrap first for the same readable-crash surface as the other windows.
import "./engine/bootTrap";
import "./engine/glContexts";
import React from "react";
import ReactDOM from "react-dom/client";
import { installDevPerformanceDrain } from "./engine/devPerformance";
import { setPreferUnthrottledYields } from "./engine/macrotask";
import { installWindowNativePort } from "./engine/windowNativePort";
import { RenderApp } from "./render/RenderApp";

installWindowNativePort();
installDevPerformanceDrain();
// Hidden pages clamp nested timers to 1s alignment (R1 spike); barrier polls in this realm yield via MessageChannel instead.
setPreferUnthrottledYields();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RenderApp />
  </React.StrictMode>,
);
