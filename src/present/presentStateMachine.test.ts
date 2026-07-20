import { describe, expect, it } from "vitest";
import { type DeckState, initialDeckState, stepDeck } from "./presentStateMachine";

const at = (sceneIndex: number, phase: DeckState["phase"]): DeckState => ({ sceneIndex, phase });

describe("stepDeck", () => {
  it("starts entering the first scene", () => {
    expect(initialDeckState()).toEqual(at(0, "entering"));
  });

  it("settles from entering into holding, and only from entering", () => {
    expect(stepDeck(at(1, "entering"), { type: "settled" }, 3)).toEqual(at(1, "holding"));
    expect(stepDeck(at(1, "holding"), { type: "settled" }, 3)).toEqual(at(1, "holding"));
    expect(stepDeck(at(1, "leaving"), { type: "settled" }, 3)).toEqual(at(1, "leaving"));
  });

  it("advances from holding into leaving", () => {
    expect(stepDeck(at(0, "holding"), { type: "advance" }, 3)).toEqual(at(0, "leaving"));
  });

  it("advancing mid-entrance skips ahead to leaving", () => {
    expect(stepDeck(at(0, "entering"), { type: "advance" }, 3)).toEqual(at(0, "leaving"));
  });

  it("ignores advance while already leaving or ended", () => {
    expect(stepDeck(at(0, "leaving"), { type: "advance" }, 3)).toEqual(at(0, "leaving"));
    expect(stepDeck(at(2, "end"), { type: "advance" }, 3)).toEqual(at(2, "end"));
  });

  it("lands the leave on the next scene's entrance", () => {
    expect(stepDeck(at(0, "leaving"), { type: "left" }, 3)).toEqual(at(1, "entering"));
  });

  it("lands the last scene's leave on the end card", () => {
    expect(stepDeck(at(2, "leaving"), { type: "left" }, 3)).toEqual(at(2, "end"));
  });

  it("back snaps straight to the previous scene's hold", () => {
    expect(stepDeck(at(2, "holding"), { type: "back" }, 3)).toEqual(at(1, "holding"));
    expect(stepDeck(at(2, "entering"), { type: "back" }, 3)).toEqual(at(1, "holding"));
  });

  it("back is a no-op on the first scene and while leaving", () => {
    expect(stepDeck(at(0, "holding"), { type: "back" }, 3)).toEqual(at(0, "holding"));
    expect(stepDeck(at(1, "leaving"), { type: "back" }, 3)).toEqual(at(1, "leaving"));
  });

  it("back recovers from the end card to the last scene's hold", () => {
    expect(stepDeck(at(2, "end"), { type: "back" }, 3)).toEqual(at(2, "holding"));
  });

  it("is inert with no scenes", () => {
    expect(stepDeck(at(0, "entering"), { type: "advance" }, 0)).toEqual(at(0, "entering"));
  });
});
