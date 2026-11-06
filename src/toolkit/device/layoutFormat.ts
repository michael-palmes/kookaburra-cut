import { useRef } from "react";
import { useFormat } from "../../engine/format";
import type { FormatInfo } from "../types";

/** `useFormat()` held steady while the frame and safe area stay put, for memos that lay devices out: the plain hook rebuilds its object every render. */
export function useLayoutFormat(): FormatInfo {
  const format = useFormat();
  const held = useRef(format);
  const { frame, safe } = held.current;
  if (
    frame.width !== format.frame.width ||
    frame.height !== format.frame.height ||
    safe.left !== format.safe.left ||
    safe.right !== format.safe.right ||
    safe.top !== format.safe.top ||
    safe.bottom !== format.safe.bottom
  ) {
    held.current = format;
  }
  return held.current;
}
