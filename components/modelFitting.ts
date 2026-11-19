/**
 * Fitting a 3D model to the photo by rendering it (analysis-by-synthesis).
 *
 * The model is rendered from the photo's camera (pinhole at the origin looking
 * along -Z, as in the perspective placement of the 3D scene), and its position,
 * size and rotation about the vertical axis are searched so that the rendering
 * does not contradict the photo. Only conditions that hold in any scene are used:
 *
 *   1. Cover the visible part: the object's mask (its visible pixels in the
 *      photo) is covered by the rendered model.
 *   2. No unexplained absence: where the model would be drawn in the image but
 *      the photo shows a surface farther away (e.g. the wall), the model would
 *      have been visible; that is a violation. Behind nearer surfaces (other
 *      objects) and outside the image the model may extend freely.
 *   3. Matching depth: on the visible part, the model's depth agrees with the
 *      depth map.
 *   4. Size prior (optional): the scale stays near the scale expected from the
 *      object's typical real size.
 *
 * Which part of the model is visible follows from the fit; nothing is specific
 * to an object category.
 */
import * as THREE from 'three';

/** Camera of the photo: horizontal field of view and aspect ratio (width / height) */
export interface FitCamera {
  hfovDeg: number;
  aspect: number;
}

/** What the photo shows, sampled on a small grid (row-major, top row first) */
export interface FitTarget {
  width: number;
  height: number;
  /** 1 where the object is visible */
  mask: Uint8Array;
  /** Distance along the viewing axis (world units) of the surface seen at each pixel */
  depth: Float32Array;
}

/**
 * Pose of the model: its origin is placed at image position (u, v) (0..1, may lie
 * outside the image) at viewing distance `depth`, scaled uniformly and rotated
 * about the vertical axis.
 */
export interface FitPose {
  u: number;
  v: number;
  depth: number;
  scale: number;
  yawDeg: number;
}

export interface FitTerms {
  /** Fraction of the mask not covered by the model (condition 1) */
  miss: number;
  /** Model pixels in front of the observed surface, relative to the mask area (condition 2) */
  violation: number;
  /** Mean |log(model depth / photo depth)| on the covered mask (condition 3) */
  depthError: number;
  /** Size prior term (condition 4) */
  prior: number;
}

export interface FitResult {
  pose: FitPose;
  cost: number;
  terms: FitTerms;
  /** Cost of the initial pose, for comparison */
  initialCost: number;
}

export interface ScalePrior {
  scale: number;
  /** Standard deviation of log(scale) */
  sigmaLog: number;
}

export interface FitOptions {
  initial: FitPose;
  scalePrior?: ScalePrior;
  /** Yaw angles (degrees) tried in the coarse search; default: around the initial yaw */
  yawCandidates?: number[];
}

// Weights of the terms. Miss and violation are fractions of the mask area.
const W_MISS = 1;
const W_VIOLATION = 1;
const W_DEPTH = 1;
const W_PRIOR = 0.2;
/** A model pixel counts as a violation when it is this much nearer than the observed surface */
const VIOLATION_TOLERANCE = 0.08;
/** Depth encoding range of the renderer (world units) */
const DEPTH_MAX = 200;

export const toWorld = (u: number, v: number, depth: number, camera: FitCamera): THREE.Vector3 => {
  const tanH = Math.tan((camera.hfovDeg / 2) * Math.PI / 180);
  return new THREE.Vector3(
    (u - 0.5) * 2 * tanH * depth,
    -(v - 0.5) * 2 * (tanH / camera.aspect) * depth,
    -depth,
  );
};

export const fromWorld = (p: THREE.Vector3, camera: FitCamera): { u: number; v: number; depth: number } => {
  const tanH = Math.tan((camera.hfovDeg / 2) * Math.PI / 180);
  const depth = -p.z;
  return {
    u: p.x / (2 * tanH * depth) + 0.5,
    v: 0.5 - p.y / (2 * (tanH / camera.aspect) * depth),
    depth,
  };
};

/** Pixels covered by a rendering: indices and their depths */
interface Rendering {
  xs: Int16Array;
  ys: Int16Array;
  depths: Float32Array;
  count: number;
}

/**
 * Offscreen renderer of model depth. One instance renders one model at a time;
 * call dispose() when done.
 */
export class FitRenderer {
  readonly width: number;
  readonly height: number;
  private renderer: THREE.WebGLRenderer;
  private target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private root = new THREE.Group();
  private yawGroup = new THREE.Group();
  private pixels: Uint8Array;
  private fitCamera: FitCamera;

