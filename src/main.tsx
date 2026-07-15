// FIRST import, deliberately: installs the uncaught-error surface before any module that could crash at boot evaluates (see engine/bootTrap.ts).
import "./engine/bootTrap";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAutoRunConfig } from "./engine/autorun";
import { revealFailsafe } from "./engine/reveal";
import { preloadAppFonts } from "./theme/fonts";
import "./styles.css";

revealFailsafe();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// Prefetch the auto-run env (App reads it synchronously on mount), then preload SDF glyphs before first paint to avoid a preview/export font-loading race; always render on failure, catching so a preload error doesn't abort autorun before render.
initAutoRunConfig()
  .then(() => preloadAppFonts())
  .catch((e) => console.error("[boot] preload failed:", e))
  .finally(() => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
