import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assetComponents, buildSbom, render } from "./sbom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CRATE_ROOT = "path+file:///Users/x/checkout/src-tauri#kookaburra-cut@1.2.3";

const pkg = (name, version, dependencies, extra = {}) => ({
  from: name,
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  path: `/Users/x/checkout/node_modules/${name}`,
  ...(dependencies ? { dependencies } : {}),
  ...extra,
});

const fixtures = () => ({
  version: "1.2.3",
  commit: COMMIT,
  epoch: 1700000000,
  pnpmLs: [
    {
      name: "product-tour",
      version: "1.2.3",
      dependencies: {
        "@scope/alpha": pkg("@scope/alpha", "2.0.0", {
          beta: pkg("beta", "1.0.0", { gamma: pkg("gamma", "0.1.0") }),
        }),
        beta: pkg("beta", "1.0.0", undefined, { deduped: true }),
      },
    },
  ],
  pnpmLicenses: {
    MIT: [{ name: "@scope/alpha", versions: ["2.0.0"], license: "MIT" }],
    "MIT OR Apache-2.0": [{ name: "beta", versions: ["1.0.0"], license: "MIT OR Apache-2.0" }],
    "SEE LICENSE IN LICENSE": [
      { name: "gamma", versions: ["0.1.0"], license: "SEE LICENSE IN LICENSE" },
    ],
  },
  cargo: {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: {
      timestamp: "2026-01-01T00:00:00.000000000Z",
      tools: [{ vendor: "CycloneDX", name: "cargo-cyclonedx", version: "0.5.9" }],
      component: {
        type: "application",
        "bom-ref": CRATE_ROOT,
        name: "kookaburra-cut",
        version: "1.2.3",
        licenses: [{ expression: "MIT OR Apache-2.0" }],
        purl: "pkg:cargo/kookaburra-cut@1.2.3?download_url=file://.",
        components: [
          { type: "library", "bom-ref": `${CRATE_ROOT} bin-target-0`, name: "kookaburra_cut_lib" },
        ],
      },
    },
    components: [
      {
        type: "library",
        "bom-ref": "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0",
        name: "serde",
        version: "1.0.0",
        licenses: [{ expression: "MIT OR Apache-2.0" }],
        purl: "pkg:cargo/serde@1.0.0",
      },
      {
        type: "library",
        "bom-ref": "registry+https://github.com/rust-lang/crates.io-index#libc@0.2.0",
        name: "libc",
        version: "0.2.0",
        licenses: [{ expression: "MIT OR Apache-2.0" }],
        purl: "pkg:cargo/libc@0.2.0",
      },
    ],
    dependencies: [
      {
        ref: CRATE_ROOT,
        dependsOn: ["registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0"],
      },
      {
        ref: "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0",
        dependsOn: ["registry+https://github.com/rust-lang/crates.io-index#libc@0.2.0"],
      },
      { ref: `${CRATE_ROOT} bin-target-0`, dependsOn: [] },
    ],
  },
  sidecarPins: [
    "FFMPEG_VERSION=8.1",
    "FFMPEG_SHA256=aa11",
    "FFMPEG_URL=https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz",
    "X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
    "X264_URL=https://code.videolan.org/videolan/x264.git",
    "X264_SEI=x264 - core 165 r3222 b35605a",
    "X264_SOURCE_SHA256=ee55",
    "X265_VERSION=4.3",
    "X265_SHA256=bb22",
    "X265_URL=https://github.com/Multicorewareinc/x265/releases/download/4.3/x265_4.3.tar.gz",
    "",
  ].join("\n"),
  modelPins: [
    "BEAT_THIS_RS_COMMIT=1ae768e78f1ad83b0ed3886241dc29ffde853c40",
    "MODEL=beat_this_small.onnx|cc33|10555592",
    "MODEL=mel_spectrogram.onnx|dd44|270742",
    "",
  ].join("\n"),
  assets: [
    {
      type: "file",
      "bom-ref": "file:src/assets/hdri/studio.hdr",
      name: "src/assets/hdri/studio.hdr",
      scope: "required",
      hashes: [{ alg: "SHA-256", content: "ff66" }],
      licenses: [{ license: { id: "CC0-1.0" } }],
    },
  ],
});

const byRef = (sbom, ref) => sbom.components.find((c) => c["bom-ref"] === ref);

