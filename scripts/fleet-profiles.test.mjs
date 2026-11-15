// The fleet profiles, scripts, cask and docs/fleet-deployment.md agree with managed.rs and with each other.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const MANAGED = read("src-tauri/src/managed.rs");
const DOMAIN = MANAGED.match(/pub const DOMAIN: &str = "([^"]+)";/)[1];
const KEY_COUNT = Number(MANAGED.match(/pub const ALL: \[Key; (\d+)\]/)[1]);
const KEYS = [...new Set([...MANAGED.matchAll(/Key::(\w+) => "(\w+)",/g)].map((m) => m[2]))];
const SHAPES = {
  "an array of strings": "keyIds",
  "an absolute path": "path",
  "an absolute folder path": "folder",
  "an https URL": "url",
  "an array of origins": "origins",
};
const shapeOf = (key) => {
  const found = MANAGED.match(new RegExp(`Key::${key} => "(${Object.keys(SHAPES).join("|")})"`));
  return found ? SHAPES[found[1]] : "boolean";
};

const MDM = "packaging/mdm";
const PROFILES = readdirSync(join(ROOT, MDM)).filter((f) => f.endsWith(".mobileconfig"));
const DOC = read("docs/fleet-deployment.md");
const CASK = read("packaging/homebrew/Casks/kookaburra-cut.rb");
const INSTALL = read(`${MDM}/install-kookaburra-cut.sh`);
const UNINSTALL = read(`${MDM}/uninstall-kookaburra-cut.sh`);

const VALUE =
  /<key>([^<]+)<\/key>\s*(<true\/>|<false\/>|<string>[^<]*<\/string>|<array\/>|<array>[\s\S]*?<\/array>)/g;

/** The forced keys of a profile's one preferences payload, as { key: raw XML value }. */
function forced(xml, file) {
  const domain = xml.indexOf(`<key>${DOMAIN}</key>`);
  assert.ok(domain > 0, `${file} does not target ${DOMAIN}`);
  assert.match(
    xml.slice(domain),
    /^<key>[^<]+<\/key>\s*<dict>\s*<key>Forced<\/key>/,
    `${file} does not use Forced`,
  );
  const body = xml.match(/<key>mcx_preference_settings<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1];
  assert.ok(body, `${file} has no mcx_preference_settings`);
  const values = Object.fromEntries([...body.matchAll(VALUE)].map((m) => [m[1], m[2]]));
  assert.equal(body.replace(VALUE, "").trim(), "", `${file} holds a value of a type no key takes`);
  return values;
}

function assertShape(key, raw, file) {
  const where = `${file}: ${key}`;
  switch (shapeOf(key)) {
    case "boolean":
      assert.match(raw, /^<(true|false)\/>$/, `${where} must be a boolean`);
      break;
    case "keyIds":
      assert.match(raw, /^<array(\/>|>[\s\S]*<\/array>)$/, `${where} must be an array`);
      for (const [, id] of raw.matchAll(/<string>([^<]*)<\/string>/g)) {
        assert.match(
          id.replaceAll(" ", ""),
          /^[0-9a-fA-F]{16}$/,
          `${where} holds ${id}, not a key id`,
        );
      }
      break;
    case "origins":
      assert.match(raw, /^<array(\/>|>[\s\S]*<\/array>)$/, `${where} must be an array`);
      for (const [, origin] of raw.matchAll(/<string>([^<]*)<\/string>/g)) {
        assert.match(
          origin,
          /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+)$/,
          `${where} holds ${origin}, not a bare origin`,
        );
      }
      break;
    case "path":
      assert.match(raw, /^<string>(\/|~\/)[^<]*<\/string>$/, `${where} must be an absolute path`);
      break;
    case "folder":
      assert.match(raw, /^<string>\/[^<]*<\/string>$/, `${where} must be an absolute folder`);
      break;
    case "url":
      assert.match(
        raw,
        /^<string>https:\/\/[^?#@{<]+<\/string>$/,
        `${where} must be a plain https URL`,
      );
      break;
  }
}

test("managed.rs names every key once", () => {
  assert.equal(KEYS.length, KEY_COUNT);
});

