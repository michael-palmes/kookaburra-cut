#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_PRODUCT_NAME = "Kookaburra Cut";
export const PRODUCTION_BUNDLE_IDENTIFIER = "com.mpalmes.kookaburracut";
export const PRODUCTION_APP_PATH = "/Applications/Kookaburra Cut.app";

function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function createAcceptanceIdentity(worktree) {
  if (!isAbsolute(worktree)) throw new Error("acceptance-app: worktree path must be absolute");
  const token = createHash("sha256").update(worktree).digest("hex").slice(0, 8);
  return {
    token,
    productName: `Kookaburra Cut Acceptance ${token}`,
    bundleIdentifier: `com.mpalmes.kookaburracut.acceptance.${token}`,
  };
}

export function assertSafeTarget({ productName, bundleIdentifier, bundlePath }) {
  if (productName === PRODUCTION_PRODUCT_NAME) {
    throw new Error("acceptance-app: refusing the production product name");
  }
  if (bundleIdentifier === PRODUCTION_BUNDLE_IDENTIFIER) {
    throw new Error("acceptance-app: refusing the production bundle identifier");
  }
  if (
    basename(bundlePath) === `${PRODUCTION_PRODUCT_NAME}.app` ||
    canonicalPath(bundlePath) === canonicalPath(PRODUCTION_APP_PATH)
  ) {
    throw new Error("acceptance-app: refusing the production application path");
  }
}

export function assertCheckoutMatches(expected, actual) {
  for (const key of ["worktree", "branch", "head"]) {
    if (expected[key] !== actual[key]) {
      throw new Error(`acceptance-app: checkout ${key} changed during the build`);
    }
  }
}

function git(worktree, ...args) {
  return execFileSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function captureCheckout(worktree) {
  const root = realpathSync.native(git(worktree, "rev-parse", "--show-toplevel"));
  let branch;
  try {
    branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
  } catch {
    throw new Error("acceptance-app: detached HEAD is not safe for branch verification");
  }
  if (git(root, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error("acceptance-app: commit or remove worktree changes before verification");
  }
  return { worktree: root, branch, head: git(root, "rev-parse", "HEAD") };
}

function runningProcesses() {
  return execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /\/kookaburra-cut(?:\s|$)|Kookaburra Cut\.app\/Contents\/MacOS\//i.test(line),
    );
}

function plistValue(plist, key) {
  return execFileSync("plutil", ["-extract", key, "raw", plist], {
    encoding: "utf8",
  }).trim();
}

function run() {
  const before = captureCheckout(process.cwd());
  const identity = createAcceptanceIdentity(before.worktree);
  const commonDir = canonicalPath(
    resolve(before.worktree, git(before.worktree, "rev-parse", "--git-common-dir")),
  );
  const primaryRoot = dirname(commonDir);
  const targetDir = join(primaryRoot, "src-tauri", "target");
  const bundlePath = join(targetDir, "debug", "bundle", "macos", `${identity.productName}.app`);
  const executablePath = join(bundlePath, "Contents", "MacOS", "kookaburra-cut");
  const resultRoot = join(targetDir, "native-acceptance", identity.token);
  const workspaceRoot = join(resultRoot, "workspace");
  const resultPath = join(resultRoot, "last-result.json");
  const processesBefore = runningProcesses();

  assertSafeTarget({ ...identity, bundlePath });
  if (processesBefore.some((line) => line.includes(bundlePath) || line.includes(executablePath))) {
    throw new Error("acceptance-app: this acceptance bundle is already running");
  }

  const tauriRoot = join(before.worktree, "src-tauri");
  const primaryBin = join(primaryRoot, "src-tauri", "bin");
  const override = {
    productName: identity.productName,
    identifier: identity.bundleIdentifier,
    bundle: {
      fileAssociations: [],
      externalBin: ["ffmpeg", "ffprobe"].map((name) =>
        relative(tauriRoot, join(primaryBin, name)).split(sep).join("/"),
      ),
    },
  };

  execFileSync(
    "pnpm",
    [
      "exec",
      "tauri",
      "build",
      "--debug",
      "--bundles",
      "app",
      "--no-sign",
      "--config",
      JSON.stringify(override),
    ],
    {
      cwd: before.worktree,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: "inherit",
    },
  );

  const after = captureCheckout(before.worktree);
  assertCheckoutMatches(before, after);
  const plist = join(bundlePath, "Contents", "Info.plist");
  if (plistValue(plist, "CFBundleName") !== identity.productName) {
    throw new Error("acceptance-app: built product name does not match");
  }
  if (plistValue(plist, "CFBundleIdentifier") !== identity.bundleIdentifier) {
    throw new Error("acceptance-app: built bundle identifier does not match");
  }
  if (!existsSync(executablePath)) throw new Error("acceptance-app: built executable is missing");

  mkdirSync(workspaceRoot, { recursive: true });
  const result = {
    ...after,
    productName: identity.productName,
    bundleIdentifier: identity.bundleIdentifier,
    bundlePath: canonicalPath(bundlePath),
    executablePath: canonicalPath(executablePath),
    workspaceRoot,
    processesBefore,
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  const child = spawn(result.executablePath, [], {
    cwd: before.worktree,
    detached: true,
    env: { ...process.env, KOOKABURRA_WORKSPACE_ROOT: workspaceRoot },
    stdio: "ignore",
  });
  child.unref();
  process.stdout.write(`Computer Use app: ${result.bundlePath}\nResult: ${resultPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
