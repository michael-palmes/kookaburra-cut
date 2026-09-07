#!/usr/bin/env node
// The autorun queue behind `kookaburra-run.sh`: one FIFO of ticket files shared by every worktree,
// so parallel agents serialise their app boots instead of colliding. The shell keeps the wait loop;
// the naming, ordering, reaping and ticket JSON live here where they can be tested.
//
//   name <pid>                          the ticket file name for a run started now
//   write <ticket> <pid> <action> <project> <worktree>
//   field <ticket> <name>               one field out of a ticket
//   front <dir>                         the oldest live ticket's path (empty when the queue is empty)
//   position <dir> <ticket>             1-based position of a ticket in the queue
//   reap <dir>                          drop tickets whose run died without releasing them
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `<epoch>-<pid>.json`, both zero-padded so the sorted directory listing IS the queue order, same-second tickets included. */
export function ticketName(epochSeconds, pid) {
  return `${String(epochSeconds).padStart(12, "0")}-${String(pid).padStart(7, "0")}.json`;
}

export function sortedTickets(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => join(dir, file));
}

export function frontTicket(dir) {
  return sortedTickets(dir)[0] ?? null;
}

/** 1-based; 0 when the ticket is not in the queue. */
export function queuePosition(dir, ticket) {
  const index = sortedTickets(dir).findIndex((path) => basename(path) === basename(ticket));
  return index + 1;
}

export function readTicket(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeTicket(path, fields) {
  writeFileSync(path, `${JSON.stringify(fields)}\n`);
}

/** Signal 0 probes without killing; EPERM means the process exists under another user. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** A run killed mid-flight cannot clear its own ticket; its pid dying is the release signal. Returns the paths dropped. */
export function reapDeadTickets(dir, isAlive = pidAlive) {
  const dropped = [];
  for (const path of sortedTickets(dir)) {
    const pid = Number(readTicket(path)?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) {
      try {
        unlinkSync(path);
        dropped.push(path);
      } catch {
        // Another worktree reaped it first.
      }
    }
  }
  return dropped;
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "name":
      return ticketName(Math.floor(Date.now() / 1000), Number(args[0]));
    case "write": {
      const [ticket, pid, action, project, worktree] = args;
      writeTicket(ticket, {
        pid: Number(pid),
        action,
        project,
        worktree,
        started: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
      return "";
    }
    case "field": {
      const value = readTicket(args[0])?.[args[1]];
      return value === undefined || value === null ? "" : String(value);
    }
    case "front":
      return frontTicket(args[0]) ?? "";
    case "position":
      return String(queuePosition(args[0], args[1]));
    case "reap":
      return reapDeadTickets(args[0]).join("\n");
    default:
      throw new Error(`run-queue: unknown command ${command ?? "(none)"}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