  constructor(width: number, height: number, camera: FitCamera) {
    this.width = width;
    this.height = height;
    this.fitCamera = camera;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
    const tanH = Math.tan((camera.hfovDeg / 2) * Math.PI / 180);
    const vfov = 2 * Math.atan(tanH / camera.aspect) * 180 / Math.PI;
    this.camera = new THREE.PerspectiveCamera(vfov, camera.aspect, 0.01, DEPTH_MAX);
    this.scene.overrideMaterial = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: `
        varying float vDepth;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        precision highp float;
        varying float vDepth;
        void main() {
          float d = clamp(vDepth / ${DEPTH_MAX.toFixed(1)}, 0.0, 1.0) * 65535.0;
          float hi = floor(d / 256.0);
          float lo = d - hi * 256.0;
          gl_FragColor = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
        }`,
    });
    this.root.add(this.yawGroup);
    this.scene.add(this.root);
    this.pixels = new Uint8Array(width * height * 4);
  }

  /** Set the object to render (it is re-parented into the renderer's scene) */
  setObject(object: THREE.Object3D) {
    while (this.yawGroup.children.length) this.yawGroup.remove(this.yawGroup.children[0]);
    this.yawGroup.add(object);
  }

  render(pose: FitPose): Rendering {
    this.root.position.copy(toWorld(pose.u, pose.v, pose.depth, this.fitCamera));
    this.root.scale.setScalar(pose.scale);
    this.yawGroup.rotation.y = pose.yawDeg * Math.PI / 180;
    this.root.updateMatrixWorld(true);
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, this.width, this.height, this.pixels);
    this.renderer.setRenderTarget(null);

    const { width, height, pixels } = this;
    const xs = new Int16Array(width * height);
    const ys = new Int16Array(width * height);
    const depths = new Float32Array(width * height);
    let count = 0;
    for (let row = 0; row < height; row++) {
      // readPixels starts at the bottom row
      const y = height - 1 - row;
      for (let x = 0; x < width; x++) {
        const o = (row * width + x) * 4;
        if (pixels[o + 3] === 0) continue;
        xs[count] = x;
        ys[count] = y;
        depths[count] = ((pixels[o] * 256 + pixels[o + 1]) / 65535) * DEPTH_MAX;
        count++;
      }
    }
    return { xs, ys, depths, count };
  }

  dispose() {
    this.setObject(new THREE.Group());
    this.target.dispose();
    (this.scene.overrideMaterial as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

const priorTerm = (scale: number, prior?: ScalePrior): number => {
  if (!prior) return 0;
  const z = Math.log(scale / prior.scale) / prior.sigmaLog;
  return z * z;
};

/**
 * Cost of a rendering shifted by (dx, dy) pixels. Pixels outside the image
 * carry no information and are ignored.
 */
const evaluate = (r: Rendering, target: FitTarget, maskCount: number, dx: number, dy: number): Omit<FitTerms, 'prior'> => {
  const { width, height, mask, depth } = target;
  let covered = 0;
  let violation = 0;
  let depthError = 0;
  for (let i = 0; i < r.count; i++) {
    const x = r.xs[i] + dx;
    const y = r.ys[i] + dy;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const t = y * width + x;
    const observed = depth[t];
    if (mask[t]) {
      covered++;
      depthError += Math.abs(Math.log(r.depths[i] / observed));
    } else if (r.depths[i] < observed * (1 - VIOLATION_TOLERANCE)) {
      violation++;
    }
  }
  return {
    miss: 1 - covered / maskCount,
    violation: violation / maskCount,
    depthError: covered > 0 ? depthError / covered : 1,
  };
};

const total = (t: FitTerms): number =>
  W_MISS * t.miss + W_VIOLATION * t.violation + W_DEPTH * t.depthError + W_PRIOR * t.prior;

/** Cost of a pose, rendered exactly */
export const poseCost = (renderer: FitRenderer, target: FitTarget, pose: FitPose, prior?: ScalePrior): { cost: number; terms: FitTerms } => {
  const maskCount = target.mask.reduce((a, b) => a + b, 0);
  const terms = { ...evaluate(renderer.render(pose), target, Math.max(1, maskCount), 0, 0), prior: priorTerm(pose.scale, prior) };
  return { cost: total(terms), terms };
};

/** Nelder–Mead minimization */
const nelderMead = (f: (x: number[]) => number, x0: number[], step: number[], iterations: number): { x: number[]; fx: number } => {
  const n = x0.length;
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step[j] : v)))];
  let values = simplex.map(f);
  for (let it = 0; it < iterations; it++) {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
    simplex = order.map(i => simplex[i]);
    values = order.map(i => values[i]);
    const centroid = Array.from({ length: n }, (_, j) => simplex.slice(0, n).reduce((s, p) => s + p[j], 0) / n);
    const worst = simplex[n];
    const at = (t: number) => centroid.map((c, j) => c + t * (worst[j] - c));
    const reflected = at(-1);
    const fr = f(reflected);
    if (fr < values[0]) {
      const expanded = at(-2);
      const fe = f(expanded);
      [simplex[n], values[n]] = fe < fr ? [expanded, fe] : [reflected, fr];
    } else if (fr < values[n - 1]) {
      [simplex[n], values[n]] = [reflected, fr];
    } else {
      const contracted = at(0.5);
      const fc = f(contracted);
      if (fc < values[n]) {
        [simplex[n], values[n]] = [contracted, fc];
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best], fx: values[best] };
};

