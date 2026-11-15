import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const V = "9.9.9";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const SOURCES = {
  "ffmpeg-8.1.tar.xz": "ffmpeg source",
  "x264-abc123.tar": "x264 source",
  "x265_4.3.tar.gz": "x265 source",
};

let work;
let dir;
let record;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "release-sums-"));
  dir = join(work, "release");
  record = join(work, "record");
  mkdirSync(dir);
  mkdirSync(record);
  for (const f of [
    `KookaburraCut-${V}.dmg`,
    `KookaburraCut-${V}.pkg`,
    `KookaburraCut-${V}.zip`,
    `KookaburraCut-${V}-updater.app.tar.gz`,
    `KookaburraCut-${V}-updater.app.tar.gz.sig`,
    "latest.json",
  ]) {
    writeFileSync(join(dir, f), f);
  }
  for (const [f, body] of Object.entries(SOURCES)) writeFileSync(join(dir, f), body);
  writeFileSync(join(record, `KookaburraCut-${V}.cdx.json`), "{}");
  writeFileSync(
    join(record, "build-info.txt"),
    [
      "FFMPEG_VERSION=8.1",
      `FFMPEG_SHA256=${sha(SOURCES["ffmpeg-8.1.tar.xz"])}`,
      "X264_COMMIT=abc123",
      `X264_SOURCE_SHA256=${sha(SOURCES["x264-abc123.tar"])}`,
      "X265_VERSION=4.3",
      `X265_SHA256=${sha(SOURCES["x265_4.3.tar.gz"])}`,
      "",
    ].join("\n"),
  );
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const run = () =>
  spawnSync("bash", ["scripts/release-sums.sh", "--dir", dir, "--record", record, "--version", V], {
    cwd: ROOT,
    encoding: "utf8",
  });

describe("release-sums.sh", () => {
  test("lists the pkg and the sidecar's source archives", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const listed = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    for (const f of [`KookaburraCut-${V}.pkg`, ...Object.keys(SOURCES)]) {
      assert.match(listed, new RegExp(`  ${f.replaceAll(".", "\\.")}\\n`));
    }
  });

  test("refuses a source archive that is not the pinned one", () => {
    writeFileSync(join(dir, "x264-abc123.tar"), "something else");
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /x264-abc123\.tar is not the source the build pinned/);
  });

  test("refuses a set without a source archive", () => {
    rmSync(join(dir, "x265_4.3.tar.gz"));
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing x265_4\.3\.tar\.gz/);
  });
});
