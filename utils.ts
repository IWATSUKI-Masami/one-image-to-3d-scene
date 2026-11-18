import { CroppedObject, DetectedObject } from './types';

// Declare cv globally for OpenCV.js
declare const cv: any;

export const fileToGenerativePart = async (file: File): Promise<{ inlineData: { data: string; mimeType: string } }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      const base64Data = base64String.split(',')[1];
      resolve({
        inlineData: {
          data: base64Data,
          mimeType: file.type
        }
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

export const urlToBase64 = async (url: string): Promise<string> => {
  if (url.startsWith('data:')) {
    return url.split(',')[1];
  }
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      resolve(base64String.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

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


export const loadImage = (src: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
};

export const cropObjectsFromImage = async (
  imageUrl: string,
  objects: any[]
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
          type: obj.label.toLowerCase().includes('person') || obj.label.toLowerCase().includes('man') || obj.label.toLowerCase().includes('woman') ? 'person' : 'object',
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
    console.log(`[RMBG] Connecting to ${space}...`);
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

export const trimTransparentEdges = async (imageUrl: string, alphaThreshold: number = 50, maintainAspectRatio: boolean = false): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(imageUrl);
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
      let found = false;

      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const alpha = data[(y * canvas.width + x) * 4 + 3];
          if (alpha > alphaThreshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            found = true;
          }
        }
      }

      if (!found) {
        resolve(imageUrl); // Return original if completely transparent
        return;
      }

      const contentW = maxX - minX + 1;
      const contentH = maxY - minY + 1;

      let finalW = contentW;
      let finalH = contentH;
      let offsetX = 0;
      let offsetY = 0;

      if (maintainAspectRatio) {
        const targetRatio = img.width / img.height;
        const contentRatio = contentW / contentH;

        if (contentRatio > targetRatio) {
          // Content is wider than target, need to increase height
          finalH = contentW / targetRatio;
          offsetY = (finalH - contentH) / 2;
        } else {
          // Content is taller than target, need to increase width
          finalW = contentH * targetRatio;
          offsetX = (finalW - contentW) / 2;
        }
      }

      const cutCanvas = document.createElement('canvas');
      cutCanvas.width = finalW;
      cutCanvas.height = finalH;
      const cutCtx = cutCanvas.getContext('2d');
      if (!cutCtx) {
        resolve(imageUrl);
        return;
      }

      // Draw the content from the original canvas to the new canvas, centered
      cutCtx.drawImage(canvas, minX, minY, contentW, contentH, offsetX, offsetY, contentW, contentH);
      resolve(cutCanvas.toDataURL());
    };
    img.onerror = () => resolve(imageUrl);
    img.src = imageUrl;
  });
};

// --- AKAZE Implementation ---

/**
 * Checks if OpenCV is fully initialized.
 */
export const isOpenCVReady = (): boolean => {
  return typeof window.cv !== 'undefined' && typeof window.cv.Mat !== 'undefined';
};

/**
 * Waits for OpenCV to be injected and ready.
 */
