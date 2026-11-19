/**
 * Processing statistics of a project, for evaluation: one row per completed
 * object with how it was completed (attempts, how the visible part was located),
 * the front alignment of its 3D model, and processing times. Exported as CSV
 * (opens in Excel; UTF-8 with BOM).
 */
import { CroppedObject, DetectedObject, Model3D } from '../types';
import { sameBox } from '../components/depthSampling';

const BORDER = 0.01;

/** Sides of the image the box touches (L, R, T, B) */
const borderSides = (box: [number, number, number, number]): string => {
  const [ymin, xmin, ymax, xmax] = box;
  return [xmin <= BORDER && 'L', xmax >= 1 - BORDER && 'R', ymin <= BORDER && 'T', ymax >= 1 - BORDER && 'B'].filter(Boolean).join('');
};

const round = (v: number | undefined, digits = 2): string =>
  v === undefined || !Number.isFinite(v) ? '' : v.toFixed(digits);

/** One-line summary of the attempts, e.g. "1: incomplete (legs too short), moved 0.42 | 2: complete, kept 0.97" */
export const describeAttempts = (item: CroppedObject): string =>
  (item.completion?.attempts ?? []).map((a, i) => {
    const check = a.complete === null ? 'not checked' : a.complete ? 'complete' : `incomplete${a.missingParts.length ? ` (${a.missingParts.join(', ')})` : ''}`;
    const part = a.partSource === 'layout' ? 'kept' : a.partSource === 'matching' ? 'matched' : 'not found';
    return `${i + 1}: ${check}, ${part} ${round(a.placementScore)}${i === item.completion?.chosenAttempt ? ' [used]' : ''}`;
  }).join(' | ');

const COLUMNS = [
  'object', 'type', 'border_sides', 'mask_coverage', 'provider', 'face_style', 'edit_mask',
  'extent_left', 'extent_right', 'extent_top', 'extent_bottom',
  'part_source', 'attempts', 'used_attempt', 'placement_score', 'attempt_details',
  'completion_s', 'model_provider', 'align_yaw_deg', 'align_score', 'align_iou', 'gen3d_s',
];

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const buildStatsCsv = (
  completed: CroppedObject[],
  models: Model3D[],
  detected: DetectedObject[],
  times: Map<string, number>,
): string => {
  const rows = completed.map(item => {
    const base = item.label.replace(/ \(Completed\)$/, '');
    const obj = detected.find(o => sameBox(o.box_2d, item.box_2d));
    // The model generated from this completed image (image URLs change when a project is loaded,
    // so the object's box is the fallback)
    const model = models.find(m => m.posterUrl === item.imageUrl)
      ?? models.find(m => m.box_2d && sameBox(m.box_2d, item.box_2d));
    const c = item.completion;
    const used = c?.attempts && c.chosenAttempt !== undefined ? c.attempts[c.chosenAttempt] : undefined;
    return [
      base, item.type, borderSides(item.box_2d), round(obj?.mask?.coverage), c?.provider ?? '', c?.faceStyle ?? '',
      c?.editMask === undefined ? '' : c.editMask ? 'yes' : 'no',
      round(c?.hiddenExtent?.left), round(c?.hiddenExtent?.right), round(c?.hiddenExtent?.top), round(c?.hiddenExtent?.bottom),
      c?.partSource ?? '', c?.attempts?.length ?? '', c?.chosenAttempt !== undefined ? c.chosenAttempt + 1 : '',
      round(used?.placementScore), describeAttempts(item),
      round(times.get(`Completion: ${base}`), 1), model?.provider ?? '',
      model?.frontAlignment ? Math.round(model.frontAlignment.yawDeg) : '', round(model?.frontAlignment?.score), round(model?.frontAlignment?.iou),
      round(times.get(`3D Gen: ${item.label}`) ?? times.get(`3D Gen: ${base}`), 1),
    ];
  });
  return '﻿' + [COLUMNS, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
};
