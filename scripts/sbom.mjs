#!/usr/bin/env node
// The release's CycloneDX 1.5 SBOM: one component per shipped npm package (pnpm ls --prod) with
// its licence (pnpm licenses list --prod), every crate in cargo cyclonedx's graph, the sidecar's
// pinned sources, the beat model's pinned files and the bundled assets (fonts, HDRIs, the licensed
// device models, the adapted shaders, the kit scripts) by hash. Two builds of one commit write
// identical bytes: the timestamp is SOURCE_DATE_EPOCH and the serial number derives from the commit.
//
//   node scripts/sbom.mjs --cargo <cargo cyclonedx json> --out <file>
//     [--version <v>] [--commit <sha>] [--pnpm-ls <json>] [--pnpm-licenses <json>]
//     [--sidecar-pins <txt>] [--model-pins <txt>]
//   SOURCE_DATE_EPOCH   the build's timestamp (default: the commit's)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "michael-palmes/kookaburra-cut";
const APP_NAME = "Kookaburra Cut";
const CRATE = "kookaburra-cut";
const GPL = "GPL-2.0-or-later";
const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function uuidv5(namespace, name) {
  const hash = createHash("sha1")
    .update(Buffer.concat([Buffer.from(namespace.replace(/-/g, ""), "hex"), Buffer.from(name)]))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A CycloneDX licence choice from a package's licence string. */
function licenses(text) {
  const s = (text ?? "").trim();
  if (!s) return undefined;
  if (/\b(AND|OR|WITH)\b/.test(s)) return [{ expression: s }];
  if (/^[A-Za-z0-9.+-]+$/.test(s)) return [{ license: { id: s } }];
  return [{ license: { name: s } }];
}

function npmPurl(name, version) {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

/** KEY=VALUE lines; a repeated key collects into an array. */
function pins(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

function npmComponents(tree, licenseList) {
  const licenseOf = new Map();
  for (const entries of Object.values(licenseList)) {
    for (const e of entries) for (const v of e.versions) licenseOf.set(`${e.name}@${v}`, e.license);
  }
  const components = new Map();
  const edges = new Map();
  const roots = new Set();
  const walk = (deps, from) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      const key = `${name}@${d.version}`;
      const ref = npmPurl(name, d.version);
      if (from) edges.get(from).add(ref);
      else roots.add(ref);
      if (!components.has(key)) {
        if (!licenseOf.has(key)) throw new Error(`no licence listed for ${key}`);
        const c = {
          type: "library",
          "bom-ref": ref,
          name,
          version: d.version,
          scope: "required",
          licenses: licenses(licenseOf.get(key)),
          purl: ref,
        };
        if (d.resolved) c.externalReferences = [{ type: "distribution", url: d.resolved }];
        components.set(key, c);
        edges.set(ref, new Set());
      }
      walk(d.dependencies, ref);
      walk(d.optionalDependencies, ref);
    }
  };
  for (const project of tree) {
    walk(project.dependencies, null);
    walk(project.optionalDependencies, null);
  }
  return { components: [...components.values()], edges, roots };
}

function cargoComponents(cargo, version) {
  const root = cargo.metadata?.component;
  if (!root || root.name !== CRATE)
    throw new Error("the cargo SBOM does not describe the app crate");
  if (root.version !== version)
    throw new Error(`the cargo SBOM is for ${root.version}, not ${version}`);
  const rootRef = `pkg:cargo/${CRATE}@${version}`;
  // cargo cyclonedx references crates by registry URL and the app by its checkout path; the purl is both stable and the convention here.
  const refs = new Map(cargo.components.map((c) => [c["bom-ref"], c.purl ?? c["bom-ref"]]));
  const rename = (ref) => refs.get(ref) ?? (ref.includes(`#${CRATE}@${version}`) ? rootRef : ref);
  const components = [
    {
      type: "library",
      "bom-ref": rootRef,
      name: CRATE,
      version,
      scope: "required",
      licenses: root.licenses,
      purl: rootRef,
    },
    ...cargo.components.map((c) => ({ ...c, "bom-ref": rename(c["bom-ref"]) })),
  ];
  const known = new Set(components.map((c) => c["bom-ref"]));
  const edges = new Map();
  for (const d of cargo.dependencies ?? []) {
    const ref = rename(d.ref);
    if (!known.has(ref)) continue;
    const on = (d.dependsOn ?? []).map(rename).filter((r) => known.has(r) && r !== ref);
    edges.set(ref, new Set([...(edges.get(ref) ?? []), ...on]));
  }
  return { components, edges, rootRef, tools: cargo.metadata.tools };
}

function sidecarComponents(pinText, version) {
  const p = pins(pinText);
  for (const k of [
    "FFMPEG_VERSION",
    "FFMPEG_SHA256",
    "FFMPEG_URL",
    "X264_COMMIT",
    "X264_URL",
    "X264_SEI",
    "X264_SOURCE_SHA256",
    "X265_VERSION",
    "X265_SHA256",
    "X265_URL",
  ]) {
    if (!p[k]) throw new Error(`the sidecar pins lack ${k}`);
  }
  const q = encodeURIComponent;
  const ffmpeg = `pkg:generic/ffmpeg@${p.FFMPEG_VERSION}`;
  const x264 = `pkg:generic/x264@${p.X264_COMMIT}`;
  const x265 = `pkg:generic/x265@${p.X265_VERSION}`;
  const attached = (name) => ({
    type: "source-distribution",
    url: `https://github.com/${REPO}/releases/download/v${version}/${name}`,
  });
  return {
    rootRef: ffmpeg,
    components: [
      {
        type: "application",
        "bom-ref": ffmpeg,
        name: "ffmpeg",
        version: p.FFMPEG_VERSION,
        description:
          "The ffmpeg and ffprobe sidecar, built from this source by scripts/build-ffmpeg-sidecar.sh",
        scope: "required",
        hashes: [{ alg: "SHA-256", content: p.FFMPEG_SHA256 }],
        licenses: [{ license: { id: GPL } }],
        purl: `${ffmpeg}?checksum=${q(`sha256:${p.FFMPEG_SHA256}`)}&download_url=${q(p.FFMPEG_URL)}`,
        externalReferences: [
          { type: "distribution", url: p.FFMPEG_URL },
          attached(`ffmpeg-${p.FFMPEG_VERSION}.tar.xz`),
        ],
      },
      {
        type: "library",
        "bom-ref": x264,
        name: "x264",
        version: p.X264_COMMIT,
        scope: "required",
        hashes: [{ alg: "SHA-256", content: p.X264_SOURCE_SHA256 }],
        licenses: [{ license: { id: GPL } }],
        purl: `${x264}?vcs_url=${q(`git+${p.X264_URL}@${p.X264_COMMIT}`)}`,
        externalReferences: [
          { type: "vcs", url: p.X264_URL },
          attached(`x264-${p.X264_COMMIT}.tar`),
        ],
        properties: [
          { name: "kookaburra-cut:x264-sei", value: p.X264_SEI },
          { name: "kookaburra-cut:source-archive", value: `git archive of ${p.X264_COMMIT}` },
        ],
      },
      {
        type: "library",
        "bom-ref": x265,
        name: "x265",
        version: p.X265_VERSION,
        scope: "required",
        hashes: [{ alg: "SHA-256", content: p.X265_SHA256 }],
        licenses: [{ license: { id: GPL } }],
        purl: `${x265}?checksum=${q(`sha256:${p.X265_SHA256}`)}&download_url=${q(p.X265_URL)}`,
        externalReferences: [
          { type: "distribution", url: p.X265_URL },
          attached(`x265_${p.X265_VERSION}.tar.gz`),
        ],
      },
    ],
    edges: new Map([[ffmpeg, new Set([x264, x265])]]),
  };
}

function modelComponents(pinText) {
  const p = pins(pinText);
  const commit = p.BEAT_THIS_RS_COMMIT;
  const models = [].concat(p.MODEL ?? []);
  if (!commit || models.length === 0) throw new Error("the model pins lack the commit or a model");
  const components = models.map((entry) => {
    const [name, sha, bytes] = entry.split("|");
    const ref = `pkg:github/danigb/beat-this-rs@${commit}#models/${name}`;
    return {
      type: "machine-learning-model",
      "bom-ref": ref,
      name,
      version: commit,
      scope: "required",
      hashes: [{ alg: "SHA-256", content: sha }],
      licenses: [{ license: { id: "MIT" } }],
      purl: ref,
      externalReferences: [
        {
          type: "distribution",
          url: `https://raw.githubusercontent.com/danigb/beat-this-rs/${commit}/models/${name}`,
        },
      ],
      properties: [{ name: "kookaburra-cut:bytes", value: bytes }],
    };
  });
  return { components, refs: components.map((c) => c["bom-ref"]) };
}

const OWN = "MIT OR Apache-2.0";
const DEVICE_TERMS =
  "Proprietary: licensed from the models' creators. Renders may be published, commercial use included; the files may not be extracted or redistributed.";
const SHADERS = [
  "meshGradient.ts",
  "simplexNoise.ts",
  "swirl.ts",
  "neuroNoise.ts",
  "warp.ts",
  "smokeRing.ts",
];

function walk(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && name !== "__pycache__")
    .flatMap((name) =>
      statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)],
    );
}

