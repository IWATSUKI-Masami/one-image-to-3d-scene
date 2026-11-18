import { CroppedObject, DetectedObject } from './types';
import { DEFAULT_SPACES } from './services/ai/models';
import openCVUrl from '@techstark/opencv-js/dist/opencv.js?url';

export const blobUrlToDataUrl = async (blobUrl: string): Promise<string> => {
  const response = await fetch(blobUrl);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result as string);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export const dataUrlToBlobUrl = async (dataUrl: string): Promise<string> => {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
};

export const cropObjectsFromImage = async (
  imageUrl: string,
  objects: DetectedObject[]
): Promise<CroppedObject[]> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const crops: CroppedObject[] = objects.map((obj, index) => {
        const [ymin, xmin, ymax, xmax] = obj.box_2d;

        // Convert normalized coordinates to pixel coordinates
        let x = Math.round(xmin * img.width);
        let y = Math.round(ymin * img.height);
        let w = Math.round((xmax - xmin) * img.width);
        let h = Math.round((ymax - ymin) * img.height);

        x = Math.max(0, x);
        y = Math.max(0, y);
        w = Math.min(img.width - x, w);
        h = Math.min(img.height - y, h);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.drawImage(img, x, y, w, h, 0, 0, w, h);

        // Use Data URL for persistence
        const croppedUrl = canvas.toDataURL('image/png');

        return {
          id: `crop-${index}-${Date.now()}`,
          label: obj.label,
          imageUrl: croppedUrl,
          box_2d: obj.box_2d,
          type: obj.type ?? (/\b(person|man|woman|boy|girl|child)\b/i.test(obj.label) ? 'person' : 'object'),
          description: obj.description
        };
      }).filter(Boolean) as CroppedObject[];

      // Add numbered suffixes to duplicate labels
      const labelCounts = new Map<string, number>();
      const labelIndices = new Map<string, number>();

      // Count occurrences of each label (case-insensitive)
      for (const crop of crops) {
        const lowerLabel = crop.label.toLowerCase();
        labelCounts.set(lowerLabel, (labelCounts.get(lowerLabel) || 0) + 1);
      }

      // Assign numbers to duplicates
      for (const crop of crops) {
        const lowerLabel = crop.label.toLowerCase();
        if (labelCounts.get(lowerLabel)! >= 2) {
          const idx = (labelIndices.get(lowerLabel) || 0) + 1;
          labelIndices.set(lowerLabel, idx);
          crop.label = `${crop.label} (${idx})`;
        }
      }

      resolve(crops);
    };
    img.onerror = reject;
    img.src = imageUrl;
  });
};

/**
 * True if the image already has a transparent background, i.e. a noticeable
 * share of its pixels is (partly) transparent. Used to skip background removal
 * for completions that come back transparent (OpenAI with background: 'transparent').
 */
export const hasTransparentBackground = async (imageUrl: string, minShare = 0.02): Promise<boolean> => {
  try {
    const img = await loadImageElement(imageUrl);
    const scale = Math.min(1, 256 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) transparent++;
    }
    return transparent / (w * h) >= minShare;
  } catch {
    return false;
  }
};

/**
 * Background removal with a BRIA RMBG Space (3.0 or 2.0; both have the same API:
 * /image -> [ImageSlider, transparent PNG]). `space` is resolved by bgRemovalSpace().
 */
export const removeBackgroundWithRembg = async (imageUrl: string, apiKey: string | undefined, space: string): Promise<Blob> => {

  const { Client } = await import("@gradio/client");
  const options: any = {};
  if (apiKey) {
    options.token = apiKey as `hf_${string}`;
  }

  try {
    const client = await Client.connect(space, options);

    const response = await fetch(imageUrl);
    const imageBlob = await response.blob();

    const result = await client.predict("/image", {
      image: imageBlob,
    });

    if ((result as any).data && (result as any).data.length > 1) {
      const output = (result as any).data[1];

      if (output instanceof Blob) {
        return output;
      } else if (typeof output === 'string') {
        const res = await fetch(output);
        return await res.blob();
      } else if ((output as any).url) {
        const res = await fetch((output as any).url);
        return await res.blob();
      }
    }

    throw new Error("No valid output from the background removal Space");

  } catch (e: any) {
    console.error(`Background removal via Gradio failed (${space}):`, e);
    throw new Error(`Background removal failed (${space}): ${e.message}`);
  }
};

