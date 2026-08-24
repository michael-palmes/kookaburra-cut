import type { ComputeFunction } from "@react-three/fiber";
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import type { FrameRect } from "../toolkit/frame/frameLayout";
import { stageWorldRect } from "./gizmoRegistry";
import { setStageCutout, stageCutout } from "./stageViewport";

/** Publishes the cutout the scene at the playhead renders into, and points r3f's own event raycaster at it. Editor chrome: an export never dispatches a pointer, and the compute below is the stock one, arithmetic included, whenever no cutout is live. See docs/gizmos.md. */

/** r3f's stock compute: offsets against the canvas box, which is the frame. */
const frameCompute: ComputeFunction = (event, state) => {
  state.pointer.set(
    (event.offsetX / state.size.width) * 2 - 1,
    -(event.offsetY / state.size.height) * 2 + 1,
  );
  state.raycaster.setFromCamera(state.pointer, state.camera);
};

const compute: ComputeFunction = (event, state, previous) => {
  // An unframed scene keeps the stock path exactly, offsets and all.
  const rect = stageCutout() ? stageWorldRect() : null;
  if (!rect || rect.width <= 0 || rect.height <= 0) return frameCompute(event, state, previous);
  state.pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  state.raycaster.setFromCamera(state.pointer, state.camera);
};

export function StagePointer({ cutout }: { cutout: FrameRect | null }) {
  const setEvents = useThree((state) => state.setEvents);

  useEffect(() => {
    setStageCutout(cutout);
    return () => setStageCutout(null);
  }, [cutout]);

  useEffect(() => {
    setEvents({ compute });
  }, [setEvents]);

  return null;
}