export const waitForOpenCV = async (timeoutMs = 20000): Promise<boolean> => {
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


export const findBestMatchPositionAKAZE = async (
  largeImageUrl: string,
  templateImageUrl: string
): Promise<[number, number, number, number] | null> => {
  return new Promise((resolve, reject) => {
    // Check if OpenCV is loaded
    if (typeof cv === 'undefined' || !cv.Mat) {
      console.warn("OpenCV.js not loaded, falling back to SSD.");
      resolve(null);
      return;
    }

    const largeImg = new Image();
    largeImg.crossOrigin = "anonymous";
    const templateImg = new Image();
    templateImg.crossOrigin = "anonymous";

    let loadedCount = 0;
    const onLoaded = () => {
      loadedCount++;
      if (loadedCount < 2) return;

      try {

        // Helper to get Mat from Image via Canvas (more reliable than imread)
        const getMatFromImage = (img: HTMLImageElement) => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error("Canvas context failed");
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, img.width, img.height);
          return cv.matFromImageData(imageData);
        };

        const img1 = getMatFromImage(templateImg);
        const img2 = getMatFromImage(largeImg);

        // Convert to grayscale
        const gray1 = new cv.Mat();
        const gray2 = new cv.Mat();
        cv.cvtColor(img1, gray1, cv.COLOR_RGBA2GRAY, 0);
        cv.cvtColor(img2, gray2, cv.COLOR_RGBA2GRAY, 0);

        // Initialize AKAZE
        const akaze = new cv.AKAZE();

        // Detect keypoints and compute descriptors
        const kp1 = new cv.KeyPointVector();
        const kp2 = new cv.KeyPointVector();
        const des1 = new cv.Mat();
        const des2 = new cv.Mat();

        akaze.detectAndCompute(gray1, new cv.Mat(), kp1, des1);
        akaze.detectAndCompute(gray2, new cv.Mat(), kp2, des2);

        if (kp1.size() === 0 || kp2.size() === 0) {
          console.warn("No keypoints detected.");
          img1.delete(); img2.delete(); gray1.delete(); gray2.delete();
          kp1.delete(); kp2.delete(); des1.delete(); des2.delete();
          akaze.delete();
          resolve(null);
          return;
        }

        // Match descriptors using BFMatcher
        const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
        const matches = new cv.DMatchVectorVector();
        bf.knnMatch(des1, des2, matches, 2);

        // Filter matches using Ratio Test
        const goodMatches = new cv.DMatchVector();
        const ratio = 0.8; // Relaxed ratio slightly
        for (let i = 0; i < matches.size(); ++i) {
          const m = matches.get(i).get(0);
          const n = matches.get(i).get(1);
          if (m.distance < ratio * n.distance) {
            goodMatches.push_back(m);
          }
        }

        if (goodMatches.size() < 4) {
          console.warn("AKAZE: Not enough matches found (< 4).");
          img1.delete(); img2.delete(); gray1.delete(); gray2.delete();
          kp1.delete(); kp2.delete(); des1.delete(); des2.delete();
          matches.delete(); goodMatches.delete(); akaze.delete(); bf.delete();
          resolve(null);
          return;
        }

        // Find Homography
        const srcPoints = [];
        const dstPoints = [];
        for (let i = 0; i < goodMatches.size(); ++i) {
          const m = goodMatches.get(i);
          const p1 = kp1.get(m.queryIdx).pt;
          const p2 = kp2.get(m.trainIdx).pt;
          srcPoints.push(p1.x); srcPoints.push(p1.y);
          dstPoints.push(p2.x); dstPoints.push(p2.y);
        }

        const srcMat = cv.matFromArray(srcPoints.length / 2, 1, cv.CV_32FC2, srcPoints);
        const dstMat = cv.matFromArray(dstPoints.length / 2, 1, cv.CV_32FC2, dstPoints);

        const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 5.0);

        if (H.empty()) {
          console.warn("AKAZE: Homography matrix is empty.");
          img1.delete(); img2.delete(); gray1.delete(); gray2.delete();
          kp1.delete(); kp2.delete(); des1.delete(); des2.delete();
          matches.delete(); goodMatches.delete(); akaze.delete(); bf.delete();
          srcMat.delete(); dstMat.delete(); H.delete();
          resolve(null);
          return;
        }

        // Project corners of the template to the scene
        const objCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
          0, 0,
          templateImg.width, 0,
          templateImg.width, templateImg.height,
          0, templateImg.height
        ]);
        const sceneCorners = new cv.Mat();
        cv.perspectiveTransform(objCorners, sceneCorners, H);

        // Calculate bounding box from projected corners
        let minX = Number.MAX_VALUE, minY = Number.MAX_VALUE;
        let maxX = Number.MIN_VALUE, maxY = Number.MIN_VALUE;

        for (let i = 0; i < 4; ++i) {
          const x = sceneCorners.data32F[i * 2];
          const y = sceneCorners.data32F[i * 2 + 1];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }

        // Normalize coordinates
        const normMinX = Math.max(0, minX / largeImg.width);
        const normMinY = Math.max(0, minY / largeImg.height);
        const normMaxX = Math.min(1, maxX / largeImg.width);
        const normMaxY = Math.min(1, maxY / largeImg.height);

        // Sanity check: verify the detected box size is reasonable
        // If the detected box is much smaller than the template, AKAZE likely found a partial match
        const detectedWidth = normMaxX - normMinX;
        const detectedHeight = normMaxY - normMinY;
        const templateAspect = templateImg.width / templateImg.height;
        const largeAspect = largeImg.width / largeImg.height;

        // Calculate expected template footprint in large image (normalized)
        const expectedMinSize = 0.3; // Detected box should be at least 30% of the large image dimension

        // If detected box is too small, reject the match
        if (detectedWidth < expectedMinSize && detectedHeight < expectedMinSize) {
          console.warn(`AKAZE: Detected box too small (${(detectedWidth * 100).toFixed(1)}% x ${(detectedHeight * 100).toFixed(1)}%), rejecting match`);
          // Cleanup
          img1.delete(); img2.delete(); gray1.delete(); gray2.delete();
          kp1.delete(); kp2.delete(); des1.delete(); des2.delete();
          matches.delete(); goodMatches.delete(); akaze.delete(); bf.delete();
          srcMat.delete(); dstMat.delete(); H.delete(); objCorners.delete(); sceneCorners.delete();
          resolve(null);
          return;
        }

        // Cleanup
        img1.delete(); img2.delete(); gray1.delete(); gray2.delete();
        kp1.delete(); kp2.delete(); des1.delete(); des2.delete();
        matches.delete(); goodMatches.delete(); akaze.delete(); bf.delete();
        srcMat.delete(); dstMat.delete(); H.delete(); objCorners.delete(); sceneCorners.delete();

        resolve([normMinY, normMinX, normMaxY, normMaxX]);

      } catch (e) {
        console.error("AKAZE execution failed:", e);
        resolve(null);
      }
    };

    largeImg.onload = onLoaded;
    templateImg.onload = onLoaded;
    largeImg.onerror = () => resolve(null);
    templateImg.onerror = () => resolve(null);

    largeImg.src = largeImageUrl;
    templateImg.src = templateImageUrl;
  });
};

