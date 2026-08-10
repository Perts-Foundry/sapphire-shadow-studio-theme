// Normalized crop box -> cover-fit extract + resize instructions for one photo cell. Pure math.
//
// The operator confirms each pattern's crop as a normalized box on the decoded hero (fractions of
// width/height). Working cells and previews are straight downscales of the decoded photo, so the
// same normalized box applies to any of them 1:1; callers pass whichever pixel dimensions they
// are actually cropping. "Cover" means the box is trimmed further (centred) to the target aspect,
// never letterboxed, so every cell in the grid fills its frame edge to edge.

/**
 * Compute the sharp extract + resize for one cell.
 * All rounding is clamped so the extract can never overflow the source (sharp's extract throws on
 * a single pixel of overflow, and a rounding-up at the right edge is exactly how that happens).
 * @param {object} input
 * @param {number} input.srcWidth - pixel width of the image being cropped
 * @param {number} input.srcHeight - pixel height of the image being cropped
 * @param {{left: number, top: number, width: number, height: number}} input.box - normalized crop
 * @param {number} input.targetWidth - output pixel width (from compositePlan)
 * @param {number} input.targetHeight - output pixel height (from compositePlan)
 * @returns {{extract: {left: number, top: number, width: number, height: number},
 *            resize: {width: number, height: number}}}
 */
export function coverCrop({ srcWidth, srcHeight, box, targetWidth, targetHeight }) {
  for (const [name, v] of [['srcWidth', srcWidth], ['srcHeight', srcHeight], ['targetWidth', targetWidth], ['targetHeight', targetHeight]]) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer, got ${v}`);
  }
  if (!box || [box.left, box.top, box.width, box.height].some((v) => !Number.isFinite(v))) {
    throw new Error('crop box must have finite left/top/width/height');
  }
  if (box.left < 0 || box.top < 0 || box.width <= 0 || box.height <= 0
    || box.left + box.width > 1 || box.top + box.height > 1) {
    throw new Error(`crop box out of bounds: ${JSON.stringify(box)}`);
  }

  // The confirmed box, in source pixels.
  let bx = box.left * srcWidth;
  let by = box.top * srcHeight;
  let bw = box.width * srcWidth;
  let bh = box.height * srcHeight;

  // Trim the box (centred) to the target aspect: cover, never letterbox.
  const targetAspect = targetWidth / targetHeight;
  const boxAspect = bw / bh;
  if (boxAspect > targetAspect) {
    const newW = bh * targetAspect;
    bx += (bw - newW) / 2;
    bw = newW;
  } else if (boxAspect < targetAspect) {
    const newH = bw / targetAspect;
    by += (bh - newH) / 2;
    bh = newH;
  }

  // Integer extract, clamped inside the source.
  let left = Math.round(bx);
  let top = Math.round(by);
  let width = Math.round(bw);
  let height = Math.round(bh);
  if (width < 1 || height < 1) {
    throw new Error(`crop box degenerates to ${width}x${height} pixels on a ${srcWidth}x${srcHeight} source`);
  }
  left = Math.min(Math.max(left, 0), srcWidth - 1);
  top = Math.min(Math.max(top, 0), srcHeight - 1);
  width = Math.min(width, srcWidth - left);
  height = Math.min(height, srcHeight - top);

  return {
    extract: { left, top, width, height },
    resize: { width: targetWidth, height: targetHeight },
  };
}
