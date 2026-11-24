/**
 * Semantic arrangement of the 3D scene with Claude.
 *
 * The automatic placement puts each model where its box and the depth map say,
 * one object at a time, so relations between objects are often wrong: cups float
 * above the table or sink into it, a seated person does not sit on the chair, a
 * table is too small for the people around it. Claude looks at the photo and at
 * renderings of the scene (from the photo's camera and from above), reads where
 * each model is, and moves, turns and scales the models with a tool until the
 * scene matches the photo; after each change it sees new renderings.
 *
 * The scene itself (three.js) is behind the ArrangeScene interface, implemented by
 * the 3D scene component.
 */
import { ARRANGE_PROVIDER_LABELS, ArrangeProvider, Block, ToolResult, ToolSpec, Usage, createArrangeChat } from './arrangeProviders';
import { ANALYSIS_PROMPT, SCENE_TOOL, SceneAnalysis, certainPart, checkRelations, describeAnalysis, parseAnalysis } from './sceneAnalysis';

/** One model in the scene, in world units (see the system prompt for the conventions) */
export interface ArrangeObject {
    id: string;
    label: string;
    description?: string;
    type?: 'person' | 'object';
    /** Object's box in the photo [ymin, xmin, ymax, xmax], 0..1 */
    photoBox?: [number, number, number, number];
    /** Center of the model's world bounding box */
    center: [number, number, number];
    /** Size of the world bounding box (x, y, z) */
    size: [number, number, number];
    /** Rotation about the vertical axis (degrees) */
    rotationYDeg: number;
    /** Rotation set by the front alignment (the model's view from the camera matched with its completed image of the photo) */
    alignedRotationYDeg?: number;
    /** Oriented footprint on the floor plane (x, z): center, half extents along the model's own axes, turn about the vertical axis */
    footprint?: { center: [number, number]; half: [number, number]; yawDeg: number };
    /**
     * How well the model's visible part, rendered from the photo's camera, matches the
     * object's mask in the photo (SAM 2.1): intersection over union, rendered area / mask
     * area, and the offset of the rendered centroid from the mask centroid (fractions of
     * the image width and height; + = right / down). Missing when the object has no mask.
     */
    photoMatch?: { iou: number; areaRatio: number; offset: [number, number]; maskFraction?: number };
    /** Physical problems found by the checks (floating, sunk, inside another model) */
    warnings?: string[];
    /** Relations and sizes of the scene analysis that the scene does not satisfy */
    relationWarnings?: string[];
    /** How far the model's proportions are from the generated model's: largest relative difference between its axis scales (0 = unchanged) */
    proportionChange?: number;
}

/** One change requested by Claude; every field is optional and applied in this order */
export interface PlacementEdit {
    id: string;
    /** Multiply the size (uniform scale about the bounding-box center) */
    scale?: number;
    /** Stretch along the model's own axes [x, y, z] (e.g. make a table taller) */
    scale_axes?: [number, number, number];
    /** Turn about the vertical axis by this many degrees (positive = counterclockwise seen from above) */
    rotate_y_deg?: number;
    /** Move the center along the line of sight from the camera by this factor (keeps the object's place in the photo; scales it by the same factor) */
    along_ray?: number;
    /** Move by this offset (world units) */
    move?: [number, number, number];
    /** Put the bounding-box center here (world units) */
    center?: [number, number, number];
    /** Put the bottom of the model on the floor ("floor") or on top of another model's bounding box (its id), moving it along the line of sight so that it keeps its place in the photo */
    rest_on?: string;
    /** Put the bottom of the model on the floor or on another model's top by moving it straight down or up (keeps its distance and size) */
    drop_on?: string;
    /** Move a chair (or stool) horizontally under a seated person (their id) and stand it on the floor */
    place_under?: string;
}

export type ArrangeView = 'photo' | 'top' | 'oblique';

export interface ArrangeScene {
    /** Current state of every model */
    objects(): ArrangeObject[];
    /** Height of the floor (y) */
    floorY(): number;
    /** Number of physical issues found by the last call of objects() */
    issueCount(): number;
    /** Apply edits; returns problems (unknown ids etc.) */
    apply(edits: PlacementEdit[]): string[];
    /** Render a view with the object labels drawn on it; base64 JPEG without the data: prefix */
    render(view: ArrangeView): Promise<string>;
    /** The photo's camera: downward tilt and horizontal field of view (degrees) */
    camera(): { pitchDeg: number; hfovDeg: number };
    /** Change the photo's camera; every model keeps its place and apparent size in the photo. Returns problems */
    setCamera(pitchDeg: number, hfovDeg: number): string[];
    /** Put the floor at the bottom of a model (by id), without moving any model. Returns problems */
    setFloorAt(id: string): string[];
    /** The placements of all models (and the camera), to go back to later */
    snapshot(): unknown;
    /** Put the models back where a snapshot had them */
    restore(snapshot: unknown): void;
}

export interface ArrangeOptions {
    provider: ArrangeProvider;
    apiKey: string;
    model: string;
    /** The photo as a data URL or URL */
    photoUrl: string;
    /** Maximum number of placement rounds */
    maxRounds?: number;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    /** Filled while the run goes on (also kept when it fails or is cancelled) */
    record?: ArrangeRecord;
    /** Reference analysis checked by a person (ids as in the object list), for evaluation only: never shown to the model */
    reference?: SceneAnalysis;
}

