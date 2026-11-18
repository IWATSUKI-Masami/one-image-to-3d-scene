/**
 * Orientation estimation: rotation of each model about the vertical axis.
 *
 * Orient Anything (https://huggingface.co/spaces/Viglong/Orient-Anything)
 * estimates, from one image, the azimuth of the viewer around the object
 * (0° = the object faces the viewer) and a confidence that the object has a
 * meaningful orientation. It is run on
 *   - the photo appearance of the object (the completed, background-removed image), and
 *   - the 3D model rendered from the front (+Z),
 * so the generator's own idea of "front" cancels out.
 *
 * Convention (checked by rendering a model at known rotations):
 *   azimuth ≈ (world angle of the viewer seen from the object) − rotation.y
 * with world angles measured like three.js rotation.y (0 = +Z, positive towards +X).
 * Hence
 *   rotation.y = viewAngle + azimuth(model, front render) − azimuth(photo)
 * where viewAngle is the direction from the object towards the photo camera.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { removeStrayFragments } from '../components/meshCleanup';
import { Model3D, ModelOrientation } from '../types';

/** Below this confidence the object is treated as having no meaningful orientation */
export const MIN_ORIENTATION_CONFIDENCE = 0.5;

/**
 * Assumed horizontal field of view of the photo. The camera of the photo is
 * unknown; this only affects the small correction for objects away from the
 * image center.
 */
const ASSUMED_HFOV_DEG = 60;

/** Normalize an angle to (-180, 180] */
export const normalizeDeg = (deg: number): number => {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
};

interface AzimuthResult {
  azimuth: number;
  confidence: number;
}

/** Ask the Orient Anything Space for the azimuth of the object in an image */
const estimateAzimuth = async (image: Blob, space: string, hfToken?: string): Promise<AzimuthResult> => {
  const { Client } = await import('@gradio/client');
  const token = hfToken?.trim() ? (hfToken.trim() as `hf_${string}`) : undefined;
  const client: any = await Client.connect(space, token ? { token } : {});
  // The images are already background-removed, so the Space's own removal is off
  const result = await client.predict('/predict', {
    img: new File([image], 'input.png', { type: image.type || 'image/png' }),
    do_rm_bkg: false,
    do_infer_aug: false,
  });
  // Outputs: [rendered result, azimuth, polar, rotation, confidence] (numbers as strings)
  const data = result.data as unknown[];
  const azimuth = parseFloat(String(data?.[1]));
  const confidence = parseFloat(String(data?.[4]));
  if (!Number.isFinite(azimuth) || !Number.isFinite(confidence)) {
    throw new Error(`Unexpected response from ${space}`);
  }
  return { azimuth, confidence };
};

/** Render a model from the front (+Z, slightly from above) on a transparent background */
export const renderModelFront = async (glbUrl: string, size = 512): Promise<Blob> => {
  const gltf = await new GLTFLoader().loadAsync(glbUrl);
  const model = gltf.scene;
  removeStrayFragments(model);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  model.position.sub(center);

  const scene = new THREE.Scene();
  scene.add(model);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(1, 2, 3);
  scene.add(sun);

  const fov = 30;
  const distance = radius / Math.sin((fov / 2) * Math.PI / 180) * 1.05;
  const elevation = 10 * Math.PI / 180; // photos are usually taken slightly from above
  const camera = new THREE.PerspectiveCamera(fov, 1, distance / 100, distance * 10);
  camera.position.set(0, Math.sin(elevation) * distance, Math.cos(elevation) * distance);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  try {
    renderer.setSize(size, size, false);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
        if (mat?.map) mat.map.colorSpace = THREE.SRGBColorSpace;
      }
    });
    renderer.render(scene, camera);
    return await new Promise<Blob>((resolve, reject) =>
      renderer.domElement.toBlob(b => (b ? resolve(b) : reject(new Error('Rendering failed'))), 'image/png'));
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

/**
 * Direction from the object towards the photo camera, as a rotation about Y.
 * An object right of the image center (+X) sees the camera to its left (negative angle).
 */
export const viewAngleDeg = (box2d: [number, number, number, number] | undefined): number => {
  if (!box2d) return 0;
  const u = (box2d[1] + box2d[3]) / 2; // horizontal center, 0..1
  const halfWidth = Math.tan((ASSUMED_HFOV_DEG / 2) * Math.PI / 180);
  return -Math.atan((u - 0.5) * 2 * halfWidth) * 180 / Math.PI;
};

/** Estimate the rotation of a model about the vertical axis */
export const estimateModelOrientation = async (model: Model3D, space: string, hfToken?: string): Promise<ModelOrientation> => {
  const photoImage = await (await fetch(model.posterUrl)).blob();
  const frontImage = await renderModelFront(model.glbUrl);
  const [photo, front] = await Promise.all([
    estimateAzimuth(photoImage, space, hfToken),
    estimateAzimuth(frontImage, space, hfToken),
  ]);
  const view = viewAngleDeg(model.box_2d);
  const meaningful = photo.confidence >= MIN_ORIENTATION_CONFIDENCE;
  // If the front render has no clear orientation, assume the generator's front is +Z
  const modelAzimuth = front.confidence >= MIN_ORIENTATION_CONFIDENCE ? front.azimuth : 0;
  return {
    yawDeg: meaningful ? normalizeDeg(view + modelAzimuth - photo.azimuth) : 0,
    photoAzimuth: photo.azimuth,
    modelAzimuth: front.azimuth,
    confidence: photo.confidence,
    modelConfidence: front.confidence,
    viewAngle: view,
  };
};
