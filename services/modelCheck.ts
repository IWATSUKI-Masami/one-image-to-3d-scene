/**
 * Model check: after a 3D model is generated, a vision-language model compares
 * it with the object in the photo and proposes a corrected annotation when the
 * model is clearly a different kind of object or in a different state (e.g. an
 * open laptop seen from the back of its screen, described as "closed" and
 * generated as a box). The proposal is added as a new extracted card; the user
 * decides whether to complete it and generate it again.
 *
 * The instructions are general: they name no test photo and no object of one.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { removeStrayFragments } from '../components/meshCleanup';
import { analyzeImageJson, loadImageData, type JsonSchema } from './ai/providers';
import type { AISettings } from '../types';

export interface ModelCheckResult {
  /** The model shows the same kind of object, in the same state, as the photo */
  matches: boolean;
  /** What is wrong (empty if it matches) */
  problem: string;
  /** A corrected annotation would likely fix it (false: e.g. a pose or shape detail that the annotation cannot fix) */
  fixableByAnnotation: boolean;
  /** Proposed label and description (only when fixable) */
  label: string;
  description: string;
  /** When the check ran */
  checkedAt: string;
}

const VIEW_SIZE = 384;

/** Render the model from the front (after the given turn), obliquely from the front left and from above, on white */
export const renderModelViews = async (glbUrl: string, yawDeg: number): Promise<string[]> => {
  const gltf = await new GLTFLoader().loadAsync(glbUrl);
  const model = gltf.scene;
  removeStrayFragments(model);
  const box = new THREE.Box3().setFromObject(model);
  model.position.sub(box.getCenter(new THREE.Vector3()));
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const turn = new THREE.Group();
  turn.add(model);
  turn.rotation.y = yawDeg * Math.PI / 180;

  const scene = new THREE.Scene();
  scene.add(turn);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  const fov = 30;
  const distance = radius / Math.sin((fov / 2) * Math.PI / 180) * 1.05;
  const camera = new THREE.PerspectiveCamera(fov, 1, distance / 100, distance * 10);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(VIEW_SIZE, VIEW_SIZE, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xffffff, 1);
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
        if (mat?.map) mat.map.colorSpace = THREE.SRGBColorSpace;
      }
    });
    // [azimuth from the front (degrees, + = from the left), elevation (degrees)]
    const views: [number, number][] = [[0, 8], [-45, 30], [0, 89]];
    return views.map(([az, el]) => {
      const a = az * Math.PI / 180, e = el * Math.PI / 180;
      camera.position.set(Math.sin(a) * Math.cos(e) * distance, Math.sin(e) * distance, Math.cos(a) * Math.cos(e) * distance);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    });
  } finally {
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

const loadImg = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const el = new Image();
  el.crossOrigin = 'anonymous';
  el.onload = () => resolve(el);
  el.onerror = () => reject(new Error('Failed to load an image for the model check'));
  el.src = url;
});

/** One image with labelled panels side by side (white background), as a PNG data URL */
export const composeSheet = async (panels: { title: string; url: string }[], height = 384): Promise<string> => {
  const imgs = await Promise.all(panels.map(p => loadImg(p.url)));
  const widths = imgs.map(i => Math.round(i.naturalWidth * height / i.naturalHeight));
  const gap = 12, titleH = 28;
  const c = document.createElement('canvas');
  c.width = widths.reduce((a, b) => a + b, 0) + gap * (imgs.length + 1);
  c.height = height + titleH + gap;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#111111';
  let x = gap;
  imgs.forEach((img, i) => {
    ctx.fillText(`${String.fromCharCode(65 + i)}: ${panels[i].title}`, x, 20);
    ctx.drawImage(img, x, titleH, widths[i], height);
    ctx.strokeStyle = '#cccccc';
    ctx.strokeRect(x, titleH, widths[i], height);
    x += widths[i] + gap;
  });
  return c.toDataURL('image/png');
};

/**
 * The object's box cut out of the photo, with every pixel outside the object's mask
 * faded to white, so that other objects inside the box (e.g. a chair behind a laptop)
 * are not taken for it
 */