describe("the release SBOM", () => {
  test("derives its serial number and timestamp from the commit and SOURCE_DATE_EPOCH", () => {
    const a = buildSbom(fixtures());
    const b = buildSbom(fixtures());
    assert.equal(a.serialNumber, b.serialNumber);
    assert.match(
      a.serialNumber,
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(a.metadata.timestamp, "2023-11-14T22:13:20Z");
    const other = buildSbom({ ...fixtures(), commit: "fedcba9876543210fedcba9876543210fedcba98" });
    assert.notEqual(other.serialNumber, a.serialNumber);
    assert.equal(a.metadata.component.purl, "pkg:github/michael-palmes/kookaburra-cut@v1.2.3");
    assert.deepEqual(
      a.metadata.properties.find((p) => p.name === "kookaburra-cut:commit"),
      { name: "kookaburra-cut:commit", value: COMMIT },
    );
  });

  test("lists one component per package with a purl and licence, machine paths left out", () => {
    const sbom = buildSbom(fixtures());
    const refs = sbom.components.map((c) => c["bom-ref"]);
    assert.equal(new Set(refs).size, refs.length);
    assert.equal(refs.filter((r) => r.startsWith("pkg:npm/")).length, 3);
    const alpha = byRef(sbom, "pkg:npm/%40scope/alpha@2.0.0");
    assert.deepEqual(alpha.licenses, [{ license: { id: "MIT" } }]);
    assert.deepEqual(byRef(sbom, "pkg:npm/beta@1.0.0").licenses, [
      { expression: "MIT OR Apache-2.0" },
    ]);
    assert.deepEqual(byRef(sbom, "pkg:npm/gamma@0.1.0").licenses, [
      { license: { name: "SEE LICENSE IN LICENSE" } },
    ]);
    assert.ok(byRef(sbom, "pkg:cargo/serde@1.0.0"));
    assert.ok(byRef(sbom, "pkg:cargo/kookaburra-cut@1.2.3"));
    assert.doesNotMatch(render(sbom), /Users\/x|path\+file|bin-target/);
    const deps = Object.fromEntries(sbom.dependencies.map((d) => [d.ref, d.dependsOn]));
    assert.deepEqual(deps["pkg:cargo/kookaburra-cut@1.2.3"], ["pkg:cargo/serde@1.0.0"]);
    assert.deepEqual(deps["pkg:npm/%40scope/alpha@2.0.0"], ["pkg:npm/beta@1.0.0"]);
    assert.deepEqual(deps["pkg:npm/beta@1.0.0"], ["pkg:npm/gamma@0.1.0"]);
    assert.ok(
      deps["pkg:github/michael-palmes/kookaburra-cut@v1.2.3"].includes("pkg:npm/beta@1.0.0"),
    );
    assert.ok(
      deps["pkg:github/michael-palmes/kookaburra-cut@v1.2.3"].includes("pkg:generic/ffmpeg@8.1"),
    );
  });

  test("names the sidecar's sources and the beat model with their pins", () => {
    const sbom = buildSbom(fixtures());
    const ffmpeg = byRef(sbom, "pkg:generic/ffmpeg@8.1");
    assert.deepEqual(ffmpeg.hashes, [{ alg: "SHA-256", content: "aa11" }]);
    assert.deepEqual(ffmpeg.licenses, [{ license: { id: "GPL-2.0-or-later" } }]);
    assert.match(ffmpeg.purl, /download_url=https%3A%2F%2Fffmpeg\.org/);
    const x264 = byRef(sbom, "pkg:generic/x264@b35605ace3ddf7c1a5d67a2eb553f034aef41d55");
    assert.deepEqual(x264.properties, [
      { name: "kookaburra-cut:x264-sei", value: "x264 - core 165 r3222 b35605a" },
      {
        name: "kookaburra-cut:source-archive",
        value: "git archive of b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
      },
    ]);
    assert.deepEqual(x264.hashes, [{ alg: "SHA-256", content: "ee55" }]);
    const releaseAsset = (c) =>
      c.externalReferences.find((r) => r.type === "source-distribution")?.url;
    assert.equal(
      releaseAsset(x264),
      `https://github.com/michael-palmes/kookaburra-cut/releases/download/v${fixtures().version}/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar`,
    );
    assert.match(releaseAsset(ffmpeg), /\/ffmpeg-8\.1\.tar\.xz$/);
    assert.match(releaseAsset(byRef(sbom, "pkg:generic/x265@4.3")), /\/x265_4\.3\.tar\.gz$/);
    assert.deepEqual(byRef(sbom, "pkg:generic/x265@4.3").hashes, [
      { alg: "SHA-256", content: "bb22" },
    ]);
    const deps = Object.fromEntries(sbom.dependencies.map((d) => [d.ref, d.dependsOn]));
    assert.deepEqual(deps["pkg:generic/ffmpeg@8.1"], [
      "pkg:generic/x264@b35605ace3ddf7c1a5d67a2eb553f034aef41d55",
      "pkg:generic/x265@4.3",
    ]);
    const model = byRef(
      sbom,
      "pkg:github/danigb/beat-this-rs@1ae768e78f1ad83b0ed3886241dc29ffde853c40#models/beat_this_small.onnx",
    );
    assert.equal(model.type, "machine-learning-model");
    assert.deepEqual(model.hashes, [{ alg: "SHA-256", content: "cc33" }]);
    assert.ok(
      byRef(
        sbom,
        "pkg:github/danigb/beat-this-rs@1ae768e78f1ad83b0ed3886241dc29ffde853c40#models/mel_spectrogram.onnx",
      ),
    );
  });

  test("refuses a cargo graph for another version, a package without a licence, or a bad commit", () => {
    const other = fixtures();
    other.cargo.metadata.component.version = "9.9.9";
    assert.throws(() => buildSbom(other), /9\.9\.9, not 1\.2\.3/);
    const unlicensed = fixtures();
    delete unlicensed.pnpmLicenses["SEE LICENSE IN LICENSE"];
    assert.throws(() => buildSbom(unlicensed), /no licence listed for gamma@0\.1\.0/);
    assert.throws(() => buildSbom({ ...fixtures(), commit: "abc" }), /not a commit/);
    assert.throws(() => buildSbom({ ...fixtures(), assets: [] }), /needs the bundled assets/);
  });

  describe("the bundled assets", () => {
    let repo;
    const put = (rel, body = rel) => {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), body);
    };
    before(() => {
      repo = mkdtempSync(join(tmpdir(), "kookaburra-assets-"));
      put("src/assets/fonts/LICENSES.md", "| Inter | Inter-Regular.*, Inter-SemiBold.woff | © |");
      put("src/assets/fonts/OFL.txt");
      put("src/assets/fonts/Inter-Regular.woff");
      put("src/assets/hdri/studio.hdr");
      put("src/assets/hdri/README.md");
      put("src/assets/models/licensed.sha256", "ab12  phone.glb\n");
      put(
        "src/toolkit/stage/shaders/NOTICE.md",
        "`meshGradient.ts`, `simplexNoise.ts`, `swirl.ts`, `neuroNoise.ts`, `warp.ts`, `smokeRing.ts`",
      );
      for (const f of ["meshGradient", "simplexNoise", "swirl", "neuroNoise", "warp", "smokeRing"])
        put(`src/toolkit/stage/shaders/${f}.ts`);
      put("kit/scripts/kb.py");
      put("kit/scripts/notes.md");
      put("kit/scripts/kblib/cli.py");
      put("kit/scripts/kblib/__pycache__/cli.pyc");
      put(
        "src-tauri/tauri.conf.json",
        JSON.stringify({
          bundle: {
            resources: {
              "../kit/scripts/*.py": "skills/scripts/",
              "../kit/scripts/kblib": "skills/scripts/kblib",
              "../kit/README.md": "skills/README.md",
            },
          },
        }),
      );
    });
    after(() => rmSync(repo, { recursive: true, force: true }));

    test("lists each by hash and licence, the device models as opaque pinned files", () => {
      const assets = assetComponents(repo);
      const by = Object.fromEntries(assets.map((a) => [a.name, a]));
      assert.deepEqual(Object.keys(by).sort(), [
        "kit/scripts/kb.py",
        "kit/scripts/kblib/cli.py",
        "src/assets/fonts/Inter-Regular.woff",
        "src/assets/hdri/studio.hdr",
        "src/assets/models/licensed/phone.glb",
        "src/toolkit/stage/shaders/meshGradient.ts",
        "src/toolkit/stage/shaders/neuroNoise.ts",
        "src/toolkit/stage/shaders/simplexNoise.ts",
        "src/toolkit/stage/shaders/smokeRing.ts",
        "src/toolkit/stage/shaders/swirl.ts",
        "src/toolkit/stage/shaders/warp.ts",
      ]);
      assert.deepEqual(by["src/assets/fonts/Inter-Regular.woff"].licenses, [
        { license: { id: "OFL-1.1" } },
      ]);
      assert.deepEqual(by["src/assets/hdri/studio.hdr"].licenses, [{ license: { id: "CC0-1.0" } }]);
      const model = by["src/assets/models/licensed/phone.glb"];
      assert.deepEqual(model.hashes, [{ alg: "SHA-256", content: "ab12" }]);
      assert.match(
        model.licenses[0].license.name,
        /^Proprietary: .*may not be extracted or redistributed/,
      );
      assert.deepEqual(by["src/toolkit/stage/shaders/warp.ts"].licenses, [
        { license: { id: "Apache-2.0" } },
      ]);
      assert.deepEqual(by["kit/scripts/kb.py"].licenses, [{ expression: "MIT OR Apache-2.0" }]);
      assert.match(by["kit/scripts/kb.py"].hashes[0].content, /^[0-9a-f]{64}$/);
    });

    test("refuses a font without a licence row", () => {
      put("src/assets/fonts/Mystery-Bold.woff");
      try {
        assert.throws(() => assetComponents(repo), /Mystery-Bold\.woff has no row/);
      } finally {
        rmSync(join(repo, "src/assets/fonts/Mystery-Bold.woff"));
      }
    });

    test("matches a resource glob's other characters literally", () => {
      const conf = join(repo, "src-tauri/tauri.conf.json");
      const saved = readFileSync(conf, "utf8");
      const odd = ["a+b.py", "ab.py", "aab.py", "(c).py", "c.py", "d\\e.py", "de.py"];
      for (const name of odd) put(`odd/scripts/${name}`);
      put(
        "src-tauri/tauri.conf.json",
        JSON.stringify({
          bundle: {
            resources: Object.fromEntries(
              ["a+b*.py", "(c)*.py", "d\\e*.py"].map((g) => [`../odd/scripts/${g}`, "x/"]),
            ),
          },
        }),
      );
      try {
        const kit = assetComponents(repo)
          .map((a) => a.name)
          .filter((n) => n.startsWith("odd/"));
        assert.deepEqual(kit, ["odd/scripts/(c).py", "odd/scripts/a+b.py", "odd/scripts/d\\e.py"]);
      } finally {
        writeFileSync(conf, saved);
        rmSync(join(repo, "odd"), { recursive: true, force: true });
      }
    });

    test("covers this checkout's licensed models, every font and the kit", () => {
      const assets = assetComponents(ROOT);
      const pinned = readFileSync(join(ROOT, "src/assets/models/licensed.sha256"), "utf8")
        .trim()
        .split("\n");
      assert.equal(
        assets.filter((a) => a.name.startsWith("src/assets/models/licensed/")).length,
        pinned.length,
      );
      assert.ok(assets.some((a) => a.name.endsWith("/scripts/kb.py")));
      assert.ok(assets.some((a) => a.name === "src/assets/fonts/KookaburraFallback.otf"));
    });
  });

  describe("from the command line", () => {
    let dir;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), "kookaburra-sbom-"));
      const f = fixtures();
      writeFileSync(join(dir, "cargo.json"), JSON.stringify(f.cargo));
      writeFileSync(join(dir, "ls.json"), JSON.stringify(f.pnpmLs));
      writeFileSync(join(dir, "licenses.json"), JSON.stringify(f.pnpmLicenses));
      writeFileSync(join(dir, "sidecar.txt"), f.sidecarPins);
      writeFileSync(join(dir, "models.txt"), f.modelPins);
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    const generate = (out) =>
      spawnSync(
        "node",
        [
          "scripts/sbom.mjs",
          ...[
            "--cargo",
            join(dir, "cargo.json"),
            "--out",
            out,
            "--version",
            "1.2.3",
            "--commit",
            COMMIT,
          ],
          ...["--pnpm-ls", join(dir, "ls.json"), "--pnpm-licenses", join(dir, "licenses.json")],
          ...["--sidecar-pins", join(dir, "sidecar.txt"), "--model-pins", join(dir, "models.txt")],
        ],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "1700000000" } },
      );

    test("writes identical bytes on two runs", () => {
      const a = generate(join(dir, "a.cdx.json"));
      assert.equal(a.status, 0, a.stderr);
      const b = generate(join(dir, "b.cdx.json"));
      assert.equal(b.status, 0, b.stderr);
      const text = readFileSync(join(dir, "a.cdx.json"), "utf8");
      assert.equal(text, readFileSync(join(dir, "b.cdx.json"), "utf8"));
      const expected = buildSbom({ ...fixtures(), assets: assetComponents(ROOT) });
      assert.equal(text, render(expected));
      assert.match(
        a.stdout,
        new RegExp(`${expected.components.length} components for Kookaburra Cut 1\\.2\\.3`),
      );
    });
  });
});
