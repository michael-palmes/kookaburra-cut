import { PerspectiveCamera, type WebGLRenderer } from "three";
import { describe, expect, it } from "vitest";
import { createRenderOnce } from "./renderOnce";

const renderer = () => ({ info: { render: { frame: 0 } } }) as Pick<WebGLRenderer, "info">;

describe("createRenderOnce", () => {
  it("is fresh for a second ask in the same render, stale once another render has run", () => {
    const gl = renderer();
    const camera = new PerspectiveCamera();
    const once = createRenderOnce();
    expect(once.fresh(gl, camera)).toBe(false);
    gl.info.render.frame += 3;
    once.made(gl, camera);
    expect(once.fresh(gl, camera)).toBe(true);
    gl.info.render.frame += 1;
    expect(once.fresh(gl, camera)).toBe(false);
  });

  it("is stale for another camera and after a reset", () => {
    const gl = renderer();
    const camera = new PerspectiveCamera();
    const once = createRenderOnce();
    once.made(gl, camera);
    expect(once.fresh(gl, new PerspectiveCamera())).toBe(false);
    expect(once.fresh(gl, camera)).toBe(true);
    once.reset();
    expect(once.fresh(gl, camera)).toBe(false);
  });
});