export const makeObjectOnlyImage = async (photoUrl: string, maskUrl: string, box: [number, number, number, number]): Promise<string> => {
  const [photo, mask] = await Promise.all([loadImg(photoUrl), loadImg(maskUrl)]);
  const W = photo.naturalWidth, H = photo.naturalHeight;
  const [ymin, xmin, ymax, xmax] = box;
  const pad = 0.15;
  const bw = (xmax - xmin) * W, bh = (ymax - ymin) * H;
  const x0 = Math.max(0, Math.floor(xmin * W - pad * bw)), y0 = Math.max(0, Math.floor(ymin * H - pad * bh));
  const x1 = Math.min(W, Math.ceil(xmax * W + pad * bw)), y1 = Math.min(H, Math.ceil(ymax * H + pad * bh));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  // The object's pixels only
  const obj = document.createElement('canvas');
  obj.width = w; obj.height = h;
  const octx = obj.getContext('2d')!;
  octx.drawImage(mask, x0 * mask.naturalWidth / W, y0 * mask.naturalHeight / H, w * mask.naturalWidth / W, h * mask.naturalHeight / H, 0, 0, w, h);
  octx.globalCompositeOperation = 'source-in';
  octx.drawImage(photo, x0, y0, w, h, 0, 0, w, h);
  // The box region faded, with the object on top
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(photo, x0, y0, w, h, 0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(obj, 0, 0);
  return c.toDataURL('image/png');
};

const CHECK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    matches: { type: 'boolean', description: 'true if the 3D model shows the same kind of object, in the same state and overall shape, as the object marked in the photo' },
    problem: { type: 'string', description: 'If it does not match: what differs, with the evidence in the photo (one or two sentences). Empty if it matches.' },
    fixable_by_annotation: { type: 'boolean', description: 'true if a corrected label and description would likely make the image model draw the object correctly (a wrong kind, state or overall shape); false for differences an annotation cannot fix (details of pose, texture, proportions of a part whose size is not visible in the photo)' },
    label: { type: 'string', description: 'Corrected short label (English), or the current one if no correction is proposed' },
    description: { type: 'string', description: 'Corrected description (English), written like the current one, or the current one if no correction is proposed' },
  },
  required: ['matches', 'problem', 'fixable_by_annotation', 'label', 'description'],
  additionalProperties: false,
};

const PROMPT = (label: string, description: string, type: 'person' | 'object', hasMask: boolean) => `You check a 3D model generated from a photo, one object at a time.
How it was made: the object marked by the red box in the photo was cut out, its hidden parts were drawn by an image model guided by the annotation below, and a 3D model was generated from that completed image. If the annotation is wrong (e.g. it names the wrong kind of object, or the wrong state such as closed instead of open, folded instead of unfolded, or the wrong overall shape), the completed image and the 3D model follow the annotation instead of the photo.

The image has these panels:
A: the photo, with the object's box marked in red
${hasMask
    ? `B: the object alone: its box cut out of the photo, with everything that is not the object faded to white
C: the completed image (what the 3D model was generated from)
D: the 3D model seen from the front, as in the photo
E: the 3D model seen obliquely from the front left and above
F: the 3D model seen from directly above`
    : `B: the completed image (what the 3D model was generated from)
C: the 3D model seen from the front, as in the photo
D: the 3D model seen obliquely from the front left and above
E: the 3D model seen from directly above`}

Which object is meant: the object named in the annotation${hasMask ? ', whose visible pixels are shown in panel B' : ''}. The red box often also contains other objects (in front of it or behind it, e.g. a chair behind a laptop or a table under a cup); they are NOT the object to check, even if they fill most of the box. Never propose an annotation for another object: the correction may change the object's state, shape or kind only when the object itself is clearly misdescribed.

Current annotation (${type}):
label: ${label}
description: ${description || '(none)'}

Task: decide whether the 3D model is the same kind of object, in the same state and with the same overall shape, as this object in the photo. Judge from what the photo shows, including what follows from it (e.g. a part seen standing upright in the photo cannot be lying flat). Ignore differences the photo cannot show, small details of texture and color, and the exact pose of people.
If it does not match, say what differs and why, and propose a corrected label and description that would make the image model draw it correctly: keep everything in the current annotation that is right, and state the corrected kind, state or shape explicitly. Set fixable_by_annotation to false if the difference is not a matter of the annotation.
If it matches, set matches to true, leave problem empty and return the current label and description.`;

/** Ask the vision model whether a generated 3D model matches its object in the photo */
export const checkModelAgainstPhoto = async (
  settings: AISettings,
  input: { referenceUrl: string; objectOnlyUrl?: string; completedUrl: string; glbUrl: string; yawDeg: number; label: string; description: string; type: 'person' | 'object' },
): Promise<ModelCheckResult> => {
  const views = await renderModelViews(input.glbUrl, input.yawDeg);
  const sheet = await composeSheet([
    { title: 'photo (object\'s box in red)', url: input.referenceUrl },
    ...(input.objectOnlyUrl ? [{ title: 'the object alone', url: input.objectOnlyUrl }] : []),
    { title: 'completed image', url: input.completedUrl },
    { title: '3D model, front', url: views[0] },
    { title: '3D model, oblique', url: views[1] },
    { title: '3D model, from above', url: views[2] },
  ]);
  const image = await loadImageData(sheet);
  const r = await analyzeImageJson<{ matches: boolean; problem: string; fixable_by_annotation: boolean; label: string; description: string }>(
    settings, image, PROMPT(input.label, input.description, input.type, !!input.objectOnlyUrl), CHECK_SCHEMA, { schemaName: 'model_check', effort: 'medium' },
  );
  return {
    matches: !!r.matches,
    problem: r.problem || '',
    fixableByAnnotation: !r.matches && !!r.fixable_by_annotation,
    label: r.label || input.label,
    description: r.description || input.description,
    checkedAt: new Date().toISOString(),
  };
};