/**
 * Fit the object to the photo. The object is rendered as given (its own
 * position/rotation are kept) inside a group that receives the pose.
 */
export const fitModel = (renderer: FitRenderer, target: FitTarget, options: FitOptions): FitResult => {
  const { initial, scalePrior } = options;
  const { width, height } = target;
  const maskCount = Math.max(1, target.mask.reduce((a, b) => a + b, 0));
  const initialEval = poseCost(renderer, target, initial, scalePrior);

  const yaws = options.yawCandidates ?? [-30, -15, 0, 15, 30].map(d => initial.yawDeg + d);
  const baseScale = scalePrior?.scale ?? initial.scale;
  const scales = (scalePrior ? [0.65, 0.75, 0.87, 1, 1.15, 1.3, 1.5] : [0.5, 0.7, 1, 1.4, 2, 2.8]).map(f => baseScale * f);
  const depths = [0.85, 0.93, 1.0, 1.08, 1.17, 1.27].map(f => initial.depth * f);

  // Mask bounds, used to skip shifts without any overlap
  let mx0 = width, mx1 = -1, my0 = height, my1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (target.mask[y * width + x]) { mx0 = Math.min(mx0, x); mx1 = Math.max(mx1, x); my0 = Math.min(my0, y); my1 = Math.max(my1, y); }
  }

  // Coarse search: render once per (yaw, scale, depth) at the initial image position,
  // then evaluate 2D shifts on the CPU (a shift at fixed depth is close to a move in the image).
  // The best shift of each rendering is kept, so the candidates stay diverse.
  const candidates: { cost: number; pose: FitPose }[] = [];
  const step = Math.max(1, Math.round(width / 64));
  for (const yawDeg of yaws) for (const scale of scales) for (const depth of depths) {
    const pose = { u: initial.u, v: initial.v, depth, scale, yawDeg };
    const r = renderer.render(pose);
    if (r.count === 0) continue;
    let rx0 = width, rx1 = -1, ry0 = height, ry1 = -1;
    for (let i = 0; i < r.count; i++) {
      rx0 = Math.min(rx0, r.xs[i]); rx1 = Math.max(rx1, r.xs[i]);
      ry0 = Math.min(ry0, r.ys[i]); ry1 = Math.max(ry1, r.ys[i]);
    }
    const prior = priorTerm(scale, scalePrior);
    let best = { cost: Infinity, dx: 0, dy: 0 };
    for (let dy = my0 - ry1; dy <= my1 - ry0; dy += step) {
      for (let dx = mx0 - rx1; dx <= mx1 - rx0; dx += step) {
        const cost = total({ ...evaluate(r, target, maskCount, dx, dy), prior });
        if (cost < best.cost) best = { cost, dx, dy };
      }
    }
    if (best.cost < Infinity) {
      candidates.push({ cost: best.cost, pose: { ...pose, u: pose.u + best.dx / width, v: pose.v + best.dy / height } });
    }
  }
  if (candidates.length === 0) {
    return { pose: initial, cost: initialEval.cost, terms: initialEval.terms, initialCost: initialEval.cost };
  }
  // Re-score the most promising candidates with exact renders
  candidates.sort((a, b) => a.cost - b.cost);
  const rescored = candidates.slice(0, 12)
    .map(c => ({ pose: c.pose, cost: poseCost(renderer, target, c.pose, scalePrior).cost }))
    .sort((a, b) => a.cost - b.cost);

  // Refinement with exact renders: parameters [u, v, log depth, log scale, yaw / 30]
  const toPose = (x: number[]): FitPose => ({ u: x[0], v: x[1], depth: Math.exp(x[2]), scale: Math.exp(x[3]), yawDeg: x[4] * 30 });
  const fromPose = (p: FitPose) => [p.u, p.v, Math.log(p.depth), Math.log(p.scale), p.yawDeg / 30];
  const f = (x: number[]) => poseCost(renderer, target, toPose(x), scalePrior).cost;
  const steps = [0.02, 0.02, 0.05, 0.08, 0.25];
  let best = { pose: initial, cost: initialEval.cost };
  for (const c of rescored.slice(0, 4)) {
    // Two rounds: the second restarts the simplex around the first result
    let result = nelderMead(f, fromPose(c.pose), steps, 60);
    result = nelderMead(f, result.x, steps.map(v => v / 2), 40);
    if (result.fx < best.cost) best = { pose: toPose(result.x), cost: result.fx };
  }
  const finalEval = poseCost(renderer, target, best.pose, scalePrior);
  return { pose: best.pose, cost: finalEval.cost, terms: finalEval.terms, initialCost: initialEval.cost };
};