/** The bundled files the package graphs miss, each by path, hash and licence; repo is the checkout. */
export function assetComponents(repo) {
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const file = (rel, licence, extra = {}) => ({
    type: "file",
    "bom-ref": `file:${rel}`,
    name: rel,
    scope: "required",
    hashes: [{ alg: "SHA-256", content: extra.sha ?? hash(join(repo, rel)) }],
    licenses: licence,
    ...(extra.fields ?? {}),
  });
  const out = [];

  const fonts = "src/assets/fonts";
  const fontRows = readFileSync(join(repo, fonts, "LICENSES.md"), "utf8");
  for (const name of readdirSync(join(repo, fonts)).sort()) {
    if (!/\.(woff2?|otf|ttf|typeface\.json)$/.test(name)) continue;
    const family = name.split(/[-.]/)[0];
    if (!fontRows.includes(`${family}-`) && !fontRows.includes(`${family}.`))
      throw new Error(`${fonts}/${name} has no row in ${fonts}/LICENSES.md`);
    out.push(file(`${fonts}/${name}`, [{ license: { id: "OFL-1.1" } }]));
  }

  const hdri = "src/assets/hdri";
  for (const name of readdirSync(join(repo, hdri)).sort()) {
    if (name.endsWith(".hdr")) out.push(file(`${hdri}/${name}`, [{ license: { id: "CC0-1.0" } }]));
  }

  const pinned = readFileSync(join(repo, "src/assets/models/licensed.sha256"), "utf8");
  for (const line of pinned.split("\n").filter(Boolean)) {
    const [sha, name] = line.trim().split(/\s+/);
    out.push(
      file(`src/assets/models/licensed/${name}`, [{ license: { name: DEVICE_TERMS } }], {
        sha,
        fields: { description: "A licensed device model, listed by hash only" },
      }),
    );
  }

  const shaders = "src/toolkit/stage/shaders";
  const shaderNotice = readFileSync(join(repo, shaders, "NOTICE.md"), "utf8");
  for (const name of SHADERS) {
    if (!shaderNotice.includes(`\`${name}\``))
      throw new Error(`${shaders}/NOTICE.md does not name ${name}`);
    out.push(
      file(`${shaders}/${name}`, [{ license: { id: "Apache-2.0" } }], {
        fields: {
          copyright: "Paper Design",
          pedigree: {
            notes: `Adapted from paper-design/shaders; ${shaders}/NOTICE.md lists the changes`,
          },
          externalReferences: [{ type: "vcs", url: "https://github.com/paper-design/shaders" }],
        },
      }),
    );
  }

  const resources = JSON.parse(readFileSync(join(repo, "src-tauri/tauri.conf.json"), "utf8")).bundle
    .resources;
  const kit = new Set();
  for (const from of Object.keys(resources).filter((k) => k.includes("/scripts/"))) {
    const path = join(repo, "src-tauri", from);
    if (basename(path).includes("*")) {
      const pattern = new RegExp(
        `^${basename(path).replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`,
      );
      for (const name of readdirSync(dirname(path))) {
        if (pattern.test(name) && statSync(join(dirname(path), name)).isFile())
          kit.add(join(dirname(path), name));
      }
    } else for (const f of walk(path)) kit.add(f);
  }
  if (kit.size === 0) throw new Error("tauri.conf.json bundles no kit scripts");
  for (const path of [...kit].sort()) out.push(file(relative(repo, path), [{ expression: OWN }]));

  return out;
}

