import { Device, ScreenRegion, useSceneDevices } from "@kookaburra/toolkit";

/** The macro's handset with its "This week, sorted" card lifted off the glass. */
export function CardDevice({ offset = [0.05, -0.3] }: { offset?: [number, number] }) {
  const [hero] = useSceneDevices();
  if (!hero) return null;
  return (
    <Device {...hero}>
      <ScreenRegion rect={[0.04, 0.172, 0.96, 0.4]} at={600} scale={1.12} offset={offset} />
    </Device>
  );
}
