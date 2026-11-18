import React from 'react';

export interface DetectedObject {
  label: string;
  box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax]
  type: 'person' | 'object';
  description?: string; // Detailed description including pose, clothing, etc.
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface Box3D {
  min: Point3D;
  max: Point3D;
  center: Point3D;
  dimensions: Point3D;
  corners: Point3D[];
}

export interface CroppedObject extends DetectedObject {
  id: string;
  imageUrl: string;
  bgRemovalFailed?: boolean;
  box_3d?: Box3D;
  completionExpansionRatio?: number;
  originalCroppedImageUrl?: string;
  originalPartBox2d?: [number, number, number, number]; // Position of original crop within completed image
  tightBox2d?: [number, number, number, number]; // Calculated tight bounding box of the object (purple box)
  isRefined?: boolean;
}

export interface AnalysisResult {
  objects: DetectedObject[];
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
  provider?: 'stability-api' | 'huggingface' | 'triposr-local' | 'trellis'; // Which 3D generation service was used
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

export interface ProcessResult {
  matchesCount: number;
  goodMatchesCount: number;
  processingTimeMs: number;
  imageWidth: number;
  imageHeight: number;
  error?: string;
}

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }

  interface Window {
    aistudio?: AIStudio;
    cv?: any;
  }
}
