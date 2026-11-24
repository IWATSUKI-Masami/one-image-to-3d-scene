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
import Anthropic from '@anthropic-ai/sdk';

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
}

/** One change requested by Claude; every field is optional and applied in this order */
export interface PlacementEdit {
    id: string;
    /** Multiply the size (uniform scale about the bounding-box center) */
    scale?: number;
    /** Turn about the vertical axis by this many degrees (positive = counterclockwise seen from above) */
    rotate_y_deg?: number;
    /** Move the center along the line of sight from the camera by this factor (keeps the object's place in the photo; scales it by the same factor) */
    along_ray?: number;
    /** Move by this offset (world units) */
    move?: [number, number, number];
    /** Put the bounding-box center here (world units) */
    center?: [number, number, number];
    /** Put the bottom of the model on the floor ("floor") or on top of another model's bounding box (its id) */
    rest_on?: string;
}

export type ArrangeView = 'photo' | 'top';

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
}

/** Models that accept the server-side refusal fallback ("default" form) */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-opus-5']);

const SYSTEM_PROMPT = `You arrange a 3D scene that was reconstructed from a single photo, so that it matches the photo.

How the scene was built: every object in the photo was cut out, its hidden parts were completed by an image model, a 3D model was generated from it, and the model was placed by monocular depth estimation, each object on its own. Positions along the line of sight and sizes are therefore rough, and relations between objects are often wrong: cups float above a table or sink into it, people do not sit on their chairs, a table is too small or too far away, objects intersect.

Conventions (world units are relative, not meters):
- The photo's camera is at the origin and looks along -Z. +X is right, +Y is up. Objects farther away have more negative z.
- The floor is the plane y = floorY (given in the object list).
- Each object is described by the center and size of its axis-aligned bounding box and its rotation about the vertical axis.
- Images: "photo" is the original photo; "photo view" renders the scene from the photo's camera; "top view" renders it from above (up in the image = away from the camera, -Z; right = +X). Object names are drawn on the renderings.

Your task: make the scene physically and semantically consistent with the photo.
- Keep every object where it is in the photo (its place in the photo view should stay close to the photo). To change an object's distance without changing its place in the photo, use along_ray, which moves it along the line of sight and scales it by the same factor.
- Supports: objects standing on furniture rest on its top (cups and vases on a table: use rest_on with the table's id); furniture and standing people rest on the floor (rest_on "floor").
- Seated people sit on their chairs: hips at the seat, feet on the floor, close to the table if they are at a table. rest_on uses the top of a bounding box, which for a chair is the backrest, so place seated people with center or move instead.
- Relative sizes should be plausible (a cup next to a person's hand, a table that two seated people can use, a chair that fits a person).
- Orientation: people and chairs should face the way they face in the photo (e.g. two people talking face each other).
- Avoid intersections, except where parts overlap in reality (legs under a table).
- Do not change objects that are already right.

Work in rounds: call update_placements with the edits for one round (you can edit several objects at once); you then get the new object list and new renderings. Check them against the photo and correct further. When the scene matches the photo well, or when further changes would not help, call finish with a short summary of what you changed. Do at most a few rounds.`;

const TOOLS: Anthropic.Beta.BetaTool[] = [
    {
        name: 'update_placements',
        description: 'Change the placement of one or more models. For each edit, the fields that are given are applied in this order: scale, rotate_y_deg, along_ray, move, center, rest_on. Returns the new object list and new renderings (photo view and top view).',
        strict: true,
        input_schema: {
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Object id from the object list' },
                            scale: { type: 'number', description: 'Multiply the size by this factor (uniform, about the bounding-box center)' },
                            rotate_y_deg: { type: 'number', description: 'Turn about the vertical axis by this many degrees (positive = counterclockwise seen from above)' },
                            along_ray: { type: 'number', description: 'Move the center along the line of sight by this factor (>1 = farther); the size is scaled by the same factor, so the object keeps its place and size in the photo' },
                            move: { type: 'array', items: { type: 'number' }, description: 'Offset [dx, dy, dz] in world units' },
                            center: { type: 'array', items: { type: 'number' }, description: 'New bounding-box center [x, y, z] in world units' },
                            rest_on: { type: 'string', description: '"floor", or the id of the object whose bounding-box top this object should stand on' },
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
        strict: true,
        input_schema: {
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
    const lines = scene.objects().map(o => JSON.stringify({
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
    }));
    return `floorY = ${round3(scene.floorY())}\nObjects:\n${lines.join('\n')}`;
};

const imageBlock = (base64: string, mediaType: 'image/jpeg' | 'image/png' = 'image/jpeg'): Anthropic.Beta.BetaImageBlockParam => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64 },
});

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
        for (const k of ['move', 'center'] as const) {
            if (e[k] === undefined) continue;
            if (isVec3(e[k])) edit[k] = e[k] as [number, number, number];
            else problems.push(`${e.id}: ${k} must be [x, y, z]`);
        }
        if (e.rest_on !== undefined) {
            if (typeof e.rest_on === 'string') edit.rest_on = e.rest_on;
            else problems.push(`${e.id}: rest_on must be a string`);
        }
        edits.push(edit);
    }
    return { edits, problems };
};

