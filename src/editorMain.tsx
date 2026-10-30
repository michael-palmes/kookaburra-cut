// Second Tauri window (label "editor"): the non-destructive video editor, with its own entry point + React root so it's a real detached window, not an in-app view; bootTrap first for the same readable-crash surface as the main window.
import "./engine/bootTrap";
import "./engine/glContexts";
import React from "react";
import ReactDOM from "react-dom/client";
import { EditorApp } from "./editor/EditorApp";
import { installDevPerformanceDrain } from "./engine/devPerformance";
import { revealFailsafe } from "./engine/reveal";
import { installWindowNativePort } from "./engine/windowNativePort";
import "./styles.css";

installWindowNativePort();
installDevPerformanceDrain();
revealFailsafe();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <EditorApp />
  </React.StrictMode>,
);