/** One API call */
export interface ArrangeCallRecord {
    index: number;
    /** Milliseconds since the start of the run, and duration of the call */
    startMs: number;
    durationMs: number;
    usage: Usage;
    /** Model that answered (as reported by the API) */
    model?: string;
    /** Tools it called */
    tools: string[];
}

/** One round of edits and the scene after it */
export interface ArrangeRoundRecord {
    round: number;
    /** Index of the API call that requested it */
    call: number;
    reason: string;
    edits: PlacementEdit[];
    /** Camera set in this round (before the edits), if any */
    camera?: { pitchDeg: number; hfovDeg: number };
    /** Object whose bottom became the floor in this round, if any */
    floorAt?: string;
    problems: string[];
    /** Milliseconds to apply the edits, render the views and measure the scene */
    applyMs: number;
    renderMs: number;
    measureMs: number;
    meanIoU?: number;
    /** Mean IoU weighted by the objects' areas in the photo */
    weightedIoU?: number;
    issues: number;
    /** Relation and size warnings from the scene analysis (undefined without an analysis) */
    relationIssues?: number;
    /** The photo's camera after the round */
    cameraAfter?: { pitchDeg: number; hfovDeg: number };
    /** The same against the reference analysis (evaluation only; undefined without a reference) */
    refRelationIssues?: number;
    refRelationWarnings?: Record<string, string[]>;
    objects: { id: string; label: string; iou?: number; areaRatio?: number; warnings?: string[]; relationWarnings?: string[]; proportionChange?: number }[];
    /** Renderings after the round (base64 JPEG): photo view, top view, oblique view */
    images: { photo: string; top: string; oblique: string };
}

export interface ArrangeRecord {
    settings: { provider: ArrangeProvider; model: string; effort: string; maxRounds: number; promptVersion: string; appVersion: string };
    startedAt: number;
    /** Scene before the first round (round 0) */
    initial?: Omit<ArrangeRoundRecord, 'call' | 'reason' | 'edits' | 'problems' | 'applyMs'>;
    /** The photo (base64 JPEG) */
    photo?: string;
    /** Semantic analysis of the photo made before the placement rounds */
    analysis?: SceneAnalysis;
    /** The analysis as the model sent it (before unknown ids and relations were dropped) */
    analysisRaw?: unknown;
    /** Reference analysis used for the evaluation */
    reference?: SceneAnalysis;
    /** update_placements calls that changed nothing, as the model sent them (to find out why) */
    emptyCalls?: { call: number; input: unknown }[];
    /** Set when the scene was set back to an earlier, better state at the end (0 = as before the run) */
    kept?: { round: number; score: number; lastRound: number; lastScore: number };
    calls: ArrangeCallRecord[];
    rounds: ArrangeRoundRecord[];
}

/** Version of the app (package version and git commit, set at build time) */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';

/** Effort used for every provider */
export const ARRANGE_EFFORT = 'high';


export interface ArrangeResult {
    rounds: number;
    summary: string;
    /** Mean photo IoU of the objects with a mask, before and after (undefined without masks) */
    photoIoUBefore?: number;
    photoIoUAfter?: number;
    /** Number of physical issues (floating, sunk, penetrating pairs) before and after */
    issuesBefore: number;
    issuesAfter: number;
    /** Number of relation and size warnings from the scene analysis before and after */
    relationIssuesBefore?: number;
    relationIssuesAfter?: number;
    /** The same against the reference analysis (evaluation only) */
    refRelationIssuesBefore?: number;
    refRelationIssuesAfter?: number;
    /** Round whose state was kept, when it is not the last one (0 = the scene as before the run) */
    keptRound?: number;
    /** The objects (with their photo match) before and after */
    objectsBefore: ArrangeObject[];
    objectsAfter: ArrangeObject[];
}

/** Mean photo IoU over the objects that have a mask */
/**
 * Mean photo IoU weighted by each object's area in the photo (its mask), so that objects
 * seen only as a sliver at the photo's edge count less (for evaluation; not shown to the model)
 */
export const weightedPhotoIoU = (objects: ArrangeObject[]): number | undefined => {
    const v = objects.flatMap(o => o.photoMatch?.maskFraction ? [[o.photoMatch.iou, o.photoMatch.maskFraction]] : []);
    const w = v.reduce((a, [, f]) => a + f, 0);
    return w > 0 ? v.reduce((a, [iou, f]) => a + iou * f, 0) / w : undefined;
};

export const meanPhotoIoU = (objects: ArrangeObject[]): number | undefined => {
    const v = objects.flatMap(o => o.photoMatch ? [o.photoMatch.iou] : []);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};

/**
 * Score of a state for keeping the best one: mean photo IoU minus 0.02 per physical issue
 * and per relation issue of the model's own analysis (the reference analysis, for
 * evaluation only, is not used). A state is kept instead of the last one only when it
 * scores at least KEEP_BEST_MARGIN higher.
 */
const stateScore = (m: { objects: ArrangeObject[]; issues: number; relationIssues?: number }) =>
    (meanPhotoIoU(m.objects) ?? 0) - 0.02 * m.issues - 0.02 * (m.relationIssues ?? 0);
