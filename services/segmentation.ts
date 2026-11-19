/**
 * Object masks in the photo: which pixels of each detected object are visible.
 *
 * SAM 2.1 (Segment Anything 2.1, Meta, Apache-2.0) runs in the browser with
 * transformers.js, prompted with the box of each detected object. The model is
 * downloaded from Hugging Face on first use and cached by the browser; no API
 * key, token or GPU quota is needed. WebGPU is used when available, otherwise
 * WebAssembly (slower).
 *
 * The masks show only what is visible: an object behind another object or cut
 * off at the image border gets a mask of its visible part. They are used for
 * the object's depth (paper, Eq. (4)) and, in the next stage, for fitting
 * partially visible 3D models to the photo.
 */
import type { Box2D } from '../components/depthSampling';

export const DEFAULT_SEGMENTATION_MODEL = 'onnx-community/sam2.1-hiera-small-ONNX';

/** The image is downscaled to this longest side before segmentation (SAM itself works at 1024×1024) */
const MAX_IMAGE_SIDE = 1024;

export interface ObjectSegmentation {
  /** PNG data URL of the mask: white, alpha 255 inside the object, 0 elsewhere (size of the downscaled photo) */
  maskUrl: string;
  /** SAM's predicted IoU of the chosen mask (0..1) */
  score: number;
  /** Fraction of the object's box covered by the mask (0..1) */
  coverage: number;
}

interface LoadedModel {
  id: string;
  model: any;
  processor: any;
  device: string;
}

let loaded: Promise<LoadedModel> | null = null;
let loadedId = '';

const hasWebGPU = async (): Promise<boolean> => {
  const gpu = (navigator as any).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
};

const loadModel = (modelId: string, onProgress?: (message: string) => void): Promise<LoadedModel> => {
  if (loaded && loadedId === modelId) return loaded;
  loadedId = modelId;
  loaded = (async () => {
    const { Sam2Model, AutoProcessor } = await import('@huggingface/transformers');
    const device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
    // fp16 halves the download on WebGPU; WebAssembly runs int8 faster than fp16
    const dtype = device === 'webgpu' ? 'fp16' : 'int8';
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (p: any) => {
      if (p.status === 'progress' && p.file) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
        let done = 0, total = 0;
        files.forEach(f => { done += f.loaded; total += f.total; });
        if (total > 0) onProgress?.(`downloading model ${Math.round(done / 1e6)} / ${Math.round(total / 1e6)} MB`);
      }
    };
    const [model, processor] = await Promise.all([
      Sam2Model.from_pretrained(modelId, { device, dtype, progress_callback } as any),
      AutoProcessor.from_pretrained(modelId, { progress_callback } as any),
    ]);
    return { id: modelId, model, processor, device };
  })();
  // A failed load (e.g. network error) can be retried
  loaded.catch(() => { if (loadedId === modelId) { loaded = null; loadedId = ''; } });
  return loaded;
};

/** Draw the photo downscaled to at most MAX_IMAGE_SIDE */
const loadDownscaledImage = async (imageUrl: string): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> => {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Failed to load the photo'));
    el.src = imageUrl;
  });
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
  return { canvas, width, height };
};

/** Encode a binary mask as a PNG data URL (white, opaque inside) */
const maskToDataUrl = (mask: Uint8Array, width: number, height: number): string => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    image.data[o] = image.data[o + 1] = image.data[o + 2] = 255;
    image.data[o + 3] = mask[i] ? 255 : 0;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
};

/**
 * Segment the visible part of each object, prompted with its box.
 * Returns one result per box (null where segmentation failed).
 */
export const segmentObjects = async (
  imageUrl: string,
  boxes: Box2D[],
  modelId: string = DEFAULT_SEGMENTATION_MODEL,
  onProgress?: (message: string) => void,
): Promise<(ObjectSegmentation | null)[]> => {
  modelId = modelId.trim() || DEFAULT_SEGMENTATION_MODEL;
  onProgress?.('loading model');
  const { model, processor } = await loadModel(modelId, onProgress);
  const { RawImage } = await import('@huggingface/transformers');

  const { canvas, width, height } = await loadDownscaledImage(imageUrl);
  const image = RawImage.fromCanvas(canvas);

  onProgress?.('encoding image');
  const inputs = await processor(image);
  // The image encoder runs once; each box only runs the light mask decoder
  const embeddings = await model.get_image_embeddings(inputs);

  const results: (ObjectSegmentation | null)[] = [];
  for (let b = 0; b < boxes.length; b++) {
    onProgress?.(`segmenting ${b + 1} / ${boxes.length}`);
    try {
      const [ymin, xmin, ymax, xmax] = boxes[b];
      const box = [xmin * width, ymin * height, xmax * width, ymax * height];
      const input_boxes = processor.reshape_input_points([[box]], inputs.original_sizes, inputs.reshaped_input_sizes, true);
      const outputs = await model({ ...embeddings, input_boxes });
      const [masks] = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
      // masks: [boxes = 1, candidates, height, width]; pick the candidate with the best predicted IoU
      const scores = Array.from(outputs.iou_scores.data as Float32Array);
      const best = scores.indexOf(Math.max(...scores));
      const plane = width * height;
      const data = masks.data as Uint8Array;

      // The visible object lies inside its box: drop mask pixels outside it
      const x0 = Math.max(0, Math.floor(xmin * width)), x1 = Math.min(width, Math.ceil(xmax * width));
      const y0 = Math.max(0, Math.floor(ymin * height)), y1 = Math.min(height, Math.ceil(ymax * height));
      const mask = new Uint8Array(plane);
      let inside = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * width + x;
          if (data[best * plane + i]) { mask[i] = 1; inside++; }
        }
      }
      const boxArea = Math.max(1, (x1 - x0) * (y1 - y0));
      results.push({ maskUrl: maskToDataUrl(mask, width, height), score: scores[best], coverage: inside / boxArea });
    } catch (e) {
      console.error(`Segmentation failed for box ${b}:`, e);
      results.push(null);
    }
  }
  return results;
};
