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
import { ARRANGE_PROVIDER_LABELS, ArrangeProvider, Block, ToolResult, ToolSpec, createArrangeChat } from './arrangeProviders';

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
    /**
     * How well the model's visible part, rendered from the photo's camera, matches the
     * object's mask in the photo (SAM 2.1): intersection over union, rendered area / mask
     * area, and the offset of the rendered centroid from the mask centroid (fractions of
     * the image width and height; + = right / down). Missing when the object has no mask.
     */
    photoMatch?: { iou: number; areaRatio: number; offset: [number, number] };
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
    /** Apply edits; returns problems (unknown ids etc.) */
    apply(edits: PlacementEdit[]): string[];
    /** Render a view with the object labels drawn on it; base64 JPEG without the data: prefix */
    render(view: ArrangeView): Promise<string>;
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
}

export interface ArrangeResult {
    rounds: number;
    summary: string;
    /** Mean photo IoU of the objects with a mask, before and after (undefined without masks) */
    photoIoUBefore?: number;
    photoIoUAfter?: number;
    /** The objects (with their photo match) before and after */
    objectsBefore: ArrangeObject[];
    objectsAfter: ArrangeObject[];
}

/** Mean photo IoU over the objects that have a mask */
export const meanPhotoIoU = (objects: ArrangeObject[]): number | undefined => {
    const v = objects.flatMap(o => o.photoMatch ? [o.photoMatch.iou] : []);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};

const SYSTEM_PROMPT = `You arrange a 3D scene that was reconstructed from a single photo, so that it matches the photo.

How the scene was built: every object in the photo was cut out, its hidden parts were completed by an image model, a 3D model was generated from it, and the model was placed by monocular depth estimation, each object on its own. Positions along the line of sight and sizes are therefore rough, and relations between objects are often wrong: cups float above a table or sink into it, people do not sit on their chairs, a table is too small or too far away, objects intersect.

Conventions (world units are relative, not meters):
- The photo's camera is at the origin and looks along -Z. +X is right, +Y is up. Objects farther away have more negative z.
- The floor is the plane y = floorY (given in the object list). It is the bottom of the lowest model; the floor is usually not visible in the photo.
- Each object is described by the center and size of its axis-aligned bounding box and its rotation about the vertical axis.
- Images: "photo" is the original photo; "photo view" renders the scene from the photo's camera; "top view" renders it from above (up in the image = away from the camera, -Z; right = +X); "oblique view" renders it from the front left and above, where distances along the line of sight and contacts are easier to see. Object names are drawn on the renderings.

Your task: make the scene physically and semantically consistent with the photo.
- Keep every object where it is in the photo (its place in the photo view should stay close to the photo). To change an object's distance without changing its place in the photo, use along_ray, which moves it along the line of sight and scales it by the same factor.
- Supports: objects standing on furniture rest on its top (cups and vases on a table); furniture and standing people rest on the floor. Two ways:
  - rest_on slides the object along the line of sight until its bottom touches the support, so it keeps its place in the photo and gets the distance (and size) that the support implies. Use it when the object's contact with the support is visible in the photo (a cup on a table top): this is usually better than the depth estimate.
  - drop_on moves the object straight down or up onto the support and keeps its distance and size. Use it when the contact is not visible (table legs and chair legs below the photo's lower edge, a person's feet hidden by a table): there the bottom's place in the photo says nothing, and rest_on would make the object much too large or too far.
  Apply them after the support itself is in its final place (edits run in the order given).
- Seated people sit on their chairs: hips at the seat, feet on the floor, close to the table if they are at a table. rest_on uses the top of a bounding box, which for a chair is the backrest, so place seated people with center or move instead.
- Each chair that a person sits on goes under that person, not beside or behind them: seat under the hips, backrest behind the person's back, the chair facing the same way as the person (a person who faces right sits on a chair whose seat faces right, so its backrest is on the person's left). A chair seen only at the edge of the photo, or only its backrest, is usually the chair of the person next to it. Use place_under to move a chair under a person (it centers the chair under the person and stands it on the floor), then turn it with rotate_y_deg so that its backrest is behind the person, and adjust with move; check in the top and oblique views that the seat is under the hips and the backrest behind the back.
- Real-world sizes: decide how many world units make a meter from the people (an adult is about 1.65-1.75 m tall standing and about 1.3 m from the floor to the top of the head when seated on a chair), then make the other objects consistent: dining or cafe table top about 0.72-0.76 m above the floor, chair seat about 0.45 m, a coffee cup about 0.08-0.10 m tall, a small vase 0.15-0.25 m. Keep the objects' places in the photo; use along_ray to change size and distance together.
- Seated people sit at chair height even when their chair is not in the scene (it may be hidden or missing): their feet on the floor, hips about 0.45 m up, the table top around the height of their lower chest or elbows. Never lower a seated person to the floor.
- Generated models can have wrong proportions (e.g. a table that is too low or too thick); fix them with scale_axes (stretch along the model's own x, y, z) rather than by changing the whole object's size.
- Orientation: people and chairs should face the way they face in the photo (e.g. two people talking face each other).
- Avoid intersections, except where parts overlap in reality (legs under a table).
- Do not change objects that are already right.

Contacts: people at a table sit close to it, with their forearms or hands on the table top when the photo shows that; a table that people sit at is between or beside them as in the photo, not a wall in front of them. Use the top and oblique views to check who sits where around the table.

Photo match: for objects with a mask in the photo, photo_match compares the model's visible part rendered from the photo's camera (hidden parts behind other models excluded) with the object's mask in the photo: iou (1 = perfect), area_ratio (rendered / photo; > 1 = too large or too near), and offset_xy (where the rendering is relative to the photo, as fractions of the image; + = right / down). Use it to check that your changes keep each object where and as large as it is in the photo, and to find objects that are off (e.g. area_ratio 1.6 and offset_xy [0.05, 0] means too large and too far right). It cannot be perfect: the models' shapes and poses differ from the photo, and objects hidden in the photo by things that are not in the scene lower it. Do not trade physical plausibility for a small gain in it, but avoid changes that lower it clearly.

Check the top view as well as the photo view: an object can look right from the camera but be at the wrong distance (e.g. a cup on the far side of the table instead of the near side). Compare where objects are on the table in the photo (near or far edge, left or right) with the top view.

Work in rounds: call update_placements with the edits for one round (you can edit several objects at once); you then get the new object list and new renderings. Check them against the photo and correct further. Before you call finish, look at your list of remaining differences: if one of them can be fixed with the tools (e.g. a person too far from the table, hands not on the table top), fix it in another round first. Call finish when the scene matches the photo well, or when further changes would not help, with a short summary of what you changed. Do at most a few rounds.`;

