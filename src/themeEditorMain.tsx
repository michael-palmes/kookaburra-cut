// Seventh Tauri window (label "theme-editor"): edit one theme document, with its own entry point + React root so it's a real detached window; bootTrap first for the same readable-crash surface as the others.
import "./engine/bootTrap";
import React from "react";
import ReactDOM from "react-dom/client";
import { revealFailsafe } from "./engine/reveal";
import { ThemeEditorApp } from "./ui/theme-editor/ThemeEditorApp";
import "./styles.css";

revealFailsafe();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeEditorApp />
  </React.StrictMode>,
);
