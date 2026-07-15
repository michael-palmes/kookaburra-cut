import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/** Timeline dock: the bottom panel holding the animation lane above the playback bar, plus, while animation mode is open, the connector: an SVG bracket dropping from the lane's track edges to a rail and stemming into the active scene's cell ("this animation belongs to that scene"); geometry is measured live and recomputed on active-scene change, the lane's collapse `transitionend`, and any dock resize. */
export function TimelineDock({
  lane,
  connectorActive = false,
  activeIndex = 0,
  children,
}: {
  lane?: ReactNode;
  /** Animation mode is open; draw the lane→cell connector. */
  connectorActive?: boolean;
  /** The active scene index (recompute trigger; geometry is queried live). */
  activeIndex?: number;
  children: ReactNode;
}) {
  const dockRef = useRef<HTMLElement>(null);
  const [path, setPath] = useState<string | null>(null);

  const recompute = useCallback(() => {
    const dock = dockRef.current;
    if (!connectorActive || !dock) {
      setPath(null);
      return;
    }
    const track = dock.querySelector(".anim-track");
    const cell = dock.querySelector(".pb-cell.active");
    if (!track || !cell) {
      setPath(null);
      return;
    }
    const d = dock.getBoundingClientRect();
    const a = track.getBoundingClientRect();
    const b = cell.getBoundingClientRect();
    if (a.height === 0 || b.height === 0) {
      setPath(null);
      return;
    }
    // Bracket: both lane-track edges drop to a rail midway across the gap; the rail runs to above the active cell and stems into its top edge.
    const lx = a.left - d.left;
    const rx = a.right - d.left;
    const ab = a.bottom - d.top + 2;
    const railY = (a.bottom + b.top) / 2 - d.top;
    const cx = Math.min(Math.max(b.left + b.width / 2, b.left + 6), b.right - 6) - d.left;
    const ct = b.top - d.top - 1;
    setPath(
      `M ${lx} ${ab} L ${lx} ${railY} L ${cx} ${railY} L ${cx} ${ct} M ${rx} ${ab} L ${rx} ${railY} L ${cx} ${railY}`,
    );
  }, [connectorActive]);

  // Active scene / mode changes recompute directly; the lane's max-height collapse settles via transitionend (bubbling from .anim-lane); sizes via ResizeObserver.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeIndex is a recompute trigger
  useEffect(recompute, [recompute, activeIndex]);
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const onTransitionEnd = () => recompute();
    dock.addEventListener("transitionend", onTransitionEnd);
    const ro = new ResizeObserver(() => recompute());
    ro.observe(dock);
    return () => {
      dock.removeEventListener("transitionend", onTransitionEnd);
      ro.disconnect();
    };
  }, [recompute]);

  return (
    <footer className="timeline-dock" ref={dockRef}>
      {lane}
      {children}
      {path && (
        <svg className="dock-connector" aria-hidden="true">
          <path d={path} />
        </svg>
      )}
    </footer>
  );
}