test("every profile forces only real keys, in the shape managed.rs reads", () => {
  assert.ok(PROFILES.length >= 3);
  for (const file of PROFILES) {
    const xml = read(`${MDM}/${file}`);
    assert.match(
      xml,
      /<key>PayloadScope<\/key>\s*<string>System<\/string>/,
      `${file} is not System scope`,
    );
    for (const [key, raw] of Object.entries(forced(xml, file))) {
      assert.ok(KEYS.includes(key), `${file} forces ${key}, which managed.rs does not read`);
      assertShape(key, raw, file);
    }
  }
});

test("the locked-down profile forces every key", () => {
  const values = forced(read(`${MDM}/kookaburra-cut-locked-down.mobileconfig`), "locked-down");
  assert.deepEqual(Object.keys(values).sort(), [...KEYS].sort());
});

test("payload UUIDs are well formed and never shared between profiles", () => {
  const uuids = PROFILES.flatMap((file) =>
    [
      ...read(`${MDM}/${file}`).matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g),
    ].map((m) => m[1]),
  );
  for (const uuid of uuids) assert.match(uuid, /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);
  assert.equal(new Set(uuids).size, uuids.length);
});

test("the posture table matches the profiles", () => {
  const rows = [...DOC.matchAll(/^\| `(\w+)` \| [\d.]+ \| (.+) \|$/gm)].map((m) => [
    m[1],
    m[2].split(" | "),
  ]);
  assert.deepEqual(rows.map(([key]) => key).sort(), [...KEYS].sort());
  const columns = ["locked-down", "agents-mirrored", "open"];
  columns.forEach((posture, i) => {
    const file = `kookaburra-cut-${posture}.mobileconfig`;
    const values = forced(read(`${MDM}/${file}`), file);
    for (const [key, cells] of rows) {
      assert.equal(
        cells[i] !== "not forced",
        key in values,
        `${posture}: ${key} disagrees with ${file}`,
      );
    }
  });
});

test("the doc carries the locked-down profile and both scripts verbatim", () => {
  assert.ok(
    DOC.includes(`\`\`\`xml\n${read(`${MDM}/kookaburra-cut-locked-down.mobileconfig`)}\`\`\``),
  );
  assert.ok(
    DOC.includes(`\`\`\`bash\n${INSTALL}\`\`\``),
    "the install script in the doc differs from the file",
  );
  assert.ok(
    DOC.includes(`\`\`\`bash\n${UNINSTALL}\`\`\``),
    "the uninstall script in the doc differs from the file",
  );
});

test("the cask, the install script and the doc pin the same release", () => {
  const version = CASK.match(/^ {2}version "([^"]+)"$/m)[1];
  const sha = CASK.match(/^ {2}sha256 "([0-9a-f]{64})"$/m)[1];
  assert.match(
    INSTALL,
    new RegExp(`^VERSION="\\$\\{4:-${version.replaceAll(".", "\\.")}\\}"$`, "m"),
  );
  assert.match(INSTALL, new RegExp(`^DMG_SHA256="\\$\\{5:-${sha}\\}"$`, "m"));
  assert.ok(
    DOC.includes(`\`${sha}\``),
    "docs/fleet-deployment.md does not name the cask's DMG hash",
  );
  assert.ok(DOC.includes(`[ "$v" = "${version}" ]`), "the Iru audit script checks another version");
});

test("the cask's minimum macOS is the app's", () => {
  const NAMES = { 26: ":tahoe" };
  const min = JSON.parse(read("src-tauri/tauri.conf.json")).bundle.macOS.minimumSystemVersion;
  assert.equal(CASK.match(/depends_on macos: (:\w+)/)[1], NAMES[Number.parseInt(min, 10)]);
});

test("the uninstall script removes exactly what the cask zaps", () => {
  const zap = [...CASK.match(/zap trash: \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map(
    (m) => m[1],
  );
  const removed = [...UNINSTALL.matchAll(/^ {4}"\$home\/([^"]+)"/gm)].map((m) => `~/${m[1]}`);
  assert.deepEqual(removed.sort(), zap.sort());
});
