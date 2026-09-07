import { type ReactNode, useEffect, useId, useRef } from "react";
import type { Group } from "three";
import { registerPersistentLayer, unregisterPersistentLayer } from "./persistentLayerRegistry";

/** Hosts a project's persistent (hoisted) object, the shared-element morph mechanism. Mounted once in App.tsx as a sibling of the `<SceneHost>` map, outside every scene group and deliberately without a `SceneContext`, so descendants read `useTimeline()` as GLOBAL time and tween continuously across scene seams. Like `SceneHost`, it never gates its own `visible`; the compositor hides persistent layers during A/B transition renders and draws them once over the composite (or they'd ghost). See engine/compositor.ts. */
export function PersistentLayer({ children }: { children: ReactNode }) {
  const key = useId();
  const groupRef = useRef<Group>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    registerPersistentLayer(key, group);
    return () => unregisterPersistentLayer(key);
  }, [key]);

  return <group ref={groupRef}>{children}</group>;
}
