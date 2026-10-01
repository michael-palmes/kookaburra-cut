import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import app from "../../vite.config.ts";

// Dev-only look lab (page at /tools/look-lab/index.html): the repo is the root so the app's globs and aliases resolve unchanged, with its own dep cache so it never disturbs `pnpm tauri dev`.
const repo = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: repo,
  base: "/",
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite-look-lab", import.meta.url)),
  plugins: [react()],
  define: app.define,
  resolve: app.resolve,
  logLevel: "warn",
  clearScreen: false,
  optimizeDeps: {
    entries: ["tools/look-lab/index.html"],
  },
  server: {
    host: "127.0.0.1",
    port: 5190,
    strictPort: false,
    fs: { allow: [repo] },
    watch: { ignored: ["**/src-tauri/**", "**/.claude/worktrees/**"] },
  },
});
