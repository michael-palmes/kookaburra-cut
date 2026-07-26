import { useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import { fixtureWorldInstances } from "../../engine/fixtures";
import { HELPER_LAYER, useLightEditStore } from "../../engine/lightEditStore";
import { placementPosition } from "../../engine/orbit";
import { spotHalfAngleRad } from "../../engine/sceneLighting";
import { useUiStore } from "../../store/uiStore";
import type { FixtureSpec, LightingSpec, LightSpec } from "../../theme/tokens";

/** Preview-only light helpers (v9 · PR 5): wireframe visualisations per light and fixture, rendered ONLY while the inspector's Lighting section is open and never during export. Two independent no-leak mechanisms (the plan's belt and braces): the whole component mounts null unless the Lighting drill is open (the UI store; autoruns never open it), and every helper object sits on HELPER_LAYER, which the exporter disables on the camera per run while the preview driver enables it per frame. Helpers for camera/subject-space entries draw at the spec's world-interpreted pose (a placement hint, not the live resolved transform). */

const SELECTED = "#4da3ff";
const DIMMED = "#5a6472";

function colourFor(selected: boolean): string {
  return selected ? SELECTED : DIMMED;
}

function LightHelper({ spec, selected }: { spec: LightSpec; selected: boolean }) {
  const aim = spec.target ?? ([0, 0, 0] as [number, number, number]);
  const position = placementPosition(spec.placement, aim);
  const colour = colourFor(selected);
  const groupRef = useRef<Group>(null);
  // Layer assignment must reach every child (three layers don't inherit).
  useEffect(() => {
    groupRef.current?.traverse((obj) => obj.layers.set(HELPER_LAYER));
  });

  switch (spec.type) {
    case "directional":
      return (
        <group ref={groupRef}>
          <mesh position={position}>
            <circleGeometry args={[0.25, 20]} />
            <meshBasicMaterial color={colour} wireframe />
          </mesh>
          <Line from={position} to={aim} colour={colour} />
        </group>
      );
    case "point": {
      const radius = spec.distance && spec.distance > 0 ? Math.min(spec.distance, 4) : 0.6;
      return (
        <group ref={groupRef}>
          <mesh position={position}>
            <sphereGeometry args={[radius, 10, 6]} />
            <meshBasicMaterial color={colour} wireframe transparent opacity={0.5} />
          </mesh>
        </group>
      );
    }
    case "spot": {
      const length = spec.distance && spec.distance > 0 ? Math.min(spec.distance, 8) : 4;
      const radius = Math.tan(spotHalfAngleRad(spec.angleDeg)) * length;
      return (
        <group ref={groupRef}>
          <group position={position}>
            <mesh position={[0, -length / 2, 0]}>
              <coneGeometry args={[radius, length, 16, 1, true]} />
              <meshBasicMaterial color={colour} wireframe transparent opacity={0.5} />
            </mesh>
          </group>
          <Line from={position} to={aim} colour={colour} />
        </group>
      );
    }
    case "area":
      return (
        <group ref={groupRef}>
          <mesh position={position}>
            <planeGeometry args={[spec.width, spec.height]} />
            <meshBasicMaterial color={colour} wireframe />
          </mesh>
          <Line from={position} to={aim} colour={colour} />
        </group>
      );
    default:
      return null;
  }
}

function FixtureHelper({ spec, selected }: { spec: FixtureSpec; selected: boolean }) {
  const colour = colourFor(selected);
  const groupRef = useRef<Group>(null);
  const instances = useMemo(() => fixtureWorldInstances(spec), [spec]);
  useEffect(() => {
    groupRef.current?.traverse((obj) => obj.layers.set(HELPER_LAYER));
  });
  return (
    <group ref={groupRef}>
      {instances.map((inst, i) => (
        <mesh
          // Derived static list.
          // biome-ignore lint/suspicious/noArrayIndexKey: derived static list
          key={i}
          position={inst.position}
        >
          <boxGeometry args={[spec.size[0], spec.size[1] * 3, spec.size[1] * 3]} />
          <meshBasicMaterial
            color={colour}
            wireframe
            transparent
            // The first instance draws solid; the repeats ghost.
            opacity={i === 0 ? 0.9 : 0.3}
          />
        </mesh>
      ))}
    </group>
  );
}

function Line({
  from,
  to,
  colour,
}: {
  from: [number, number, number];
  to: [number, number, number];
  colour: string;
}) {
  const positions = useMemo(() => new Float32Array([...from, ...to]), [from, to]);
  return (
    <line>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
          count={2}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial color={colour} />
    </line>
  );
}

export function LightHelpers({ lighting }: { lighting: LightingSpec | undefined }) {
  // Mount gate one: the Lighting drill must be open (never true in an autorun or export).
  const open = useUiStore((s) => s.inspector.drillIn === "lighting");
  const selectedLightId = useLightEditStore((s) => s.selectedLightId);
  const selectedFixtureId = useLightEditStore((s) => s.selectedFixtureId);
  if (!open || !lighting) return null;
  return (
    <>
      {(lighting.lights ?? [])
        .filter((l) => l.enabled !== false)
        .map((light) => (
          <LightHelper key={light.id} spec={light} selected={light.id === selectedLightId} />
        ))}
      {(lighting.fixtures ?? [])
        .filter((f) => f.enabled !== false)
        .map((fixture) => (
          <FixtureHelper
            key={fixture.id}
            spec={fixture}
            selected={fixture.id === selectedFixtureId}
          />
        ))}
    </>
  );
}
