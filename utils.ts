import { CroppedObject, DetectedObject } from './types';

// OpenCV.js is loaded globally from index.html
declare const cv: any;

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

export const removeBackgroundWithRembg = async (imageUrl: string, apiKey?: string): Promise<Blob> => {
  const space = 'briaai/BRIA-RMBG-2.0';

  const { Client } = await import("@gradio/client");
  const options: any = {};
  if (apiKey) {
    options.hf_token = apiKey as `hf_${string}`;
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

    throw new Error("No valid output from RMBG-2.0");

  } catch (e: any) {
    console.error(`RMBG-2.0 via Gradio failed (${space}):`, e);
    throw new Error(`RMBG-2.0 Failed: ${e.message}`);
  }
};

// --- AKAZE feature matching (Phase 4) ---

const isOpenCVReady = (): boolean =>
  typeof window.cv !== 'undefined' && typeof window.cv.Mat !== 'undefined';

/** OpenCV.js is loaded asynchronously; wait until it is ready. */
const waitForOpenCV = async (timeoutMs = 20000): Promise<boolean> => {
  if (isOpenCVReady()) return true;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      if (isOpenCVReady()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        console.error("OpenCV load timed out");
        resolve(false);
      }
    }, 100);
  });
};

const loadImageElement = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/**
 * Locate the template image (original crop) inside the large image (completed image)
 * with AKAZE + Lowe's ratio test + RANSAC homography.
 *
 * Returns the normalized box [ymin, xmin, ymax, xmax] in the large image, or null
 * if no reliable match was found (the caller then falls back to tightBox2d).
 */
export const findBestMatchPosition = async (
  largeImageUrl: string,
  templateImageUrl: string
): Promise<[number, number, number, number] | null> => {
  if (!(await waitForOpenCV())) {
    console.warn("AKAZE: OpenCV.js is not available.");
    return null;
  }

  let largeImg: HTMLImageElement, templateImg: HTMLImageElement;
  try {
    [largeImg, templateImg] = await Promise.all([loadImageElement(largeImageUrl), loadImageElement(templateImageUrl)]);
  } catch {
    return null;
  }

  // Every OpenCV object is tracked here and released in `finally`
  const allocated: { delete: () => void }[] = [];
  const track = <T extends { delete: () => void }>(obj: T): T => { allocated.push(obj); return obj; };

  const matFromImage = (img: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Canvas context failed");
    ctx.drawImage(img, 0, 0);
    return track(cv.matFromImageData(ctx.getImageData(0, 0, img.width, img.height)));
  };

  try {
    // Grayscale images
    const gray1 = track(new cv.Mat());
    const gray2 = track(new cv.Mat());
    cv.cvtColor(matFromImage(templateImg), gray1, cv.COLOR_RGBA2GRAY, 0);
    cv.cvtColor(matFromImage(largeImg), gray2, cv.COLOR_RGBA2GRAY, 0);

    // Keypoints and descriptors
    const akaze = track(new cv.AKAZE());
    const kp1 = track(new cv.KeyPointVector());
    const kp2 = track(new cv.KeyPointVector());
    const des1 = track(new cv.Mat());
    const des2 = track(new cv.Mat());
    const noMask = track(new cv.Mat());
    akaze.detectAndCompute(gray1, noMask, kp1, des1);
    akaze.detectAndCompute(gray2, noMask, kp2, des2);

    if (kp1.size() === 0 || kp2.size() === 0) {
      console.warn("AKAZE: No keypoints detected.");
      return null;
    }

    // k-NN matching (k = 2) with Lowe's ratio test
    const bf = track(new cv.BFMatcher(cv.NORM_HAMMING, false));
    const matches = track(new cv.DMatchVectorVector());
    bf.knnMatch(des1, des2, matches, 2);

    const ratio = 0.8;
    const srcPoints: number[] = [];
    const dstPoints: number[] = [];
    for (let i = 0; i < matches.size(); ++i) {
      const pair = matches.get(i);
      if (pair.size() < 2) continue;
      const m = pair.get(0);
      const n = pair.get(1);
      if (m.distance < ratio * n.distance) {
        const p1 = kp1.get(m.queryIdx).pt;
        const p2 = kp2.get(m.trainIdx).pt;
        srcPoints.push(p1.x, p1.y);
        dstPoints.push(p2.x, p2.y);
      }
    }

    if (srcPoints.length / 2 < 4) {
      console.warn("AKAZE: Not enough matches found (< 4).");
      return null;
    }

    // Homography with RANSAC
    const srcMat = track(cv.matFromArray(srcPoints.length / 2, 1, cv.CV_32FC2, srcPoints));
    const dstMat = track(cv.matFromArray(dstPoints.length / 2, 1, cv.CV_32FC2, dstPoints));
    const H = track(cv.findHomography(srcMat, dstMat, cv.RANSAC, 5.0));
    if (H.empty()) {
      console.warn("AKAZE: Homography matrix is empty.");
      return null;
    }

    // Project the template corners into the large image
    const objCorners = track(cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      templateImg.width, 0,
      templateImg.width, templateImg.height,
      0, templateImg.height
    ]));
    const sceneCorners = track(new cv.Mat());
    cv.perspectiveTransform(objCorners, sceneCorners, H);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; ++i) {
      const x = sceneCorners.data32F[i * 2];
      const y = sceneCorners.data32F[i * 2 + 1];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }

    const normMinX = Math.max(0, minX / largeImg.width);
    const normMinY = Math.max(0, minY / largeImg.height);
    const normMaxX = Math.min(1, maxX / largeImg.width);
    const normMaxY = Math.min(1, maxY / largeImg.height);

    // A box much smaller than the large image means AKAZE matched only a part of it
    const minSize = 0.3;
    const detectedWidth = normMaxX - normMinX;
    const detectedHeight = normMaxY - normMinY;
    if (detectedWidth < minSize && detectedHeight < minSize) {
      console.warn(`AKAZE: Detected box too small (${(detectedWidth * 100).toFixed(1)}% x ${(detectedHeight * 100).toFixed(1)}%), rejecting match`);
      return null;
    }

    return [normMinY, normMinX, normMaxY, normMaxX];
  } catch (e) {
    console.error("AKAZE execution failed:", e);
    return null;
  } finally {
    allocated.forEach(obj => obj.delete());
  }
};