// --- AKAZE feature matching (Phase 4) ---

/**
 * OpenCV.js 4.10.0, shipped with the app from npm (@techstark/opencv-js, pinned)
 * and loaded on first use as a classic <script> (the file is about 10 MB).
 *
 * It is not imported as an ES module: the Emscripten module has a `then`
 * method, so awaiting the module namespace never settles. For the same reason
 * the global `cv` is returned wrapped in an object, and readiness is detected
 * by polling for `cv.Mat`.
 */
let openCVPromise: Promise<{ cv: any } | null> | null = null;

const loadOpenCV = (timeoutMs = 60000): Promise<{ cv: any } | null> => {
  openCVPromise ??= (async () => {
    try {
      const w = window as any;
      if (!w.cv) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = openCVUrl;
          script.async = true;
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Failed to load ' + openCVUrl));
          document.head.appendChild(script);
        });
      }
      const start = Date.now();
      while (!(w.cv && w.cv.Mat)) {
        if (Date.now() - start > timeoutMs) throw new Error('OpenCV.js initialization timed out');
        await new Promise(r => setTimeout(r, 50));
      }
      return { cv: w.cv };
    } catch (e) {
      console.error('Failed to load OpenCV.js:', e);
      openCVPromise = null; // allow a retry later
      return null;
    }
  })();
  return openCVPromise;
};

const loadImageElement = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

type Point = [number, number];

/** Inlier distance, as a fraction of the larger side of the completed image */
const MATCH_INLIER_THRESHOLD = 0.015;
/** Minimum number of matches that must agree on the transform */
const MATCH_MIN_INLIERS = 8;
/** Minimum fraction of all ratio-test matches that must agree */
const MATCH_MIN_INLIER_RATIO = 0.25;
/** Minimum fraction of the matched box that must lie inside the completed image */
const MATCH_MIN_INSIDE = 0.8;

/** Details of the last match (for diagnostics and tests) */
export let lastMatchDiagnostics: { matches: number; inliers: number; imageScale: number | null } | null = null;

/**
 * Estimate dst = s * src + t (uniform scale + translation) with RANSAC.
 *
 * Image completion is asked not to move, resize or deform the visible part, so
 * the original crop appears in the completed image scaled and shifted only.
 * This 3-parameter model needs far fewer correct matches than a homography
 * (8 parameters), which produces distorted boxes from a few wrong matches.
 * A fixed random seed keeps results reproducible.
 */
export const estimateScaleTranslation = (
  src: Point[],
  dst: Point[],
  threshold: number,
  iterations = 2000,
): { s: number; tx: number; ty: number; inliers: number } | null => {
  const n = src.length;
  if (n < 2) return null;

  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  const countInliers = (s: number, tx: number, ty: number, mark?: boolean[]) => {
    let count = 0;
    for (let i = 0; i < n; i++) {
      const ok = Math.hypot(s * src[i][0] + tx - dst[i][0], s * src[i][1] + ty - dst[i][1]) < threshold;
      if (ok) count++;
      if (mark) mark[i] = ok;
    }
    return count;
  };

  let best: { s: number; tx: number; ty: number; inliers: number } | null = null;
  for (let it = 0; it < iterations; it++) {
    const i = Math.floor(rand() * n);
    let j = Math.floor(rand() * (n - 1));
    if (j >= i) j++;
    const ds = Math.hypot(src[j][0] - src[i][0], src[j][1] - src[i][1]);
    if (ds < 1e-6) continue;
    const s = Math.hypot(dst[j][0] - dst[i][0], dst[j][1] - dst[i][1]) / ds;
    if (s < 0.2 || s > 10) continue;
    const tx = dst[i][0] - s * src[i][0];
    const ty = dst[i][1] - s * src[i][1];
    const inliers = countInliers(s, tx, ty);
    if (!best || inliers > best.inliers) best = { s, tx, ty, inliers };
  }
  if (!best) return null;

  // Least-squares refinement on the inliers
  const mark: boolean[] = [];
  countInliers(best.s, best.tx, best.ty, mark);
  const idx = mark.flatMap((ok, i) => (ok ? [i] : []));
  if (idx.length >= 2) {
    const mean = (pts: Point[], k: 0 | 1) => idx.reduce((a, i) => a + pts[i][k], 0) / idx.length;
    const sx = mean(src, 0), sy = mean(src, 1), dx = mean(dst, 0), dy = mean(dst, 1);
    let num = 0, den = 0;
    for (const i of idx) {
      num += (src[i][0] - sx) * (dst[i][0] - dx) + (src[i][1] - sy) * (dst[i][1] - dy);
      den += (src[i][0] - sx) ** 2 + (src[i][1] - sy) ** 2;
    }
    if (den > 1e-9 && num > 0) {
      const s = num / den;
      best = { s, tx: dx - s * sx, ty: dy - s * sy, inliers: countInliers(s, dx - s * sx, dy - s * sy) };
    }
  }
  return best;
};