/** The whole SBOM as a plain object with a fixed key order and sorted lists. */
export function buildSbom({
  version,
  commit,
  epoch,
  cargo,
  pnpmLs,
  pnpmLicenses,
  sidecarPins,
  modelPins,
  assets,
}) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  if (!Number.isInteger(epoch) || epoch <= 0) throw new Error(`not a timestamp: ${epoch}`);
  const npm = npmComponents(pnpmLs, pnpmLicenses);
  const rust = cargoComponents(cargo, version);
  const sidecar = sidecarComponents(sidecarPins, version);
  const model = modelComponents(modelPins);
  if (!Array.isArray(assets) || assets.length === 0)
    throw new Error("the SBOM needs the bundled assets");
  const rootRef = `pkg:github/${REPO}@v${version}`;
  const edges = new Map([
    [
      rootRef,
      new Set([
        rust.rootRef,
        ...npm.roots,
        sidecar.rootRef,
        ...model.refs,
        ...assets.map((a) => a["bom-ref"]),
      ]),
    ],
    ...npm.edges,
    ...rust.edges,
    ...sidecar.edges,
  ]);
  const components = [
    ...npm.components,
    ...rust.components,
    ...sidecar.components,
    ...model.components,
    ...assets,
  ].sort(byKey("bom-ref"));
  const refs = new Set(components.map((c) => c["bom-ref"]));
  if (refs.size !== components.length) throw new Error("duplicate component references");
  const dependencies = [...edges.entries()]
    .map(([ref, on]) => ({ ref, dependsOn: [...on].sort() }))
    .sort(byKey("ref"));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${uuidv5(URL_NAMESPACE, `https://github.com/${REPO}/commit/${commit}`)}`,
    version: 1,
    metadata: {
      timestamp: new Date(epoch * 1000).toISOString().replace(/\.000Z$/, "Z"),
      tools: {
        components: [
          ...(rust.tools ?? []).map((t) => ({
            type: "application",
            group: t.vendor,
            name: t.name,
            version: t.version,
          })),
          { type: "application", group: REPO, name: "scripts/sbom.mjs", version: commit },
        ],
      },
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: APP_NAME,
        version,
        licenses: [{ expression: OWN }],
        purl: rootRef,
        externalReferences: [{ type: "vcs", url: `https://github.com/${REPO}` }],
      },
      properties: [
        { name: "kookaburra-cut:commit", value: commit },
        { name: "kookaburra-cut:source-date-epoch", value: String(epoch) },
      ],
    },
    components,
    dependencies,
  };
}

