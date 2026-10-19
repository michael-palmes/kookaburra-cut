import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "kookaburra-run.sh");

function run(args, env = process.env) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });
}

describe("kookaburra-run --cold", () => {
  for (const action of ["perf", "theme-previews", "option-previews", "render-spike"]) {
    test(`refuses ${action}, which needs preview frames`, () => {
      const result = run(["--action", action, "--cold"]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--cold only applies to verify, export, screenshot/);
    });
  }
});

describe("kookaburra-run packaged app check", () => {
  const PACKAGED = "/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut";
  const WAIT_LOOP = `/bin/zsh -c until ! pgrep -f "${PACKAGED}"; do sleep 5; done`;
  const bins = [];
  after(() => {
    for (const bin of bins) rmSync(bin, { recursive: true, force: true });
  });

  // Fake process tools: `ps` lists executables for `comm=` and full command lines otherwise; `pgrep` always matches.
  function envWithProcesses(executables) {
    const bin = mkdtempSync(join(tmpdir(), "kb-run-ps-"));
    bins.push(bin);
    const quoted = (lines) => lines.map((line) => `'${line}'`).join(" ");
    writeFileSync(
      join(bin, "ps"),
      `#!/bin/sh\ncase "$*" in\n  *comm=*) printf '%s\\n' ${quoted(executables)} ;;\n  *) printf '%s\\n' ${quoted([...executables, WAIT_LOOP])} ;;\nesac\n`,
    );
    writeFileSync(join(bin, "pgrep"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "ps"), 0o755);
    chmodSync(join(bin, "pgrep"), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  }

  test("refuses while a packaged app runs", () => {
    const result = run(["--action", "verify"], envWithProcesses(["/bin/zsh", PACKAGED]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /a packaged Kookaburra Cut is already running/);
  });

  test("ignores the bundle's ffmpeg running on its own", () => {
    const result = run(
      ["--action", "verify", "--app", "/nonexistent/Fake.app"],
      envWithProcesses(["/Applications/Kookaburra Cut.app/Contents/MacOS/ffmpeg"]),
    );
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr, /already running/);
  });

  test("ignores a shell that only names the packaged path", () => {
    const result = run(
      ["--action", "verify", "--app", "/nonexistent/Fake.app"],
      envWithProcesses(["/bin/zsh"]),
    );
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr, /already running/);
    assert.match(result.stderr, /no executable found inside/);
  });
});

describe("kookaburra-run busy warning", () => {
  const bins = [];
  after(() => {
    for (const bin of bins) rmSync(bin, { recursive: true, force: true });
  });

  // Fake sysctl and xcrun report the given swap use and booted simulators.
  function envWithLoad(swapMb, booted) {
    const bin = mkdtempSync(join(tmpdir(), "kb-run-busy-"));
    bins.push(bin);
    writeFileSync(
      join(bin, "sysctl"),
      `#!/bin/sh\necho "total = 20480.00M  used = ${swapMb}.00M  free = 1.00M  (encrypted)"\n`,
    );
    const lines = Array.from(
      { length: booted },
      (_, i) => `    Sim ${i} (0000-${i}) (Booted)`,
    ).join("\\n");
    writeFileSync(join(bin, "xcrun"), `#!/bin/sh\nprintf '== Devices ==\\n${lines}\\n'\n`);
    chmodSync(join(bin, "sysctl"), 0o755);
    chmodSync(join(bin, "xcrun"), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  }

  test("names heavy swap and booted simulators", () => {
    const result = run(
      ["--action", "verify", "--app", "/nonexistent/Fake.app"],
      envWithLoad(14336, 3),
    );
    assert.match(
      result.stderr,
      /busy machine \(14 GB of swap in use, 3 iOS simulator\(s\) booted\)/,
    );
  });

  test("stays quiet on an idle machine", () => {
    const result = run(
      ["--action", "verify", "--app", "/nonexistent/Fake.app"],
      envWithLoad(512, 0),
    );
    assert.doesNotMatch(result.stderr, /busy machine/);
  });

  // Linux CI has neither: a failed sysctl once ended the run under set -e before any other check.
  test("never blocks when sysctl and xcrun fail", () => {
    const bin = mkdtempSync(join(tmpdir(), "kb-run-busy-"));
    bins.push(bin);
    for (const tool of ["sysctl", "xcrun"]) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
      chmodSync(join(bin, tool), 0o755);
    }
    const result = run(["--action", "verify", "--app", "/nonexistent/Fake.app"], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no executable found inside/);
  });
});
