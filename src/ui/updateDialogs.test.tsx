import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WelcomeDialog } from "./updateDialogs";

const escapeLayer = vi.hoisted(() => ({ close: null as null | (() => void) }));
vi.mock("./useEscapeClose", () => ({
  useEscapeClose: (onClose: () => void) => {
    escapeLayer.close = onClose;
  },
}));

describe("WelcomeDialog", () => {
  it("recommends the update check with its switch on", () => {
    const html = renderToStaticMarkup(<WelcomeDialog onAnswer={() => undefined} />);
    expect(html).toContain("Recommended");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('checked=""');
    expect(html).toContain("What leaves your Mac");
  });

  it("saves off when Escape dismisses it, even with the switch on", () => {
    const onAnswer = vi.fn();
    renderToStaticMarkup(<WelcomeDialog onAnswer={onAnswer} />);
    escapeLayer.close?.();
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(false);
  });
});