export function render(sbom) {
  return `${JSON.stringify(sbom, null, 2)}\n`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined)
      throw new Error(`usage: ${key} needs a value`);
    out[key.slice(2)] = value;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cargo || !args.out)
    throw new Error("usage: sbom.mjs --cargo <file> --out <file> [...]");
  const file = (p) => readFileSync(p, "utf8");
  const version = args.version ?? JSON.parse(file(join(ROOT, "src-tauri/tauri.conf.json"))).version;
  const commit = args.commit ?? run("git", ["rev-parse", "HEAD"]).trim();
  const epoch = Number(
    process.env.SOURCE_DATE_EPOCH ?? run("git", ["show", "-s", "--format=%ct", "HEAD"]).trim(),
  );
  const sbom = buildSbom({
    version,
    commit,
    epoch,
    cargo: JSON.parse(file(args.cargo)),
    pnpmLs: JSON.parse(
      args["pnpm-ls"]
        ? file(args["pnpm-ls"])
        : run("pnpm", ["ls", "--prod", "--json", "--depth=Infinity"]),
    ),
    pnpmLicenses: JSON.parse(
      args["pnpm-licenses"]
        ? file(args["pnpm-licenses"])
        : run("pnpm", ["licenses", "list", "--prod", "--json"]),
    ),
    sidecarPins: args["sidecar-pins"]
      ? file(args["sidecar-pins"])
      : run("bash", ["scripts/build-ffmpeg-sidecar.sh", "--print-pins"]),
    modelPins: args["model-pins"]
      ? file(args["model-pins"])
      : run("bash", ["scripts/setup-models.sh", "--print-pins"]),
    assets: assetComponents(ROOT),
  });
  writeFileSync(args.out, render(sbom));
  console.log(
    `${args.out}: ${sbom.components.length} components for ${APP_NAME} ${version} at ${commit.slice(0, 12)}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
