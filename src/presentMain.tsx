// Third Tauri window (label "present"): live video/slideshow playback of a project, chromeless and never part of the export path; bootTrap first for the same readable-crash surface as the main window.
import "./engine/bootTrap";
import React from "react";
import ReactDOM from "react-dom/client";
import { revealFailsafe } from "./engine/reveal";
import { PresentApp } from "./present/PresentApp";
import "./styles.css";

revealFailsafe();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <PresentApp />
  </React.StrictMode>,
);