export const generateDepthMap = async (imageUrl: string, apiKey?: string): Promise<string> => {
  const { Client } = await import("@gradio/client");

  // Ensure hfToken is undefined if empty string
  const token = apiKey && apiKey.trim().length > 0 ? apiKey : undefined;

  const space = 'depth-anything/Depth-Anything-V2';

  try {
    const client = await Client.connect(space, token ? { hf_token: token } as any : {});

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
    throw new Error(`Depth Map Failed: ${errorMsg}`);
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

export const generate3DModelWithTripoSRLocal = async (imageUrl: string, mcResolution: number = 256, apiUrl: string = "http://127.0.0.1:7860/"): Promise<Blob> => {
  try {
    const { Client } = await import("@gradio/client");

    // Connect to local Gradio server
    const client = await Client.connect(apiUrl);

    const imageBlob = await (await fetch(imageUrl)).blob();

    // Endpoint /generate based on provided docs
    const result = await client.predict("/generate", {
      image: imageBlob,
      mc_resolution: mcResolution,
    });

    const data = result.data as any[];

    if (data && data.length > 1) {
      // API Returns [0]: OBJ, [1]: GLB - we prefer GLB for web viewing
      // Note: Gradio client might return a clean URL or a data object depending on version
      const glbItem = data[1];

      let glbUrl = "";
      if (typeof glbItem === 'string') {
        glbUrl = glbItem;
      } else if (glbItem && glbItem.url) {
        glbUrl = glbItem.url;
      }

      if (glbUrl) {
        // Fetch the actual blob from the URL
        const response = await fetch(glbUrl);
        return await response.blob();
      }
    }

    throw new Error("Invalid response structure from TripoSR Local");

  } catch (error) {
    console.error("TripoSR Local generation error:", error);
    // Suggest checking the server if connection failed
    if (error instanceof Error && error.message.includes("Failed to fetch")) {
      throw new Error(`Failed to connect to TripoSR Local at ${apiUrl}. Please ensure the server is running.`);
    }
    throw error;
  }
};

export const generate3DModelWithTrellis = async (imageUrl: string, hfToken?: string): Promise<Blob> => {
  try {
    const { Client } = await import("@gradio/client");

    // An HF token is required so that ZeroGPU usage is billed to the user's own quota
    const token = hfToken && hfToken.trim().length > 0 ? hfToken : undefined;

    if (!token) {
      throw new Error("Hugging Face token is required for TRELLIS.2. Please enter your HF Token in the settings.");
    }

    const client: any = await Client.connect('microsoft/TRELLIS.2', { hf_token: token } as any);
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

    throw new Error(`TRELLIS.2 Failed: ${errorMsg}`);
  }
};