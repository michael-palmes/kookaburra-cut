// The version files, the four security documents and the changelog move together at a release.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const VERSION = JSON.parse(read("src-tauri/tauri.conf.json")).version;

const VERSION_FILES = [
  ["package.json", (text) => JSON.parse(text).version],
  ["src-tauri/Cargo.toml", (text) => text.match(/^version = "([^"]+)"/m)?.[1]],
];

const VERSION_LINES = [
  ["SECURITY.md", /^\*\*As of version (\d+\.\d+\.\d+)\.\*\*/m],
  ["docs/privacy.md", /^This page describes version (\d+\.\d+\.\d+)\./m],
  ["docs/security-overview.md", /^Describes version (\d+\.\d+\.\d+)\./m],
  ["docs/fleet.md", /^Describes version (\d+\.\d+\.\d+)\./m],
];

test("package.json and Cargo.toml carry the version tauri.conf.json names", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  for (const [file, pick] of VERSION_FILES) {
    assert.equal(pick(read(file)), VERSION, `${file} is not at ${VERSION}`);
  }
});

test("every security document describes the version tauri.conf.json names", () => {
  for (const [file, line] of VERSION_LINES) {
    const found = read(file).match(line);
    assert.ok(found, `${file} has no version line`);
    assert.equal(found[1], VERSION, `${file} describes ${found[1]}; tauri.conf.json is ${VERSION}`);
  }
});

test("the changelog has a section for that version", () => {
  const heading = new RegExp(`^## \\[${VERSION.replaceAll(".", "\\.")}\\]`, "m");
  assert.match(read("CHANGELOG.md"), heading, `CHANGELOG.md has no ## [${VERSION}] section`);
});