/** Scales of the completed image to search (completions are often drawn much larger than the crop) */
const MATCH_SCALES = [1, 0.5, 0.25];

/**
 * Locate the template image (original crop) inside the large image (completed image).
 *
 * AKAZE keypoints + k-NN matching with Lowe's ratio test (r = 0.8), then a
 * uniform scale + translation fitted with RANSAC (see estimateScaleTranslation).
 * The completed image is searched at several scales and the most consistent
 * result is kept.
 *
 * Returns the normalized box [ymin, xmin, ymax, xmax] in the large image, or null
 * if no reliable match was found (the caller then falls back to tightBox2d).
 */
export const findBestMatchPosition = async (
  largeImageUrl: string,
  templateImageUrl: string
): Promise<[number, number, number, number] | null> => {
  lastMatchDiagnostics = null;
  const opencv = await loadOpenCV();
  if (!opencv) {
    console.warn("AKAZE: OpenCV.js is not available.");
    return null;
  }
  const { cv } = opencv;

  let largeImg: HTMLImageElement, templateImg: HTMLImageElement;
  try {
    [largeImg, templateImg] = await Promise.all([loadImageElement(largeImageUrl), loadImageElement(templateImageUrl)]);
  } catch {
    return null;
  }

  // Every OpenCV object is tracked here and released in `finally`
  const allocated: { delete: () => void }[] = [];
  const track = <T extends { delete: () => void }>(obj: T): T => { allocated.push(obj); return obj; };

  /** Grayscale Mat of an image drawn at `scale`, composited on white */
  const grayFromImage = (img: HTMLImageElement, scale = 1) => {
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Canvas context failed");
    // Transparent pixels would become black in grayscale and create false edges;
    // completions are generated on white, so composite on white.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const rgba = track(cv.matFromImageData(ctx.getImageData(0, 0, w, h)));
    const gray = track(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY, 0);
    return { gray, w, h };
  };

  try {
    const akaze = track(new cv.AKAZE());
    const bf = track(new cv.BFMatcher(cv.NORM_HAMMING, false));
    const noMask = track(new cv.Mat());

    const tpl = grayFromImage(templateImg);
    const kp1 = track(new cv.KeyPointVector());
    const des1 = track(new cv.Mat());
    akaze.detectAndCompute(tpl.gray, noMask, kp1, des1);
    if (kp1.size() === 0) {
      console.warn("AKAZE: No keypoints in the original crop.");
      return null;
    }

    type Candidate = { box: [number, number, number, number]; inliers: number; matches: number; scale: number };
    let best: Candidate | null = null;
    let tried = 0;

    for (const imageScale of MATCH_SCALES) {
      const large = grayFromImage(largeImg, imageScale);
      if (Math.min(large.w, large.h) < 32) continue;
      const kp2 = track(new cv.KeyPointVector());
      const des2 = track(new cv.Mat());
      akaze.detectAndCompute(large.gray, noMask, kp2, des2);
      if (kp2.size() < 2) continue;

      // k-NN matching (k = 2) with Lowe's ratio test
      const matches = track(new cv.DMatchVectorVector());
      bf.knnMatch(des1, des2, matches, 2);
      const src: Point[] = [], dst: Point[] = [];
      for (let i = 0; i < matches.size(); ++i) {
        const pair = matches.get(i);
        if (pair.size() < 2) continue;
        const m = pair.get(0);
        const n = pair.get(1);
        if (m.distance < 0.8 * n.distance) {
          const p1 = kp1.get(m.queryIdx).pt;
          const p2 = kp2.get(m.trainIdx).pt;
          src.push([p1.x, p1.y]);
          dst.push([p2.x, p2.y]);
        }
      }
      tried = Math.max(tried, src.length);

      const model = estimateScaleTranslation(src, dst, MATCH_INLIER_THRESHOLD * Math.max(large.w, large.h));
      if (!model || model.inliers < MATCH_MIN_INLIERS || model.inliers < MATCH_MIN_INLIER_RATIO * src.length) continue;

      // The template rectangle mapped into the large image
      const x0 = model.tx, y0 = model.ty;
      const x1 = model.tx + model.s * tpl.w, y1 = model.ty + model.s * tpl.h;
      const inside = (Math.min(x1, large.w) - Math.max(x0, 0)) * (Math.min(y1, large.h) - Math.max(y0, 0));
      if (inside <= 0 || inside < MATCH_MIN_INSIDE * (x1 - x0) * (y1 - y0)) continue;

      if (!best || model.inliers > best.inliers) {
        best = {
          box: [Math.max(0, y0 / large.h), Math.max(0, x0 / large.w), Math.min(1, y1 / large.h), Math.min(1, x1 / large.w)],
          inliers: model.inliers,
          matches: src.length,
          scale: imageScale,
        };
      }
    }

    lastMatchDiagnostics = best
      ? { matches: best.matches, inliers: best.inliers, imageScale: best.scale }
      : { matches: tried, inliers: 0, imageScale: null };
    if (!best) {
      console.warn(`AKAZE: No reliable match (at most ${tried} ratio-test matches); using the fallback box.`);
      return null;
    }
    return best.box;
  } catch (e) {
    console.error("AKAZE execution failed:", e);
    return null;
  } finally {
    allocated.forEach(obj => obj.delete());
  }
};

