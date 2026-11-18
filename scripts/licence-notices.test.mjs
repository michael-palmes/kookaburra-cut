import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  licenceFiles,
  listedPackages,
  missingFromNotices,
  renderNotices,
  spdxIds,
} from "./licence-notices.mjs";

const MIT = "MIT standard text\n";
const STANDARD = new Map([
  ["MIT", MIT],
  ["Apache-2.0", "Apache standard text\n"],
]);
const pkg = (kind, name, version, licence, files = {}) => ({
  kind,
  name,
  version,
  licence,
  by: "Someone",
  home: `https://example.com/${name}`,
  files: new Map(Object.entries(files)),
});

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "licence-notices-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("licence-notices", () => {
  test("reads the ids an expression names, old slash style included", () => {
    assert.deepEqual(spdxIds("(MIT OR Apache-2.0) AND Unicode-3.0"), [
      "MIT",
      "Apache-2.0",
      "Unicode-3.0",
    ]);
    assert.deepEqual(spdxIds("Apache-2.0 WITH LLVM-exception"), ["Apache-2.0", "LLVM-exception"]);
    assert.deepEqual(spdxIds("MIT/Apache-2.0"), ["MIT", "Apache-2.0"]);
  });

  test("finds licence files and a REUSE folder, never other files", () => {
    writeFileSync(join(dir, "LICENSE-MIT"), "mit");
    writeFileSync(join(dir, "COPYING"), "copying");
    writeFileSync(join(dir, "README.md"), "readme");
    mkdirSync(join(dir, "LICENSES"));
    writeFileSync(join(dir, "LICENSES", "Apache-2.0.txt"), "apache");
    mkdirSync(join(dir, "license"));
    assert.deepEqual(
      [...licenceFiles(dir).keys()],
      ["COPYING", "LICENSE-MIT", "LICENSES/Apache-2.0.txt"],
    );
  });

  test("prints a shared text once, in a stable order, and the standard text for a bare package", () => {
    const shared = { LICENSE: "Copyright Someone\nPermission granted.\n" };
    const notices = renderNotices(
      [
        pkg("npm", "zeta", "1.0.0", "MIT", shared),
        pkg("crate", "bare", "0.1.0", "MIT"),
        pkg("npm", "alpha", "2.0.0", "MIT", shared),
      ],
      STANDARD,
    );
    assert.equal(notices.match(/Permission granted\./g).length, 1);
    assert.match(notices, /LICENSE: the same text as LICENSE in alpha 2\.0\.0 above\./);
    assert.ok(notices.indexOf("crate: bare") < notices.indexOf("npm: alpha"));
    assert.ok(notices.indexOf("npm: alpha") < notices.indexOf("npm: zeta"));
    assert.match(notices, /No licence file in the package: the standard MIT text is at the end\./);
    assert.ok(notices.endsWith(`MIT:\n\n${MIT}`));
    assert.equal(
      notices,
      renderNotices(
        [
          pkg("npm", "alpha", "2.0.0", "MIT", shared),
          pkg("crate", "bare", "0.1.0", "MIT"),
          pkg("npm", "zeta", "1.0.0", "MIT", shared),
        ],
        STANDARD,
      ),
    );
  });

  test("refuses a bare package whose licence has no standard text", () => {
    assert.throws(
      () => renderNotices([pkg("crate", "odd", "1.0.0", "Bespoke-1.0")], STANDARD),
      /odd 1\.0\.0 needs the standard Bespoke-1\.0 text/,
    );
  });

  test("names every SBOM package the notices leave out, but not the app crate", () => {
    const notices = renderNotices(
      [
        pkg("npm", "@scope/kept", "1.0.0", "MIT", { LICENSE: "x" }),
        pkg("crate", "serde", "1.0.0", "MIT"),
      ],
      STANDARD,
    );
    assert.deepEqual([...listedPackages(notices)].sort(), [
      "crate:serde@1.0.0",
      "npm:@scope/kept@1.0.0",
    ]);
    const sbom = {
      components: [
        { name: "@scope/kept", version: "1.0.0", purl: "pkg:npm/%40scope/kept@1.0.0" },
        { name: "serde", version: "1.0.0", purl: "pkg:cargo/serde@1.0.0" },
        { name: "kookaburra-cut", version: "0.23.0", purl: "pkg:cargo/kookaburra-cut@0.23.0" },
        { name: "left-out", version: "2.0.0", purl: "pkg:cargo/left-out@2.0.0" },
        { name: "ffmpeg", version: "8.1", purl: "pkg:generic/ffmpeg@8.1" },
      ],
    };
    assert.deepEqual(missingFromNotices(sbom, notices), ["crate:left-out@2.0.0"]);
  });
});
