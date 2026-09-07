/** Anti-flash reveal: each entry html holds `#root` at opacity 0 over the window-background colour (the native side strips WKWebView's white layer); the root component calls `revealApp()` on mount to fade the UI in, and each entry file schedules `revealFailsafe()` so a wedged boot can never leave the window permanently blank. bootTrap's crash screen forces opacity inline. */

export function revealApp() {
  document.getElementById("root")?.classList.add("ready");
}

export function revealFailsafe(ms = 3000) {
  window.setTimeout(revealApp, ms);
}