export const generateDepthMap = async (imageUrl: string, apiKey?: string, space: string = DEFAULT_SPACES.depth): Promise<string> => {
  space = space.trim() || DEFAULT_SPACES.depth; // an empty setting means the official Space
  const { Client } = await import("@gradio/client");

  // Ensure hfToken is undefined if empty string
  const token = apiKey && apiKey.trim().length > 0 ? apiKey : undefined;

  try {
    const client = await Client.connect(space, token ? { token: token as `hf_${string}` } : {});

    const imageBlob = await (await fetch(imageUrl)).blob();

    const result = await client.predict("/on_submit", {
      image: imageBlob,
    });

    const data = result.data as any[];

    if (data) {
      let output = undefined;

      if (data.length > 1 && data[1]) {
        output = data[1];
      }

      if (!output) {
        output = data.find(item =>
          (typeof item === 'object' && item?.url) ||
          (typeof item === 'string' && (item.endsWith('.png') || item.endsWith('.jpg') || item.startsWith('http')))
        );
      }

      if (output) {
        let fetchUrl = output;
        if (typeof output === 'object' && output.url) fetchUrl = output.url;

        const res = await fetch(fetchUrl);
        const blob = await res.blob();
        return URL.createObjectURL(blob);
      }
    }

    throw new Error("No valid output from Depth Anything V2");

  } catch (e: any) {
    console.error(`Depth Map generation failed (${space}):`, e);
    let errorMsg = e.message || "Unknown error";
    if (e.original_msg) errorMsg = e.original_msg;
    throw new Error(`Depth Map Failed (${space}): ${errorMsg}`);
  }
};

