export interface DetectedObject {
  label: string;
  box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax]
  type: 'person' | 'object';
  description?: string; // Detailed description including pose, clothing, etc.
  /** Japanese label and description (translation of, or edited instead of, the English ones) */
  labelJa?: string;
  descriptionJa?: string;
  /** The annotation was edited by the user */
  annotationEdited?: boolean;
  /** Mask of the visible part of the object in the photo (SAM 2.1), if segmented */
  mask?: ObjectPhotoMask;
}

export interface ObjectPhotoMask {
  /** PNG data URL covering the whole photo; alpha 255 on the object's visible pixels */
  url: string;
  /** SAM's predicted IoU of the mask (0..1) */
  score: number;
  /** Fraction of the object's box covered by the mask (0..1) */
  coverage: number;
}

export interface CroppedObject extends DetectedObject {
  id: string;
  imageUrl: string;
  bgRemovalFailed?: boolean;
  completionExpansionRatio?: number;
  originalCroppedImageUrl?: string;
  originalPartBox2d?: [number, number, number, number]; // Position of original crop within completed image
  tightBox2d?: [number, number, number, number]; // Calculated tight bounding box of the object (purple box)
  isRefined?: boolean;
  /** How the image was completed (shown on the completed card) */
  completion?: CompletionInfo;
}

/**
 * Face of people in completion:
 * - keep: copy the face from the photo as it is
 * - redraw: redraw a blurred or small face sharply, keeping the expression
 * - calm: like redraw, with a relaxed closed-mouth expression (teeth and open mouths look uncanny in 3D)
 * - mannequin: smooth face without painted features, like a store mannequin
 */
export type FaceStyle = 'keep' | 'redraw' | 'calm' | 'mannequin';

export interface CompletionInfo {
  /** Image provider used for completion (e.g. 'OpenAI') */
  provider: string;
  /** Face style (people only) */
  faceStyle?: FaceStyle;
  /** How the visible part was located in the completed image */
  partSource?: PartBoxSource;
  /** Every completion attempt, in order (the chosen one is `chosenAttempt`) */
  attempts?: CompletionAttempt[];
  /** Index (0-based) of the attempt that was used */
  chosenAttempt?: number;
  /** Visible pixels were locked with an edit mask (OpenAI with photo masks) */
  editMask?: boolean;
  /** Estimated extent of the object beyond its box (fractions of the box size; before enlargement) */
  hiddenExtent?: { left: number; right: number; top: number; bottom: number };
}

/** One completion attempt */
export interface CompletionAttempt {
  /** Check result: nothing cut off and natural proportions (null: not checked, single-attempt mode) */
  complete: boolean | null;
  /** Problems reported by the check (e.g. "legs too short") */
  missingParts: string[];
  /** How the visible part was located in this attempt */
  partSource: PartBoxSource;
  /** Correlation of the visible part near its box (-1..1) */
  placementScore: number;
}

/**
 * How the visible part (originalPartBox2d) was located in the completed image:
 * - layout: it stayed at the box where it was put on the completion canvas (checked)
 * - matching: found by AKAZE feature matching
 * - whole: neither worked; the whole object's box is used
 */
export type PartBoxSource = 'layout' | 'matching' | 'whole';

/** 3D generation service (Hugging Face Spaces) */
export type ModelProvider = 'trellis' | 'hunyuan3d';

export interface Model3D {
  id: string;
  label: string;
  glbUrl: string;
  posterUrl: string; // The image used to generate it
  box_2d?: [number, number, number, number]; // Position in original image
  type?: 'person' | 'object';
  timestamp?: number;
  depthMapUrl?: string;
  completionExpansionRatio?: number;
  originalPartBox2d?: [number, number, number, number];
  tightBox2d?: [number, number, number, number]; // Bounds of the non-transparent object in the image
  /**
   * Rotation about the vertical axis (degrees) that makes the model's front view
   * match the completed image it was generated from (render and compare); the
   * generator does not always keep the input image's viewpoint.
   */
  frontAlignment?: { yawDeg: number; score: number; iou: number; version?: number };
  provider?: ModelProvider | 'triposr-local'; // Service that generated the model ('triposr-local': projects saved by earlier versions)
}

