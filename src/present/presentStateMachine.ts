/** Pure phase machine for the present slideshow deck. The driver owns clocks and effects (anchor re-basing, hold latching, seeks); this module only decides which phase follows each event, so every transition unit-tests in isolation. */

export type PresentPhase = "entering" | "holding" | "leaving" | "end";

export interface DeckState {
  sceneIndex: number;
  phase: PresentPhase;
}

export type DeckEvent =
  /** The driver saw the scene's local time reach its hold point. */
  | { type: "settled" }
  /** Space, right arrow or click. */
  | { type: "advance" }
  /** Left arrow. */
  | { type: "back" }
  /** The leave finished: the transition landed, or the end fade completed. */
  | { type: "left" };

export const initialDeckState = (): DeckState => ({ sceneIndex: 0, phase: "entering" });

/** Steps the deck. Advance during "end" is the close signal and is handled by the app shell, not here; back from "end" recovers to the last scene's hold. */
export function stepDeck(state: DeckState, event: DeckEvent, sceneCount: number): DeckState {
  if (sceneCount <= 0) return state;
  switch (event.type) {
    case "settled":
      return state.phase === "entering" ? { ...state, phase: "holding" } : state;
    case "advance":
      if (state.phase === "entering" || state.phase === "holding") {
        return { ...state, phase: "leaving" };
      }
      return state;
    case "back":
      if (state.phase === "leaving") return state;
      if (state.phase === "end") return { ...state, phase: "holding" };
      if (state.sceneIndex === 0) return state;
      return { sceneIndex: state.sceneIndex - 1, phase: "holding" };
    case "left": {
      if (state.phase !== "leaving") return state;
      if (state.sceneIndex >= sceneCount - 1) return { ...state, phase: "end" };
      return { sceneIndex: state.sceneIndex + 1, phase: "entering" };
    }
  }
}
