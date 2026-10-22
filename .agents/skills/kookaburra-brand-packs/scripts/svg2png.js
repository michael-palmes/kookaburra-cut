// osascript -l JavaScript svg2png.js <longEdgePx> <in.svg> <out.png> [...pairs]: transparent PNGs, macOS only, no installs.
ObjC.import("AppKit");

// biome-ignore lint/correctness/noUnusedVariables: osascript calls run(argv)
function run(argv) {
  const edge = Number(argv[0]);
  let done = 0;
  for (let i = 1; i + 1 < argv.length; i += 2) {
    const image = $.NSImage.alloc.initWithContentsOfFile(argv[i]);
    if (image.isNil() || image.size.width === 0) {
      console.log(`skipped ${argv[i]}`);
      continue;
    }
    const k = edge / Math.max(image.size.width, image.size.height);
    const w = Math.round(image.size.width * k);
    const h = Math.round(image.size.height * k);
    const rep =
      $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
        null,
        w,
        h,
        8,
        4,
        true,
        false,
        $.NSDeviceRGBColorSpace,
        0,
        0,
      );
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(
      $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep),
    );
    image.drawInRectFromRectOperationFraction(
      $.NSMakeRect(0, 0, w, h),
      $.NSZeroRect,
      $.NSCompositingOperationSourceOver,
      1,
    );
    $.NSGraphicsContext.restoreGraphicsState;
    rep
      .representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())
      .writeToFileAtomically(argv[i + 1], true);
    done++;
  }
  return `${done} rasterised`;
}
