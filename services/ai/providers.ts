/**
 * Thin provider layer: the same two operations for every AI provider.
 *
 * - analyzeImageJson: send one image + prompt, get JSON that matches a schema
 * - generateImage: send one image + prompt, get a generated image
 *
 * Providers: Gemini and OpenAI.
 *
 * All calls are made directly from the browser with the user's own API keys.
 */
import { GoogleGenAI } from '@google/genai';
import OpenAI, { toFile } from 'openai';
import { AIProvider, AISettings } from '../../types';
import { PROVIDER_LABELS } from './models';

/**
 * Gemini API version. SDK 3.x defaults to 'v1', where model aliases such as
 * `gemini-pro-latest`, preview models and JSON-schema output are not available.
 */
const GEMINI_API_VERSION = 'v1beta';

export interface ImageData {
  base64: string;
  mimeType: string;
}

export type JsonSchema = Record<string, unknown>;

export interface AnalyzeOptions {
  /** Name of the schema (required by OpenAI structured outputs) */
  schemaName: string;
  /** Use deterministic sampling where the provider supports it (Gemini) */
  deterministic?: boolean;
  /** Reasoning effort for OpenAI. Higher is slower but more careful. */
  effort?: 'low' | 'medium' | 'high';
}

/** Target aspect ratio of a completed image */
/**
 * Output layout of an image completion.
 * - size: OpenAI output size (the input image should have the same size so that
 *   pixels map one to one)
 * - aspect: Gemini aspect ratio
 * - maskUrl: OpenAI edit mask (PNG data URL of the same size): transparent pixels
 *   may be edited, opaque pixels are kept. Gemini has no mask.
 */
export interface ImageLayout {
  size: OpenAIImageSize;
  aspect: string;
  maskUrl?: string;
  /** Second input image for reference only (e.g. the whole photo with the object marked) */
  reference?: ImageData;
}
export type OpenAIImageSize = '1024x1024' | '1536x1024' | '1024x1536';

const SUPPORTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Load an image URL (data:, blob: or http) as base64 with its real MIME type. */
export const loadImageData = async (url: string): Promise<ImageData> => {
  const blob = await (await fetch(url)).blob();
  const converted = SUPPORTED_MIME.includes(blob.type) ? blob : await convertToPng(blob);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(converted);
  });
  return { base64: dataUrl.split(',')[1], mimeType: converted.type || 'image/png' };
};

const convertToPng = async (blob: Blob): Promise<Blob> => {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG conversion failed'))), 'image/png'));
};

const requireKey = (settings: AISettings, provider: AIProvider): string => {
  const key = settings.keys[provider]?.trim();
  if (!key) {
    throw new Error(`${PROVIDER_LABELS[provider]} API key is not set. Open AI Settings and enter the key.`);
  }
  return key;
};

const parseJson = <T>(text: string | undefined | null, provider: string): T => {
  if (!text) throw new Error(`${provider} returned no data`);
  // Structured outputs return bare JSON; strip code fences just in case.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned) as T;
};

// ---------------------------------------------------------------------------
// Image understanding
// ---------------------------------------------------------------------------

export const analyzeImageJson = async <T>(
  settings: AISettings,
  image: ImageData | null,
  prompt: string,
  schema: JsonSchema,
  options: AnalyzeOptions,
): Promise<T> => {
  // `image` may be null for text-only tasks (e.g. translating annotations)
  const provider = settings.visionProvider;
  const apiKey = requireKey(settings, provider);

  if (provider === 'gemini') {
    const ai = new GoogleGenAI({ apiKey, apiVersion: GEMINI_API_VERSION });
    const response = await ai.models.generateContent({
      model: settings.models.geminiVision,
      contents: {
        parts: [
          ...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }] : []),
          { text: prompt },
        ],
      },
      config: {
        ...(options.deterministic ? { temperature: 0, seed: 1 } : {}),
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    });
    return parseJson<T>(response.text, 'Gemini');
  }

  // OpenAI
  const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
  const response = await client.responses.create({
    model: settings.models.openaiVision,
    reasoning: { effort: options.effort ?? 'medium' },
    input: [{
      role: 'user',
      content: [
        ...(image ? [{ type: 'input_image' as const, image_url: `data:${image.mimeType};base64,${image.base64}`, detail: 'high' as const }] : []),
        { type: 'input_text' as const, text: prompt },
      ],
    }],
    text: {
      format: { type: 'json_schema', name: options.schemaName, schema, strict: true },
    },
  });
  return parseJson<T>(response.output_text, 'OpenAI');
};

// ---------------------------------------------------------------------------
// Image generation (completion / outpainting)
// ---------------------------------------------------------------------------

/** Returns the generated image as a data URL. */
export const generateImage = async (
  settings: AISettings,
  image: ImageData,
  prompt: string,
  layout: ImageLayout,
): Promise<string> => {
  const provider = settings.imageProvider;
  const apiKey = requireKey(settings, provider);

  if (provider === 'gemini') {
    const ai = new GoogleGenAI({ apiKey, apiVersion: GEMINI_API_VERSION });
    const response = await ai.models.generateContent({
      model: settings.models.geminiImage,
      contents: {
        parts: [
          { inlineData: { mimeType: image.mimeType, data: image.base64 } },
          ...(layout.reference ? [{ inlineData: { mimeType: layout.reference.mimeType, data: layout.reference.base64 } }] : []),
          { text: prompt },
        ],
      },
      config: {
        imageConfig: { aspectRatio: layout.aspect },
      },
    });
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData?.data) {
        return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
      }
    }
    throw new Error('Gemini generated no image.');
  }

  // OpenAI: image edit with the prepared image as input, in one of the standard
  // sizes supported by all GPT image models.
  const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
  const bytes = Uint8Array.from(atob(image.base64), c => c.charCodeAt(0));
  const ext = image.mimeType.split('/')[1] || 'png';
  const maskBytes = layout.maskUrl
    ? Uint8Array.from(atob(layout.maskUrl.split(',')[1]), c => c.charCodeAt(0))
    : null;
  const edit = async (background?: 'transparent') => client.images.edit({
    model: settings.models.openaiImage,
    // The edit mask applies to the first image; a reference image follows it
    image: layout.reference
      ? [await toFile(bytes, `input.${ext}`, { type: image.mimeType }), await toFile(
        Uint8Array.from(atob(layout.reference.base64), c => c.charCodeAt(0)),
        `reference.${layout.reference.mimeType.split('/')[1] || 'png'}`, { type: layout.reference.mimeType })]
      : await toFile(bytes, `input.${ext}`, { type: image.mimeType }),
    ...(maskBytes ? { mask: await toFile(maskBytes, 'mask.png', { type: 'image/png' }) } : {}),
    prompt,
    size: layout.size,
    output_format: 'png',
    ...(background ? { background } : {}),
  });
  // Ask for a transparent background so that no separate background removal is
  // needed. Models without transparency support reject it; retry without.
  let response;
  try {
    response = await edit('transparent');
  } catch (e: any) {
    if (e?.status !== 400) throw e;
    console.warn('OpenAI: transparent background not accepted, retrying with the default background:', e?.message);
    response = await edit();
  }
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI generated no image.');
  return `data:image/png;base64,${b64}`;
};
