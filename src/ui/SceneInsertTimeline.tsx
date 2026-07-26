import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fsUrl } from "../engine/media";
import {
  edgeScrollVelocity,
  elasticX,
  gapCentres,
  gapFromPlacement,
  nearestGap,
  placementFromGap,
  type StripLayout,
} from "./insertMath";
import type { WizardSceneInfo } from "./SceneWizards";

/** Reusable insert-position strip: fixed-width scene cards with a draggable indicator that rubber-bands between the gaps (insertMath owns the geometry); encodes "start" | "end" | "after:<index>" so call sites swap without data changes. */
export function SceneInsertTimeline({
  scenes,
  thumbs,
  value,
  onChange,
}: {
  scenes: WizardSceneInfo[];
  /** Thumb paths by scene stem; missing entries render placeholder frames. */
  thumbs: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<StripLayout | null>(null);
  const [dragX, setDragX] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; clientX: number; raf: number } | null>(null);

  const count = scenes.length;
  const centres = useMemo(() => (layout ? gapCentres(layout) : []), [layout]);
  const halfSpan = layout ? (layout.cardWidth + layout.gapWidth) / 2 : 0;
  const gap = gapFromPlacement(value, count);

  // Cards flex-shrink to a floor before the strip scrolls, so geometry is measured, not assumed.
  const measure = useCallback(() => {
    const cards = cardsRef.current?.querySelectorAll<HTMLElement>(".insert-card");
    if (!cards || cards.length === 0) {
      setLayout(null);
      return;
    }
    const first = cards[0];
    const cardWidth = first.offsetWidth;
    const gapWidth =
      cards.length > 1 ? cards[1].offsetLeft - first.offsetLeft - cardWidth : first.offsetLeft;
    // Identity-stable when nothing moved, so resize ticks can't re-trigger the reveal scroll.
    setLayout((prev) =>
      prev &&
      prev.count === cards.length &&
      prev.cardWidth === cardWidth &&
      prev.gapWidth === gapWidth &&
      prev.padStart === first.offsetLeft
        ? prev
        : { count: cards.length, cardWidth, gapWidth, padStart: first.offsetLeft },
    );
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: count re-measures when the card set changes
  useLayoutEffect(measure, [measure, count]);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [measure]);

  // Keep the committed gap in view (seeded values can sit deep in a long strip); the first reveal positions instantly, later ones glide.
  const revealed = useRef(false);
  useEffect(() => {
    const scroller = scrollerRef.current;
    const x = centres[gap];
    if (dragX !== null || !scroller || x === undefined) return;
    const behavior = revealed.current ? "smooth" : "auto";
    revealed.current = true;
    const margin = 40;
    if (x < scroller.scrollLeft + margin) {
      scroller.scrollTo({ left: Math.max(0, x - margin), behavior });
    } else if (x > scroller.scrollLeft + scroller.clientWidth - margin) {
      scroller.scrollTo({ left: x - scroller.clientWidth + margin, behavior });
    }
  }, [gap, centres, dragX]);

  useEffect(
    () => () => {
      if (drag.current) cancelAnimationFrame(drag.current.raf);
    },
    [],
  );

  const contentX = useCallback(
    (clientX: number): number => {
      const scroller = scrollerRef.current;
      if (!scroller || centres.length === 0) return 0;
      const rect = scroller.getBoundingClientRect();
      const raw = clientX - rect.left + scroller.scrollLeft;
      return Math.min(centres[centres.length - 1], Math.max(centres[0], raw));
    },
    [centres],
  );

  const endDrag = (e: React.PointerEvent, commit: boolean) => {
    const state = drag.current;
    if (!state || state.pointerId !== e.pointerId) return;
    cancelAnimationFrame(state.raf);
    drag.current = null;
    setDragX(null);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    if (commit) onChange(placementFromGap(nearestGap(contentX(e.clientX), centres), count));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !layout || centres.length === 0) return;
    e.preventDefault();
    // preventDefault suppresses the browser's click-to-focus, so hand the slider focus for the click-then-nudge keyboard flow.
    scrollerRef.current?.focus({ preventScroll: true });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const state = { pointerId: e.pointerId, clientX: e.clientX, raf: 0 };
    drag.current = state;
    setDragX(contentX(e.clientX));
    // Holding near an edge keeps scrolling even with the pointer still, so the loop, not pointermove, owns the scroll.
    const step = () => {
      const scroller = scrollerRef.current;
      if (!scroller || drag.current !== state) return;
      const rect = scroller.getBoundingClientRect();
      const v = edgeScrollVelocity(state.clientX, rect.left, rect.right);
      if (v !== 0 && scroller.scrollWidth > scroller.clientWidth) {
        scroller.scrollLeft += v;
        setDragX(contentX(state.clientX));
      }
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const state = drag.current;
    if (!state || state.pointerId !== e.pointerId) return;
    state.clientX = e.clientX;
    setDragX(contentX(e.clientX));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const next =
      e.key === "ArrowLeft"
        ? Math.max(0, gap - 1)
        : e.key === "ArrowRight"
          ? Math.min(count, gap + 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? count
              : null;
    if (next === null) return;
    e.preventDefault();
    if (next !== gap) onChange(placementFromGap(next, count));
  };

  const activeGap = dragX !== null && centres.length > 0 ? nearestGap(dragX, centres) : gap;
  const indicatorX =
    dragX !== null && centres.length > 0
      ? elasticX(dragX, centres[activeGap], halfSpan)
      : centres[gap];
  const sceneLabel = (s: WizardSceneInfo) => s.name ?? s.id;
  const valueText =
    activeGap >= count
      ? "At the end"
      : activeGap === 0
        ? "At the start"
        : `After ${sceneLabel(scenes[activeGap - 1])}`;

  return (
    <div className="insert-timeline">
      <div
        ref={scrollerRef}
        className={`insert-strip${dragX !== null ? " dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label="Insert position"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={count}
        aria-valuenow={activeGap}
        aria-valuetext={valueText}
        onKeyDown={onKeyDown}
      >
        <div
          ref={cardsRef}
          className="insert-cards"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, true)}
          onPointerCancel={(e) => endDrag(e, false)}
        >
          {scenes.map((s) => (
            <div key={s.stem} className="insert-card">
              <span className="insert-card-thumb">
                {thumbs[s.stem] ? (
                  <img src={fsUrl(thumbs[s.stem])} alt="" draggable={false} />
                ) : (
                  <span aria-hidden>·</span>
                )}
              </span>
              <span className="insert-card-name" title={sceneLabel(s)}>
                {sceneLabel(s)}
              </span>
            </div>
          ))}
          {indicatorX !== undefined && (
            <div
              className={`insert-indicator${dragX !== null ? " dragging" : ""}`}
              style={{ left: `${indicatorX}px` }}
            >
              <span className="insert-handle" />
            </div>
          )}
        </div>
      </div>
      <p className="insert-caption">{valueText}</p>
    </div>
  );
}
