// Third Tauri window (label "present"): live video/slideshow playback of a project, chromeless and never part of the export path; bootTrap first for the same readable-crash surface as the main window.
import "./engine/bootTrap";
import "./engine/glContexts";
import React from "react";
import ReactDOM from "react-dom/client";
import { installDevPerformanceDrain } from "./engine/devPerformance";
import { revealFailsafe } from "./engine/reveal";
import { installWindowNativePort } from "./engine/windowNativePort";
import { PresentApp } from "./present/PresentApp";
import "./styles.css";

installWindowNativePort();
installDevPerformanceDrain();
revealFailsafe();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <PresentApp />
  </React.StrictMode>,
);