const KEEP_BEST_MARGIN = 0.01;

const SYSTEM_PROMPT = `You arrange a 3D scene that was reconstructed from a single photo, so that it matches the photo.

How the scene was built: every object in the photo was cut out, its hidden parts were completed by an image model, a 3D model was generated from it, and the model was placed by monocular depth estimation, each object on its own. Positions along the line of sight and sizes are therefore rough, and relations between objects are often wrong: objects float above their support or sink into it, people do not sit on their seats, furniture is too small or too far away, objects intersect.

Conventions (world units are relative, not meters):
- The photo's camera is at the origin and looks along -Z. +X is right, +Y is up. Objects farther away have more negative z.
- The floor is the plane y = floorY (given in the object list). It is the bottom of the lowest model; the floor is usually not visible in the photo.
- Each object is described by the center and size of its axis-aligned bounding box and its rotation about the vertical axis.
- Images: "photo" is the original photo; "photo view" renders the scene from the photo's camera; "top view" renders it from above (up in the image = away from the camera, -Z; right = +X); "oblique view" renders it from the front left and above, where distances along the line of sight and contacts are easier to see. Object names are drawn on the renderings.

Your task: make the scene physically and semantically consistent with the photo. A scene analysis made from the photo comes first: what the scene is, the real size of each object, the scale reference, and the relations between objects (on, sits_on, sits_at, faces, in_front_of). Use it as the plan; "relation_warnings" in the object list show relations and sizes that the scene does not satisfy yet. The analysis can be wrong: where the photo clearly shows otherwise, follow the photo and say so in the summary.
- Keep every object where it is in the photo (its place in the photo view should stay close to the photo). To change an object's distance without changing its place in the photo, use along_ray, which moves it along the line of sight and scales it by the same factor.
- Real-world sizes: decide how many world units make a meter from the analysis' scale reference, then give every object the height the analysis gives it by scaling it uniformly (scale, or along_ray to change size and distance together); the widths are only a check, not a reason to stretch.
- Supports ("on" in the analysis): an object resting on another stands on its top, furniture and standing people on the floor. Two ways:
  - rest_on slides the object along the line of sight until its bottom touches the support, so it keeps its place in the photo and gets the distance (and size) that the support implies. Use it when the contact is visible in the photo (contact visible in the analysis): this is usually better than the depth estimate.
  - drop_on moves the object straight down or up onto the support and keeps its distance and size. Use it when the contact is not visible (contact not visible in the analysis, e.g. legs below the photo's lower edge or hidden behind something): there the bottom's place in the photo says nothing, and rest_on would make the object much too large or too far.
  Apply them after the support itself is in its final place (edits run in the order given).
- Seated people ("sits_on", "sits_at"): hips at the seat, about 0.45 m above the floor, feet on the floor, close to the table or desk they sit at, with the top around the height of their lower chest or elbows. This holds also when the seat is not in the scene ("sits_on none"): never lower a seated person to the floor. rest_on uses the top of a bounding box, which for a chair is the backrest, so place seated people with center or move.
- A seat in the scene goes under the person who sits on it: use place_under (it centers the seat under the person and stands it on the floor), then turn it with rotate_y_deg so that the person faces the way the seat faces (backrest behind the back), and adjust with move; check in the top and oblique views that the seat is under the hips.
- Generated models can have wrong proportions (e.g. furniture that is too low or too thick); fix them with scale_axes (stretch along the model's own x, y, z) rather than by changing the whole object's size. Never stretch people: their body proportions stay as generated (scale_axes is refused for people; use scale). Do not stretch other objects only to improve the photo match either; proportion_change in the object list shows how far each object is from the generated model's proportions.
- Orientation ("faces"): people, chairs and other objects with a front should face the way they face in the photo. rotation_y_deg_from_photo is the turn that the front alignment found by comparing each model, seen from the camera, with the object in the photo (e.g. a table seen corner-on); keep it unless the photo clearly shows another orientation, and do not turn furniture square to the camera only because that seems usual.
- The photo's camera: the scene was built for a level camera (pitch_deg 0) with a 60° horizontal field of view, which is only an assumption. If the objects cannot all have their real sizes and their places in the photo at the same time (e.g. an object resting on a support whose contact is visible comes out clearly larger or smaller than its real size; a piece of furniture standing on the floor at its real height does not reach its top or bottom edge in the photo; objects farther from the camera look too small at their real sizes), the camera is probably tilted or has another field of view. Typical values: a photo taken at eye level is tilted about 0-10° down, one taken looking down on the scene about 15-30°, one looking up is negative; phone cameras have about 65-75° horizontal field of view, zoomed photos less. Then set camera with update_placements: all models keep their place and apparent size in the photo. The floor then moves to the bottom of the lowest model, which may be wrong (e.g. a chair re-projected below the people's feet); set floor_at in the same call to the object that stands on the floor most reliably (usually a person whose feet are generated, or a piece of furniture whose legs are visible), and fix the other supports in the same edits (drop_on floor for furniture and people whose contact is hidden, rest_on for objects on tops). The camera's height above the floor follows from the floor and needs no setting. Change the camera early, before fine-tuning, and only for such a conflict.
- Avoid intersections, except where parts overlap in reality (legs under a table).
- Do not change objects that are already right.

Photo match: for objects with a mask in the photo, photo_match compares the model's visible part rendered from the photo's camera (hidden parts behind other models excluded) with the object's mask in the photo: iou (1 = perfect), area_ratio (rendered / photo; > 1 = too large or too near), and offset_xy (where the rendering is relative to the photo, as fractions of the image; + = right / down). Use it to check that your changes keep each object where and as large as it is in the photo, and to find objects that are off (e.g. area_ratio 1.6 and offset_xy [0.05, 0] means too large and too far right). It cannot be perfect: the models' shapes and poses differ from the photo, and objects hidden in the photo by things that are not in the scene lower it. Do not trade physical plausibility for a small gain in it, but avoid changes that lower it clearly.

Physical checks: "warnings" lists problems measured on the meshes: floating (the bottom is above the floor or the surface below it, e.g. a person's feet in the air), sunk (the bottom is below the top of the object it stands on, or below the floor), inside (part of the object's surface is inside another object), and cuts through (the object passes through another one, e.g. a table top through a seated person's thighs or torso: the person sits too close or inside the table's outline, or the table is too low). "physical issues" is their number in the scene. Fix them, except contacts that are real (e.g. a seated person slightly sinking into a cushion); a scene with no warnings is not necessarily right, so still compare it with the photo.

Check the top view as well as the photo view: an object can look right from the camera but be at the wrong distance (e.g. a cup on the far side of a table instead of the near side). Compare the order along the line of sight ("in_front_of" in the analysis, near or far edge of a support, left or right) with the top view.

Work in rounds: call update_placements with the edits for one round (you can edit several objects at once); you then get the new object list and new renderings. Check them against the photo and correct further. Before you call finish, look at your list of remaining differences and at the relation warnings: if one of them can be fixed with the tools (e.g. a person too far from the table they sit at), fix it in another round first. No warnings is not enough: if an object's photo_match area_ratio is below 0.75 or above 1.33, or its iou is clearly lower than the others', do another round for it, unless you can say why it cannot be fixed (e.g. it is hidden in the photo by something that is not in the scene, or its generated shape differs from the photo); give that reason in the summary. Call finish when the scene matches the photo well, or when further changes would not help, with a short summary of what you changed. Do at most a few rounds.`;

