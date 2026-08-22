/** The window's chrome root, the mount point for any overlay raised from deep inside a panel: the camera pill sits inside `.stage`, a size container, which would trap and clip a fixed overlay inside the stage box; the inspector's drill pages animate with a transform, which becomes the containing block for `position: fixed` and would slide an overlay with the page; and `--chrome-top` (the draggable titlebar strip) is set here. */
export function modalHost(): HTMLElement {
  return document.querySelector<HTMLElement>(".app, .editor-window") ?? document.body;
}
