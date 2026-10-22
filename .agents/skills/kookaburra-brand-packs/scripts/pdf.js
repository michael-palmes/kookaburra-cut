// osascript -l JavaScript pdf.js <guidelines.pdf> <outDir> [widthPx]: page JPEGs plus text.txt, macOS only, no installs.
ObjC.import("AppKit");
ObjC.import("PDFKit");

// biome-ignore lint/correctness/noUnusedVariables: osascript calls run(argv)
function run(argv) {
  const [pdfPath, outDir, widthArg] = argv;
  if (!pdfPath || !outDir)
    return "usage: osascript -l JavaScript pdf.js <file.pdf> <outDir> [widthPx]";
  const width = Number(widthArg || 1400);
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(pdfPath));
  if (doc.isNil()) throw new Error(`cannot open ${pdfPath}`);
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
    outDir,
    true,
    $(),
    $(),
  );
  const pages = doc.pageCount;
  let text = "";
  for (let i = 0; i < pages; i++) {
    const page = doc.pageAtIndex(i);
    const label = String(i + 1).padStart(2, "0");
    text += `\n===== PAGE ${i + 1} =====\n${page.string.isNil() ? "" : page.string.js}`;
    const box = page.boundsForBox($.kPDFDisplayBoxMediaBox);
    const size = $.NSMakeSize(width, (box.size.height * width) / box.size.width);
    const image = page.thumbnailOfSizeForBox(size, $.kPDFDisplayBoxMediaBox);
    const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
    const jpeg = rep.representationUsingTypeProperties(
      $.NSBitmapImageFileTypeJPEG,
      $({ NSImageCompressionFactor: 0.75 }),
    );
    jpeg.writeToFileAtomically(`${outDir}/page-${label}.jpg`, true);
  }
  $(text).writeToFileAtomicallyEncodingError(
    `${outDir}/text.txt`,
    true,
    $.NSUTF8StringEncoding,
    $(),
  );
  return `${pages} pages: ${outDir}/page-NN.jpg and ${outDir}/text.txt`;
}
