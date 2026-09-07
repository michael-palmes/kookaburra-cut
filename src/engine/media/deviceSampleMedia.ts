export const SAMPLE_PHONE_VIDEO = "assets/sample-phone-recording.mp4";
export const SAMPLE_LAPTOP_VIDEO = "assets/sample-laptop-recording.mp4";

export function sampleVideoForDevice(model: string): string {
  // Landscape screens take the laptop recording; portrait handsets the phone one.
  return model === "macbook-pro-16" || model === "ipad-pro-13"
    ? SAMPLE_LAPTOP_VIDEO
    : SAMPLE_PHONE_VIDEO;
}

export function isSampleDeviceVideo(rel: string | undefined): boolean {
  return rel === SAMPLE_PHONE_VIDEO || rel === SAMPLE_LAPTOP_VIDEO;
}
