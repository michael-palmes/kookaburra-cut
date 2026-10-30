import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";

/** OSC 52 one way only: a program in the terminal may put text on the clipboard, never read what is there. The default provider answers reads, which would hand a shell session (a scene terminal's included) whatever the person last copied. */
export class WriteOnlyClipboardProvider implements IClipboardProvider {
  readText(): Promise<string> {
    return Promise.resolve("");
  }

  writeText(_selection: unknown, text: string): Promise<void> {
    return navigator.clipboard?.writeText(text).catch(() => undefined) ?? Promise.resolve();
  }
}

export function writeOnlyClipboardAddon(): ClipboardAddon {
  return new ClipboardAddon(undefined, new WriteOnlyClipboardProvider());
}
