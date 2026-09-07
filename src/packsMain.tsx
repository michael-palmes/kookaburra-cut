// Fourth Tauri window (label "packs"): export and import .kbpack files; bootTrap first for the same readable-crash surface as the others.
import "./engine/stage/bootTrap";
import React from "react";
import ReactDOM from "react-dom/client";
import { revealFailsafe } from "./engine/stage/reveal";
import { PacksApp } from "./packs/PacksApp";
import "./styles.css";

revealFailsafe();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <PacksApp />
  </React.StrictMode>,
);
