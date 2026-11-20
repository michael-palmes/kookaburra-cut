import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useClockStore } from "./clock";
import { SceneHost } from "./SceneHost";
import { SceneContext, type SceneTimeContext } from "./sceneContext";
import { useSceneDuration } from "./timeline";

function Probe({ onRead }: { onRead: (ms: number) => void }) {
  onRead(useSceneDuration());
  return null;
}

function read(scene: SceneTimeContext | null): number {
  let ms = Number.NaN;
  renderToStaticMarkup(
    <SceneContext.Provider value={scene}>
      <Probe
        onRead={(v) => {
          ms = v;
        }}
      />
    </SceneContext.Provider>,
  );
  return ms;
}

describe("useSceneDuration", () => {
  it("reads the host's slot length, not the TSX default", () => {
    expect(read({ index: 4, startMs: 22483, durationMs: 1875 })).toBe(1875);
  });

  it("stays on the scene's length while Present stretches the live window", () => {
    expect(read({ index: 4, startMs: 0, durationMs: 1875 + 86_400_000, lengthMs: 1875 })).toBe(
      1875,
    );
  });

  it("reads the length a host forwards beside its stretched window", () => {
    let ms = Number.NaN;
    renderToStaticMarkup(
      <SceneHost index={4} id="scenes/a.tsx" startMs={0} durationMs={86_401_875} lengthMs={1875}>
        <Probe
          onRead={(v) => {
            ms = v;
          }}
        />
      </SceneHost>,
    );
    expect(ms).toBe(1875);
  });

  it("falls back to the project's length outside a scene", () => {
    // Server rendering reads the store's initial state.
    expect(read(null)).toBe(useClockStore.getInitialState().durationMs);
  });
});
