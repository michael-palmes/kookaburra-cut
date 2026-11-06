#!/usr/bin/env node
// The release's CycloneDX 1.5 SBOM: one component per shipped npm package (pnpm ls --prod) with
// its licence (pnpm licenses list --prod), every crate in cargo cyclonedx's graph, the sidecar's
// pinned sources and the beat model's pinned files. Two builds of one commit write identical
// bytes: the timestamp is SOURCE_DATE_EPOCH and the serial number derives from the commit.
//
//   node scripts/sbom.mjs --cargo <cargo cyclonedx json> --out <file>
//     [--version <v>] [--commit <sha>] [--pnpm-ls <json>] [--pnpm-licenses <json>]
//     [--sidecar-pins <txt>] [--model-pins <txt>]
//   SOURCE_DATE_EPOCH   the build's timestamp (default: the commit's)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const bySortedRef = (a, b) =>
  a["bom-ref"] < b["bom-ref"] ? -1 : a["bom-ref"] > b["bom-ref"] ? 1 : 0;

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

function sidecarComponents(pinText) {
  const p = pins(pinText);
  for (const k of [
    "FFMPEG_VERSION",
    "FFMPEG_SHA256",
    "FFMPEG_URL",
    "X264_COMMIT",
    "X264_URL",
    "X264_SEI",
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
        externalReferences: [{ type: "distribution", url: p.FFMPEG_URL }],
      },
      {
        type: "library",
        "bom-ref": x264,
        name: "x264",
        version: p.X264_COMMIT,
        scope: "required",
        licenses: [{ license: { id: GPL } }],
        purl: `${x264}?vcs_url=${q(`git+${p.X264_URL}@${p.X264_COMMIT}`)}`,
        externalReferences: [{ type: "vcs", url: p.X264_URL }],
        properties: [{ name: "kookaburra-cut:x264-sei", value: p.X264_SEI }],
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
        externalReferences: [{ type: "distribution", url: p.X265_URL }],
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
}) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  if (!Number.isInteger(epoch) || epoch <= 0) throw new Error(`not a timestamp: ${epoch}`);
  const npm = npmComponents(pnpmLs, pnpmLicenses);
  const rust = cargoComponents(cargo, version);
  const sidecar = sidecarComponents(sidecarPins);
  const model = modelComponents(modelPins);
  const rootRef = `pkg:github/${REPO}@v${version}`;
  const edges = new Map([
    [rootRef, new Set([rust.rootRef, ...npm.roots, sidecar.rootRef, ...model.refs])],
    ...npm.edges,
    ...rust.edges,
    ...sidecar.edges,
  ]);
  const components = [
    ...npm.components,
    ...rust.components,
    ...sidecar.components,
    ...model.components,
  ].sort(bySortedRef);
  const refs = new Set(components.map((c) => c["bom-ref"]));
  if (refs.size !== components.length) throw new Error("duplicate component references");
  const dependencies = [...edges.entries()]
    .map(([ref, on]) => ({ ref, dependsOn: [...on].sort() }))
    .sort(bySortedRef_);
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
        licenses: [{ expression: "MIT OR Apache-2.0" }],
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

const bySortedRef_ = (a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

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
  });
  writeFileSync(args.out, render(sbom));
  console.log(
    `${args.out}: ${sbom.components.length} components for ${APP_NAME} ${version} at ${commit.slice(0, 12)}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
