/**
 * AI tasks of the pipeline, independent of the provider:
 *
 * - detectObjectsInImage   (Phase 1: VLM object detection)        Gemini / OpenAI
 * - estimateHiddenExtent    (Phase 3: canvas before completion)      Gemini / OpenAI
 * - generateCompletion      (Phase 3: image completion/outpainting)  Gemini / OpenAI
 * - verifyCompletion        (Phase 3: check the completed image)     Gemini / OpenAI
 *
 * The prompts are the ones used in the paper (KBSE2025-61); only the JSON output
 * format is now enforced with each provider's structured-output feature.
 */
import { AISettings, DetectedObject, FaceStyle } from "../types";
import { analyzeImageJson, generateImage, loadImageData, JsonSchema, ImageLayout } from "./ai/providers";

// ---------------------------------------------------------------------------
// JSON schemas (compatible with Gemini and OpenAI strict mode)
// ---------------------------------------------------------------------------

const DETECTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    objects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "The descriptive name of the detected object" },
          type: { type: "string", enum: ["person", "object"], description: "Category of the object" },
          box_2d: {
            type: "array",
            description: "Tight bounding box [ymin, xmin, ymax, xmax], normalized 0.0-1.0",
            items: { type: "number" },
          },
          description: { type: "string", description: "Detailed description including pose, action, clothing, and colors" },
        },
        required: ["label", "type", "box_2d", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["objects"],
  additionalProperties: false,
};

