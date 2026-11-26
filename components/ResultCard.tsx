import React, { useState, useEffect } from 'react';
import { CroppedObject } from '../types';
import { FACE_STYLE_LABELS } from '../services/ai/models';
import { describeAttempts } from '../services/stats';

/** How the visible part was located in the completed image (green box) */
const PART_SOURCE_LABELS = { layout: 'kept', matching: 'matched', whole: 'not found' } as const;
import { Download, AlertTriangle, Wand2, Trash2, Box, Pencil } from 'lucide-react';
import { BoundingBoxOverlay, OverlayBox } from './BoundingBoxOverlay';
import { findBestMatchPosition, calculateTightBoundingBox } from '../utils';

const CHECKERBOARD: React.CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage: 'linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
};

interface ResultCardProps {
  item: CroppedObject;
  onCompleteBody?: (item: CroppedObject) => void;
  onDelete?: () => void;
  onGenerate3D?: (item: CroppedObject) => void;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  onUpdate?: (item: CroppedObject) => void;
  showBoundingBox?: boolean;
  isProcessing?: boolean; // External processing state (persists across tab switches)
  /** Language of the label and description shown (Japanese falls back to English) */
  annotationLang?: 'en' | 'ja';
  /** Edit the label and description (in the shown language); enables the edit button */
  onEditAnnotation?: (label: string, description: string) => Promise<void> | void;
}

