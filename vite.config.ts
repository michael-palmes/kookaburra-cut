/// <reference types="vitest/config" />
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri sets this when running on a physical device / over the LAN.
const host = process.env.TAURI_DEV_HOST;

// Absolute path to the file-based project tree, baked in for the DEV runtime so the native
// side can resolve reel assets (e.g. VideoClip sources) by absolute path. See
// engine/reel.ts `resolveAssetPath`. Bundled-app resolution is a later phase.
const projectsDir = fileURLToPath(new URL("./projects", import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  define: {
    __PROJECTS_DIR__: JSON.stringify(projectsDir),
  },

  // Tauri serves the built bundle over a custom protocol (tauri://localhost),
  // so assets MUST be referenced with relative paths or they 404 in the .app.
  base: "./",

  // Don't let Vite wipe Rust compiler errors from the terminal during `tauri dev`.
  clearScreen: false,

  resolve: {
    alias: {
      "@kookaburra/toolkit": fileURLToPath(new URL("./src/toolkit/index.ts", import.meta.url)),
    },
    // Workspace scenes (v6: user projects under ~/Kookaburra Cut, served via /@fs/) sit
    // outside the repo, so their bare imports must be forced onto the app's single copies —
    // a second react or three instance breaks hooks/scene-graph identity silently.
    dedupe: [
      "react",
      "react-dom",
      "three",
      "@react-three/fiber",
      "@react-three/drei",
      "@react-three/postprocessing",
      "troika-three-text",
      "animejs",
      "zustand",
    ],
  },

  server: {
    host: host || false,
    port: 1420,
    strictPort: true,
    // Long exports starve the HMR websocket and vite's reconnect reloads the page mid-run, so no HMR under autorun.
    hmr: process.env.KOOKABURRA_ACTION
      ? false
      : host
        ? { protocol: "ws", host, port: 1421 }
        : undefined,
    fs: {
      // Dev-only: lets the dev server serve workspace projects (user-chosen at runtime,
      // so scoped to the home dir) through /@fs/ imports, alongside the repo itself.
      allow: [fileURLToPath(new URL(".", import.meta.url)), homedir()],
    },
    watch: {
      // Rust source changes shouldn't trigger a frontend reload.
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // WKWebView floor on macOS 26 is Safari 26. (Vite 8 passes this to the Oxc transformer.)
    target: "safari26",
    minify: process.env.TAURI_DEBUG ? false : "oxc",
    sourcemap: !!process.env.TAURI_DEBUG,
    // Three entry points: the main studio window, the M5 video-editor window and the
    // M5.6 settings window (each its own Tauri WebviewWindow + html entry).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        editor: fileURLToPath(new URL("./editor.html", import.meta.url)),
        present: fileURLToPath(new URL("./present.html", import.meta.url)),
        settings: fileURLToPath(new URL("./settings.html", import.meta.url)),
      },
    },
  },

  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
