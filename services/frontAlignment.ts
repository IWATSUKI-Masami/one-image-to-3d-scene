/**
 * Front alignment: turn a generated 3D model so that, seen from the front (+Z),
 * it looks like the completed image it was generated from.
 *
 * Image-to-3D generators (TRELLIS.2, Hunyuan3D-2.1) do not always keep the
 * viewpoint of the input image: a chair seen obliquely may come back facing
 * another way. Everything that maps the completed image onto the model (the
 * visible part's box, the box placement, the fit) assumes that the model's front
 * view is the completed image. This module finds the rotation about the vertical
 * axis that makes it so, by rendering the model at many angles and comparing
 * each rendering with the completed image (silhouette overlap, aspect ratio and
 * brightness pattern).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { removeStrayFragments } from '../components/meshCleanup';

export interface FrontAlignment {
  /** Rotation about the vertical axis (degrees, three.js rotation.y) to apply to the model */
  yawDeg: number;
  /** Match score of the best angle (higher is better; about 1 for a perfect match) */
  score: number;
  /** Silhouette overlap (IoU) at the best angle */
  iou: number;
}

/** Comparison grid (pixels per side) */
const N = 64;
const RENDER_SIZE = 192;

interface Signature {
  mask: Uint8Array;
  gray: Float32Array;
  aspect: number;
}

/** Crop RGBA pixels to the bounds of their alpha and resample to N×N */
const signatureOf = (data: Uint8ClampedArray | Uint8Array, width: number, height: number, flipY = false): Signature | null => {
  let x0 = width, x1 = -1, y0 = height, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 128) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const mask = new Uint8Array(N * N);
  const gray = new Float32Array(N * N);
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    const sx = Math.min(width - 1, x0 + Math.floor((gx + 0.5) / N * bw));
    // Rendered pixels are read bottom row first: the image's top row is the bounds' last row
    const sy = flipY ? y1 - Math.floor((gy + 0.5) / N * bh) : Math.min(height - 1, y0 + Math.floor((gy + 0.5) / N * bh));
    const o = (sy * width + sx) * 4;
    const i = gy * N + gx;
    mask[i] = data[o + 3] > 128 ? 1 : 0;
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return { mask, gray, aspect: bw / bh };
};

/** Similarity of two signatures: silhouette IoU, brightness correlation and aspect ratio */
const compare = (a: Signature, b: Signature): { score: number; iou: number } => {
  let inter = 0, union = 0, n = 0, ma = 0, mb = 0;
  for (let i = 0; i < N * N; i++) {
    if (a.mask[i] && b.mask[i]) { inter++; n++; ma += a.gray[i]; mb += b.gray[i]; }
    if (a.mask[i] || b.mask[i]) union++;
  }
  const iou = union > 0 ? inter / union : 0;
  let ncc = 0;
  if (n > 16) {
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < N * N; i++) if (a.mask[i] && b.mask[i]) {
      const da = a.gray[i] - ma, db = b.gray[i] - mb;
      sab += da * db; saa += da * da; sbb += db * db;
    }
    if (saa > 0 && sbb > 0) ncc = sab / Math.sqrt(saa * sbb);
  }
  const aspectPenalty = Math.abs(Math.log(a.aspect / b.aspect));
  return { score: iou + 0.4 * Math.max(0, ncc) - 0.5 * aspectPenalty, iou };
};

const loadImagePixels = async (url: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> => {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Failed to load the completed image'));
    el.src = url;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
};

/** Below this score the match is not trusted and the model is not turned */
export const MIN_ALIGNMENT_SCORE = 0.5;

/** Rotation to apply for a model's front alignment (0 if none or not trusted) */
export const alignmentYawDeg = (alignment?: { yawDeg: number; score: number }): number =>
  alignment && alignment.score >= MIN_ALIGNMENT_SCORE ? alignment.yawDeg : 0;

const normalizeDeg = (d: number): number => ((d % 360) + 540) % 360 - 180;

/**
 * Find the rotation about the vertical axis at which the model, seen from the
 * front, best matches the completed image (which must have a transparent background).
 * `baseYawDeg` is the rotation the app already applies to this kind of model.
 */
export const estimateFrontAlignment = async (glbUrl: string, completedImageUrl: string, baseYawDeg = 0): Promise<FrontAlignment> => {
  const pixels = await loadImagePixels(completedImageUrl);
  const target = signatureOf(pixels.data, pixels.width, pixels.height);
  if (!target) throw new Error('The completed image has no opaque pixels');

  const gltf = await new GLTFLoader().loadAsync(glbUrl);
  const model = gltf.scene;
  removeStrayFragments(model);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  model.position.sub(center);
  const turn = new THREE.Group();
  turn.add(model);

  const scene = new THREE.Scene();
  scene.add(turn);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(1, 2, 3);
  scene.add(sun);

  // Photos are usually taken at about eye level, slightly from above
  const fov = 25;
  const distance = radius / Math.sin((fov / 2) * Math.PI / 180) * 1.05;
  const elevation = 8 * Math.PI / 180;
  const camera = new THREE.PerspectiveCamera(fov, 1, distance / 100, distance * 10);
  camera.position.set(0, Math.sin(elevation) * distance, Math.cos(elevation) * distance);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const target3 = new THREE.WebGLRenderTarget(RENDER_SIZE, RENDER_SIZE);
  const buffer = new Uint8Array(RENDER_SIZE * RENDER_SIZE * 4);
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(RENDER_SIZE, RENDER_SIZE, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
        if (mat?.map) mat.map.colorSpace = THREE.SRGBColorSpace;
      }
    });

    const evaluate = (yawDeg: number) => {
      turn.rotation.y = (baseYawDeg + yawDeg) * Math.PI / 180;
      renderer.setRenderTarget(target3);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target3, 0, 0, RENDER_SIZE, RENDER_SIZE, buffer);
      renderer.setRenderTarget(null);
      const sig = signatureOf(buffer, RENDER_SIZE, RENDER_SIZE, true);
      return sig ? compare(target, sig) : { score: -Infinity, iou: 0 };
    };

    // Coarse search every 10°, then refine around the best angle in 2° steps.
    // A small preference for small turns keeps nearly symmetric objects (cups, vases)
    // as generated when other angles match about as well.
    const preference = (yaw: number) => 0.02 * Math.abs(normalizeDeg(yaw)) / 180;
    let best = { yawDeg: 0, score: -Infinity, iou: 0, ranked: -Infinity };
    const consider = (yaw: number) => {
      const r = evaluate(yaw);
      const ranked = r.score - preference(yaw);
      if (ranked > best.ranked) best = { yawDeg: yaw, ...r, ranked };
    };
    for (let yaw = -180; yaw < 180; yaw += 10) consider(yaw);
    const coarse = best.yawDeg;
    for (let yaw = coarse - 8; yaw <= coarse + 8; yaw += 2) consider(yaw);
    return { yawDeg: normalizeDeg(best.yawDeg), score: best.score, iou: best.iou };
  } finally {
    target3.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    scene.traverse((obj: any) => {
      obj.geometry?.dispose?.();
      for (const m of (Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [])) {
        for (const value of Object.values(m) as any[]) if (value?.isTexture) value.dispose();
        m.dispose?.();
      }
    });
  }
};
