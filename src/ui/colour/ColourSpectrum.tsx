import { useRef } from "react";
import { type Hsv, hsvToHex } from "./colourUtils";

/** The picker's free-form colour surface: a saturation/brightness square over a hue rail, both pointer- and keyboard-driven. The host owns the HSV so hue survives the achromatic corners, where the hex alone cannot carry it. */

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function saturationValueFromPoint(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
): { s: number; v: number } {
  return {
    s: clamp01((clientX - rect.left) / rect.width),
    v: clamp01(1 - (clientY - rect.top) / rect.height),
  };
}

/** Capped just under 360 so a drag to the right edge never reads back as a full wrap. */
export function hueFromPoint(rect: Pick<DOMRect, "left" | "width">, clientX: number): number {
  return Math.min(359.999, clamp01((clientX - rect.left) / rect.width) * 360);
}

export interface ColourSpectrumProps {
  /** The picker's live HSV; the host owns it so hue survives the achromatic corners. */
  hsv: Hsv;
  /** Continuous: every drag sample and every arrow key. */
  onChange: (hsv: Hsv) => void;
}

export function ColourSpectrum({ hsv, onChange }: ColourSpectrumProps) {
  const squareRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const updateSquare = (clientX: number, clientY: number) => {
    const rect = squareRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { s, v } = saturationValueFromPoint(rect, clientX, clientY);
    onChange({ h: hsv.h, s, v });
  };
  const updateHue = (clientX: number) => {
    const rect = hueRef.current?.getBoundingClientRect();
    if (!rect) return;
    onChange({ ...hsv, h: hueFromPoint(rect, clientX) });
  };

  return (
    <div className="colour-spectrum">
      <div
        ref={squareRef}
        className="colour-spectrum-square"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.v * 100)}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateSquare(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          updateSquare(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          updateSquare(event.clientX, event.clientY);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onKeyDown={(event) => {
          const step = (event.shiftKey ? 10 : 1) / 100;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onChange({ ...hsv, s: clamp01(hsv.s - step) });
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            onChange({ ...hsv, s: clamp01(hsv.s + step) });
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            onChange({ ...hsv, v: clamp01(hsv.v + step) });
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onChange({ ...hsv, v: clamp01(hsv.v - step) });
          } else if (event.key === "Home") {
            event.preventDefault();
            onChange({ ...hsv, s: 0 });
          } else if (event.key === "End") {
            event.preventDefault();
            onChange({ ...hsv, s: 1 });
          } else if (event.key === "PageUp") {
            event.preventDefault();
            onChange({ ...hsv, v: 1 });
          } else if (event.key === "PageDown") {
            event.preventDefault();
            onChange({ ...hsv, v: 0 });
          }
        }}
      >
        <span
          className="colour-spectrum-thumb"
          aria-hidden="true"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: hsvToHex(hsv),
          }}
        />
      </div>
      <div
        ref={hueRef}
        className="colour-spectrum-hue"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`${Math.round(hsv.h)} degrees`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateHue(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          updateHue(event.clientX);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          updateHue(event.clientX);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            onChange({ ...hsv, h: Math.max(0, hsv.h - step) });
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            onChange({ ...hsv, h: Math.min(359, hsv.h + step) });
          } else if (event.key === "Home") {
            event.preventDefault();
            onChange({ ...hsv, h: 0 });
          } else if (event.key === "End") {
            event.preventDefault();
            onChange({ ...hsv, h: 359 });
          }
        }}
      >
        <span
          className="colour-spectrum-hue-thumb"
          aria-hidden="true"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            background: hsvToHex({ h: hsv.h, s: 1, v: 1 }),
          }}
        />
      </div>
    </div>
  );
}
