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
}

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

export interface AISettings {
  visionProvider: VisionProvider;
  imageProvider: ImageProvider;
  keys: AIKeys;
  models: AIModels;
}

declare global {
  interface Window {
    cv?: any;
  }
}