export const ResultCard: React.FC<ResultCardProps> = ({ item, onCompleteBody, onDelete, onGenerate3D, selected, onSelect, onUpdate, showBoundingBox, isProcessing, annotationLang = 'en', onEditAnnotation }) => {
  const shownLabel = (annotationLang === 'ja' && item.labelJa) || item.label;
  const shownDescription = (annotationLang === 'ja' && item.descriptionJa) || item.description || '';
  const [editing, setEditing] = useState(false);
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraftLabel(shownLabel);
    setDraftDescription(shownDescription);
    setEditing(true);
  };
  const saveAnnotation = async () => {
    if (!onEditAnnotation) return;
    setSavingAnnotation(true);
    try {
      await onEditAnnotation(draftLabel.trim() || shownLabel, draftDescription.trim());
      setEditing(false);
    } finally {
      setSavingAnnotation(false);
    }
  };
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGenerating3D, setIsGenerating3D] = useState(false);
  const [detectedBox, setDetectedBox] = useState<[number, number, number, number] | null>(null);
  const [fullObjectBox, setFullObjectBox] = useState<[number, number, number, number] | null>(null);
  const [imageAspectRatio, setImageAspectRatio] = useState<number | null>(null);

  useEffect(() => {
    let isMounted = true;

    const detectPosition = async () => {
      let newItemUpdates: Partial<CroppedObject> = {};
      let hasUpdates = false;

      // 1. Green Box (Original Part)
      // Only run matching if it's a completed image (has expansion ratio) and we have the original source
      if (item.completionExpansionRatio !== undefined && item.originalCroppedImageUrl && item.imageUrl) {
        if (!item.originalPartBox2d && !item.isRefined) {
          try {
            const box = await findBestMatchPosition(item.imageUrl, item.originalCroppedImageUrl);
            if (isMounted && box) {
              setDetectedBox(box);
              newItemUpdates.originalPartBox2d = box;
              newItemUpdates.isRefined = true;
              hasUpdates = true;
            }
          } catch (e) {
            console.error("Failed to match template position", e);
          }
        } else if (item.originalPartBox2d) {
          if (isMounted) setDetectedBox(item.originalPartBox2d);
        }
      } else {
        // If already refined/loaded, use the stored originalPartBox2d
        if (isMounted && item.originalPartBox2d) {
          setDetectedBox(item.originalPartBox2d);
        } else if (isMounted) {
          setDetectedBox(null);
        }
      }

      // 2. Purple Box (Tight Object Bounds)
      if (item.completionExpansionRatio !== undefined && item.imageUrl) {
        if (item.tightBox2d) {
          if (isMounted) setFullObjectBox(item.tightBox2d);
        } else {
          try {
            // Verify imageUrl valid (skip blob check if needed or keep loose)
            const tightBox = await calculateTightBoundingBox(item.imageUrl);
            if (isMounted && tightBox) {
              setFullObjectBox(tightBox);
              newItemUpdates.tightBox2d = tightBox;
              hasUpdates = true;
            }
          } catch (e) {
            console.warn("Failed to calculate tight bounding box", e);
          }
        }
      }

      // Batch Update
      if (hasUpdates && onUpdate && isMounted) {
        // Send updates back to parent
        onUpdate({ ...item, ...newItemUpdates });
      }
    };

    detectPosition();

    return () => { isMounted = false; };
  }, [item.imageUrl, item.originalCroppedImageUrl, item.completionExpansionRatio, item.originalPartBox2d, item.tightBox2d, item.isRefined, onUpdate]);

  const handleGenerateClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onCompleteBody || isGenerating) return;

    setIsGenerating(true);
    try {
      await onCompleteBody(item);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerate3DClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onGenerate3D || isGenerating3D) return;

    setIsGenerating3D(true);
    try {
      await onGenerate3D(item);
    } finally {
      setIsGenerating3D(false);
    }
  };

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border overflow-hidden hover:shadow-md transition-shadow relative
  ${selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200'}`}
    >
      <div className="aspect-square w-full bg-slate-50 flex items-center justify-center p-4 relative group">

        {/* Image and Overlay Wrapper */}
        <div
          className="relative flex items-center justify-center transition-all duration-300"
          style={{
            width: imageAspectRatio && imageAspectRatio > 1 ? '100%' : 'auto',
            height: imageAspectRatio && imageAspectRatio <= 1 ? '100%' : 'auto',
            aspectRatio: imageAspectRatio ? `${imageAspectRatio}` : 'auto',
            maxWidth: '100%',
            maxHeight: '100%',
            // Checkerboard behind completed images, so that a transparent background
            // is visible (a white background stays white)
            ...(item.completionExpansionRatio !== undefined ? CHECKERBOARD : {})
          }}
        >
          <img
            src={item.imageUrl}
            alt={item.label}
            className="w-full h-full object-contain"
            onLoad={(e) => setImageAspectRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
          />

          {/* Bounding Box Overlay */}
          {showBoundingBox && (() => {
            if (item.completionExpansionRatio !== undefined) {
              const boxesToShow: OverlayBox[] = [];

              // 1. Full Object Box (Purple) - Requested by User
              boxesToShow.push({
                label: "Full Object",
                box_2d: fullObjectBox || [0, 0, 1, 1], // Use calculated tight box or fallback to full image
                type: 'object',
                colorOverride: '#a855f7' // Purple-500
              });

              // 2. Original/Detected Part Box (Green/Orange)
              if (detectedBox) {
                boxesToShow.push({
                  label: "Original Part",
                  box_2d: detectedBox,
                  type: 'person', // Use person type for thinner lines if needed, or object
                  colorOverride: '#22c55e' // Green-500
                });
              } else {
                const heightRatio = 1 - item.completionExpansionRatio;
                const yOffset = (1 - heightRatio) / 2;
                boxesToShow.push({
                  label: "Original Part (Est)",
                  box_2d: [yOffset, 0, yOffset + heightRatio, 1],
                  type: 'person',
                  colorOverride: '#f97316' // Orange-500
                });
              }

              return (
                <BoundingBoxOverlay
                  objects={boxesToShow}
                  color={'#3b82f6'} // Default fallback, overridden by items
                />
              );
            } else {
              // For extracted images, just show the full box
              return (
                <BoundingBoxOverlay
                  objects={[{
                    label: item.label,
                    box_2d: [0, 0, 1, 1],
                    type: item.type
                  }]}
                  color={'#3b82f6'}
                />
              );
            }
          })()}
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

        {/* Failure Indicator */}
        {item.bgRemovalFailed && (
          <div className="absolute top-2 left-2 right-2 flex justify-center pointer-events-none">
            <div className="bg-amber-100 text-amber-800 text-[10px] font-semibold px-2 py-1 rounded-full border border-amber-200 shadow-sm flex items-center gap-1 opacity-90">
              <AlertTriangle size={12} />
              Background removal failed
            </div>
          </div>
        )}

        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-end justify-end p-2 opacity-0 group-hover:opacity-100 gap-2 flex-wrap">
          {onCompleteBody && !isGenerating && (
            <button
              onClick={handleGenerateClick}
              className="bg-white text-purple-600 p-2 rounded-full shadow-sm hover:bg-purple-50 transition-colors"
              title="AI Generate Completion"
            >
              <Wand2 size={16} />
            </button>
          )}

          {onGenerate3D && !isGenerating3D && (
            <button
              onClick={handleGenerate3DClick}
              className="bg-white text-orange-600 p-2 rounded-full shadow-sm hover:bg-orange-50 transition-colors"
              title="Generate 3D Model"
            >
              <Box size={16} />
            </button>
          )}

          <a
            href={item.imageUrl}
            download={`${item.label.replace(/\s+/g, '_')}${item.bgRemovalFailed ? '' : '_transparent'}.png`}
            className="bg-white text-slate-700 p-2 rounded-full shadow-sm hover:bg-slate-100 hover:text-blue-600 transition-colors"
            title="Download Image"
            onClick={(e) => e.stopPropagation()}
          >
            <Download size={16} />
          </a>

          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="bg-white text-red-600 p-2 rounded-full shadow-sm hover:bg-red-50 transition-colors"
              title="Delete Image"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>

        {isGenerating && (
          <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-600"></div>
          </div>
        )}

        {(isProcessing || isGenerating3D) && (
          <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-orange-600"></div>
          </div>
        )}

      </div>
      <div className="p-3 border-t border-slate-100">
        {editing ? (
          <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              className="w-full text-sm border border-slate-300 rounded px-2 py-1"
              aria-label="Label"
            />
            <textarea
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              rows={4}
              className="w-full text-xs border border-slate-300 rounded px-2 py-1"
              aria-label="Description"
              placeholder={annotationLang === 'ja' ? '物体の説明（隠れた部分の形も書けます）' : 'Description (you can describe the shape of hidden parts)'}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(false)} disabled={savingAnnotation}
                className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
                {annotationLang === 'ja' ? 'キャンセル' : 'Cancel'}
              </button>
              <button onClick={saveAnnotation} disabled={savingAnnotation}
                className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 flex items-center gap-1">
                {savingAnnotation && <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" />}
                {annotationLang === 'ja' ? '保存' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
        <>
        <div className="flex items-center justify-center gap-1">
          <p className="font-medium text-slate-800 capitalize text-center truncate" title={shownLabel}>
            {shownLabel}
          </p>
          {onEditAnnotation && (
            <button onClick={startEditing} className="text-slate-400 hover:text-indigo-600 shrink-0"
              title={annotationLang === 'ja' ? '注釈（ラベルと説明）を編集。説明は補完の指示に使われます' : 'Edit the annotation (label and description). The description is used in the completion prompt'}
              aria-label="Edit annotation">
              <Pencil size={13} />
            </button>
          )}
          {item.annotationEdited && <span className="text-[10px] text-amber-600 shrink-0" title="Edited by the user">✎</span>}
        </div>
        {item.completion && (
          <p className="text-[11px] text-indigo-600 mt-1 text-center truncate"
            title={item.completion.attempts?.length ? `Attempts: ${describeAttempts(item)}` : "Settings used for the completion: image provider, face style (people), and how the visible part was located (kept in place / matched / not found)"}>
            {item.completion.provider}
            {item.completion.faceStyle && ` · Face: ${FACE_STYLE_LABELS[item.completion.faceStyle]}`}
            {item.completion.partSource && ` · Part: ${PART_SOURCE_LABELS[item.completion.partSource]}`}
            {item.completion.attempts && item.completion.attempts.length > 1 && ` · ${item.completion.attempts.length} attempts`}
          </p>
        )}
        {item.suggestion && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded mt-1 px-1.5 py-0.5 text-center line-clamp-3"
            title={`Proposed by the model check of "${item.suggestion.fromModel}": ${item.suggestion.problem}\nComplete this card to generate the object again with the corrected annotation, or delete it.`}>
            AI suggestion: {item.suggestion.problem}
          </p>
        )}
        {shownDescription && (
          <p className="text-xs text-slate-500 mt-1 text-center line-clamp-2" title={shownDescription}>
            {shownDescription}
          </p>
        )}
        </>
        )}
      </div>
    </div>
  );
};

export default ResultCard;