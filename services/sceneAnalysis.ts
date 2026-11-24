/**
 * Semantic analysis of the photo before Arrange, and checks of the scene against it.
 *
 * Instead of rules for particular kinds of scenes in the Arrange prompt (people at a
 * table, cups on it), the model first describes the scene from the photo alone: what
 * it shows, the real-world size of each object, and the relations that matter for the
 * placement (what rests on what, who sits on or at what, who faces whom, which object
 * is in front). Arrange then works from this analysis, and the relations and sizes are
 * checked on the scene (relation warnings, counted before and after as a third measure
 * next to the photo match and the physical issues). The analysis is saved with the
 * run, so that it can be checked by hand.
 */
import type { ToolSpec } from './arrangeProviders';

export type RelationKind = 'on' | 'sits_on' | 'sits_at' | 'faces' | 'in_front_of';

export interface SceneRelation {
    subject: string;
    relation: RelationKind;
    /** Object id; "floor" for on, "none" for sits_on when the seat is not in the scene */
    object: string;
    /** Whether the contact (the subject's bottom touching the object) is visible in the photo */
    contact_visible: boolean;
}

export interface SceneAnalysis {
    scene: string;
    scale_reference: { ids: string[]; reason: string };
    objects: { id: string; height_m: number; width_m: number; pose: string }[];
    relations: SceneRelation[];
    notes: string;
}

/** Box of a model in world units */
export interface RelationBox {
    id: string;
    center: [number, number, number];
    size: [number, number, number];
}

export const ANALYSIS_PROMPT = `You analyze a photo before a 3D reconstruction of it is arranged. Every object in the given list was reconstructed as a separate 3D model; another step will place the models so that the scene matches the photo, guided by your analysis. Look only at the photo and the object list (ids, labels, descriptions and boxes in the photo).

Report with report_scene:
- scene: what the photo shows, in one or two sentences (place, people, what they do).
- scale_reference: the ids of the objects whose real size you know best (people if there are any, otherwise furniture or everyday objects), and why.
- objects: for every object in the list, its real height and width in meters as it is posed in the photo (a seated person: from the floor to the top of the head, about 1.3 m for an adult on a chair; a standing adult about 1.65-1.75 m), consistent with each other, and its pose in a few words (e.g. "seated, leaning towards o2", "upright", "open, screen facing the person").
- relations that matter for the placement, using the ids:
  - on: the subject rests on the object's top ("floor" for furniture and standing people on the floor). Give every object that stands on another object in the list.
  - sits_on: a seated person and the seat ("none" when the seat is not in the list, e.g. hidden or cut off).
  - sits_at: a seated person and the table or desk they sit at.
  - faces: the subject faces the object (e.g. two people talking).
  - in_front_of: the subject is nearer to the camera than the object, for objects that overlap in the photo or stand on the same support.
  contact_visible: whether the contact (the subject's bottom touching the object) can be seen in the photo; false when it is hidden or outside the photo (e.g. table legs below the lower edge). Use false for faces and in_front_of.
- notes: anything else the placement should know (e.g. objects cut off by the photo's edges, unusual sizes).`;

export const SCENE_TOOL: ToolSpec = {
    name: 'report_scene',
    description: 'Report the analysis of the photo.',
    schema: {
        type: 'object',
        properties: {
            scene: { type: 'string', description: 'What the photo shows, in one or two sentences' },
            scale_reference: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the objects whose real size is known best' },
                    reason: { type: 'string' },
                },
                required: ['ids', 'reason'],
                additionalProperties: false,
            },
            objects: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        height_m: { type: 'number', description: 'Real height in meters as posed in the photo' },
                        width_m: { type: 'number', description: 'Real width in meters' },
                        pose: { type: 'string', description: 'Pose or state in a few words' },
                    },
                    required: ['id', 'height_m', 'width_m', 'pose'],
                    additionalProperties: false,
                },
            },
            relations: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        subject: { type: 'string', description: 'Object id' },
                        relation: { type: 'string', enum: ['on', 'sits_on', 'sits_at', 'faces', 'in_front_of'] },
                        object: { type: 'string', description: 'Object id, "floor" (on) or "none" (sits_on, seat not in the list)' },
                        contact_visible: { type: 'boolean' },
                    },
                    required: ['subject', 'relation', 'object', 'contact_visible'],
                    additionalProperties: false,
                },
            },
            notes: { type: 'string' },
        },
        required: ['scene', 'scale_reference', 'objects', 'relations', 'notes'],
        additionalProperties: false,
    },
};

const RELATIONS: RelationKind[] = ['on', 'sits_on', 'sits_at', 'faces', 'in_front_of'];

/** Check the analysis the model sent; unknown ids and relations are dropped */
export const parseAnalysis = (input: unknown, ids: Set<string>): SceneAnalysis | undefined => {
    const a = input as Partial<SceneAnalysis> | undefined;
    if (!a || typeof a !== 'object') return undefined;
    const str = (v: unknown) => typeof v === 'string' ? v : '';
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    const objects = (Array.isArray(a.objects) ? a.objects : [])
        .filter(o => ids.has(str(o?.id)))
        .map(o => ({ id: o.id, height_m: num(o.height_m), width_m: num(o.width_m), pose: str(o.pose) }));
    const target = (v: string) => ids.has(v) || v === 'floor' || v === 'none';
    const relations = (Array.isArray(a.relations) ? a.relations : [])
        .filter(r => ids.has(str(r?.subject)) && RELATIONS.includes(r?.relation as RelationKind) && target(str(r?.object)) && r.subject !== r.object)
        .map(r => ({ subject: r.subject, relation: r.relation, object: r.object, contact_visible: r.contact_visible === true }));
    const refIds = Array.isArray(a.scale_reference?.ids) ? a.scale_reference.ids.filter(id => ids.has(id)) : [];
    return {
        scene: str(a.scene),
        scale_reference: { ids: refIds, reason: str(a.scale_reference?.reason) },
        objects, relations, notes: str(a.notes),
    };
};

