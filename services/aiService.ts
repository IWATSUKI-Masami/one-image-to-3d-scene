/**
 * AI tasks of the pipeline, independent of the provider:
 *
 * - detectObjectsInImage   (Phase 1: VLM object detection)        Gemini / Claude / OpenAI
 * - estimateCanvasExpansion (Phase 3: canvas size before completion) Gemini / Claude / OpenAI
 * - generateCompletion      (Phase 3: image completion/outpainting)  Gemini / OpenAI
 * - verifyCompletion        (Phase 3: check the completed image)     Gemini / Claude / OpenAI
 *
 * The prompts are the ones used in the paper (KBSE2025-61); only the JSON output
 * format is now enforced with each provider's structured-output feature.
 */
import { AISettings, DetectedObject } from "../types";
import { analyzeImageJson, generateImage, loadImageData, JsonSchema } from "./ai/providers";

// ---------------------------------------------------------------------------
// JSON schemas (compatible with Gemini, Claude and OpenAI strict mode)
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

const EXPANSION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    bottomCutoffPercent: { type: "number" },
    topCutoffPercent: { type: "number" },
    sideCutoffPercent: { type: "number" },
  },
  required: ["bottomCutoffPercent", "topCutoffPercent", "sideCutoffPercent"],
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

export const generateCompletion = async (
  imageUrl: string,
  label: string,
  type: 'person' | 'object',
  settings: AISettings,
  description?: string,
): Promise<string> => {
  try {
    const image = await loadImageData(imageUrl);

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
    
    2. **PRESERVE ORIGINAL PIXELS**: Copy all visible parts of the person pixel-for-pixel from the input. Do NOT regenerate or modify any visible part.
    
    3. **COMPLETE ALL CUT-OFF BODY PARTS AT EVERY EDGE**: 
       - If ARM is cut off at left/right edge: Complete the full arm including HAND and FINGERS
       - If HAND is cut off: Complete all fingers
       - If LEGS are cut off at bottom: Complete legs down to FEET
       - If FEET are cut off: Complete entire feet/shoes
       - NO BODY PART should touch or be cut by ANY image edge
    
    4. **EXTEND CANVAS GENEROUSLY IN ALL DIRECTIONS**: 
       - Extend the image to fit the COMPLETE body with MARGIN on ALL sides
       - Do NOT resize, move, or repose the person
       - Leave WHITE SPACE around the entire body - top, bottom, left, AND right
    
    5. **REMOVE FURNITURE BUT KEEP POSE**: Remove chairs/tables, but the person's body position must remain as if they were still seated/leaning.
    
    6. **PURE WHITE BACKGROUND - CRITICAL**: 
       - Background MUST be RGB(255,255,255) - pure white, no gray
       - Do NOT use light gray, cream, or off-white - ONLY #FFFFFF
       - Every non-person pixel must be exactly R=255, G=255, B=255
       - No shadows, no gradients, no shading on the background
    
    Output: A COMPLETE FULL-BODY image with ALL body parts (head, arms, hands, legs, feet) FULLY visible with NO cut-offs at ANY edge.`;
    } else {
      prompt = `Input image: ${label || 'an object'}.

      Goal: Create a clean, full - view image of ONLY the "${label}".
      
      STRICT CONSTRAINTS(MUST FOLLOW):
      1. ** DO NOT RESIZE OR MOVE **: The object in the input image is already centered and sized correctly.DO NOT SCALE, RESIZE, OR MOVE IT.
      2. ** PRESERVE ORIGINAL PIXELS **: The visible parts of the object in the input image MUST remain EXACTLY the same in the output.Do not change the color, texture, lighting, or shape of the existing parts.
      3. ** REMOVE HANDS AND PEOPLE **: If the object is being held, touched, or interacting with a person / hand, YOU MUST REMOVE THE HAND / PERSON ENTIRELY.The object should appear as if floating or standing alone.
      4. ** ISOLATE THE SUBJECT **: Remove any background, tables, surfaces, or other surrounding items.ONLY the "${label}" should be visible.
      5. ** COMPLETE THE OBJECT **: If parts are cropped(e.g.base of a vase, legs of a chair), regenerate them realistically to show the full object.
      6. ** WHITE BACKGROUND **: The background must be solid white.

        Output: A clean, isolated sprite of the complete object.`;
    }

    // Use 9:16 for persons (more vertical space for sitting figures), 3:4 for objects
    return await generateImage(settings, image, prompt, type === 'person' ? '9:16' : '3:4');
  } catch (error) {
    console.error("Error generating completion:", error);
    throw error;
  }
};

/**
 * Estimate the canvas expansion needed to complete a cropped image.
 * Analyzes what percentage of the object is visible and what's cut off.
 */
export const estimateCanvasExpansion = async (
  imageUrl: string,
  label: string,
  type: 'person' | 'object',
  settings: AISettings,
): Promise<{ verticalRatio: number, horizontalRatio: number }> => {
  try {
    const image = await loadImageData(imageUrl);

    const prompt = type === 'person'
      ? `Analyze this cropped image of "${label}" (a person).

TASK: Estimate how much of the person's body is CUT OFF (not visible) in this image.

Look at:
1. Is the head fully visible? (top cutoff)
2. Are the legs/feet cut off? If sitting, are knees visible? (bottom cutoff)
3. Are arms/hands cut off on the sides? (left/right cutoff)

Return ONLY valid JSON (no markdown, no code blocks):
{
  "bottomCutoffPercent": <0-200, how much height to add at bottom as percentage of current height>,
  "topCutoffPercent": <0-50, how much height to add at top>,
  "sideCutoffPercent": <0-50, how much width to add on each side>
}

Examples:
- If only head and shoulders visible (sitting person, legs hidden): {"bottomCutoffPercent": 150, "topCutoffPercent": 0, "sideCutoffPercent": 20}
- If full standing person with feet slightly cut: {"bottomCutoffPercent": 20, "topCutoffPercent": 0, "sideCutoffPercent": 10}
- If upper body visible, lower body hidden: {"bottomCutoffPercent": 100, "topCutoffPercent": 0, "sideCutoffPercent": 15}`
      : `Analyze this cropped image of "${label}" (an object).

TASK: Estimate how much of the object is CUT OFF in this image.

Return ONLY valid JSON:
{
  "bottomCutoffPercent": <0-100>,
  "topCutoffPercent": <0-50>,
  "sideCutoffPercent": <0-50>
}`;

    const parsed = await analyzeImageJson<{ bottomCutoffPercent: number, topCutoffPercent: number, sideCutoffPercent: number }>(
      settings, image, prompt, EXPANSION_SCHEMA, { schemaName: "canvas_expansion", effort: "low" },
    );

    const verticalRatio = 1 + (parsed.bottomCutoffPercent + parsed.topCutoffPercent) / 100;
    const horizontalRatio = 1 + (parsed.sideCutoffPercent * 2) / 100;


    return {
      verticalRatio: Math.min(Math.max(verticalRatio, 1.2), 3.5), // Clamp between 120% and 350%
      horizontalRatio: Math.min(Math.max(horizontalRatio, 1.1), 2.0) // Clamp between 110% and 200%
    };
  } catch (error) {
    console.warn('[Canvas Estimate] Failed, using default:', error);
    // Fallback to generous defaults
    return { verticalRatio: 2.2, horizontalRatio: 1.3 };
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

Return ONLY valid JSON:
{
  "isComplete": true/false,
  "missingParts": ["feet", "legs", etc] or []
}

Be strict: if ANY body part is cut off at the edge, it's NOT complete.`
      : `Analyze this image of "${label}" (an object).

Is the ENTIRE object visible with nothing cut off at the edges?

Return ONLY valid JSON:
{
  "isComplete": true/false,
  "missingParts": ["base", "top", etc] or []
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
