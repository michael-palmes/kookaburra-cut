import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { FOLD_BLUR_LEAD, FOLD_BLUR_TAPS, FOLD_STATIC_GUARD } from "../../engine/foldTransition";
import {
  applyFoldScreenShader,
  bindFoldScreenHome,
  FOLD_SCREEN_GLSL,
  measureFoldHome,
  setFoldScreenCrop,
  setFoldScreenState,
} from "./foldScreenShader";

describe("the fold display shader", () => {
  it("samples the media untouched whenever the handover is idle", () => {
    const [idle, ...active] = FOLD_SCREEN_GLSL.fragment.split("} else {");
    expect(idle).toContain("uFoldBlur <= 0.0 && uFoldDarken <= 0.0 && uFoldFlat <= 0.0");
    expect(idle).toContain("sampledDiffuseColor = texture2D( map, vMapUv );");
    // Every other tap sits in per-fragment control flow, so none may lean on implicit derivatives.
    expect(active.join("")).not.toContain("texture2D(");
  });

  it("bakes the engine's contract constants, never its own copies", () => {
    expect(FOLD_SCREEN_GLSL.fragment).toContain(`i < ${FOLD_BLUR_TAPS};`);
    expect(FOLD_SCREEN_GLSL.fragment).toContain(
      `smoothstep( 0.0, ${FOLD_STATIC_GUARD.toFixed(4)},`,
    );
    expect(FOLD_SCREEN_GLSL.fragment).toContain(`foldSoft * ${FOLD_BLUR_LEAD.toFixed(4)} )`);
    expect(FOLD_SCREEN_GLSL.fragment).toContain("foldCoord - uFoldSoftFront");
    expect(FOLD_SCREEN_GLSL.pars).not.toMatch(/fract\s*\(\s*sin/);
  });

  it("patches the stock chunks under one stable program key", () => {
    const material = new MeshBasicMaterial();
    applyFoldScreenShader(material, 1.42);
    expect(material.customProgramCacheKey()).toBe("kookaburra-fold-screen-v1");
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: "#include <common>\nvoid main() {\n#include <project_vertex>\n}",
      fragmentShader: "#include <map_pars_fragment>\nvoid main() {\n#include <map_fragment>\n}",
    };
    material.onBeforeCompile(shader as never, undefined as never);
    expect(shader.fragmentShader).toContain("foldHash");
    expect(shader.fragmentShader).not.toContain("#include <map_fragment>");
    // The root-frame position is taken after skinning, so a bent display projects from its real surface.
    expect(shader.vertexShader).toMatch(/#include <project_vertex>\s+vFoldRootPos =/);
    expect(shader.uniforms.uFoldAspect.value).toBe(1.42);
  });

  it("writes the crop and the frame's state, and is inert on any other material", () => {
    const material = new MeshBasicMaterial();
    applyFoldScreenShader(material, 0.69);
    setFoldScreenCrop(material, { u0: 0.1, v0: 1, u1: 0.9, v1: 0 });
    setFoldScreenState(
      material,
      {
        level: 1,
        front: 0.4,
        softFront: 0.1,
        ramp: 0.65,
        offset: 1,
        scale: -2,
        blur: 0.04,
        darken: 1,
        flat: 0.5,
      },
      new Vector3(0.1, 0.2, 0.3),
    );
    const uniforms = material.userData.foldScreen;
    expect(uniforms.uFoldCrop.value.toArray()).toEqual([0.1, 1, 0.9, 0]);
    expect(uniforms.uFoldAxis.value.toArray()).toEqual([1, -2]);
    expect(uniforms.uFoldRamp.value).toBe(0.65);
    expect(uniforms.uFoldFront.value).toBe(0.4);
    expect(uniforms.uFoldBlur.value).toBe(0.04);
    expect(uniforms.uFoldFlat.value).toBe(0.5);
    expect(uniforms.uFoldEye.value.toArray()).toEqual([0.1, 0.2, 0.3]);

    const plain = new MeshBasicMaterial();
    setFoldScreenCrop(plain, { u0: 0, v0: 0, u1: 1, v1: 1 });
    setFoldScreenState(
      plain,
      {
        level: 1,
        front: 0,
        softFront: 0,
        ramp: 1,
        offset: 0,
        scale: 0,
        blur: 1,
        darken: 1,
        flat: 1,
      },
      new Vector3(),
    );
    expect(plain.userData.foldScreen).toBeUndefined();
  });

  it("measures a display's home rect from its UVs, flipped axes included", () => {
    // A 4 x 2 panel at z = 0.5, offset in its parent, with glTF-style UVs: u left to right, v = 0 at the top.
    const root = new Group();
    root.position.set(10, 20, 30);
    const mesh = new Mesh(new BoxGeometry(4, 2, 0), new MeshBasicMaterial());
    mesh.position.set(1, 3, 0.5);
    root.add(mesh);
    const position = mesh.geometry.getAttribute("position");
    const uv = mesh.geometry.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (position.getX(i) + 2) / 4, 1 - (position.getY(i) + 1) / 2);
    }
    const home = measureFoldHome(root, [mesh]);
    // In the ROOT's frame, so the root's own placement drops out.
    expect(home.z).toBeCloseTo(0.5, 9);
    expect(home.rect.toArray().map((n) => Math.round(n * 1e6) / 1e6)).toEqual([-1, 4, 4, -2]);

    const material = new MeshBasicMaterial();
    applyFoldScreenShader(material, 2);
    bindFoldScreenHome(root, [mesh], material, home);
    root.updateMatrixWorld(true);
    mesh.onBeforeRender(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const probe = new Vector3(10, 20, 30).applyMatrix4(
      material.userData.foldScreen.uFoldRootInv.value,
    );
    expect(probe.toArray().map((n) => Math.round(n * 1e6) / 1e6)).toEqual([0, 0, 0]);
  });
});
