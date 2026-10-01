import { AnimatedHeadline } from "@kookaburra/toolkit";
import { Component, type ReactNode, Suspense, useLayoutEffect, useMemo } from "react";
import { CanvasTexture, DoubleSide, Shape, ShapeGeometry, SRGBColorSpace } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { useClockStore } from "../../../src/engine/clock";
import { computeFormat, FORMATS } from "../../../src/engine/format";
import { FormatContext, SceneContext, SceneThemeContext } from "../../../src/engine/sceneContext";
import type { Theme, ThemeBackground } from "../../../src/theme/tokens";
import { FixedBackdrop } from "../../../src/toolkit/stage/FixedBackdrop";
import { SceneStage } from "../../../src/toolkit/stage/SceneStage";

export type Scene3dSpec = Extract<ThemeBackground, { type: "scene3d" }>;

/** Everything one committed lab state renders; `key` changes per preset, aspect and time. */
export interface LabFrame {
  key: string;
  aspect: "16:9" | "9:16";
  tMs: number;
  spec: Scene3dSpec;
  textColor: string;
  headline: string;
  content: boolean;
  theme: Theme;
}

class ErrorBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Fires once the committed tree carries this frame's key and clock time. */
function CommitSignal({
  frameKey,
  tMs,
  onCommit,
}: {
  frameKey: string;
  tMs: number;
  onCommit: (key: string) => void;
}) {
  const currentMs = useClockStore((s) => s.currentMs);
  useLayoutEffect(() => {
    if (currentMs === tMs) onCommit(frameKey);
  });
  return null;
}

// iPhone 17 Pro at the Device auto-fit (2.6 high, 1.25 wide, 0.184 deep, 0.204 corner).
const PHONE = { width: 1.25, height: 2.6, depth: 0.184, radius: 0.204 };

function roundedRect(width: number, height: number, radius: number): ShapeGeometry {
  const x = -width / 2;
  const y = -height / 2;
  const s = new Shape();
  s.moveTo(x + radius, y);
  s.lineTo(x + width - radius, y);
  s.quadraticCurveTo(x + width, y, x + width, y + radius);
  s.lineTo(x + width, y + height - radius);
  s.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  s.lineTo(x + radius, y + height);
  s.quadraticCurveTo(x, y + height, x, y + height - radius);
  s.lineTo(x, y + radius);
  s.quadraticCurveTo(x, y, x + radius, y);
  const geometry = new ShapeGeometry(s, 12);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) - x) / width, (uv.getY(i) - y) / height);
  }
  return geometry;
}

function screenTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 552;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#eef1f5";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#2f5fc4";
  g.fillRect(0, 0, c.width, 120);
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.fillRect(20, 64, 140, 18);
  for (let i = 0; i < 5; i++) {
    g.fillStyle = i % 2 ? "#dfe4ea" : "#ffffff";
    g.fillRect(16, 140 + i * 74, c.width - 32, 62);
    g.fillStyle = "#9aa6b4";
    g.fillRect(28, 156 + i * 74, 120, 10);
    g.fillRect(28, 176 + i * 74, 80, 8);
  }
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** A silver-rimmed handset with a light app screen: unlit, so it reads the same with or without stage lighting. */
function StandInHandset() {
  const parts = useMemo(() => {
    const body = new RoundedBoxGeometry(
      PHONE.width,
      PHONE.height,
      PHONE.depth,
      4,
      PHONE.radius / 2,
    );
    const glass = roundedRect(PHONE.width - 0.04, PHONE.height - 0.04, PHONE.radius - 0.02);
    const screen = roundedRect(PHONE.width - 0.12, PHONE.height - 0.12, PHONE.radius - 0.06);
    return { body, glass, screen, texture: screenTexture() };
  }, []);
  useLayoutEffect(
    () => () => {
      parts.body.dispose();
      parts.glass.dispose();
      parts.screen.dispose();
      parts.texture.dispose();
    },
    [parts],
  );
  const z = PHONE.depth / 2;
  return (
    <group position={[0, -0.35, 0]}>
      <mesh geometry={parts.body}>
        <meshBasicMaterial color="#b9bdc4" toneMapped={false} />
      </mesh>
      <mesh geometry={parts.glass} position={[0, 0, z + 0.001]}>
        <meshBasicMaterial color="#08090b" toneMapped={false} />
      </mesh>
      <mesh geometry={parts.screen} position={[0, 0, z + 0.002]}>
        <meshBasicMaterial map={parts.texture} toneMapped={false} side={DoubleSide} />
      </mesh>
    </group>
  );
}

/** The atlas scenes' content: the headline above a handset at the stage centre. */
function StandInContent({ frame }: { frame: LabFrame }) {
  const portrait = frame.aspect === "9:16";
  return (
    <SceneContext.Provider value={{ index: 0, startMs: frame.tMs - 10_000, durationMs: 20_000 }}>
      <AnimatedHeadline
        text={frame.headline}
        from={200}
        to={1100}
        color={frame.textColor}
        position={[0, portrait ? 1.9 : 1.7, 0]}
        fontSize={portrait ? 0.23 : 0.4}
        maxWidth={portrait ? 2 : 9}
      />
      <StandInHandset />
    </SceneContext.Provider>
  );
}

/** One lab state under the real providers the scene host gives a scene: the canvas clear colour, theme, export format and scene clock context, then the fixed backdrop (backing plus look) as SceneBackground mounts it. */
export function LabScene({
  frame,
  onCommit,
  onError,
}: {
  frame: LabFrame;
  onCommit: (key: string) => void;
  onError: (error: unknown) => void;
}) {
  const format = useMemo(() => computeFormat(FORMATS[frame.aspect]), [frame.aspect]);
  return (
    <SceneThemeContext.Provider value={frame.theme}>
      <color attach="background" args={[frame.theme.colors.background]} />
      <FormatContext.Provider value={format}>
        <SceneContext.Provider value={{ index: 0, startMs: 0, durationMs: frame.tMs + 1 }}>
          <Suspense fallback={null}>
            <ErrorBoundary key={`look:${frame.key}`} onError={onError}>
              <FixedBackdrop spec={frame.spec} />
            </ErrorBoundary>
            {frame.content && (
              <ErrorBoundary key={`content:${frame.key}`} onError={onError}>
                <SceneStage>
                  <StandInContent frame={frame} />
                </SceneStage>
              </ErrorBoundary>
            )}
            <CommitSignal frameKey={frame.key} tMs={frame.tMs} onCommit={onCommit} />
          </Suspense>
        </SceneContext.Provider>
      </FormatContext.Provider>
    </SceneThemeContext.Provider>
  );
}
