import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as toolkit from "../toolkit";
import { EM_DASH, TOOLKIT_SUMMARIES } from "./catalog";
import {
  buildToolkitDocs,
  dtsErrors,
  exampleUses,
  type ToolkitDocs,
  type ToolkitEntry,
} from "./toolkitDocs";
import { TOOLKIT_SHOW } from "./toolkitShow";

const KIT = "../../.agents/skills/kookaburra-scene-authoring/";
const DTS_PATH = fileURLToPath(new URL(`${KIT}toolkit.d.ts`, import.meta.url));
const JSON_PATH = fileURLToPath(new URL(`${KIT}toolkit.json`, import.meta.url));

let docs: ToolkitDocs;
const entry = (name: string): ToolkitEntry => docs.entries[name];

describe("the kit's toolkit reference", { timeout: 180_000 }, () => {
  // The compile is heavy and synchronous, so it runs under this long timeout, not at import.
  beforeAll(() => {
    docs = buildToolkitDocs(TOOLKIT_SUMMARIES);
  }, 180_000);

  it("matches the committed files (run pnpm agent:catalog when this fails)", () => {
    if (process.env.KB_WRITE_CATALOG) {
      writeFileSync(DTS_PATH, docs.dts);
      writeFileSync(JSON_PATH, `${JSON.stringify(docs.entries, null, 2)}\n`);
      return;
    }
    expect(readFileSync(DTS_PATH, "utf8")).toBe(docs.dts);
    expect(JSON.parse(readFileSync(JSON_PATH, "utf8"))).toEqual(
      JSON.parse(JSON.stringify(docs.entries)),
    );
  });

  it("keeps local paths and the em dash out", () => {
    const text = docs.dts + JSON.stringify(docs.entries);
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain('import("/');
    expect(text).not.toContain(EM_DASH);
  });

  it("compiles on its own", () => {
    expect(dtsErrors(DTS_PATH)).toEqual([]);
  });

  it("covers every public runtime export", () => {
    for (const name of Object.keys(toolkit)) {
      if (TOOLKIT_SUMMARIES[name]?.internal) continue;
      expect(docs.entries[name], name).toBeDefined();
    }
  });

  it("reads props, defaults and units from the source", () => {
    const props = entry("AnimatedHeadline").props ?? [];
    const prop = (name: string) => props.find((p) => p.name === name);
    expect(prop("text")?.required).toBe(true);
    expect(prop("fontSize")?.default).toBe("0.6");
    expect(prop("hitAt")?.units).toBe("ms");
    expect(prop("fit")?.type).toBe('"width"');
    expect(entry("Stamp").props?.find((p) => p.name === "inMs")).toBeDefined();
  });

  it("flattens a union of prop shapes", () => {
    const names = entry("StagedObject").props?.map((p) => p.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["spec", "objectId", "position"]));
  });

  it("holds every hand-written example to the real props", () => {
    for (const [name, show] of Object.entries(TOOLKIT_SHOW)) {
      expect(docs.entries[name], `${name} is not a toolkit export`).toBeDefined();
      if (!show.example) continue;
      for (const use of exampleUses(show.example)) {
        const target = docs.entries[use.tag];
        expect(target, `${name}'s example uses unknown <${use.tag}>`).toBeDefined();
        const known = target.props?.map((p) => p.name) ?? [];
        for (const attr of use.attrs) expect(known, `${use.tag}.${attr}`).toContain(attr);
        for (const p of target.props ?? []) {
          if (p.required && p.name !== "children")
            expect(use.attrs, `${use.tag}.${p.name}`).toContain(p.name);
        }
      }
    }
  });

  it("gives every component an example", () => {
    for (const [name, e] of Object.entries(docs.entries)) {
      if (e.kind === "component" && e.props) expect(e.example, name).toBeTruthy();
    }
  });
});