/** Where one model is in the 3D scene (its container's position, Euler XYZ rotation in radians, and scale) */
export interface SceneModelPlacement {
  id: string;
  label: string;
  box_2d?: [number, number, number, number];
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/** One Arrange run that changed the scene (kept with the layout and the project) */
export interface ArrangeRun {
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  /** ISO date-time of the end of the run */
  at: string;
  rounds: number;
  outcome: 'done' | 'failed' | 'cancelled';
  /** Mean photo IoU before and after */
  photoIoUBefore?: number;
  photoIoUAfter?: number;
  /** Number of physical issues before and after */
  issuesBefore?: number;
  issuesAfter?: number;
  /** Relation and size warnings of the scene analysis before and after */
  relationIssuesBefore?: number;
  relationIssuesAfter?: number;
  /** Times (seconds: total, waiting for the API), tokens and estimated cost (USD, list prices) */
  elapsedS?: number;
  apiS?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Version of the instructions and of the app that produced it */
  promptVersion?: string;
  appVersion?: string;
  /** The run's report (settings, photo match per object before and after, and the log) as text */
  report?: string;
}

/** Scene settings, camera and model placements (in a project: only the placements set by hand) */
export interface SceneLayout {
  settings: { depthScale: number; perspective: boolean; applyAlignment: boolean; pointSize: number };
  camera?: { position: [number, number, number]; target: [number, number, number]; fov: number };
  models: SceneModelPlacement[];
  /** Arrange runs whose changes are in the placements (oldest first); undone runs are removed */
  arrangeRuns?: ArrangeRun[];
}

export interface ProjectArchive {
  version: number;
  timestamp: number;
  mode: string;
  previewUrl: string | null;
  originalImageDimensions: { width: number, height: number } | null;
  detectedObjects: DetectedObject[];
  croppedImages: CroppedObject[];
  processedImages?: CroppedObject[];  // Kept optional for backwards compatibility with old archives
  completedImages: CroppedObject[];
  models3D: Model3D[];
  depthMapUrl?: string | null;
  processingTimes?: Record<string, number>;
  sourceImageName?: string; // File name of the analyzed photo (without extension), used for saved file names
  sceneLayout?: SceneLayout; // Placements set by hand in the 3D scene, scene settings and camera
}

// ---- AI provider settings ----

export type AIProvider = 'gemini' | 'openai';
/** Provider for image understanding: object detection, canvas expansion estimate, completion check */
export type VisionProvider = AIProvider;
/** Provider for image completion (outpainting) */
export type ImageProvider = AIProvider;

/** API key per provider (Anthropic: semantic arrangement of the 3D scene with Claude) */
export type AIKeys = Record<AIProvider | 'anthropic', string>;

export interface AIModels {
  geminiVision: string;
  geminiImage: string;
  openaiVision: string;
  openaiImage: string;
  /** Claude model that arranges the 3D scene (Arrange in the scene panel) */
  claudeArrange: string;
}

/**
 * Hugging Face Spaces used by the pipeline (Space ID "owner/name" or a URL).
 * Defaults are the official Spaces; they can be replaced with duplicates
 * running on dedicated (paid) GPUs, which have no ZeroGPU quota.
 */
export interface HFSpaces {
  /** BRIA RMBG 3.0 (the key is kept as `rmbg` so that stored settings stay valid) */
  rmbg: string;
  /** BRIA RMBG 2.0 */
  rmbg2: string;
  depth: string;
  trellis: string;
  hunyuan3d: string;
}

/** Background-removal model; both Spaces have the same API */
export type BgRemovalModel = 'rmbg3' | 'rmbg2';

/** Provider for Arrange in the 3D scene (semantic arrangement of the models) */
export type ArrangeProviderSetting = 'anthropic' | 'openai' | 'gemini';

export interface AISettings {
  visionProvider: VisionProvider;
  arrangeProvider: ArrangeProviderSetting;
  /** Maximum number of Arrange rounds (1-20) */
  arrangeMaxRounds: number;
  imageProvider: ImageProvider;
  bgRemoval: BgRemovalModel;
  keys: AIKeys;
  models: AIModels;
  spaces: HFSpaces;
}

