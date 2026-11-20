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

  {
    out: "fairywren-sorted-phone.jpg",
    page: "fairywren/features.html?scene=sorted",
    device: "phone",
    at: 4.5,
  },
  {
    out: "fairywren-sorted-dark-phone.jpg",
    page: "fairywren/features.html?scene=sorted&mode=dark",
    device: "phone",
    at: 4.5,
  },
  {
    out: "fairywren-quickadd-phone.jpg",
    page: "fairywren/features.html?scene=quickadd",
    device: "phone",
    at: 3,
  },
  {
    out: "fairywren-reschedule-phone.jpg",
    page: "fairywren/features.html?scene=reschedule",
    device: "phone",
    at: 2.6,
  },
  {
    out: "fairywren-share-phone.jpg",
    page: "fairywren/features.html?scene=share",
    device: "phone",
    at: 5.4,
  },
  {
    out: "fairywren-insights-phone.jpg",
    page: "fairywren/features.html?scene=insights",
    device: "phone",
  },
  {
    out: "fairywren-month-phone.jpg",
    page: "fairywren/features.html?scene=month",
    device: "phone",
  },
  {
    out: "fairywren-sorted-phone.mp4",
    page: "fairywren/features.html?scene=sorted",
    device: "phone",
    seconds: 6,
  },
  {
    out: "fairywren-quickadd-phone.mp4",
    page: "fairywren/features.html?scene=quickadd",
    device: "phone",
    seconds: 5,
  },
  {
    out: "fairywren-reschedule-phone.mp4",
    page: "fairywren/features.html?scene=reschedule",
    device: "phone",
    seconds: 5,
  },
  {
    out: "fairywren-share-phone.mp4",
    page: "fairywren/features.html?scene=share",
    device: "phone",
    seconds: 5.5,
  },
  {
    out: "fairywren-focusflow-phone.mp4",
    page: "fairywren/features.html?scene=focusflow",
    device: "phone",
    seconds: 6,
  },

  {
    out: "fairywren-focus-dark-phone.jpg",
    page: "fairywren/phone.html?scene=focus&mode=dark",
    device: "phone",
    at: 5,
  },
  {
    out: "fairywren-quickadd-dark-phone.jpg",
    page: "fairywren/features.html?scene=quickadd&mode=dark",
    device: "phone",
    at: 3,
  },
  {
    out: "fairywren-reschedule-dark-phone.jpg",
    page: "fairywren/features.html?scene=reschedule&mode=dark",
    device: "phone",
    at: 2.6,
  },
  {
    out: "fairywren-share-dark-phone.jpg",
    page: "fairywren/features.html?scene=share&mode=dark",
    device: "phone",
    at: 5.4,
  },
  {
    out: "fairywren-insights-dark-phone.jpg",
    page: "fairywren/features.html?scene=insights&mode=dark",
    device: "phone",
  },
  {
    out: "fairywren-month-dark-phone.jpg",
    page: "fairywren/features.html?scene=month&mode=dark",
    device: "phone",
  },
  {
    out: "fairywren-plan-dark-phone.mp4",
    page: "fairywren/phone.html?scene=plan&mode=dark",
    device: "phone",
    seconds: 5,
  },
  {
    out: "fairywren-sorted-dark-phone.mp4",
    page: "fairywren/features.html?scene=sorted&mode=dark",
    device: "phone",
    seconds: 6,
  },
  {
    out: "fairywren-quickadd-dark-phone.mp4",
    page: "fairywren/features.html?scene=quickadd&mode=dark",
    device: "phone",
    seconds: 5,
  },
  {
    out: "fairywren-reschedule-dark-phone.mp4",
    page: "fairywren/features.html?scene=reschedule&mode=dark",
    device: "phone",
    seconds: 5,
  },
  {
    out: "fairywren-share-dark-phone.mp4",
    page: "fairywren/features.html?scene=share&mode=dark",
    device: "phone",
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

  {
    out: "thornbill-changes-terminal.jpg",
    page: "thornbill/terminal.html?scene=changes",
    device: "window",
    at: 6,
  },
  { out: "thornbill-diff-window.jpg", page: "thornbill/review.html?page=diff", device: "window" },
  {
    out: "thornbill-benchmark-window.jpg",
    page: "thornbill/review.html?page=bench",
    device: "window",
  },
  {
    out: "thornbill-changes-terminal.mp4",
    page: "thornbill/terminal.html?scene=changes",
    device: "window",
    seconds: 6,
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
  {
    out: "songlark-offsite-ask-window.jpg",
    page: "songlark/window.html?topic=offsite",
    device: "window",
    at: 2.25,
  },
  {
    out: "songlark-offsite-answer-window.jpg",
    page: "songlark/window.html?topic=offsite",
    device: "window",
    at: 6.5,
  },
  {
    out: "songlark-notes-ask-window.jpg",
    page: "songlark/window.html?topic=notes",
    device: "window",
    at: 2.25,
  },
  {
    out: "songlark-notes-answer-window.jpg",
    page: "songlark/window.html?topic=notes",
    device: "window",
    at: 6.5,
  },
  {
    out: "songlark-followup-window.jpg",
    page: "songlark/window.html?scene=followup",
    device: "window",
    at: 6,
  },
  {
    out: "songlark-followup-window.mp4",
    page: "songlark/window.html?scene=followup",
    device: "window",
    seconds: 6,
  },
];
