#!/usr/bin/env node
// Dev-server port broker for multi-worktree runs: agent-driven `pnpm tauri dev` boots pick a
// free port in 1430-1499 so 1420/1421 stay free for the interactive session.
//
//   pick              print one free port (exit 1 when the whole range is taken)
//   override <port>   print the compact `tauri dev -c '<json>'` config moving devUrl and
//                     the dev CSP onto that port
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PORT_MIN = 1430;
export const PORT_MAX = 1499;

// Free means bindable right now: an lsof scan misses ports held without LISTEN.
function bindable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

export async function pickPort(min = PORT_MIN, max = PORT_MAX) {
  const span = max - min + 1;
  // Random start: two agents picking in the same second should not both land on min.
  const offset = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = min + ((offset + i) % span);
    if (await bindable(port)) return port;
  }
  return null;
}

export function overrideConfig(port, confPath = join(SCRIPT_ROOT, "src-tauri", "tauri.conf.json")) {
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const devCsp = conf?.app?.security?.devCsp;
  if (typeof devCsp !== "string") {
    throw new Error(`dev-port: no app.security.devCsp in ${confPath}`);
  }
  return {
    build: { devUrl: `http://localhost:${port}` },
    app: { security: { devCsp: devCsp.split("1420").join(String(port)) } },
  };
}

async function runCli() {
  const mode = process.argv[2];
  if (mode === "pick") {
    const port = await pickPort();
    if (port === null) {
      console.error(`dev-port: no free port in ${PORT_MIN}-${PORT_MAX}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${port}\n`);
    return;
  }
  if (mode === "override") {
    const port = Number(process.argv[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error("dev-port: override needs a port number");
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify(overrideConfig(port))}\n`);
    return;
  }
  console.error("usage: dev-port.mjs pick | override <port>");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCli();