const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** World units per meter, from the scale reference (or all objects) and their real heights */
export const unitsPerMeter = (analysis: SceneAnalysis, boxes: RelationBox[]): number | undefined => {
    const box = new Map(boxes.map(b => [b.id, b]));
    const ratios = (ids: string[]) => ids.flatMap(id => {
        const real = analysis.objects.find(o => o.id === id)?.height_m;
        const b = box.get(id);
        return real && b ? [b.size[1] / real] : [];
    });
    const ref = ratios(analysis.scale_reference.ids);
    const r = ref.length ? ref : ratios(analysis.objects.map(o => o.id));
    return r.length ? median(r) : undefined;
};

/** Size outside this ratio of the analysis' real size is reported */
const SIZE_RATIO = 1.33;

/**
 * Relation and size warnings per object (by id). Checked on the bounding boxes, with
 * generous margins: only clear violations are reported. "faces" is not checked (it
 * needs the models' front directions); it guides the placement only.
 */
export const checkRelations = (analysis: SceneAnalysis, boxes: RelationBox[], floorY: number, tolerance: number): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    const add = (id: string, w: string) => out.set(id, [...(out.get(id) ?? []), w]);
    const box = new Map(boxes.map(b => [b.id, b]));
    const upm = unitsPerMeter(analysis, boxes);
    const m = (units: number) => upm ? `${(units / upm).toFixed(2)} m` : `${units.toFixed(2)} units`;
    const min = (b: RelationBox, k: number) => b.center[k] - b.size[k] / 2;
    const max = (b: RelationBox, k: number) => b.center[k] + b.size[k] / 2;
    const over = (a: RelationBox, b: RelationBox, margin = 0) =>
        a.center[0] >= min(b, 0) - margin && a.center[0] <= max(b, 0) + margin && a.center[2] >= min(b, 2) - margin && a.center[2] <= max(b, 2) + margin;
    void floorY;

    for (const r of analysis.relations) {
        const a = box.get(r.subject);
        const b = box.get(r.object);
        if (!a) continue;
        if (r.relation === 'on' && b) {
            const gap = min(a, 1) - max(b, 1);
            if (!over(a, b)) add(r.subject, `should rest on ${r.object} but is not over its top`);
            else if (Math.abs(gap) > tolerance) add(r.subject, `should rest on ${r.object} but its bottom is ${m(Math.abs(gap))} ${gap > 0 ? 'above' : 'below'} ${r.object}'s top`);
        } else if (r.relation === 'sits_on' && b) {
            if (!over(a, b, 0.25 * Math.max(b.size[0], b.size[2]))) add(r.subject, `should sit on ${r.object} but is not above it`);
        } else if (r.relation === 'sits_at' && b) {
            // Horizontal gap between the boxes, and whether the person is deep inside the table's outline
            const gx = Math.max(0, min(b, 0) - max(a, 0), min(a, 0) - max(b, 0));
            const gz = Math.max(0, min(b, 2) - max(a, 2), min(a, 2) - max(b, 2));
            const gap = Math.hypot(gx, gz);
            const reach = upm ? 0.3 * upm : 0.2 * Math.max(b.size[0], b.size[2]);
            const dist = Math.hypot(a.center[0] - b.center[0], a.center[2] - b.center[2]);
            if (gap > reach) add(r.subject, `should sit at ${r.object} but is ${m(gap)} away from it`);
            else if (dist < 0.3 * Math.min(b.size[0], b.size[2])) add(r.subject, `should sit at ${r.object} but is inside its outline`);
        } else if (r.relation === 'in_front_of' && b) {
            if (Math.hypot(...a.center) > Math.hypot(...b.center) + tolerance) add(r.subject, `should be in front of ${r.object} (nearer to the camera) but is behind it`);
        }
    }
    if (upm) {
        for (const o of analysis.objects) {
            const b = box.get(o.id);
            if (!b || !o.height_m) continue;
            const h = b.size[1] / upm;
            const ratio = h / o.height_m;
            if (ratio > SIZE_RATIO || ratio < 1 / SIZE_RATIO) add(o.id, `is ${h.toFixed(2)} m tall at the scene's scale; the analysis expects about ${o.height_m.toFixed(2)} m`);
        }
    }
    return out;
};

/** Short text of the analysis for the Arrange model */
export const describeAnalysis = (a: SceneAnalysis): string => [
    `Scene analysis (made from the photo alone; follow the photo where it clearly differs, and say so in the summary):`,
    `scene: ${a.scene}`,
    `scale reference: ${a.scale_reference.ids.join(', ') || '-'} (${a.scale_reference.reason})`,
    'objects:',
    ...a.objects.map(o => `  ${o.id}: ${o.height_m.toFixed(2)} m tall, ${o.width_m.toFixed(2)} m wide; ${o.pose}`),
    'relations:',
    ...a.relations.map(r => `  ${r.subject} ${r.relation} ${r.object}${r.relation === 'on' || r.relation === 'sits_on' ? ` (contact ${r.contact_visible ? 'visible' : 'not visible'} in the photo)` : ''}`),
    ...(a.notes ? [`notes: ${a.notes}`] : []),
].join('\n');