const TOOLS: ToolSpec[] = [
    {
        name: 'update_placements',
        description: 'Change the placement of one or more models, optionally after setting the photo\'s camera (camera) and the floor (floor_at). For each edit, the fields that are given are applied in this order: scale, scale_axes, rotate_y_deg, place_under, along_ray, move, center, rest_on, drop_on. Returns the new object list and new renderings (photo view, top view and oblique view).',
        schema: {
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Object id from the object list' },
                            scale: { type: 'number', description: 'Multiply the size by this factor (uniform, about the bounding-box center)' },
                            scale_axes: { type: 'array', items: { type: 'number' }, description: 'Stretch along the model\'s own axes [sx, sy, sz] about the bounding-box center (e.g. [1, 1.4, 1] makes a table taller)' },
                            rotate_y_deg: { type: 'number', description: 'Turn about the vertical axis by this many degrees (positive = counterclockwise seen from above)' },
                            along_ray: { type: 'number', description: 'Move the center along the line of sight by this factor (>1 = farther); the size is scaled by the same factor, so the object keeps its place and size in the photo' },
                            move: { type: 'array', items: { type: 'number' }, description: 'Offset [dx, dy, dz] in world units' },
                            center: { type: 'array', items: { type: 'number' }, description: 'New bounding-box center [x, y, z] in world units' },
                            rest_on: { type: 'string', description: '"floor", or the id of the object whose bounding-box top this object should stand on; the object slides along the line of sight until it touches it (keeps its place in the photo)' },
                            place_under: { type: 'string', description: 'Id of a seated person: moves this chair horizontally so that it is centered under the person, and stands it on the floor (then turn it with rotate_y_deg so that its backrest is behind the person)' },
                            drop_on: { type: 'string', description: '"floor", or the id of the object whose bounding-box top this object should stand on; moves straight down or up and keeps distance and size (use when the contact is not visible in the photo)' },
                        },
                        required: ['id'],
                        additionalProperties: false,
                    },
                },
                camera: {
                    type: 'object',
                    description: 'Optional: set the photo\'s camera before the edits (downward tilt and horizontal field of view). Every model keeps its place and apparent size in the photo; supports must be fixed again afterwards.',
                    properties: {
                        pitch_deg: { type: 'number', description: 'Downward tilt of the camera in degrees (0 = level; e.g. 10 for a camera looking slightly down)' },
                        hfov_deg: { type: 'number', description: 'Horizontal field of view in degrees (60 = default; wider for phone cameras, narrower for zoomed photos)' },
                    },
                    required: ['pitch_deg', 'hfov_deg'],
                    additionalProperties: false,
                },
                floor_at: { type: 'string', description: 'Optional: put the floor at the bottom of this object (its id), e.g. a seated person whose feet are on the floor in reality, after the camera and before the edits; no model moves. Without it the floor is the bottom of the lowest model.' },
                reason: { type: 'string', description: 'What these edits fix, in one or two sentences' },
            },
            required: ['edits', 'reason'],
            additionalProperties: false,
        },
    },
    {
        name: 'finish',
        description: 'End the arrangement when the scene matches the photo, or when further changes would not help.',
        schema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'Short summary of what was changed and what still differs from the photo' },
            },
            required: ['summary'],
            additionalProperties: false,
        },
    },
];

