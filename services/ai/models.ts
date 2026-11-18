import { AIModels, AIProvider, AISettings, BgRemovalModel, HFSpaces } from '../../types';

/**
 * Default model IDs.
 *
 * Model IDs change often. Every ID can be overridden in the AI Settings dialog,
 * so a retired model can be replaced without changing code.
 *
 * Note: the results in the paper (KBSE2025-61) were obtained with
 * `gemini-3-pro-preview` (detection) and `gemini-3-pro-image-preview` (completion),
 * both of which have since been shut down.
 */
export const DEFAULT_MODELS: AIModels = {
  // Alias that always points to the latest Gemini Pro model
  geminiVision: 'gemini-pro-latest',
  // GA successor of gemini-3-pro-image-preview ("Nano Banana Pro")
  geminiImage: 'gemini-3-pro-image',
  openaiVision: 'gpt-5.6-sol',
  openaiImage: 'gpt-image-2.6-sunburst',
};

/**
 * Official Hugging Face Spaces (ZeroGPU). Each can be replaced in AI Settings,
 * e.g. with your own duplicate on a dedicated GPU. A duplicate must keep the
 * same API as the original Space.
 */
export const DEFAULT_SPACES: HFSpaces = {
  rmbg: 'briaai/BRIA-RMBG-3.0',
  rmbg2: 'briaai/BRIA-RMBG-2.0',
  depth: 'depth-anything/Depth-Anything-V2',
  trellis: 'microsoft/TRELLIS.2',
  hunyuan3d: 'tencent/Hunyuan3D-2.1',
  orient: 'Viglong/Orient-Anything',
};

/** Suggestions shown in the model ID fields (any other ID can be typed in). */
export const MODEL_SUGGESTIONS: Record<keyof AIModels, string[]> = {
  geminiVision: ['gemini-pro-latest', 'gemini-4-argon', 'gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-flash-latest'],
  geminiImage: ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1'],
  openaiVision: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'],
  openaiImage: ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2'],
};

// Key order is the display order (OpenAI first: it is the default)
export const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
};

// Key order is the display order
export const BG_REMOVAL_LABELS: Record<BgRemovalModel, string> = {
  rmbg2: 'RMBG 2.0',
  rmbg3: 'RMBG 3.0',
};

/**
 * True when background removal is used: only after Gemini completion.
 * OpenAI completions already have a transparent background.
 */
export const usesBgRemoval = (settings: AISettings): boolean => settings.imageProvider !== 'openai';

/** Space settings key of each background-removal model */
export const BG_REMOVAL_SPACE_KEY: Record<BgRemovalModel, keyof HFSpaces> = {
  rmbg3: 'rmbg',
  rmbg2: 'rmbg2',
};

/** Space ID of the selected background-removal model (an empty setting means the official Space) */
export const bgRemovalSpace = (settings: AISettings): string => {
  const key = BG_REMOVAL_SPACE_KEY[settings.bgRemoval];
  return settings.spaces[key].trim() || DEFAULT_SPACES[key];
};

const isBgRemovalModel = (value: unknown): value is BgRemovalModel => value === 'rmbg3' || value === 'rmbg2';

const isProvider = (value: unknown): value is AIProvider => value === 'gemini' || value === 'openai';

/** True when the keys for both the selected vision and image providers are set. */
export const hasRequiredKeys = (settings: AISettings): boolean =>
  !!settings.keys[settings.visionProvider]?.trim() &&
  !!settings.keys[settings.imageProvider]?.trim();

const STORAGE_KEY = 'one-image-to-3d-scene:ai-settings';

/**
 * Former default values. Earlier versions stored every value, including
 * untouched defaults, so a stored former default is treated as "not set" and
 * replaced by the current default. (RMBG 2.0 is now selected with
 * `bgRemoval: 'rmbg2'`, whose Space is `spaces.rmbg2`.)
 */
const FORMER_DEFAULTS: { models: Partial<Record<keyof AIModels, string[]>>; spaces: Partial<Record<keyof HFSpaces, string[]>> } = {
  models: {},
  spaces: { rmbg: ['briaai/BRIA-RMBG-2.0'] },
};

/**
 * Initial settings. API keys come only from environment variables (never from
 * browser storage); providers, model IDs and Space IDs are remembered in localStorage.
 */
export const loadAISettings = (): AISettings => {
  const settings: AISettings = {
    visionProvider: 'openai',
    imageProvider: 'openai',
    bgRemoval: 'rmbg3',
    keys: {
      gemini: import.meta.env.VITE_GEMINI_API_KEY || '',
      openai: import.meta.env.VITE_OPENAI_API_KEY || '',
    },
    models: { ...DEFAULT_MODELS },
    spaces: { ...DEFAULT_SPACES },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) {
      // Unknown providers (e.g. 'claude' from an earlier version) fall back to the default
      if (isProvider(saved.visionProvider)) settings.visionProvider = saved.visionProvider;
      if (isProvider(saved.imageProvider)) settings.imageProvider = saved.imageProvider;
      if (isBgRemovalModel(saved.bgRemoval)) settings.bgRemoval = saved.bgRemoval;
      for (const k of Object.keys(DEFAULT_MODELS) as (keyof AIModels)[]) {
        const v = typeof saved.models?.[k] === 'string' ? saved.models[k].trim() : '';
        if (v && !FORMER_DEFAULTS.models[k]?.includes(v)) settings.models[k] = v;
      }
      for (const k of Object.keys(DEFAULT_SPACES) as (keyof HFSpaces)[]) {
        const v = typeof saved.spaces?.[k] === 'string' ? saved.spaces[k].trim() : '';
        if (v && !FORMER_DEFAULTS.spaces[k]?.includes(v)) settings.spaces[k] = v;
      }
    }
  } catch {
    // Storage unavailable or corrupted: use defaults
  }
  return settings;
};

/** Keep only the values that differ from the defaults */
const overrides = <T extends object>(values: T, defaults: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(values as Record<string, string>)
      .filter(([k, v]) => v.trim() && v.trim() !== (defaults as Record<string, string>)[k]),
  ) as Partial<T>;

/**
 * Remember providers, the background-removal model, and model / Space IDs that were changed (API keys are
 * intentionally not stored). Untouched defaults are not stored, so a new
 * default in a later version takes effect.
 */
export const saveAISettings = (settings: AISettings): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      visionProvider: settings.visionProvider,
      imageProvider: settings.imageProvider,
      bgRemoval: settings.bgRemoval,
      models: overrides(settings.models, DEFAULT_MODELS),
      spaces: overrides(settings.spaces, DEFAULT_SPACES),
    }));
  } catch {
    // Ignore storage errors
  }
};