const VERIFY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    isComplete: { type: "boolean" },
    missingParts: { type: "array", items: { type: "string" } },
  },
  required: ["isComplete", "missingParts"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Phase 1: object detection
// ---------------------------------------------------------------------------

const DETECTION_PROMPT = `Analyze this image and detect the main distinct objects. 
            
            CRITICAL INSTRUCTION: Group related items that physically belong together (e.g., flowers in a vase, a cup on a saucer) into a SINGLE object.
            
            For each object, provide:
            1. 'label': A short, descriptive name (e.g., 'woman in yellow sweater', 'man in blue blazer').
            2. 'type': Classify as 'person' if it is a human, otherwise 'object'.
            3. 'box_2d': A bounding box as [ymin, xmin, ymax, xmax] with normalized coordinates (0.0 to 1.0).
               - CRITICAL: The box must TIGHTLY enclose the ENTIRE visible object.
               - ymin = top edge, ymax = bottom edge (ymax > ymin)
               - xmin = left edge, xmax = right edge (xmax > xmin)
               - VERIFY: The aspect ratio of the box MUST match the object's actual shape.
            4. 'description': A DETAILED visual description. MUST include POSE (sitting/standing), ACTION, and CLOTHING. Do NOT just repeat the label.
            
            Return the result as JSON in the form {"objects": [...]}.`;

export const detectObjectsInImage = async (file: File, settings: AISettings): Promise<DetectedObject[]> => {
  try {
    const url = URL.createObjectURL(file);
    let image;
    try {
      image = await loadImageData(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const result = await analyzeImageJson<{ objects: DetectedObject[] }>(
      settings, image, DETECTION_PROMPT, DETECTION_SCHEMA,
      { schemaName: "detected_objects", deterministic: true, effort: "high" },
    );
    const objects = result.objects || [];
    return objects;
  } catch (error) {
    console.error("Error detecting objects:", error);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Phase 3: image completion
// ---------------------------------------------------------------------------

export type { FaceStyle };

const FACE_RULES: Record<Exclude<FaceStyle, 'keep'>, string> = {
  redraw: `**CLEAR, NATURAL FACE**:
       - Keep the person's hairstyle, skin tone, apparent age, head direction and expression
       - Render the face sharp and in focus with natural proportions: clearly defined eyes, nose, mouth and ears
       - If the face is blurred, small, low-resolution or partly hidden in the input, redraw it cleanly instead of copying the blur or artifacts
       - No distorted, melted, asymmetric or doll-like features`,
  calm: `**CLEAR, CALM FACE**:
       - Keep the person's hairstyle, skin tone, apparent age and head direction
       - Give the face a relaxed, gentle expression with the MOUTH CLOSED: a slight closed-lip smile at most, NO visible teeth, no open mouth
       - Eyes naturally open and relaxed, looking in the same direction as in the input; no squinting, no raised eyebrows
       - Render the face sharp and in focus with natural proportions; redraw a blurred, small or low-resolution face cleanly
       - Soft, even lighting on the face without strong shadows or highlights
       - No distorted, melted, asymmetric or doll-like features`,
  mannequin: `**MANNEQUIN FACE**:
       - Render the face like a smooth store mannequin or artist's figure: a uniform skin-colored surface with only the gentle shape of the brow, nose, cheeks and chin
       - NO painted or detailed eyes, eyebrows, lips, teeth or makeup
       - Keep the hair, ears, head shape, skin tone and head direction exactly as in the input
       - Keep the rest of the body, the clothing and the pose unchanged`,
};

/** Options of image completion */
export interface CompletionOptions {
  /** People: how to render the face (default 'calm') */
  faceStyle?: FaceStyle;
  /**
   * Output layout. When given (see prepareCompletionCanvas), the visible part is
   * already at its final position and size on the canvas and must stay there, so
   * that its box carries over to the completed image without matching.
   */
  layout?: ImageLayout;
  /**
   * The whole photo with the object marked by a red box (data URL), given to the
   * image model as a second image for reference: the object's appearance, viewpoint
   * and where its hidden parts go.
   */
  referenceUrl?: string;
}

const REFERENCE_RULE = `
    ***REFERENCE IMAGE***:
    A SECOND image is attached: the whole original photo, with this subject marked by a RED BOX.
    Use it ONLY as a reference for the subject's appearance, style, viewpoint and orientation, and for how its hidden
    parts continue behind other objects or beyond the photo border (e.g. other objects of the same kind in the photo).
    Do NOT copy the photo, its background or other objects. Your output is the FIRST image, completed.`;

/** Added to the prompt when the visible part must keep its place on the canvas */
const LOCKED_LAYOUT_RULE = `
    ***LAYOUT IS FIXED - CRITICAL***:
    The visible part of the subject is already drawn at its FINAL position and size on this canvas.
    - Do NOT move, rescale, re-center, crop or re-frame it; keep every visible pixel exactly where it is.
    - Draw the missing parts in the surrounding white area so that they connect seamlessly to the visible part.
    - The output must have exactly the same framing as the input canvas.`;

export const generateCompletion = async (
  imageUrl: string,
  label: string,
  type: 'person' | 'object',
  settings: AISettings,
  description?: string,
  options: CompletionOptions = {},
): Promise<string> => {
  try {
    const image = await loadImageData(imageUrl);
    const faceStyle: FaceStyle = options.faceStyle ?? 'calm';
    const faceRule = faceStyle === 'keep' ? null : FACE_RULES[faceStyle];

    let prompt = '';
    if (type === 'person') {
      // Include description with pose information if available
      const poseInfo = description ? `

    ***CRITICAL POSE CONSTRAINT***:
    Original description: "${description}"
    - If the person is SITTING, they MUST remain SITTING. Do NOT make them stand.
    - If the person is LEANING, they MUST remain LEANING. Do NOT straighten them.
    - If the person is CROUCHING, they MUST remain CROUCHING.
    - The body posture in the input image is SACRED and MUST NOT be changed.` : '';

      prompt = `Input image: ${label || 'a person'}.${poseInfo}
    
    Goal: Create a COMPLETE FULL-BODY image of this person on a pure white background. 
    
    ***CRITICAL - ALL BODY PARTS MUST BE FULLY VISIBLE***:
    The output image MUST show the ENTIRE person with NO body parts cut off at ANY edge:
    - Complete HEAD and hair (not cut off at top)
    - BOTH ARMS fully visible from shoulder to fingertips (not cut off at left/right edges)
    - BOTH HANDS with all fingers visible (not cut off at any edge)
    - Complete LEGS from hip to toe (not cut off anywhere)
    - BOTH FEET/SHOES fully visible (not cut off at bottom)
    - There MUST be WHITE MARGIN/SPACE around the entire body on ALL sides
    
    ***ABSOLUTE RULES - VIOLATION IS FAILURE***:
    
    1. **POSE IS SACRED - DO NOT CHANGE IT**: 
       - If the person appears SITTING, generate them SITTING (with chair removed)
       - If the person appears LEANING, generate them LEANING at the same angle
       - If legs are bent, they MUST remain bent
       - Do NOT straighten the body or make a sitting person stand up
       - The upper body angle and orientation MUST match the input EXACTLY
    
    2. **PRESERVE ORIGINAL PIXELS**: Copy all visible parts of the person pixel-for-pixel from the input. Do NOT regenerate or modify any visible part${faceRule ? ', except the face (rule 6)' : ''}.
    
    3. **COMPLETE ALL CUT-OFF BODY PARTS AT EVERY EDGE**: 
       - If ARM is cut off at left/right edge: Complete the full arm including HAND and FINGERS
       - If HAND is cut off: Complete all fingers
       - If LEGS are cut off at bottom: Complete legs down to FEET
       - If FEET are cut off: Complete entire feet/shoes
       - NO BODY PART should touch or be cut by ANY image edge
    
    4. **${options.layout ? 'USE THE WHITE AREA OF THE CANVAS' : 'EXTEND CANVAS GENEROUSLY IN ALL DIRECTIONS'}**: 
       - ${options.layout ? 'The canvas already has room for the COMPLETE body; draw the missing parts in the white area' : 'Extend the image to fit the COMPLETE body with MARGIN on ALL sides'}
       - Do NOT resize, move, or repose the person
       - Leave WHITE SPACE around the entire body - top, bottom, left, AND right
    
    5. **REMOVE FURNITURE BUT KEEP POSE**: Remove chairs/tables, but the person's body position must remain as if they were still seated/leaning.
    
    ${faceRule ? `6. ${faceRule}
    
    7` : '6'}. **PURE WHITE BACKGROUND - CRITICAL**: 
       - Background MUST be RGB(255,255,255) - pure white, no gray
       - Do NOT use light gray, cream, or off-white - ONLY #FFFFFF
       - Every non-person pixel must be exactly R=255, G=255, B=255
       - No shadows, no gradients, no shading on the background
    
    Output: A COMPLETE FULL-BODY image with ALL body parts (head, arms, hands, legs, feet) FULLY visible with NO cut-offs at ANY edge.`;
    } else {
      prompt = `Input image: ${label || 'an object'}.${description ? `
      Description of the WHOLE object (including parts hidden in the photo; follow it for the shape of the missing parts): "${description}"` : ''}

      Goal: Create a clean, full - view image of ONLY the "${label}".
      
      STRICT CONSTRAINTS(MUST FOLLOW):
      1. ** DO NOT RESIZE OR MOVE **: The object in the input image is already ${options.layout ? 'placed' : 'centered'} and sized correctly.DO NOT SCALE, RESIZE, OR MOVE IT.${options.layout ? ' The white area around it is room for its missing parts.' : ''}
      2. ** PRESERVE ORIGINAL PIXELS **: The visible parts of the object in the input image MUST remain EXACTLY the same in the output.Do not change the color, texture, lighting, or shape of the existing parts.
      3. ** REMOVE HANDS AND PEOPLE **: If the object is being held, touched, or interacting with a person / hand, YOU MUST REMOVE THE HAND / PERSON ENTIRELY.The object should appear as if floating or standing alone.
      4. ** ISOLATE THE SUBJECT **: Remove any background, tables, surfaces, or other surrounding items.ONLY the "${label}" should be visible.
      5. ** COMPLETE THE OBJECT **: If parts are cropped(e.g.base of a vase, legs of a chair), regenerate them realistically to show the full object.
      6. ** WHITE BACKGROUND **: The background must be solid white.

        Output: A clean, isolated sprite of the complete object.`;
    }

    // Use 9:16 for persons (more vertical space for sitting figures), 3:4 for objects
    if (options.layout) prompt += LOCKED_LAYOUT_RULE;
    if (options.referenceUrl) prompt += REFERENCE_RULE;
    // Without a layout: 9:16 for persons (more vertical space for sitting figures), 3:4 for objects
    const layout: ImageLayout = {
      ...(options.layout ?? { size: '1024x1536', aspect: type === 'person' ? '9:16' : '3:4' }),
      ...(options.referenceUrl ? { reference: await loadImageData(options.referenceUrl) } : {}),
    };
    return await generateImage(settings, image, prompt, layout);
  } catch (error) {
    console.error("Error generating completion:", error);
    throw error;
  }
};

/**
 * Verify if a completion is complete (all body parts visible).
 * Returns whether the image shows the full object or if parts are still cut off.
 */
export const verifyCompletion = async (
  imageUrl: string,
  label: string,
  type: 'person' | 'object',
  settings: AISettings,
): Promise<{ isComplete: boolean, missingParts: string[] }> => {
  try {
    const image = await loadImageData(imageUrl);

    const prompt = type === 'person'
      ? `Analyze this image of "${label}" (a person).

Is the ENTIRE body visible? Check:
- Head (fully visible?)
- Torso (fully visible?)
- Arms and hands (fully visible?)
- Legs (fully visible?)
- Feet (fully visible?)
- Proportions: are the legs, arms and torso NATURALLY proportioned for an adult (or the apparent age)?
  Legs or limbs that look shortened, compressed or squashed to fit the frame count as NOT complete
  (report them in missingParts, e.g. "legs too short").

Return ONLY valid JSON:
{
  "isComplete": true/false,
  "missingParts": ["feet", "legs", "legs too short", etc] or []
}

Be strict: if ANY body part is cut off at the edge, or the body is unnaturally squashed, it's NOT complete.`
      : `Analyze this image of "${label}" (an object).

Is the ENTIRE object visible with nothing cut off at the edges, and does it have natural proportions
(not squashed or shortened to fit the frame, e.g. legs of furniture of normal length)?

Return ONLY valid JSON:
{
  "isComplete": true/false,
  "missingParts": ["base", "top", "legs too short", etc] or []
}`;

    const parsed = await analyzeImageJson<{ isComplete: boolean, missingParts: string[] }>(
      settings, image, prompt, VERIFY_SCHEMA, { schemaName: "completion_check", effort: "low" },
    );
    return {
      isComplete: !!parsed.isComplete,
      missingParts: parsed.missingParts || []
    };
  } catch (error) {
    console.warn('[Completion Verify] Failed, assuming complete:', error);
    return { isComplete: true, missingParts: [] };
  }
};

// ---------------------------------------------------------------------------
// Hidden extent of an object (canvas for layout-preserving completion)
// ---------------------------------------------------------------------------

/** How far the whole object extends beyond its box, as fractions of the box size */
export interface HiddenExtent {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const EXTENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    left: { type: "number", description: "Hidden extent beyond the LEFT edge of the box, as a fraction of the box WIDTH" },
    right: { type: "number", description: "Hidden extent beyond the RIGHT edge of the box, as a fraction of the box WIDTH" },
    top: { type: "number", description: "Hidden extent beyond the TOP edge of the box, as a fraction of the box HEIGHT" },
    bottom: { type: "number", description: "Hidden extent beyond the BOTTOM edge of the box, as a fraction of the box HEIGHT" },
  },
  required: ["left", "right", "top", "bottom"],
  additionalProperties: false,
};

/**
 * Estimate how far the whole object extends beyond its visible box on each side
 * (hidden behind other objects or cut off by the image border), looking at the
 * whole photo. Used to size and place the completion canvas.
 */
export const estimateHiddenExtent = async (
  photoUrl: string,
  box: [number, number, number, number],
  label: string,
  type: 'person' | 'object',
  settings: AISettings,
  description?: string,
): Promise<HiddenExtent> => {
  const image = await loadImageData(photoUrl);
  const [ymin, xmin, ymax, xmax] = box;
  const touches = [
    xmin <= 0.01 && 'LEFT', xmax >= 0.99 && 'RIGHT', ymin <= 0.01 && 'TOP', ymax >= 0.99 && 'BOTTOM',
  ].filter(Boolean);
  const prompt = `In this photo, the ${type === 'person' ? 'person' : 'object'} "${label}" is visible inside the box
[ymin, xmin, ymax, xmax] = [${box.map(v => v.toFixed(3)).join(', ')}] (normalized 0-1).${description ? `\nDescription of the whole object: "${description}"` : ''}
${touches.length ? `The box touches the image border on the ${touches.join(', ')} side(s), so the object may continue outside the photo there.` : 'The box does not touch the image border.'}

Parts of the object may be hidden behind other objects or cut off by the image border.
Estimate how far the WHOLE object extends beyond each edge of the box:
- left / right: as a fraction of the box WIDTH
- top / bottom: as a fraction of the box HEIGHT
0 means the object ends at that edge. Use typical proportions of such an object and the surrounding scene
(e.g. a chair seen only as a thin strip of its backrest at the image border extends far beyond the box;
a seated person whose legs are hidden by a table extends below the box by about the visible height).

Return JSON: {"left": <number>, "right": <number>, "top": <number>, "bottom": <number>}`;
  try {
    const r = await analyzeImageJson<HiddenExtent>(settings, image, prompt, EXTENT_SCHEMA, { schemaName: "hidden_extent", effort: "medium" });
    const clamp = (v: number) => Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 8);
    return { left: clamp(r.left), right: clamp(r.right), top: clamp(r.top), bottom: clamp(r.bottom) };
  } catch (error) {
    console.warn('[Hidden extent] Failed, using defaults:', error);
    return type === 'person'
      ? { left: 0.15, right: 0.15, top: 0.05, bottom: 1.2 }
      : { left: 0.3, right: 0.3, top: 0.3, bottom: 0.3 };
  }
};

// ---------------------------------------------------------------------------
// Annotation translation (labels and descriptions, English <-> Japanese)
// ---------------------------------------------------------------------------

const TRANSLATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          label: { type: "string" },
          description: { type: "string" },
        },
        required: ["index", "label", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/**
 * Translate object annotations (label and description) between English and
 * Japanese. The English annotations are what the prompts use; Japanese ones are
 * for reading and editing. Returns one entry per item, in order.
 */
export const translateAnnotations = async (
  items: { label: string; description: string }[],
  to: 'ja' | 'en',
  settings: AISettings,
): Promise<{ label: string; description: string }[]> => {
  if (items.length === 0) return [];
  const list = items.map((it, i) => `${i}: label: ${JSON.stringify(it.label)} / description: ${JSON.stringify(it.description)}`).join('\n');
  const prompt = to === 'ja'
    ? `Translate these annotations of objects in a photo into natural Japanese. Keep the meaning exactly (shape, pose, colors, which parts are visible or hidden). Labels should be short noun phrases.\n\n${list}\n\nReturn JSON: {"items": [{"index": 0, "label": "...", "description": "..."}, ...]}`
    : `Translate these annotations of objects in a photo into natural English, as used in prompts for image generation. Keep the meaning exactly (shape, pose, colors, which parts are visible or hidden). Labels should be short noun phrases in lowercase.\n\n${list}\n\nReturn JSON: {"items": [{"index": 0, "label": "...", "description": "..."}, ...]}`;
  const result = await analyzeImageJson<{ items: { index: number; label: string; description: string }[] }>(
    settings, null, prompt, TRANSLATION_SCHEMA, { schemaName: "annotation_translation", effort: "low" },
  );
  return items.map((it, i) => {
    const t = result.items?.find(x => x.index === i);
    return t ? { label: t.label.trim() || it.label, description: t.description.trim() || it.description } : it;
  });
};

