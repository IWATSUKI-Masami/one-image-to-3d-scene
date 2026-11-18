export interface DetectedObject {
  label: string;
  box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax]
  type: 'person' | 'object';
  description?: string; // Detailed description including pose, clothing, etc.
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
}

/** 3D generation service (Hugging Face Spaces) */
export type ModelProvider = 'trellis' | 'hunyuan3d';

/** Estimated rotation of a model about the vertical axis (see services/orientation.ts) */
export interface ModelOrientation {
  /** Rotation applied in the 3D scene, degrees (three.js rotation.y; 0 = facing the camera) */
  yawDeg: number;
  /** Orient Anything azimuth of the object in the photo, degrees */
  photoAzimuth: number;
  /** Orient Anything azimuth of the model rendered from the front, degrees */
  modelAzimuth: number;
  /** Confidence that the object in the photo has a meaningful orientation (0..1) */
  confidence: number;
  /** Same for the front render of the model */
  modelConfidence: number;
  /** Direction from the object towards the photo camera, degrees */
  viewAngle: number;
}

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
  orientation?: ModelOrientation; // Estimated orientation, if estimated
  provider?: ModelProvider | 'triposr-local'; // Service that generated the model ('triposr-local': projects saved by earlier versions)
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
}

// ---- AI provider settings ----

export type AIProvider = 'gemini' | 'openai';
/** Provider for image understanding: object detection, canvas expansion estimate, completion check */
export type VisionProvider = AIProvider;
/** Provider for image completion (outpainting) */
export type ImageProvider = AIProvider;

/** API key per provider */
export type AIKeys = Record<AIProvider, string>;

export interface AIModels {
  geminiVision: string;
  geminiImage: string;
  openaiVision: string;
  openaiImage: string;
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
  /** Orientation estimation (Orient Anything) */
  orient: string;
}

/** Background-removal model; both Spaces have the same API */
export type BgRemovalModel = 'rmbg3' | 'rmbg2';

export interface AISettings {
  visionProvider: VisionProvider;
  imageProvider: ImageProvider;
  bgRemoval: BgRemovalModel;
  keys: AIKeys;
  models: AIModels;
  spaces: HFSpaces;
}

