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
 *
 * Part correspondence (optional): when it is known which part of the model is
 * visible in the photo (the visible part's box in the completed image, from which
 * the model was generated), condition 1 asks that the mask be covered by THAT part
 * of the model, and the yaw is kept near the view direction of the photo (the
 * generator's front is the completed image's view).
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
  /** Yaw prior (degrees), e.g. from part correspondence */
  yawPrior?: { yawDeg: number; sigmaDeg: number };
}

/**
 * Region of the model visible in the photo, in the model's own frame (the frame
 * of the object given to FitRenderer.setObject): x and y ranges of its front view.
 */
export interface PartRegion {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Mask pixels covered by model pixels outside the visible part count this much */
const NON_PART_COVERAGE = 0.3;
const W_YAW = 0.2;

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

/** Pixels covered by a rendering: indices, their depths, and whether they belong to the visible part */
interface Rendering {
  xs: Int16Array;
  ys: Int16Array;
  depths: Float32Array;
  part: Uint8Array;
  count: number;
  /** A part region was set */
  hasPart: boolean;
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
        uniform mat4 uFrameInverse;
        varying float vDepth;
        varying vec3 vFrame;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          vFrame = (uFrameInverse * modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        precision highp float;
        uniform vec4 uPart; // x0, x1, y0, y1 in the model's frame; x0 > x1 = none
        varying float vDepth;
        varying vec3 vFrame;
        void main() {
          float d = clamp(vDepth / ${DEPTH_MAX.toFixed(1)}, 0.0, 1.0) * 65535.0;
          float hi = floor(d / 256.0);
          float lo = d - hi * 256.0;
          float part = (vFrame.x >= uPart.x && vFrame.x <= uPart.y && vFrame.y >= uPart.z && vFrame.y <= uPart.w) ? 1.0 : 0.0;
          gl_FragColor = vec4(hi / 255.0, lo / 255.0, part, 1.0);
        }`,
      uniforms: {
        uFrameInverse: { value: new THREE.Matrix4() },
        uPart: { value: new THREE.Vector4(1, 0, 1, 0) },
      },
    });
    this.root.add(this.yawGroup);
    this.scene.add(this.root);
    this.pixels = new Uint8Array(width * height * 4);
  }

  private hasPart = false;

  /** Set the object to render (it is re-parented into the renderer's scene) */
  setObject(object: THREE.Object3D) {
    while (this.yawGroup.children.length) this.yawGroup.remove(this.yawGroup.children[0]);
    this.yawGroup.add(object);
  }

  /** Mark the visible part of the model (in the frame of the object's parent, i.e. the object as given) */
  setPartRegion(region: PartRegion | null) {
    const u = (this.scene.overrideMaterial as THREE.ShaderMaterial).uniforms.uPart.value as THREE.Vector4;
    if (region) u.set(region.x0, region.x1, region.y0, region.y1);
    else u.set(1, 0, 1, 0);
    this.hasPart = !!region;
  }

  render(pose: FitPose): Rendering {
    this.root.position.copy(toWorld(pose.u, pose.v, pose.depth, this.fitCamera));
    this.root.scale.setScalar(pose.scale);
    this.yawGroup.rotation.y = pose.yawDeg * Math.PI / 180;
    this.root.updateMatrixWorld(true);
    ((this.scene.overrideMaterial as THREE.ShaderMaterial).uniforms.uFrameInverse.value as THREE.Matrix4)
      .copy(this.yawGroup.matrixWorld).invert();
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
    const part = new Uint8Array(width * height);
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
        part[count] = pixels[o + 2] > 127 ? 1 : 0;
        count++;
      }
    }
    return { xs, ys, depths, part, count, hasPart: this.hasPart };
  }

  dispose() {
    this.setObject(new THREE.Group());
    this.target.dispose();
    (this.scene.overrideMaterial as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** Angle difference in degrees, -180..180 */
const angleDiff = (a: number, b: number): number => ((a - b) % 360 + 540) % 360 - 180;

/** Prior terms (condition 4): size, and yaw when a yaw prior is given */
const priorTerm = (pose: FitPose, prior?: ScalePrior, yawPrior?: FitOptions['yawPrior']): number => {
  let t = 0;
  if (prior) {
    const z = Math.log(pose.scale / prior.scale) / prior.sigmaLog;
    t += z * z;
  }
  if (yawPrior) {
    const z = angleDiff(pose.yawDeg, yawPrior.yawDeg) / yawPrior.sigmaDeg;
    t += (W_YAW / W_PRIOR) * z * z;
  }
  return t;
};

/**
 * Cost of a rendering shifted by (dx, dy) pixels. Pixels outside the image
 * carry no information and are ignored.
 */
const evaluate = (r: Rendering, target: FitTarget, maskCount: number, dx: number, dy: number): Omit<FitTerms, 'prior'> => {
  const { width, height, mask, depth } = target;
  let covered = 0;
  let coveredPixels = 0;
  let violation = 0;
  let depthError = 0;
  for (let i = 0; i < r.count; i++) {
    const x = r.xs[i] + dx;
    const y = r.ys[i] + dy;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const t = y * width + x;
    const observed = depth[t];
    if (mask[t]) {
      // With a known visible part, the mask should be covered by that part of the model
      covered += !r.hasPart || r.part[i] ? 1 : NON_PART_COVERAGE;
      coveredPixels++;
      depthError += Math.abs(Math.log(r.depths[i] / observed));
    } else if (r.depths[i] < observed * (1 - VIOLATION_TOLERANCE)) {
      violation++;
    }
  }
  return {
    miss: Math.max(0, 1 - covered / maskCount),
    violation: violation / maskCount,
    depthError: coveredPixels > 0 ? depthError / coveredPixels : 1,
  };
};

const total = (t: FitTerms): number =>
  W_MISS * t.miss + W_VIOLATION * t.violation + W_DEPTH * t.depthError + W_PRIOR * t.prior;

/** Cost of a pose, rendered exactly */
export const poseCost = (renderer: FitRenderer, target: FitTarget, pose: FitPose, prior?: ScalePrior, yawPrior?: FitOptions['yawPrior']): { cost: number; terms: FitTerms } => {
  const maskCount = target.mask.reduce((a, b) => a + b, 0);
  const terms = { ...evaluate(renderer.render(pose), target, Math.max(1, maskCount), 0, 0), prior: priorTerm(pose, prior, yawPrior) };
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
  const initialEval = poseCost(renderer, target, initial, scalePrior, options.yawPrior);

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
    const prior = priorTerm(pose, scalePrior, options.yawPrior);
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
    .map(c => ({ pose: c.pose, cost: poseCost(renderer, target, c.pose, scalePrior, options.yawPrior).cost }))
    .sort((a, b) => a.cost - b.cost);

  // Refinement with exact renders: parameters [u, v, log depth, log scale, yaw / 30]
  const toPose = (x: number[]): FitPose => ({ u: x[0], v: x[1], depth: Math.exp(x[2]), scale: Math.exp(x[3]), yawDeg: x[4] * 30 });
  const fromPose = (p: FitPose) => [p.u, p.v, Math.log(p.depth), Math.log(p.scale), p.yawDeg / 30];
  const f = (x: number[]) => poseCost(renderer, target, toPose(x), scalePrior, options.yawPrior).cost;
  const steps = [0.02, 0.02, 0.05, 0.08, 0.25];
  let best = { pose: initial, cost: initialEval.cost };
  for (const c of rescored.slice(0, 4)) {
    // Two rounds: the second restarts the simplex around the first result
    let result = nelderMead(f, fromPose(c.pose), steps, 60);
    result = nelderMead(f, result.x, steps.map(v => v / 2), 40);
    if (result.fx < best.cost) best = { pose: toPose(result.x), cost: result.fx };
  }
  const finalEval = poseCost(renderer, target, best.pose, scalePrior, options.yawPrior);
  return { pose: best.pose, cost: finalEval.cost, terms: finalEval.terms, initialCost: initialEval.cost };
};

/**
 * Visible part of a model from boxes in the image it was generated from:
 * `tightBox` is the whole object and `partBox` the part visible in the photo
 * (both [ymin, xmin, ymax, xmax] in the completed image). The model's front view
 * is taken to match that image, so the part's relative position in the tight box
 * maps onto the model's x/y extent (in the frame of the object as given).
 */
export const partRegionFromBoxes = (
  object: THREE.Object3D,
  tightBox: [number, number, number, number],
  partBox: [number, number, number, number],
): PartRegion | null => {
  const [tymin, txmin, tymax, txmax] = tightBox;
  const [pymin, pxmin, pymax, pxmax] = partBox;
  const tw = txmax - txmin, th = tymax - tymin;
  if (tw <= 1e-6 || th <= 1e-6) return null;
  const rx0 = (pxmin - txmin) / tw, rx1 = (pxmax - txmin) / tw;
  const ry0 = (pymin - tymin) / th, ry1 = (pymax - tymin) / th;
  // The part box is the whole object: no information
  if (rx0 <= 0.02 && ry0 <= 0.02 && rx1 >= 0.98 && ry1 >= 0.98) return null;
  const parent = object.parent;
  if (parent) parent.remove(object);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object, true);
  if (parent) parent.add(object);
  const w = box.max.x - box.min.x, h = box.max.y - box.min.y;
  // A little slack: the generator's front view is not exactly the completed image
  const slack = 0.05;
  return {
    x0: box.min.x + (rx0 - slack) * w,
    x1: box.min.x + (rx1 + slack) * w,
    y0: box.max.y - (ry1 + slack) * h,
    y1: box.max.y - (ry0 - slack) * h,
  };
};

/** Direction from an object at image position u towards the camera, as a yaw (degrees) */
export const viewYawDeg = (u: number, camera: FitCamera): number =>
  -Math.atan((u - 0.5) * 2 * Math.tan((camera.hfovDeg / 2) * Math.PI / 180)) * 180 / Math.PI;
