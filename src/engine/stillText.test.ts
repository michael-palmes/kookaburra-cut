import { Group, Layers, Object3D, PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import { cutoutPixelRect, frameLayout } from "../toolkit/frame/frameLayout";
import type { ResolvedOverlay } from "./overlayPlan";
import {
  cleanStillText,
  collectPageText,
  fallbackPageText,
  finishTextItems,
  pageTextRoots,
  projectLineBox,
  type TextRoot,
  troikaLines,
} from "./stillText";

/** Fixed-advance carets for `text` on one baseline: each char 1 unit wide from `x`. */
function carets(text: string, x = 0, bottom = 0, top = 1): number[] {
  return Array.from(text).flatMap((_, i) => [x + i, x + i + 1, bottom, top]);
}

function camera(aspect = 16 / 9): PerspectiveCamera {
  const cam = new PerspectiveCamera(30, aspect, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** A troika-like text mesh: the fields the text layer reads. */
function textMesh(
  text: string,
  caretData: number[] | null,
  extra: Record<string, unknown> = {},
): Object3D {
  const mesh = new Object3D();
  Object.assign(mesh, {
    text,
    textRenderInfo: { caretPositions: caretData, blockBounds: [-1, -0.5, 1, 0.5] },
    fillOpacity: 1,
    material: { opacity: 1 },
    ...extra,
  });
  return mesh;
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const HALF_H = 10 * Math.tan((15 * Math.PI) / 180);
const HALF_W = HALF_H * (16 / 9);

describe("troikaLines", () => {
  it("splits on newlines and keeps each line's caret box", () => {
    const text = "Hi\nYo";
    const data = [...carets("Hi", 0, 0, 1), 0, 0, 0, 0, ...carets("Yo", 0, -1.5, -0.5)];
    expect(troikaLines(text, data)).toEqual([
      { text: "Hi", x0: 0, x1: 2, y0: 0, y1: 1 },
      { text: "Yo", x0: 0, x1: 2, y0: -1.5, y1: -0.5 },
    ]);
  });

  it("starts a new line on a wrap's vertical jump", () => {
    const data = [...carets("ab ", 0, 0, 1), ...carets("cd", 0, -1.2, -0.2)];
    const lines = troikaLines("ab cd", data);
    expect(lines?.map((l) => l.text)).toEqual(["ab ", "cd"]);
  });

  it("is null without caret data", () => {
    expect(troikaLines("abc", null)).toBeNull();
    expect(troikaLines("abc", [0, 1, 0, 1])).toBeNull();
  });
});

describe("cleanStillText", () => {
  it("strips emoji placeholders and NFC-normalises", () => {
    expect(cleanStillText("Café  ok")).toBe("Café ok");
  });

  it("collapses whitespace and control characters", () => {
    expect(cleanStillText("  a\tb\u0007c  ")).toBe("a b c");
  });
});

describe("projectLineBox", () => {
  it("projects a centred box into normalised top-left page space", () => {
    const rect = projectLineBox(
      { x0: -1, x1: 1, y0: -0.5, y1: 0.5 },
      new Object3D().matrixWorld,
      camera(),
      FULL,
    );
    expect(rect?.x).toBeCloseTo(0.5 - 0.5 / HALF_W, 4);
    expect(rect?.w).toBeCloseTo(1 / HALF_W, 4);
    expect(rect?.y).toBeCloseTo(0.5 - 0.25 / HALF_H, 4);
    expect(rect?.h).toBeCloseTo(0.5 / HALF_H, 4);
  });

  it("maps through a viewport and clamps to it", () => {
    const vp = { x: 0.5, y: 0.25, w: 0.5, h: 0.5 };
    const rect = projectLineBox(
      { x0: 0, x1: 100, y0: -0.5, y1: 0.5 },
      new Object3D().matrixWorld,
      camera(),
      vp,
    );
    expect(rect?.x).toBeCloseTo(0.75, 4);
    expect((rect?.x ?? 0) + (rect?.w ?? 0)).toBeCloseTo(1, 4);
  });

  it("culls boxes behind the camera or off the page", () => {
    const behind = new Object3D();
    behind.position.set(0, 0, 20);
    behind.updateMatrixWorld(true);
    expect(
      projectLineBox({ x0: -1, x1: 1, y0: -1, y1: 1 }, behind.matrixWorld, camera(), FULL),
    ).toBeNull();
    const off = new Object3D();
    off.position.set(50, 0, 0);
    off.updateMatrixWorld(true);
    expect(
      projectLineBox({ x0: -1, x1: 1, y0: -1, y1: 1 }, off.matrixWorld, camera(), FULL),
    ).toBeNull();
  });
});

describe("collectPageText", () => {
  const root = (children: Object3D[], visible = false) => {
    const group = new Group();
    group.visible = visible;
    for (const child of children) group.add(child);
    group.updateMatrixWorld(true);
    return group;
  };
  const roots = (group: Object3D, rootVisibility = false): TextRoot[] => [
    { root: group, rootVisibility, camera: camera(), viewport: FULL },
  ];

  it("reads visible lines under a host the compositor has hidden again", () => {
    const items = collectPageText(
      roots(root([textMesh("Hello", carets("Hello", -2.5))])),
      new Layers(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Hello");
  });

  it("skips hidden branches, faded text and other camera layers", () => {
    const hidden = new Group();
    hidden.visible = false;
    hidden.add(textMesh("Hidden", carets("Hidden")));
    const faded = textMesh("Faded", carets("Faded"), { fillOpacity: 0.01 });
    const helper = textMesh("Helper", carets("Helper"));
    helper.layers.set(5);
    const items = collectPageText(roots(root([hidden, faded, helper])), new Layers());
    expect(items).toEqual([]);
  });

  it("honours a persistent layer's own visibility", () => {
    const group = root([textMesh("Layer", carets("Layer"))], false);
    expect(collectPageText(roots(group, true), new Layers())).toEqual([]);
    group.visible = true;
    expect(collectPageText(roots(group, true), new Layers())).toHaveLength(1);
  });

  it("reads outlined text (a material array) and hollow text by its stroke", () => {
    const outlined = textMesh("Outlined", carets("Outlined", -4), {
      material: [{ opacity: 1 }, { opacity: 1 }],
    });
    const hollow = textMesh("Hollow", carets("Hollow", -3, 2, 3), {
      fillOpacity: 0,
      strokeWidth: 0.02,
      strokeOpacity: 1,
    });
    const texts = collectPageText(roots(root([outlined, hollow])), new Layers()).map((i) => i.text);
    expect(texts).toEqual(["Hollow", "Outlined"]);
  });

  it("falls back to the block bounds without carets", () => {
    const items = collectPageText(roots(root([textMesh("Block", null)])), new Layers());
    expect(items[0].text).toBe("Block");
    expect(items[0].w).toBeCloseTo(1 / HALF_W, 4);
  });

  it("drops chromatic echoes and orders top to bottom, left to right", () => {
    const echo = textMesh("Title", carets("Title", -2.5, 2, 3));
    echo.position.x = 0.001;
    const items = collectPageText(
      roots(
        root([
          textMesh("Body right", carets("Body right", 1, -2, -1)),
          textMesh("Title", carets("Title", -2.5, 2, 3)),
          echo,
          textMesh("Body", carets("Body", -6, -2, -1)),
        ]),
      ),
      new Layers(),
    );
    expect(items.map((i) => i.text)).toEqual(["Title", "Body", "Body right"]);
  });
});

describe("finishTextItems and fallbackPageText", () => {
  it("keeps the same text at different places", () => {
    const a = { text: "Same", x: 0.1, y: 0.1, w: 0.1, h: 0.05 };
    expect(finishTextItems([a, { ...a, y: 0.5 }])).toHaveLength(2);
  });

  it("lists registered strings unpositioned, line by line, once each", () => {
    expect(fallbackPageText(["One\nTwo", "One", " "])).toEqual([
      { text: "One", x: 0, y: 0, w: 1, h: 0.02 },
      { text: "Two", x: 0, y: 0, w: 1, h: 0.02 },
    ]);
  });
});

describe("pageTextRoots", () => {
  const host = new Group();
  const hostB = new Group();
  const panel = new Group();
  const layer = new Group();
  const overlay = (shape: "rounded-rect" | "none", panelKind = "flat"): ResolvedOverlay =>
    ({
      frame: { cutout: { shape } },
      panelColor: [0, 0, 0],
      panel: { kind: panelKind },
    }) as unknown as ResolvedOverlay;
  const input = {
    sceneIndex: 2,
    hosts: [
      { index: 2, group: host },
      { index: 2, side: "b" as const, group: hostB },
    ],
    framePanels: [{ index: 2, group: panel, hasSceneImages: false }],
    persistent: [layer],
    camera: camera(),
    overlay: null,
    comparing: false,
    width: 1920,
    height: 1080,
  };

  it("reads side A full frame, the panel at the base pose and the persistent layers", () => {
    const roots = pageTextRoots(input);
    expect(roots.map((r) => r.root)).toEqual([host, panel, layer]);
    expect(roots[0].viewport).toEqual(FULL);
    expect(roots[2].rootVisibility).toBe(true);
  });

  it("maps a framed scene into its cutout at the cutout's aspect", () => {
    const roots = pageTextRoots({ ...input, overlay: overlay("rounded-rect") });
    const px = cutoutPixelRect(frameLayout(16 / 9, { shape: "rounded-rect" }).cutout, 1920, 1080);
    expect(roots[0].viewport).toEqual({
      x: px.x / 1920,
      y: px.y / 1080,
      w: px.width / 1920,
      h: px.height / 1080,
    });
    expect((roots[0].camera as PerspectiveCamera).aspect).toBeCloseTo(px.width / px.height, 6);
  });

  it("leaves out a scene a full panel covers, and keeps a transparent one full frame", () => {
    expect(pageTextRoots({ ...input, overlay: overlay("none") }).map((r) => r.root)).toEqual([
      panel,
      layer,
    ]);
    const transparent = pageTextRoots({ ...input, overlay: overlay("none", "transparent") });
    expect(transparent[0]).toMatchObject({ root: host, viewport: FULL });
  });

  it("stands overlays down for a comparison and only takes an image panel", () => {
    const roots = pageTextRoots({ ...input, overlay: overlay("rounded-rect"), comparing: true });
    expect(roots.map((r) => r.root)).toEqual([host, layer]);
    expect(roots[0].viewport).toEqual(FULL);
    expect(roots[1].rootVisibility).toBe(false);
  });
});
