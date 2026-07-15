import { PlaybackBar } from "@kookaburra/chrome";

const SCENES = [
  { name: "Opening", durationMs: 2400 },
  { name: "Device", durationMs: 3100 },
  { name: "Stats", durationMs: 2000 },
  { name: "Close", durationMs: 1400 },
];

export const Paused = () => (
  <PlaybackBar
    scenes={SCENES}
    activeIndex={1}
    fraction={0.34}
    readout="00:03.0 / 00:08.9"
    onNewScene={() => {}}
  />
);

export const Playing = () => (
  <PlaybackBar
    playing
    scenes={SCENES}
    activeIndex={2}
    fraction={0.71}
    readout="00:06.3 / 00:08.9"
    muted
    onNewScene={() => {}}
  />
);

export const DisabledDuringExport = () => (
  <PlaybackBar disabled scenes={SCENES} fraction={0} readout="Exporting… frame 212 / 534" />
);
