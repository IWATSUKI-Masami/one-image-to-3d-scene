import React from 'react';
import { DetectedObject } from '../types';

/** Distinct colors for the object masks */
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#84cc16', '#f97316', '#6366f1'];

/** Tints the visible pixels of each segmented object (masks cover the whole photo) */
export const MaskOverlay: React.FC<{ objects: DetectedObject[] }> = ({ objects }) => (
  <div className="absolute inset-0 pointer-events-none">
    {objects.map((obj, i) => obj.mask && (
      <div
        key={i}
        title={obj.label}
        className="absolute inset-0"
        style={{
          backgroundColor: COLORS[i % COLORS.length],
          opacity: 0.45,
          WebkitMaskImage: `url(${obj.mask.url})`,
          maskImage: `url(${obj.mask.url})`,
          WebkitMaskSize: '100% 100%',
          maskSize: '100% 100%',
        }}
      />
    ))}
  </div>
);