export const findBestMatchPosition = async (
  largeImageUrl: string,
  templateImageUrl: string
): Promise<[number, number, number, number] | null> => {
  // Try AKAZE only - if it fails, caller should use tightBox2d fallback
  const akazeResult = await findBestMatchPositionAKAZE(largeImageUrl, templateImageUrl);
  if (akazeResult) {
    return akazeResult;
  }

  console.warn("AKAZE match failed, returning null (caller should use tightBox2d fallback)");
  return null;
};

export const generateDepthMap = async (imageUrl: string, apiKey?: string): Promise<string> => {
  const { Client } = await import("@gradio/client");

  // Ensure hfToken is undefined if empty string
  const token = apiKey && apiKey.trim().length > 0 ? apiKey : undefined;

  const space = 'depth-anything/Depth-Anything-V2';

  try {
    console.log(`[DepthMap] Connecting to ${space}...`);
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

/**
 * Refines overlaps by masking out pixels where other objects' non-transparent pixels exist.
 * Directly compares pixels between images using bbox coordinate transformation.
 */
export const refineOverlaps = async (objects: CroppedObject[], sceneWidth: number, sceneHeight: number, sceneUrl?: string): Promise<CroppedObject[]> => {
  if (objects.length < 2) return objects;

  // Load all images first
  const loadedImages: Map<string, { img: HTMLImageElement, data: ImageData }> = new Map();
  for (const obj of objects) {
    try {
      const img = await loadImageForMask(obj.imageUrl);
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.width;
      tempCanvas.height = img.height;
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) {
        tempCtx.drawImage(img, 0, 0);
        const data = tempCtx.getImageData(0, 0, img.width, img.height);
        loadedImages.set(obj.id, { img, data });
      }
    } catch (e) {
      console.warn(`Failed to load image for ${obj.label}`, e);
    }
  }

  const refinedObjects: CroppedObject[] = [];

  for (const currentObj of objects) {
    const current = loadedImages.get(currentObj.id);
    if (!current) {
      refinedObjects.push(currentObj);
      continue;
    }

    // Current bbox (normalized coordinates)
    const [cymin, cxmin, cymax, cxmax] = currentObj.box_2d;
    const cw = cxmax - cxmin;
    const ch = cymax - cymin;

    // Create canvas for result
    const canvas = document.createElement('canvas');
    canvas.width = current.img.width;
    canvas.height = current.img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      refinedObjects.push(currentObj);
      continue;
    }

    ctx.drawImage(current.img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    let modified = false;

    // Check against each other object
    for (const otherObj of objects) {
      if (otherObj.id === currentObj.id) continue;

      const other = loadedImages.get(otherObj.id);
      if (!other) continue;

      const [oymin, oxmin, oymax, oxmax] = otherObj.box_2d;
      const ow = oxmax - oxmin;
      const oh = oymax - oymin;

      // Check if bboxes overlap (in normalized coordinates)
      if (cxmax <= oxmin || oxmax <= cxmin || cymax <= oymin || oymax <= cymin) continue;

      // For each pixel in current image
      for (let py = 0; py < current.img.height; py++) {
        for (let px = 0; px < current.img.width; px++) {
          const idx = (py * current.img.width + px) * 4;

          // Skip already transparent pixels
          if (imageData.data[idx + 3] < 128) continue;

          // This pixel's position in normalized scene coordinates
          const normX = cxmin + (px / current.img.width) * cw;
          const normY = cymin + (py / current.img.height) * ch;

          // Check if this point is inside other's bbox
          if (normX < oxmin || normX >= oxmax || normY < oymin || normY >= oymax) continue;

          // Calculate corresponding pixel in other image
          const ox = Math.floor(((normX - oxmin) / ow) * other.img.width);
          const oy = Math.floor(((normY - oymin) / oh) * other.img.height);

          if (ox < 0 || ox >= other.img.width || oy < 0 || oy >= other.img.height) continue;

          const otherIdx = (oy * other.img.width + ox) * 4;
          const otherAlpha = other.data.data[otherIdx + 3];

          // Only proceed if other has non-transparent pixel here
          if (otherAlpha > 128) {
            // Compare pixel colors - only remove if colors match (same object visible in both)
            const r1 = imageData.data[idx];
            const g1 = imageData.data[idx + 1];
            const b1 = imageData.data[idx + 2];

            const r2 = other.data.data[otherIdx];
            const g2 = other.data.data[otherIdx + 1];
            const b2 = other.data.data[otherIdx + 2];

            // Calculate color difference
            const colorDiff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);

            // Only make transparent if colors are very similar (threshold: 40 for sum of RGB differences)
            if (colorDiff < 40) {
              imageData.data[idx + 3] = 0;
              modified = true;
            }
          }
        }
      }
    }

    if (modified) {
      ctx.putImageData(imageData, 0, 0);
      refinedObjects.push({
        ...currentObj,
        imageUrl: canvas.toDataURL('image/png'),
        isRefined: true
      });
    } else {
      refinedObjects.push(currentObj);
    }
  }

  return refinedObjects;
};



