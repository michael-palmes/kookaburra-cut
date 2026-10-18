/** Text-derived state that has not settled yet: a primitive whose layout or timing waits on measured text (a face still parsing for `useTextMetrics`, a pinned headline reveal still waiting on its unit count) reports here from a layout effect, and `awaitTextSync` keeps settling typesets until nothing is outstanding, so no frame captures the pre-measure layout. Pure module. */

let outstanding = 0;

/** Reports one pending item; the returned clear is idempotent. */
export function reportTextDerivedPending(): () => void {
  outstanding++;
  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    outstanding--;
  };
}

export function textDerivedPendingCount(): number {
  return outstanding;
}
