import androidGlbUrl from "../../assets/models/android.glb?url";
import placeholderPhoneUrl from "../../assets/models/placeholder-phone.glb?url";

/** Resolves optional licensed model URLs at build time. Public clones produce an empty match. */
const licensed = import.meta.glob("../../assets/models/licensed/*.glb", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** The licensed glb URL by filename, else null (public clones build without any of them). */
function licensedModelUrl(filename: string): string | null {
  return licensed[`../../assets/models/licensed/${filename}`] ?? null;
}

// Licensed files are named by fixed UUIDs, not product names, so bundled asset filenames
// stay trade-dress-neutral; the same mapping drives scripts/prepare-device-model.sh.
const IPHONE_15_PRO_GLB = "6241bad0-f016-4c0f-95c0-9aac0930a6ac.glb";
const IPHONE_17_PRO_GLB = "e1bfddac-38f7-48a6-adf0-0d0120b7e937.glb";
const MACBOOK_PRO_16_GLB = "b30d3bc4-a66b-4376-95d1-30978b87212c.glb";
const IPAD_PRO_13_GLB = "1a8f4c65-0cd1-42c2-a5cd-ffb632ec372b.glb";

const licensedPhoneModelUrl = licensedModelUrl(IPHONE_15_PRO_GLB);
const licensedIphone17ProModelUrl = licensedModelUrl(IPHONE_17_PRO_GLB);
const licensedMacbookPro16ModelUrl = licensedModelUrl(MACBOOK_PRO_16_GLB);
const licensedIpadPro13ModelUrl = licensedModelUrl(IPAD_PRO_13_GLB);

// Legacy DeviceMockup and HeroObject keep their generic placeholder fallback.
export const phoneModelUrl: string = licensedPhoneModelUrl ?? placeholderPhoneUrl;
export const iphone17ProModelUrl: string = licensedIphone17ProModelUrl ?? placeholderPhoneUrl;
export const macbookPro16ModelUrl: string = licensedMacbookPro16ModelUrl ?? placeholderPhoneUrl;
export const ipadPro13ModelUrl: string = licensedIpadPro13ModelUrl ?? placeholderPhoneUrl;

export const iphone15ProModelAvailable = licensedPhoneModelUrl !== null;
export const iphone17ProModelAvailable = licensedIphone17ProModelUrl !== null;
export const macbookPro16ModelAvailable = licensedMacbookPro16ModelUrl !== null;
export const ipadPro13ModelAvailable = licensedIpadPro13ModelUrl !== null;

/** The generated Android (Pixel-style) handset; unlicensed, so it's committed directly (no licensed override). */
export const androidModelUrl: string = androidGlbUrl;

/** True when the licensed vendor model is present (used nowhere critical, informational). */
export const usingLicensedPhoneModel = iphone15ProModelAvailable;
