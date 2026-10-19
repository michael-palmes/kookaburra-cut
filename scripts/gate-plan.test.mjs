import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { classify, plan, readBaselines, readStillsBaselines } from "./gate-plan.mjs";
import { renderClosure } from "./render-closure.mjs";

const legsOf = (p) => p.legs.map((l) => `${l.project}@${l.aspect}`);

describe("gate plan", () => {
  const closure = new Set([
    "src/engine/exporter.ts",
    "src/toolkit/device/Device.tsx",
    "src/engine/compositor.ts",
  ]);

  test("a change off the export path needs no verify", () => {
    const p = plan(
      [
        "src/ui/Inspector.tsx",
        "docs/design.md",
        ".agents/skills/x/SKILL.md",
        "src-tauri/src/kit.rs",
      ],
      closure,
    );
    assert.deepEqual(p.legs, []);
    assert.deepEqual(p.actions, []);
  });

  test("one render path runs gate:merge, anchors first", () => {
    const titles = new Set(["src/engine/sceneTitle.ts"]);
    assert.deepEqual(legsOf(plan(["src/engine/sceneTitle.ts"], titles)), [
      "showcase-tour@16:9",
      "ws:launch-2026@16:9",
    ]);
  });

  test("a feature area adds its fixture, never as a routine leg", () => {
    assert.deepEqual(legsOf(plan(["src/toolkit/device/Device.tsx"], closure)), [
      "showcase-tour@16:9",
      "ws:launch-2026@16:9",
      "ws:device-video-spike@16:9",
    ]);
  });

  test("the shared seam adds the other class project and a 9:16 spot check, all ×2", () => {
    const p = plan(["src/engine/exporter.ts"], closure);
    assert.deepEqual(legsOf(p), [
      "showcase-tour@16:9",
      "ws:launch-2026@16:9",
      "ws:device-video-spike@16:9",
      "showcase-tour@9:16",
    ]);
    assert.equal(p.twice, true);
    assert.equal(plan(["src/toolkit/device/Device.tsx"], closure).twice, false);
  });

  test("pack and stills paths add their round trips", () => {
    assert.deepEqual(
      plan(["src-tauri/src/pack/apply.rs", "src-tauri/src/stills/pdf.rs"], closure).actions.map(
        (a) => a.action,
      ),
      ["packroundtrip", "stillsverify"],
    );
  });

  test("a bundled fixture's own files gate only that fixture", () => {
    assert.deepEqual(legsOf(plan(["fixtures/transition-spike/scenes/01.tsx"], closure)), [
      "transition-spike@16:9",
    ]);
  });

  test("package.json gates only when dependencies moved", () => {
    assert.equal(classify("package.json", closure, { depsChanged: false }).kind, "none");
    assert.equal(classify("package.json", closure, { depsChanged: true }).kind, "render");
  });

  test("unlisted paths and the app shell are gated", () => {
    for (const path of [
      "src/App.tsx",
      "vite.config.ts",
      "patches/x.patch",
      "src-tauri/src/encode.rs",
      "scripts/kookaburra-run.sh",
    ]) {
      assert.equal(classify(path, closure).kind, "render", path);
    }
  });

  test("statics follow the diff", () => {
    assert.deepEqual(plan(["src-tauri/src/kit.rs"], closure).statics, {
      lint: true,
      build: false,
      vitest: null,
      scripts: false,
      kit: false,
      rust: true,
    });
    assert.equal(plan(["pnpm-lock.yaml"], closure).statics.vitest, "all");
  });

  test("a kit-only change runs cargo test too, as CI does", () => {
    const s = plan(["src-tauri/templates/project-kb.sh"], closure).statics;
    assert.equal(s.rust, true);
    assert.equal(s.kit, true);
  });

  test("a data-only change leaves cargo and the kb suite to CI", () => {
    const s = plan(["src/theme/builtin/night.json", "presets/a/preset.json"], closure).statics;
    assert.equal(s.rust, false);
    assert.equal(s.kit, false);
  });
});

describe("recorded baselines", () => {
  test("reads both anchors from docs/determinism.md", () => {
    const b = readBaselines();
    assert.match(b["showcase-tour"]["16:9"], /^[0-9a-f]{8}/);
    assert.match(b["ws:launch-2026"]["16:9"], /^[0-9a-f]{8}/);
  });

  test("reads stills pagesHash per format, apart from the video table", () => {
    const s = readStillsBaselines();
    assert.match(s["showcase-tour"].pdf, /^[0-9a-f]{64}$/);
    assert.match(s["showcase-tour"].png, /^[0-9a-f]{64}$/);
    assert.equal(readBaselines()["showcase-tour"].PDF, undefined);
  });
});

describe("the render closure", () => {
  let real;
  before(async () => {
    real = await renderClosure();
  });

  test("holds the export loop and the toolkit, not the inspector", () => {
    for (const path of [
      "src/engine/exporter.ts",
      "src/engine/compositor.ts",
      "src/toolkit/index.ts",
      "src/toolkit/device/Device.tsx",
    ]) {
      assert.ok(real.has(path), path);
    }
    assert.ok(!real.has("src/ui/inspector/DeviceDrillIn.tsx"));
  });

  // Other projects', presets' and dev labs' content never renders inside a gate project, so only they may be skipped.
  test("no path the export path loads is classed as no-verify", () => {
    const skipped = [...real].filter(
      (p) => !/^(projects|presets|fixtures)\//.test(p) && classify(p, real).kind === "none",
    );
    assert.deepEqual(skipped, []);
  });
});
