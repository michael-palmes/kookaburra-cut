import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  frontTicket,
  queuePosition,
  readTicket,
  reapDeadTickets,
  sortedTickets,
  ticketName,
  writeTicket,
} from "./run-queue.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "run-queue.mjs");
const dirs = [];

function queueDir() {
  const dir = mkdtempSync(join(tmpdir(), "run-queue-"));
  dirs.push(dir);
  return dir;
}

function ticket(dir, epoch, pid, fields = {}) {
  const path = join(dir, ticketName(epoch, pid));
  writeTicket(path, { pid, action: "verify", project: "p", worktree: "w", ...fields });
  return path;
}

function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ticket names", () => {
  test("pad the epoch and the pid so the sorted listing is the arrival order", () => {
    assert.equal(ticketName(1757000000, 123), "001757000000-0000123.json");
    const sameSecond = [ticketName(1757000000, 45678), ticketName(1757000000, 9999)].sort();
    assert.deepEqual(sameSecond, [ticketName(1757000000, 9999), ticketName(1757000000, 45678)]);
    assert.ok(ticketName(1757000001, 1) > ticketName(1757000000, 9999999));
  });
});

describe("queue order", () => {
  test("the front is the oldest ticket and positions count from one", () => {
    const dir = queueDir();
    const second = ticket(dir, 1757000010, 200);
    const first = ticket(dir, 1757000000, 100);
    const third = ticket(dir, 1757000010, 300);
    assert.deepEqual(
      sortedTickets(dir).map((path) => basename(path)),
      [first, second, third].map((path) => basename(path)),
    );
    assert.equal(frontTicket(dir), first);
    assert.equal(queuePosition(dir, third), 3);
    assert.equal(queuePosition(dir, join(dir, "missing.json")), 0);
  });

  test("an empty or missing queue has no front", () => {
    assert.equal(frontTicket(queueDir()), null);
    assert.equal(frontTicket(join(tmpdir(), "run-queue-never-made")), null);
  });
});

describe("reaping", () => {
  test("drops tickets whose run died and keeps the live ones", () => {
    const dir = queueDir();
    const dead = ticket(dir, 1757000000, 111);
    const live = ticket(dir, 1757000001, 222);
    const unreadable = join(dir, ticketName(1757000002, 333));
    writeTicket(unreadable, { action: "no pid" });
    const dropped = reapDeadTickets(dir, (pid) => pid === 222);
    assert.deepEqual(
      dropped.map((path) => basename(path)).sort(),
      [dead, unreadable].map((path) => basename(path)).sort(),
    );
    assert.ok(!existsSync(dead));
    assert.ok(existsSync(live));
    assert.equal(frontTicket(dir), live);
  });
});

describe("the CLI the shell calls", () => {
  test("names, writes, reads back and reaps through the same functions", () => {
    const dir = queueDir();
    const name = cli("name", String(process.pid));
    assert.match(name, /^\d{12}-\d{7}\.json$/);
    const path = join(dir, name);
    cli("write", path, String(process.pid), "verify", "showcase-tour", "/tmp/w");
    assert.deepEqual(readTicket(path).pid, process.pid);
    assert.equal(cli("field", path, "project"), "showcase-tour");
    assert.equal(cli("field", path, "nope"), "");
    assert.equal(cli("front", dir), path);
    assert.equal(cli("position", dir, path), "1");
    const dead = ticket(dir, 1, 999999999);
    assert.equal(cli("reap", dir), dead);
    assert.equal(cli("front", dir), path);
  });

  test("an unknown command exits 2", () => {
    assert.throws(
      () => cli("frobnicate"),
      (error) => error.status === 2,
    );
  });
});