const TOOLS: ToolSpec[] = [
    {
        name: 'update_placements',
        description: 'Change the placement of one or more models. For each edit, the fields that are given are applied in this order: scale, scale_axes, rotate_y_deg, place_under, along_ray, move, center, rest_on, drop_on. Returns the new object list and new renderings (photo view, top view and oblique view).',
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

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The object list given to Claude */
const describeObjects = (scene: ArrangeScene): string => {
    const objects = scene.objects();
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
        ...(o.photoMatch ? {
            photo_match: {
                iou: round3(o.photoMatch.iou),
                area_ratio: round3(o.photoMatch.areaRatio),
                offset_xy: o.photoMatch.offset.map(round3),
            },
        } : {}),
    }));
    return `floorY = ${round3(scene.floorY())}${mean !== undefined ? `\nmean photo_match iou = ${round3(mean)}` : ''}\nObjects:\n${lines.join('\n')}`;
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
    const { provider, apiKey, model, photoUrl, maxRounds = 6, signal, onProgress } = options;
    const name = ARRANGE_PROVIDER_LABELS[provider];

    onProgress?.('Rendering the scene…');
    const objectsBefore = scene.objects();
    const photoIoUBefore = meanPhotoIoU(objectsBefore);
    const end = () => { const objectsAfter = scene.objects(); return { photoIoUBefore, photoIoUAfter: meanPhotoIoU(objectsAfter), objectsBefore, objectsAfter }; };
    const [photo, photoView, topView, obliqueView] = await Promise.all([photoToJpeg(photoUrl), scene.render('photo'), scene.render('top'), scene.render('oblique')]);

    const chat = createArrangeChat({
        provider, apiKey, model, signal,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        first: [
            { type: 'text', text: 'Photo:' },
            imageBlock(photo),
            { type: 'text', text: 'Photo view of the current scene:' },
            imageBlock(photoView),
            { type: 'text', text: 'Top view of the current scene:' },
            imageBlock(topView),
            { type: 'text', text: 'Oblique view of the current scene:' },
            imageBlock(obliqueView),
            { type: 'text', text: `${describeObjects(scene)}\n\nArrange the scene so that it matches the photo. Use update_placements, and call finish when done.` },
        ],
    });

    let rounds = 0;
    for (let turn = 0; turn < maxRounds + 3; turn++) {
        onProgress?.(rounds === 0 ? `${name} is looking at the photo and the scene…` : `${name} is checking round ${rounds}…`);
        const { texts, calls } = await chat.next();

        if (calls.length === 0) {
            // A final answer without tools becomes the summary
            return { rounds, summary: texts.join('\n') || `${name} ended without calling finish.`, ...end() };
        }
        // Comments between rounds
        texts.forEach(t => onProgress?.(t));

        const finish = calls.find(t => t.name === 'finish');
        if (finish) {
            const summary = String((finish.input as { summary?: unknown })?.summary ?? '').trim();
            return { rounds, summary: summary || 'Done.', ...end() };
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
            rounds++;
            const reason = String((tool.input as { reason?: unknown })?.reason ?? '').trim();
            onProgress?.(`Round ${rounds}: ${reason || `${edits.length} edit(s)`}`);
            problems.push(...scene.apply(edits));
            const [newPhotoView, newTopView, newObliqueView] = await Promise.all([scene.render('photo'), scene.render('top'), scene.render('oblique')]);
            results.push({
                id: tool.id,
                name: tool.name,
                blocks: [
                    { type: 'text', text: `${problems.length ? `Problems: ${problems.join('; ')}\n` : ''}Applied ${edits.length} edit(s) (round ${rounds} of at most ${maxRounds}).\n${describeObjects(scene)}\nPhoto view:` },
                    imageBlock(newPhotoView),
                    { type: 'text', text: 'Top view:' },
                    imageBlock(newTopView),
                    { type: 'text', text: 'Oblique view:' },
                    imageBlock(newObliqueView),
                ],
            });
        }
        chat.addToolResults(results);
    }
    return { rounds, summary: 'Stopped after the maximum number of rounds.', ...end() };
};
