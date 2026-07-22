import androidGlbUrl from "../../assets/models/android.glb?url";
import placeholderPhoneUrl from "../../assets/models/placeholder-phone.glb?url";

/** Resolves the bundled handset model URL: the LICENSED photoreal asset (gitignored, never committed) wins when present locally, else public clones build against the committed generic placeholder; `import.meta.glob` makes the licensed file OPTIONAL at build time since an empty match isn't an error, unlike a static import. */
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

export const phoneModelUrl: string = licensedModelUrl(IPHONE_15_PRO_GLB) ?? placeholderPhoneUrl;
export const iphone17ProModelUrl: string =
  licensedModelUrl(IPHONE_17_PRO_GLB) ?? placeholderPhoneUrl;
/** Falls back to the placeholder PHONE when the licensed glb is absent; licence-less builds show a phone silhouette for the laptop rather than failing. */
export const macbookPro16ModelUrl: string =
  licensedModelUrl(MACBOOK_PRO_16_GLB) ?? placeholderPhoneUrl;

/** The generated Android (Pixel-style) handset; unlicensed, so it's committed directly (no licensed override). */
export const androidModelUrl: string = androidGlbUrl;

/** True when the licensed vendor model is present (used nowhere critical, informational). */
export const usingLicensedPhoneModel = licensedModelUrl(IPHONE_15_PRO_GLB) !== null;