/** Short hash of the prompt and tools, to tell which version of the instructions a result comes from */
export const ARRANGE_PROMPT_VERSION = (() => {
    const text = SYSTEM_PROMPT + JSON.stringify(TOOLS) + ANALYSIS_PROMPT + JSON.stringify(SCENE_TOOL);
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
})();

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The object list given to Claude */
const describeObjects = (scene: ArrangeScene, objects: ArrangeObject[], relationIssues?: number): string => {
    const mean = meanPhotoIoU(objects);
    const lines = objects.map(o => JSON.stringify({
        id: o.id,
        label: o.label,
        type: o.type ?? 'object',
        ...(o.description ? { description: o.description } : {}),
        ...(o.photoBox ? { photo_box_ymin_xmin_ymax_xmax: o.photoBox.map(round3) } : {}),
        center: o.center.map(round3),
        size: o.size.map(round3),
        bottom_y: round3(o.center[1] - o.size[1] / 2),
        top_y: round3(o.center[1] + o.size[1] / 2),
        rotation_y_deg: Math.round(o.rotationYDeg),
        ...(o.alignedRotationYDeg !== undefined ? { rotation_y_deg_from_photo: Math.round(o.alignedRotationYDeg) } : {}),
        ...(o.warnings?.length ? { warnings: o.warnings } : {}),
        ...(o.relationWarnings?.length ? { relation_warnings: o.relationWarnings } : {}),
        ...(o.proportionChange !== undefined && o.proportionChange > 0.005 ? { proportion_change: round3(o.proportionChange) } : {}),
        ...(o.photoMatch ? {
            photo_match: {
                iou: round3(o.photoMatch.iou),
                area_ratio: round3(o.photoMatch.areaRatio),
                offset_xy: o.photoMatch.offset.map(round3),
            },
        } : {}),
    }));
    const cam = scene.camera();
    return `camera: pitch_deg ${round3(cam.pitchDeg)} (downward tilt), hfov_deg ${round3(cam.hfovDeg)}\nfloorY = ${round3(scene.floorY())}${mean !== undefined ? `\nmean photo_match iou = ${round3(mean)}` : ''}\nphysical issues = ${scene.issueCount()}${relationIssues !== undefined ? `\nrelation issues = ${relationIssues}` : ''}\nObjects:\n${lines.join('\n')}`;
};

const imageBlock = (base64: string): Block => ({ type: 'image', base64 });

/** Photo as base64 JPEG (at most 1568 px on the long side, the size Claude uses) */
const photoToJpeg = async (url: string): Promise<string> => {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.crossOrigin = 'anonymous';
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Failed to load the photo'));
        el.src = url;
    });
    const s = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88).split(',')[1];
};

/** The camera requested with update_placements, if any (tilt -10..45°, field of view 30..100°) */
const validateCamera = (input: unknown, problems: string[]): { pitchDeg: number; hfovDeg: number } | undefined => {
    const c = (input as { camera?: { pitch_deg?: unknown; hfov_deg?: unknown } })?.camera;
    if (c === undefined || c === null) return undefined;
    const p = c.pitch_deg, f = c.hfov_deg;
    if (typeof p !== 'number' || typeof f !== 'number' || !Number.isFinite(p) || !Number.isFinite(f) || p < -10 || p > 45 || f < 30 || f > 100) {
        problems.push('camera: pitch_deg must be -10..45 and hfov_deg 30..100; the camera was not changed');
        return undefined;
    }
    return { pitchDeg: p, hfovDeg: f };
};

const isVec3 = (v: unknown): v is [number, number, number] =>
    Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));

