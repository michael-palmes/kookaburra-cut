export const FPS = 30;
export const MAX_VIDEO_BYTES = 1_500_000;

// CSS size x scale = the device catalogue's screen pixels (src/toolkit/device/catalog.ts).
export const DEVICES = {
  phone: { width: 402, height: 874, scale: 3 },
  tablet: { width: 1376, height: 1032, scale: 2 },
  laptop: { width: 1728, height: 1117, scale: 2 },
  window: { width: 1280, height: 800, scale: 2 },
  icon: { width: 512, height: 512, scale: 2, transparent: true },
};

export const JOBS = [
  { out: "fairywren-icon.png", page: "fairywren/icon.html", device: "icon" },
  {
    out: "fairywren-today-phone.jpg",
    page: "fairywren/phone.html?scene=plan",
    device: "phone",
    at: 3.1,
  },
  {
    out: "fairywren-today-dark-phone.jpg",
    page: "fairywren/phone.html?scene=plan&mode=dark",
    device: "phone",
    at: 3.1,
  },
  {
    out: "fairywren-focus-phone.jpg",
    page: "fairywren/phone.html?scene=focus",
    device: "phone",
    at: 5,
  },
  { out: "fairywren-then-phone.jpg", page: "fairywren/phone.html?scene=then", device: "phone" },
  { out: "fairywren-week-tablet.jpg", page: "fairywren/desk.html?form=tablet", device: "tablet" },
  { out: "fairywren-week-laptop.jpg", page: "fairywren/desk.html?form=laptop", device: "laptop" },
  { out: "fairywren-share-window.jpg", page: "fairywren/window.html?still=1", device: "window" },
  {
    out: "fairywren-plan-phone.mp4",
    page: "fairywren/phone.html?scene=plan",
    device: "phone",
    seconds: 5,
  },
  {
    out: "fairywren-focus-phone.mp4",
    page: "fairywren/phone.html?scene=focus",
    device: "phone",
    seconds: 5,
  },
  {
    out: "fairywren-share-window.mp4",
    page: "fairywren/window.html",
    device: "window",
    seconds: 5.5,
  },

  { out: "thornbill-icon.png", page: "thornbill/icon.html", device: "icon" },
  {
    out: "thornbill-upgrade-terminal.jpg",
    page: "thornbill/terminal.html",
    device: "window",
    at: 5,
  },
  {
    out: "thornbill-docs-window.jpg",
    page: "thornbill/docs.html?page=home",
    device: "window",
    at: 5,
  },
  {
    out: "thornbill-api-window.jpg",
    page: "thornbill/docs.html?page=api&still=1",
    device: "window",
  },
  {
    out: "thornbill-changelog-window.jpg",
    page: "thornbill/docs.html?page=changelog",
    device: "window",
  },
  { out: "thornbill-dashboard-laptop.jpg", page: "thornbill/dashboard.html", device: "laptop" },
  { out: "thornbill-editor-window.jpg", page: "thornbill/editor.html", device: "window" },
  {
    out: "thornbill-upgrade-terminal.mp4",
    page: "thornbill/terminal.html",
    device: "window",
    seconds: 5,
  },
  {
    out: "thornbill-docs-window.mp4",
    page: "thornbill/docs.html?page=api",
    device: "window",
    seconds: 5,
  },

  { out: "songlark-icon.png", page: "songlark/icon.html", device: "icon" },
  { out: "songlark-ask-window.jpg", page: "songlark/window.html", device: "window", at: 1.9 },
  { out: "songlark-answer-window.jpg", page: "songlark/window.html", device: "window", at: 6 },
  { out: "songlark-ask-phone.jpg", page: "songlark/phone.html", device: "phone", at: 1.45 },
  { out: "songlark-answer-phone.jpg", page: "songlark/phone.html", device: "phone", at: 5 },
  {
    out: "songlark-voice-phone.jpg",
    page: "songlark/phone.html?scene=voice",
    device: "phone",
    at: 2,
  },
  { out: "songlark-ask-window.mp4", page: "songlark/window.html", device: "window", seconds: 6 },
  { out: "songlark-ask-phone.mp4", page: "songlark/phone.html", device: "phone", seconds: 5 },
];
