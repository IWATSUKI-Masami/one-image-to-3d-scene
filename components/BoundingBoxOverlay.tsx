import React from 'react';
import { DetectedObject } from '../types';

interface BoundingBoxOverlayProps {
  objects: DetectedObject[];
  color?: string;
}

export const BoundingBoxOverlay: React.FC<BoundingBoxOverlayProps> = ({ objects, color = '#3b82f6' }) => {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {objects.map((obj, idx) => {
        const [ymin, xmin, ymax, xmax] = obj.box_2d;

        // Use object-specific color if available (cast to any to avoid changing global types for now)
        const boxColor = (obj as any).colorOverride || color;

        // Convert normalized coordinates to percentages
        const top = ymin * 100;
        const left = xmin * 100;
        const width = (xmax - xmin) * 100;
        const height = (ymax - ymin) * 100;

        return (
          <div
            key={idx}
            className="absolute transition-colors group"
            style={{
              top: `${top}%`,
              left: `${left}%`,
              width: `${width}%`,
              height: `${height}%`,
              boxShadow: `0 0 0 2px ${boxColor}`,
              backgroundColor: `${boxColor}1A` // ~10% opacity
            }}
          >
            <span
              className="absolute -top-6 left-0 text-white text-xs px-2 py-0.5 rounded shadow-sm opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10"
              style={{ backgroundColor: boxColor }}
            >
              {obj.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};