/** Check the edits Claude sent (strict tool use guarantees the shape, but not the values) */
const validateEdits = (input: unknown): { edits: PlacementEdit[]; problems: string[] } => {
    const problems: string[] = [];
    const raw = (input as { edits?: unknown })?.edits;
    if (!Array.isArray(raw)) return { edits: [], problems: ['"edits" must be an array'] };
    const edits: PlacementEdit[] = [];
    for (const e of raw as Record<string, unknown>[]) {
        if (typeof e?.id !== 'string') { problems.push('an edit has no id'); continue; }
        const edit: PlacementEdit = { id: e.id };
        const positive = (k: 'scale' | 'along_ray') => {
            const v = e[k];
            if (v === undefined) return;
            if (typeof v === 'number' && Number.isFinite(v) && v > 0.05 && v < 20) edit[k] = v;
            else problems.push(`${e.id}: ${k} must be a number between 0.05 and 20`);
        };
        positive('scale');
        positive('along_ray');
        if (e.rotate_y_deg !== undefined) {
            if (typeof e.rotate_y_deg === 'number' && Number.isFinite(e.rotate_y_deg)) edit.rotate_y_deg = e.rotate_y_deg;
            else problems.push(`${e.id}: rotate_y_deg must be a number`);
        }
        if (e.scale_axes !== undefined) {
            if (isVec3(e.scale_axes) && (e.scale_axes as number[]).every(v => v > 0.1 && v < 10)) edit.scale_axes = e.scale_axes as [number, number, number];
            else problems.push(`${e.id}: scale_axes must be [sx, sy, sz] with factors between 0.1 and 10`);
        }
        for (const k of ['move', 'center'] as const) {
            if (e[k] === undefined) continue;
            if (isVec3(e[k])) edit[k] = e[k] as [number, number, number];
            else problems.push(`${e.id}: ${k} must be [x, y, z]`);
        }
        if (e.rest_on !== undefined) {
            if (typeof e.rest_on === 'string') edit.rest_on = e.rest_on;
            else problems.push(`${e.id}: rest_on must be a string`);
        }
        if (e.place_under !== undefined) {
            if (typeof e.place_under === 'string') edit.place_under = e.place_under;
            else problems.push(`${e.id}: place_under must be a string`);
        }
        if (e.drop_on !== undefined) {
            if (typeof e.drop_on === 'string') edit.drop_on = e.drop_on;
            else problems.push(`${e.id}: drop_on must be a string`);
        }
        edits.push(edit);
    }
    return { edits, problems };
};

/**
 * Let a vision model (Claude, OpenAI or Gemini) arrange the scene. The scene is changed
 * in place through `scene.apply`; the caller records the result (e.g. as placements set
 * by hand, one undo step).
 */
