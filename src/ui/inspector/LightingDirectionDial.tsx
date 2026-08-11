import { useRef } from "react";
import { LightingIcon } from "./LightingIcon";

export function lightingDirectionFromPoint(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
): number {
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  return Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
}

const wrapDirection = (value: number): number => {
  let wrapped = value;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
};

export function LightingDirectionDial({
  value,
  cameraAzimuth = 0,
  onInput,
  onCommit,
}: {
  value: number;
  cameraAzimuth?: number;
  onInput: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(value);
  const update = (clientX: number, clientY: number, commit: boolean) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const next = lightingDirectionFromPoint(rect, clientX, clientY);
    latest.current = next;
    if (commit) onCommit(next);
    else onInput(next);
  };
  const keyboardCommit = (next: number) => {
    const wrapped = wrapDirection(next);
    latest.current = wrapped;
    onCommit(wrapped);
  };

  return (
    <div className="lighting-direction-control">
      <div
        ref={ref}
        className="lighting-direction-dial"
        role="slider"
        tabIndex={0}
        aria-label="Sun direction"
        aria-valuemin={-180}
        aria-valuemax={180}
        aria-valuenow={Math.round(value)}
        aria-valuetext={`${Math.round(value)} degrees`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          update(event.clientX, event.clientY, false);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          update(event.clientX, event.clientY, false);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          update(event.clientX, event.clientY, true);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          onCommit(latest.current);
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
            event.preventDefault();
            keyboardCommit(value - step);
          } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
            event.preventDefault();
            keyboardCommit(value + step);
          } else if (event.key === "Home") {
            event.preventDefault();
            keyboardCommit(-180);
          } else if (event.key === "End") {
            event.preventDefault();
            keyboardCommit(180);
          }
        }}
      >
        <span className="lighting-direction-subject" aria-hidden="true" />
        <span
          className="lighting-direction-camera"
          style={{ transform: `rotate(${cameraAzimuth}deg) translateY(-34px)` }}
          aria-hidden="true"
        >
          <LightingIcon name="direction" size={12} />
        </span>
        <span
          className="lighting-direction-sun"
          style={{ transform: `rotate(${value}deg) translateY(-37px)` }}
          aria-hidden="true"
        >
          <LightingIcon name="sun" size={14} />
        </span>
      </div>
      <span className="lighting-direction-value">{Math.round(value)}°</span>
    </div>
  );
}
