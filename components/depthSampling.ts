/**
 * Depth sampling for PC Box placement (paper KBSE2025-61, Eq. (3) and (4)).
 *
 *   Z        = Z_max - (b / 255) * (Z_max - Z_min)          (3)
 *   Z_median = median({ Z_i | alpha_i > 128 })              (4)
 *
 * The alpha mask comes from the background-removed image of the object
 * (the completed image used for 3D generation). Only the part of that image
 * that corresponds to the original crop (`region`, found by AKAZE matching)
 * is mapped onto the object's bounding box in the scene.
 */

export type Box2D = [number, number, number, number]; // [ymin, xmin, ymax, xmax], normalized

export interface ObjectMask {
  alpha: Uint8ClampedArray;
  width: number;
  height: number;
  /** Area of the mask image that corresponds to the object's box in the scene */
  region: Box2D;
}

export interface DepthRange {
  min: number;
  max: number;
  /**
   * Treat brightness as inverse depth (disparity). Depth Anything V2 outputs
   * relative disparity, so this is the physically consistent mapping; the
   * paper's original placement maps brightness linearly to depth.
   */
  inverse?: boolean;
}

export interface DepthSample {
  /** Median depth Z */
  z: number;
  /** Number of depth-map pixels used */
  samples: number;
  /** true: Eq. (4) with the alpha mask; false: all pixels of the box (no usable mask) */
  usedMask: boolean;
}

const ALPHA_THRESHOLD = 128;
/** With fewer masked pixels than this, the mask is not trusted */
const MIN_MASK_SAMPLES = 5;

/** Load the alpha channel of a (background-removed) image. */
export const loadObjectMask = async (imageUrl: string, region: Box2D = [0, 0, 1, 1]): Promise<ObjectMask> => {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    if (!imageUrl.startsWith('data:') && !imageUrl.startsWith('blob:')) el.crossOrigin = 'anonymous';
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = imageUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context failed');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const alpha = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return { alpha, width: canvas.width, height: canvas.height, region };
};

/** Eq. (3): depth-map brightness (R channel, 255 = near) to distance Z */
export const depthFromBrightness = (b: number, range: DepthRange): number =>
  range.inverse
    ? 1 / (1 / range.max + (b / 255) * (1 / range.min - 1 / range.max))
    : range.max - (b / 255) * (range.max - range.min);

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * Median depth of an object (Eq. (4)).
 *
 * Every depth-map pixel inside `box` is mapped into the mask; the pixel is used
 * when the mask's alpha there is > 128. Without a mask (or with too few masked
 * pixels) the median of all pixels in the box is returned instead.
 */
export const medianDepthInBox = (
  depth: ImageData,
  box: Box2D,
  range: DepthRange,
  mask?: ObjectMask | null,
): DepthSample => {
  const [ymin, xmin, ymax, xmax] = box;
  const { width, height, data } = depth;

  const px0 = Math.max(0, Math.floor(xmin * width));
  const px1 = Math.min(width - 1, Math.ceil(xmax * width) - 1);
  const py0 = Math.max(0, Math.floor(ymin * height));
  const py1 = Math.min(height - 1, Math.ceil(ymax * height) - 1);
  const boxW = Math.max(xmax - xmin, 1e-6);
  const boxH = Math.max(ymax - ymin, 1e-6);

  const masked: number[] = [];
  const all: number[] = [];

  for (let py = py0; py <= py1; py++) {
    for (let px = px0; px <= px1; px++) {
      const z = depthFromBrightness(data[(py * width + px) * 4], range);
      all.push(z);

      if (mask) {
        // Position of this pixel inside the box (0..1), then inside the mask region
        const u = ((px + 0.5) / width - xmin) / boxW;
        const v = ((py + 0.5) / height - ymin) / boxH;
        const [rymin, rxmin, rymax, rxmax] = mask.region;
        const mx = Math.floor((rxmin + u * (rxmax - rxmin)) * mask.width);
        const my = Math.floor((rymin + v * (rymax - rymin)) * mask.height);
        if (mx >= 0 && mx < mask.width && my >= 0 && my < mask.height &&
          mask.alpha[my * mask.width + mx] > ALPHA_THRESHOLD) {
          masked.push(z);
        }
      }
    }
  }

  if (masked.length >= MIN_MASK_SAMPLES) {
    return { z: median(masked), samples: masked.length, usedMask: true };
  }
  if (all.length === 0) {
    // Degenerate box: sample its center
    const cx = Math.min(width - 1, Math.max(0, Math.floor(((xmin + xmax) / 2) * width)));
    const cy = Math.min(height - 1, Math.max(0, Math.floor(((ymin + ymax) / 2) * height)));
    return { z: depthFromBrightness(data[(cy * width + cx) * 4], range), samples: 1, usedMask: false };
  }
  return { z: median(all), samples: all.length, usedMask: false };
};

/** Same box (within floating-point noise) */
export const sameBox = (a: Box2D, b: Box2D): boolean => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