export const arrangeScene = async (scene: ArrangeScene, options: ArrangeOptions): Promise<ArrangeResult> => {
    const { provider, apiKey, model, photoUrl, maxRounds = 6, signal, onProgress, reference } = options;
    const name = ARRANGE_PROVIDER_LABELS[provider];
    const startedAt = Date.now();
    const record: ArrangeRecord = options.record ?? {
        settings: { provider, model, effort: ARRANGE_EFFORT, maxRounds, promptVersion: ARRANGE_PROMPT_VERSION, appVersion: APP_VERSION },
        startedAt, calls: [], rounds: [],
    };
    const now = () => performance.now();
    /** Measure the scene: objects with photo match and warnings, and the number of physical issues */
    let analysis: SceneAnalysis | undefined;
    const measure = () => {
        const t = now();
        const objects = scene.objects();
        let relationIssues: number | undefined;
        if (analysis) {
            // Same contact tolerance as the physical checks: 1.5% of the tallest model
            const tolerance = 0.015 * Math.max(...objects.map(o => o.size[1]));
            const warnings = checkRelations(analysis, objects, scene.floorY(), tolerance);
            objects.forEach(o => { o.relationWarnings = warnings.get(o.id) ?? []; });
            relationIssues = [...warnings.values()].reduce((n, w) => n + w.length, 0);
        }
        let refRelationIssues: number | undefined, refRelationWarnings: Record<string, string[]> | undefined;
        if (reference) {
            const tolerance = 0.015 * Math.max(...objects.map(o => o.size[1]));
            const warnings = checkRelations(certainPart(reference), objects, scene.floorY(), tolerance);
            refRelationWarnings = Object.fromEntries(warnings);
            refRelationIssues = [...warnings.values()].reduce((n, w) => n + w.length, 0);
        }
        return { objects, issues: scene.issueCount(), relationIssues, refRelationIssues, refRelationWarnings, ms: now() - t };
    };
    const summarizeObjects = (objects: ArrangeObject[]) => objects.map(o => ({
        id: o.id, label: o.label, iou: o.photoMatch?.iou, areaRatio: o.photoMatch?.areaRatio, warnings: o.warnings, relationWarnings: o.relationWarnings, proportionChange: o.proportionChange,
}));
    const renderAll = async () => {
        const t = now();
        const [photo, top, oblique] = await Promise.all([scene.render('photo'), scene.render('top'), scene.render('oblique')]);
        return { images: { photo, top, oblique }, ms: now() - t };
    };

    const photo = await photoToJpeg(photoUrl);
    record.photo = photo;

    // 1. Semantic analysis of the photo (photo and object list only, no renderings)
    {
        onProgress?.(`${name} is analyzing the photo…`);
        const listed = scene.objects();
        const ids = new Set(listed.map(o => o.id));
        const list = listed.map(o => JSON.stringify({
            id: o.id, label: o.label, type: o.type ?? 'object',
            ...(o.description ? { description: o.description } : {}),
            ...(o.photoBox ? { photo_box_ymin_xmin_ymax_xmax: o.photoBox.map(round3) } : {}),
        })).join('\n');
        const analysisChat = createArrangeChat({
            provider, apiKey, model, signal,
            system: ANALYSIS_PROMPT,
            tools: [SCENE_TOOL],
            first: [
                { type: 'text', text: 'Photo:' },
                imageBlock(photo),
                { type: 'text', text: `Objects:\n${list}\n\nAnalyze the photo and call report_scene.` },
            ],
        });
        for (let attempt = 0; attempt < 2 && !analysis; attempt++) {
            const t0 = now(), startMs = Date.now() - startedAt;
            const { calls, usage, model: answeredBy } = await analysisChat.next();
            record.calls.push({ index: record.calls.length + 1, startMs, durationMs: Math.round(now() - t0), usage, model: answeredBy, tools: calls.map(c => c.name) });
            const call = calls.find(c => c.name === SCENE_TOOL.name);
            if (call) {
                record.analysisRaw = call.input;
                const parsed = parseAnalysis(call.input, ids);
                // An analysis without objects (e.g. ids not taken from the list) is asked again
                if (parsed && parsed.objects.length > 0) analysis = parsed;
                else if (attempt === 0) analysisChat.addToolResults([{ id: call.id, name: call.name, isError: true, blocks: [{ type: 'text', text: `The analysis has no objects with the listed ids (${[...ids].join(', ')}). Call report_scene again with every listed object in "objects" and the relations between them, using exactly these ids.` }] }]);
                else analysis = parsed;
            } else analysisChat.addText('Call report_scene with your analysis.');
        }
        record.analysis = analysis;
        record.reference = reference;
        onProgress?.(analysis
            ? `Scene: ${analysis.scene} (${analysis.relations.length} relations)`
            : `${name} gave no scene analysis; arranging without it.`);
    }

    // 2. Placement rounds
    onProgress?.('Rendering the scene…');
    const before = measure();
    const objectsBefore = before.objects;
    const photoIoUBefore = meanPhotoIoU(objectsBefore);
    const issuesBefore = before.issues;
    const relationIssuesBefore = before.relationIssues;
    const refRelationIssuesBefore = before.refRelationIssues;
    let lastObjects = objectsBefore, lastIssues = issuesBefore, lastRelationIssues = relationIssuesBefore, lastRef = refRelationIssuesBefore;
    /** At the end: if an earlier state (or the scene before the run) scored clearly better than the last one, go back to it */
    let keptRound: number | undefined;
    const keepBest = () => {
        const last = states[states.length - 1];
        const best = states.reduce((a, b) => b.score > a.score ? b : a, states[0]);
        if (best === last || best.score <= last.score + KEEP_BEST_MARGIN) return;
        scene.restore(best.snap);
        keptRound = best.round;
        record.kept = { round: best.round, score: best.score, lastRound: last.round, lastScore: last.score };
        lastObjects = best.objects;
        lastIssues = best.issues;
        lastRelationIssues = best.relationIssues;
        lastRef = best.refRelationIssues;
        onProgress?.(best.round === 0
            ? `The rounds made the scene worse (score ${last.score.toFixed(3)} vs ${best.score.toFixed(3)} before the run), so the scene was set back to how it was before.`
            : `Round ${best.round} scored better than the last round ${last.round} (${best.score.toFixed(3)} vs ${last.score.toFixed(3)}), so the scene was set back to round ${best.round}.`);
    };
    const end = () => ({
        photoIoUBefore, photoIoUAfter: meanPhotoIoU(lastObjects), issuesBefore, issuesAfter: lastIssues,
        relationIssuesBefore, relationIssuesAfter: lastRelationIssues,
        refRelationIssuesBefore, refRelationIssuesAfter: lastRef, keptRound, objectsBefore, objectsAfter: lastObjects,
    });
    const keptNote = () => keptRound === undefined ? '' : keptRound === 0
        ? ' (Arrange then set the scene back to how it was before the run, which scored better.)'
        : ` (Arrange then set the scene back to round ${keptRound}, which scored better than the last round.)`;
    // States after each round (0 = before), to keep the best one if the last rounds made things worse
    type State = { round: number; score: number; snap: unknown; objects: ArrangeObject[]; issues: number; relationIssues?: number; refRelationIssues?: number };
    const states: State[] = [{ round: 0, score: stateScore(before), snap: scene.snapshot(), objects: objectsBefore, issues: issuesBefore, relationIssues: relationIssuesBefore, refRelationIssues: before.refRelationIssues }];
    const initial = await renderAll();
    record.initial = {
        round: 0, renderMs: initial.ms, measureMs: before.ms, meanIoU: photoIoUBefore, weightedIoU: weightedPhotoIoU(objectsBefore), issues: issuesBefore, relationIssues: relationIssuesBefore,
        refRelationIssues: before.refRelationIssues, refRelationWarnings: before.refRelationWarnings, cameraAfter: scene.camera(),
        objects: summarizeObjects(objectsBefore), images: initial.images,
    };

    const chat = createArrangeChat({
        provider, apiKey, model, signal,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        first: [
            { type: 'text', text: 'Photo:' },
            imageBlock(photo),
            { type: 'text', text: 'Photo view of the current scene:' },
            imageBlock(initial.images.photo),
            { type: 'text', text: 'Top view of the current scene:' },
            imageBlock(initial.images.top),
            { type: 'text', text: 'Oblique view of the current scene:' },
            imageBlock(initial.images.oblique),
            { type: 'text', text: `${analysis ? `${describeAnalysis(analysis)}\n\n` : ''}${describeObjects(scene, objectsBefore, relationIssuesBefore)}\n\nArrange the scene so that it matches the photo. Use update_placements, and call finish when done.` },
        ],
    });

    let rounds = 0, nudged = false;
    // Turns: one per round, a few for finishing and refused rounds, and one more for each
    // request to continue after an answer without a tool call (those do not use up rounds)
    let nudges = 0;
    for (let turn = 0; turn < maxRounds + 3 + nudges; turn++) {
        onProgress?.(rounds === 0 ? `${name} is looking at the photo and the scene…` : `${name} is checking round ${rounds}…`);
        const t0 = now(), startMs = Date.now() - startedAt;
        const { texts, calls, usage, model: answeredBy } = await chat.next();
        const callIndex = record.calls.length + 1;
        record.calls.push({ index: callIndex, startMs, durationMs: Math.round(now() - t0), usage, model: answeredBy, tools: calls.map(c => c.name) });

        if (calls.length === 0) {
            // An answer without tools: ask to continue with a tool (Gemini often answers a
            // round's renderings with an almost empty text, then works on after a plain
            // request); a second such answer in a row ends the run
            if (!nudged) {
                nudged = true;
                nudges++;
                texts.forEach(t => onProgress?.(t));
                onProgress?.(`${name} answered without a tool call; asking it to continue…`);
                chat.addText('You answered without calling a tool. Check the latest renderings, object list and warnings: call update_placements for another round, or finish with a summary if the scene matches the photo.');
                continue;
            }
            keepBest();
            return { rounds, summary: (texts.join('\n') || `${name} ended without calling finish.`) + keptNote(), ...end() };
        }
        // Comments between rounds
        texts.forEach(t => onProgress?.(t));

        const finish = calls.find(t => t.name === 'finish');
        if (finish) {
            const summary = String((finish.input as { summary?: unknown })?.summary ?? '').trim();
            keepBest();
            return { rounds, summary: (summary || 'Done.') + keptNote(), ...end() };
        }

        // All tool results of this turn go back together
        const results: ToolResult[] = [];
        for (const tool of calls) {
            if (tool.name !== 'update_placements') {
                results.push({ id: tool.id, name: tool.name, isError: true, blocks: [{ type: 'text', text: `Unknown tool ${tool.name}` }] });
                continue;
            }
            if (rounds >= maxRounds) {
                results.push({ id: tool.id, name: tool.name, isError: true, blocks: [{ type: 'text', text: 'No more rounds are allowed. Call finish now with a summary.' }] });
                continue;
            }
            const { edits, problems } = validateEdits(tool.input);
            const camera = validateCamera(tool.input, problems);
            rounds++;
            nudged = false;
            const reason = String((tool.input as { reason?: unknown })?.reason ?? '').trim();
            onProgress?.(`Round ${rounds}: ${reason || `${edits.length} edit(s)`}`);
            const ta = now();
            if (camera) problems.push(...scene.setCamera(camera.pitchDeg, camera.hfovDeg));
            const floorAt = typeof (tool.input as { floor_at?: unknown })?.floor_at === 'string' ? (tool.input as { floor_at: string }).floor_at : undefined;
            if (floorAt) problems.push(...scene.setFloorAt(floorAt));
            if (edits.length === 0 && !camera && !floorAt) {
                problems.push('nothing was changed: the call had no edits, camera or floor_at');
                record.emptyCalls = [...(record.emptyCalls ?? []), { call: callIndex, input: tool.input }];
            }
            problems.push(...scene.apply(edits));
            const applyMs = now() - ta;
            const rendered = await renderAll();
            const after = measure();
            lastObjects = after.objects;
            lastIssues = after.issues;
            lastRelationIssues = after.relationIssues;
            lastRef = after.refRelationIssues;
            states.push({ round: rounds, score: stateScore(after), snap: scene.snapshot(), objects: after.objects, issues: after.issues, relationIssues: after.relationIssues, refRelationIssues: after.refRelationIssues });
            record.rounds.push({
                round: rounds, call: callIndex, reason, edits, ...(camera ? { camera } : {}), ...(floorAt ? { floorAt } : {}), problems, cameraAfter: scene.camera(),
                applyMs: Math.round(applyMs), renderMs: Math.round(rendered.ms), measureMs: Math.round(after.ms),
                meanIoU: meanPhotoIoU(after.objects), weightedIoU: weightedPhotoIoU(after.objects), issues: after.issues, relationIssues: after.relationIssues,
                refRelationIssues: after.refRelationIssues, refRelationWarnings: after.refRelationWarnings, objects: summarizeObjects(after.objects), images: rendered.images,
            });
            results.push({
                id: tool.id,
                name: tool.name,
                blocks: [
                    { type: 'text', text: `${problems.length ? `Problems: ${problems.join('; ')}\n` : ''}Applied ${edits.length} edit(s) (round ${rounds} of at most ${maxRounds}).\n${describeObjects(scene, after.objects, after.relationIssues)}\nPhoto view:` },
                    imageBlock(rendered.images.photo),
                    { type: 'text', text: 'Top view:' },
                    imageBlock(rendered.images.top),
                    { type: 'text', text: 'Oblique view:' },
                    imageBlock(rendered.images.oblique),
                ],
            });
        }
        chat.addToolResults(results);
    }
    keepBest();
    return { rounds, summary: (rounds >= maxRounds ? 'Stopped after the maximum number of rounds.' : 'Stopped: the model did not finish within the allowed number of turns.') + keptNote(), ...end() };
};
