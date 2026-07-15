// Third Tauri window (label "settings"): the app Settings panel, opened from the application menu (⌘,); bootTrap first for the same readable-crash surface as the others.
import "./engine/bootTrap";
import React from "react";
import ReactDOM from "react-dom/client";
import { revealFailsafe } from "./engine/reveal";
import { SettingsApp } from "./settings/SettingsApp";
import "./styles.css";

revealFailsafe();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