export const prepareImageForCompletion = async (
  url: string,
  customVerticalRatio?: number,
  customHorizontalRatio?: number
): Promise<{ imageUrl: string, expansionRatio: number }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Use custom ratios if provided, otherwise use defaults
      const verticalPaddingRatio = customVerticalRatio !== undefined
        ? customVerticalRatio - 1 // Convert ratio to padding (e.g., 2.2 -> 1.2 = 120% padding)
        : 1.2; // Default: Add 120% more height at the bottom
      const horizontalPaddingRatio = customHorizontalRatio !== undefined
        ? customHorizontalRatio - 1 // Convert ratio to padding
        : 0.3; // Default: Add 30% more width (15% each side)

      const newHeight = Math.floor(img.height * (1 + verticalPaddingRatio));
      const newWidth = Math.floor(img.width * (1 + horizontalPaddingRatio));
      const offsetX = Math.floor((newWidth - img.width) / 2); // Center horizontally

      const canvas = document.createElement('canvas');
      canvas.width = newWidth;
      canvas.height = newHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas context failed')); return; }

      // Fill with white (as per prompt requirements for completion)
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw original image centered horizontally, at top vertically
      ctx.drawImage(img, offsetX, 0);

      const newUrl = canvas.toDataURL('image/png');
      resolve({ imageUrl: newUrl, expansionRatio: 1 + verticalPaddingRatio });
    };
    img.onerror = reject;
    img.src = url;
  });
};

export const calculateTightBoundingBox = async (imageUrl: string): Promise<[number, number, number, number]> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error("Canvas context failed")); return; }

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { data, width, height } = imageData;

      // Sample top-left pixel
      const bgR = data[0];
      const bgG = data[1];
      const bgB = data[2];
      const bgA = data[3];
      const isBgTransparent = bgA < 20;

      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let found = false;

      // Scan all pixels
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];

          // 1. Check Transparency
          if (a < 30) continue;

          // 2. Check similarity to background
          if (!isBgTransparent) {
            const diff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
            if (diff < 50) continue;
          }

          // 3. Failsafe White Check
          if (r > 250 && g > 250 && b > 250) continue;

          // Content found
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }

      if (!found) {
        // Fallback to full image if nothing found (e.g. empty or all white)
        resolve([0, 0, 1, 1]);
        return;
      }

      // Add slight padding (margin)
      const padding = 2; // px
      minX = Math.max(0, minX - padding);
      minY = Math.max(0, minY - padding);
      maxX = Math.min(width, maxX + padding);
      maxY = Math.min(height, maxY + padding);

      // Normalize to 0-1
      resolve([
        minY / height,
        minX / width,
        maxY / height,
        maxX / width
      ]);
    };
    img.onerror = reject;
    img.src = imageUrl;
  });
};

/**
 * Hunyuan3D-2.1 (Tencent) via its official Hugging Face Space.
 * Calls `generation_all` (shape + PBR texture) of the Space's Gradio app and
 * returns the textured GLB. Parameters are the app's defaults.
 */
export const generate3DModelWithHunyuan3D = async (imageUrl: string, hfToken?: string, space: string = DEFAULT_SPACES.hunyuan3d): Promise<Blob> => {
  space = space.trim() || DEFAULT_SPACES.hunyuan3d; // an empty setting means the official Space
  try {
    const { Client } = await import("@gradio/client");

    // An HF token is required so that ZeroGPU usage is billed to the user's own quota
    const token = hfToken && hfToken.trim().length > 0 ? hfToken : undefined;
    if (!token) {
      throw new Error("Hugging Face token is required for Hunyuan3D-2.1. Please enter your HF Token in the settings.");
    }

    const client: any = await Client.connect(space, { token: token as `hf_${string}` });

    const imageBlob = await (await fetch(imageUrl)).blob();
    const imageFile = new File([imageBlob], 'input.png', { type: imageBlob.type || 'image/png' });

    const result = await client.predict("/generation_all", {
      image: imageFile,
      mv_image_front: null,
      mv_image_back: null,
      mv_image_left: null,
      mv_image_right: null,
      steps: 30,
      guidance_scale: 5.0,
      seed: 1234,
      octree_resolution: 256,
      check_box_rembg: true,
      num_chunks: 8000,
      randomize_seed: true,
    });

    // Outputs: [untextured mesh, textured GLB, viewer HTML, stats, seed]
    const textured = (result.data as any[])?.[1];
    const glbUrl: string | undefined = typeof textured === 'string' ? textured : (textured?.url ?? textured?.value?.url);
    if (!glbUrl) throw new Error("No textured GLB in the response");

    const response = await fetch(glbUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!response.ok) throw new Error(`GLB download failed: ${response.status} ${response.statusText}`);
    return new Blob([await response.arrayBuffer()], { type: 'model/gltf-binary' });

  } catch (e: any) {
    console.error("Hunyuan3D-2.1 via Gradio failed:", e);
    const errorMsg = e.original_msg ? `Gradio Error: ${e.original_msg}` : (e.message || "An unknown error occurred");
    throw new Error(`Hunyuan3D-2.1 Failed (${space}): ${errorMsg}`);
  }
};