/**
 * Let Claude arrange the scene. The scene is changed in place through `scene.apply`;
 * the caller records the result (e.g. as placements set by hand, one undo step).
 */
export const arrangeSceneWithClaude = async (scene: ArrangeScene, options: ArrangeOptions): Promise<ArrangeResult> => {
    const { apiKey, model, photoUrl, maxRounds = 6, signal, onProgress } = options;
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const useFallbacks = FALLBACK_MODELS.has(model);

    onProgress?.('Rendering the scene…');
    const [photo, photoView, topView] = await Promise.all([photoToJpeg(photoUrl), scene.render('photo'), scene.render('top')]);

    const messages: Anthropic.Beta.BetaMessageParam[] = [{
        role: 'user',
        content: [
            { type: 'text', text: 'Photo:' },
            imageBlock(photo),
            { type: 'text', text: 'Photo view of the current scene:' },
            imageBlock(photoView),
            { type: 'text', text: 'Top view of the current scene:' },
            imageBlock(topView),
            { type: 'text', text: `${describeObjects(scene)}\n\nArrange the scene so that it matches the photo. Use update_placements, and call finish when done.` },
        ],
    }];

    let rounds = 0;
    for (let turn = 0; turn < maxRounds + 3; turn++) {
        onProgress?.(rounds === 0 ? 'Claude is looking at the photo and the scene…' : `Claude is checking round ${rounds}…`);
        const response = await client.beta.messages.create({
            model,
            max_tokens: 16000,
            system: SYSTEM_PROMPT,
            tools: TOOLS,
            messages,
            output_config: { effort: 'high' },
            ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        }, { signal });

        if (response.stop_reason === 'refusal') {
            throw new Error(`Claude declined to arrange the scene${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}.`);
        }
        if (response.stop_reason === 'max_tokens') {
            throw new Error('Claude\'s answer was cut off (max_tokens).');
        }

        // Keep the whole assistant turn (thinking blocks included) unchanged
        messages.push({ role: 'assistant', content: response.content });

        for (const block of response.content) {
            if (block.type === 'text' && block.text.trim()) onProgress?.(block.text.trim());
        }
        const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0) {
            const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map(b => b.text).join('\n');
            return { rounds, summary: text.trim() || 'Claude ended without calling finish.' };
        }

        const finish = toolUses.find(t => t.name === 'finish');
        if (finish) {
            const summary = String((finish.input as { summary?: unknown })?.summary ?? '').trim();
            return { rounds, summary: summary || 'Done.' };
        }

        // All tool results of this turn go back in one user message
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const tool of toolUses) {
            if (tool.name !== 'update_placements') {
                results.push({ type: 'tool_result', tool_use_id: tool.id, is_error: true, content: `Unknown tool ${tool.name}` });
                continue;
            }
            if (rounds >= maxRounds) {
                results.push({ type: 'tool_result', tool_use_id: tool.id, is_error: true, content: 'No more rounds are allowed. Call finish now with a summary.' });
                continue;
            }
            const { edits, problems } = validateEdits(tool.input);
            rounds++;
            const reason = String((tool.input as { reason?: unknown })?.reason ?? '').trim();
            onProgress?.(`Round ${rounds}: ${reason || `${edits.length} edit(s)`}`);
            problems.push(...scene.apply(edits));
            const [newPhotoView, newTopView] = await Promise.all([scene.render('photo'), scene.render('top')]);
            results.push({
                type: 'tool_result',
                tool_use_id: tool.id,
                content: [
                    { type: 'text', text: `${problems.length ? `Problems: ${problems.join('; ')}\n` : ''}Applied ${edits.length} edit(s) (round ${rounds} of at most ${maxRounds}).\n${describeObjects(scene)}\nPhoto view:` },
                    imageBlock(newPhotoView),
                    { type: 'text', text: 'Top view:' },
                    imageBlock(newTopView),
                ],
            });
        }
        messages.push({ role: 'user', content: results });
    }
    return { rounds, summary: 'Stopped after the maximum number of rounds.' };
};