const loadImageForMask = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Only set crossOrigin for external URLs
    // Data URLs and Blob URLs are same-origin and don't need crossOrigin
    const isLocalUrl = url.startsWith('data:') || url.startsWith('blob:');
    if (!isLocalUrl) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
};

export const refineSingleOverlap = async (target: CroppedObject, all: CroppedObject[], width: number, height: number, sceneUrl?: string): Promise<CroppedObject> => {
  if (!sceneUrl) return target;

  // Use the wrapper function which tries AKAZE then SSD
  const matchBox = await findBestMatchPosition(sceneUrl, target.imageUrl);

  if (matchBox) {
    return {
      ...target,
      box_2d: matchBox
    };
  } else {
    console.warn(`No match found for ${target.label}`);
    return target;
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

    const space = 'microsoft/TRELLIS.2';
    console.log(`[TRELLIS] Connecting to ${space}...`);
    const client: any = await Client.connect(space, { hf_token: token } as any);
    // Test connection with start_session
    await client.predict("/start_session", {});
    console.log(`[TRELLIS] Connected to ${space} successfully`);

    // Convert to PNG and create File object (matching how Gradio UI sends files)
    const response = await fetch(imageUrl);
    const originalBlob = await response.blob();

    // Convert to PNG via canvas to ensure proper format
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = imageUrl;
    });

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
      console.log('TRELLIS.2: No foreground found, using full image');
      minX = 0; minY = 0; maxX = img.width; maxY = img.height;
    }

    console.log(`TRELLIS.2 foreground bbox: (${minX},${minY}) to (${maxX},${maxY})`);

    // Step 2: Calculate square crop centered on foreground
    const bboxWidth = maxX - minX;
    const bboxHeight = maxY - minY;
    const centerX = minX + bboxWidth / 2;
    const centerY = minY + bboxHeight / 2;
    const cropSize = Math.max(bboxWidth, bboxHeight);

    // Calculate crop bounds
    const cropX = Math.floor(centerX - cropSize / 2);
    const cropY = Math.floor(centerY - cropSize / 2);

    console.log(`TRELLIS.2 square crop: ${cropSize}x${cropSize} centered at (${centerX.toFixed(0)},${centerY.toFixed(0)})`);

    // Step 3: Create 1024x1024 output canvas with foreground centered
    // Square crop centered on foreground, then resize to 1024x1024
    const targetSize = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context failed');

    // Clear canvas (transparent padding)
    ctx.clearRect(0, 0, targetSize, targetSize);

    // Use cropSize, cropX, cropY already calculated in Step 2 above

    // Handle cases where crop extends beyond image bounds  
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

    console.log(`TRELLIS.2 preprocessing: white bg converted to transparent, alpha-premultiplied`);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to convert to PNG'));
      }, 'image/png');
    });

    // Create File object (Gradio expects File, not Blob)
    const imageFile = new File([pngBlob], 'input.png', { type: 'image/png' });
    console.log(`TRELLIS.2 sending as File: ${targetSize}x${targetSize}, type=${imageFile.type}, size=${imageFile.size} bytes`);

    // Step 2: Image to 3D with default parameters (using random seed like Gradio UI)
    const randomSeed = Math.floor(Math.random() * 2147483647);
    console.log(`TRELLIS.2 using seed: ${randomSeed}`);
    const result = await client.predict("/image_to_3d", {
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

    console.log("TRELLIS.2 /image_to_3d result:", result.data);

    // Step 3: Extract GLB
    const extractResult = await client.predict("/extract_glb", {
      decimation_target: 300000,
      texture_size: 2048,
    });

    const data = extractResult.data as any[];
    console.log("TRELLIS.2 /extract_glb result:", data);

    if (data && data.length > 0) {
      console.log("TRELLIS.2 /extract_glb data[0]:", JSON.stringify(data[0], null, 2));
      console.log("TRELLIS.2 /extract_glb data[1]:", JSON.stringify(data[1], null, 2));

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
          console.log("TRELLIS.2 using GLB URL:", glbUrl);
          // Include auth header for authenticated file access
          const fetchOptions: RequestInit = token ? {
            headers: { 'Authorization': `Bearer ${token}` }
          } : {};
          const response = await fetch(glbUrl, fetchOptions);
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