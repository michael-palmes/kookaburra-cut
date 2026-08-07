// Hidden Tauri window (label "render"): the background renderer. Never shown; it serves capture and thumbnail jobs without touching the editor's canvas or clock. bootTrap first for the same readable-crash surface as the other windows.
import "./engine/bootTrap";
import React from "react";
import ReactDOM from "react-dom/client";
import { RenderApp } from "./render/RenderApp";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RenderApp />
  </React.StrictMode>,
);
