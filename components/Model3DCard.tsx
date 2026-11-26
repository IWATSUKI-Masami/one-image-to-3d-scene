import { MIN_ALIGNMENT_SCORE } from '../services/frontAlignment';
import React from 'react';
import { Model3D } from '../types';
import { Download, Trash2, Box } from 'lucide-react';
import { SingleModelViewer } from './SingleModelViewer';

interface Model3DCardProps {
  model: Model3D;
  onDelete: () => void;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  showBoundingBox?: boolean;
  /** The model check is running for this model */
  checking?: boolean;
}

export const Model3DCard: React.FC<Model3DCardProps> = ({ model, onDelete, selected, onSelect, showBoundingBox, checking }) => {
  return (
    <div
      className={`bg-white rounded-xl shadow-sm border overflow-hidden hover:shadow-md transition-shadow relative
        ${selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200'}`}
    >
      <div className="aspect-square w-full bg-slate-50 relative group">

        <div className="absolute inset-0">
          <SingleModelViewer model={model} showBoundingBox={showBoundingBox} />
        </div>

        {/* Selection Checkbox */}
        {onSelect && (
          <div className="absolute top-2 left-2 z-10" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected || false}
              onChange={(e) => onSelect(e.target.checked)}
              className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer shadow-sm"
            />
          </div>
        )}

        {/* Overlay Controls */}
        <div className="absolute inset-0 pointer-events-none flex items-end justify-end p-2 gap-2">
          <a
            href={model.glbUrl}
            download={`${model.label.replace(/\s+/g, '_')}.glb`}
            className="bg-white text-slate-700 p-2 rounded-full shadow-sm hover:bg-slate-100 hover:text-orange-600 transition-colors pointer-events-auto"
            title="Download GLB"
            onClick={(e) => e.stopPropagation()}
          >
            <Download size={16} />
          </a>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="bg-white text-red-600 p-2 rounded-full shadow-sm hover:bg-red-50 transition-colors pointer-events-auto"
            title="Delete Model"
          >
            <Trash2 size={16} />
          </button>
        </div>

        {/* Badge */}
        <div className="absolute top-2 right-2 pointer-events-none">
          <div className="bg-orange-100 text-orange-800 text-[10px] font-semibold px-2 py-1 rounded-full border border-orange-200 shadow-sm flex items-center gap-1 opacity-90">
            <Box size={12} />
            {showBoundingBox ? 'Bounding Box View' : 'Interactive 3D'}
          </div>
        </div>
      </div>
      <div className="p-3 border-t border-slate-100">
        <p className="font-medium text-slate-800 capitalize text-center truncate" title={model.label}>
          {model.label}
        </p>
        {model.frontAlignment && (
          <p className="text-[11px] text-indigo-600 mt-1 text-center truncate"
            title="Front alignment: rotation that makes the model's front view match its completed image (score: silhouette overlap + brightness correlation − aspect-ratio difference; IoU: silhouette overlap)">
            {model.frontAlignment.score >= MIN_ALIGNMENT_SCORE
              ? `Align: ${Math.round(model.frontAlignment.yawDeg)}° (score ${model.frontAlignment.score.toFixed(2)})`
              : `Align: not used (score ${model.frontAlignment.score.toFixed(2)})`}
          </p>
        )}
        {checking && <p className="text-[11px] text-slate-500 mt-1 text-center">Checking against the photo…</p>}
        {!checking && model.check && (
          <p className={`text-[11px] mt-1 text-center line-clamp-2 ${model.check.matches ? 'text-emerald-600' : 'text-amber-700'}`}
            title={model.check.matches ? 'The model matches its object in the photo' : model.check.problem}>
            {model.check.matches
              ? 'Check: matches the photo'
              : `Check: ${model.check.problem}${model.check.suggestionId ? ' → corrected annotation added to Extracted' : model.check.fixableByAnnotation ? '' : ' (not fixable by the annotation)'}`}
          </p>
        )}
      </div>
    </div>
  );
};