export const generate3DModelWithTrellis = async (imageUrl: string, hfToken?: string, space: string = DEFAULT_SPACES.trellis): Promise<Blob> => {
  space = space.trim() || DEFAULT_SPACES.trellis; // an empty setting means the official Space
  try {
    const { Client } = await import("@gradio/client");

    // An HF token is required so that ZeroGPU usage is billed to the user's own quota
    const token = hfToken && hfToken.trim().length > 0 ? hfToken : undefined;

    if (!token) {
      throw new Error("Hugging Face token is required for TRELLIS.2. Please enter your HF Token in the settings.");
    }

    const client: any = await Client.connect(space, { token: token as `hf_${string}` });
    await client.predict("/start_session", {});

    const img = await loadImageElement(imageUrl);

    // TRELLIS.2 Official Preprocessing (from trellis2/pipelines/trellis2_image_to_3d.py)
    // 1. Find foreground bounding box using alpha channel
    // 2. Crop to square centered on foreground 
    // 3. Alpha-premultiply RGB (creates black background effect)
    // 4. Resize so max dimension is 1024

    // Step 1: Get image data to find foreground bbox
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.width;
    tempCanvas.height = img.height;
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) throw new Error('Canvas context failed');
    tempCtx.drawImage(img, 0, 0);
    const srcData = tempCtx.getImageData(0, 0, img.width, img.height);
    const pixels = srcData.data;

    // Find bounding box of foreground (alpha > threshold)
    const alphaThreshold = 0.8 * 255; // 80% as in TRELLIS source
    let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const idx = (y * img.width + x) * 4;
        if (pixels[idx + 3] > alphaThreshold) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    // Handle case where no foreground found
    if (minX >= maxX || minY >= maxY) {
      minX = 0; minY = 0; maxX = img.width; maxY = img.height;
    }

    // Step 2: Calculate square crop centered on foreground
    const bboxWidth = maxX - minX;
    const bboxHeight = maxY - minY;
    const centerX = minX + bboxWidth / 2;
    const centerY = minY + bboxHeight / 2;
    const cropSize = Math.max(bboxWidth, bboxHeight);

    // Calculate crop bounds
    const cropX = Math.floor(centerX - cropSize / 2);
    const cropY = Math.floor(centerY - cropSize / 2);

    // Step 3: Create 1024x1024 output canvas with foreground centered
    // Square crop centered on foreground, then resize to 1024x1024
    const targetSize = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context failed');

    // Handle cases where crop extends beyond image bounds (padding stays transparent)
    const srcX = Math.max(0, cropX);
    const srcY = Math.max(0, cropY);
    const srcW = Math.min(cropSize, img.width - srcX);
    const srcH = Math.min(cropSize, img.height - srcY);
    const dstX = (cropX < 0 ? -cropX : 0) * targetSize / cropSize;
    const dstY = (cropY < 0 ? -cropY : 0) * targetSize / cropSize;
    const dstW = srcW * targetSize / cropSize;
    const dstH = srcH * targetSize / cropSize;

    ctx.drawImage(tempCanvas, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);

    // TRELLIS.2 Processing: Convert white/light gray background to transparent
    // This is critical because completed images often have near-white backgrounds instead of true transparency
    const outputData = ctx.getImageData(0, 0, targetSize, targetSize);
    const outPixels = outputData.data;

    // First pass: Convert only pure white/near-white pixels to transparent
    // Be very conservative to avoid removing clothing pixels
    const whitenessThreshold = 250; // Only very white pixels (RGB > 250)
    for (let i = 0; i < outPixels.length; i += 4) {
      const r = outPixels[i];
      const g = outPixels[i + 1];
      const b = outPixels[i + 2];

      // Only remove pixels that are nearly pure white
      const isWhite = r > whitenessThreshold && g > whitenessThreshold && b > whitenessThreshold;

      if (isWhite) {
        outPixels[i] = 0;
        outPixels[i + 1] = 0;
        outPixels[i + 2] = 0;
        outPixels[i + 3] = 0; // Make transparent
      }
    }

    // Second pass: Binary alpha mask - clean up semi-transparent pixels
    const alphaCutoff = 128; // Moderate threshold
    for (let i = 0; i < outPixels.length; i += 4) {
      if (outPixels[i + 3] < alphaCutoff) {
        outPixels[i] = 0;
        outPixels[i + 1] = 0;
        outPixels[i + 2] = 0;
        outPixels[i + 3] = 0;
      } else if (outPixels[i + 3] > 0) {
        // Alpha-premultiply for TRELLIS
        const alpha = outPixels[i + 3] / 255;
        outPixels[i] = Math.round(outPixels[i] * alpha);
        outPixels[i + 1] = Math.round(outPixels[i + 1] * alpha);
        outPixels[i + 2] = Math.round(outPixels[i + 2] * alpha);
        outPixels[i + 3] = 255; // Fully opaque
      }
    }
    ctx.putImageData(outputData, 0, 0);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to convert to PNG'));
      }, 'image/png');
    });

    // Create File object (Gradio expects File, not Blob)
    const imageFile = new File([pngBlob], 'input.png', { type: 'image/png' });

    // Image to 3D with default parameters (random seed, like the Gradio UI)
    const randomSeed = Math.floor(Math.random() * 2147483647);
    await client.predict("/image_to_3d", {
      image: imageFile,
      seed: randomSeed,
      resolution: "1024",
      ss_guidance_strength: 7.5,
      ss_guidance_rescale: 0.7,
      ss_sampling_steps: 12,
      ss_rescale_t: 5,
      shape_slat_guidance_strength: 10,  // Increased from 7.5 to reduce wall artifacts
      shape_slat_guidance_rescale: 0.5,
      shape_slat_sampling_steps: 12,
      shape_slat_rescale_t: 3,
      tex_slat_guidance_strength: 1,
      tex_slat_guidance_rescale: 0,
      tex_slat_sampling_steps: 12,
      tex_slat_rescale_t: 3,
    });

    // Extract GLB
    const extractResult = await client.predict("/extract_glb", {
      decimation_target: 300000,
      texture_size: 2048,
    });

    const data = extractResult.data as any[];

    if (data && data.length > 0) {
      // Try data[1] first (download button/file) as it may have the full GLB
      // Then fall back to data[0] (Model3D viewer)
      const candidates = [data[1], data[0]];

      for (const glbItem of candidates) {
        if (!glbItem) continue;

        let glbUrl = "";
        if (typeof glbItem === 'string') {
          glbUrl = glbItem;
        } else if (glbItem.url) {
          glbUrl = glbItem.url;
        } else if (glbItem.value && glbItem.value.url) {
          glbUrl = glbItem.value.url;
        } else if (glbItem.path) {
          // Some Gradio responses use 'path' instead of 'url'
          glbUrl = glbItem.path;
        }

        if (glbUrl) {
          // Include auth header for authenticated file access
          const response = await fetch(glbUrl, { headers: { 'Authorization': `Bearer ${token}` } });
          if (!response.ok) {
            console.error("GLB fetch failed:", response.status, response.statusText);
            continue; // Try next candidate
          }
          // Create blob with explicit MIME type for GLB
          const arrayBuffer = await response.arrayBuffer();
          return new Blob([arrayBuffer], { type: 'model/gltf-binary' });
        }
      }
    }

    throw new Error("No valid GLB output from TRELLIS.2");

  } catch (e: any) {
    console.error("TRELLIS.2 via Gradio failed:", e);

    let errorMsg = e.message || "An unknown error occurred";
    if (e.original_msg) {
      errorMsg = `Gradio Error: ${e.original_msg}`;
    } else if (e.type === 'status' && e.message) {
      errorMsg = `Gradio Status: ${e.message}`;
    }

    throw new Error(`TRELLIS.2 Failed (${space}): ${errorMsg}`);
  }
};