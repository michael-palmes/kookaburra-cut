// Second Tauri window (label "editor"): the non-destructive video editor, with its own entry point + React root so it's a real detached window, not an in-app view; bootTrap first for the same readable-crash surface as the main window.
import "./engine/bootTrap";
import React from "react";
import ReactDOM from "react-dom/client";
import { EditorApp } from "./editor/EditorApp";
import { revealFailsafe } from "./engine/reveal";
import "./styles.css";

revealFailsafe();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <EditorApp />
  </React.StrictMode>,
);
