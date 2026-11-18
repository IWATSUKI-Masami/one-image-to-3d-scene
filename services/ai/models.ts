import { AIModels, AISettings, ImageProvider, VisionProvider } from '../../types';

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
  claudeVision: 'claude-opus-5-5',
  openaiVision: 'gpt-5.6-sol',
  openaiImage: 'gpt-image-2.6-sunburst',
};

/** Suggestions shown in the model ID fields (any other ID can be typed in). */
export const MODEL_SUGGESTIONS: Record<keyof AIModels, string[]> = {
  geminiVision: ['gemini-pro-latest', 'gemini-4-argon', 'gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-flash-latest'],
  geminiImage: ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1'],
  claudeVision: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'],
  openaiVision: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'],
  openaiImage: ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2'],
};

export const VISION_PROVIDER_LABELS: Record<VisionProvider, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
  openai: 'OpenAI',
};

export const IMAGE_PROVIDER_LABELS: Record<ImageProvider, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
};

/** Which API key a provider needs. */
export const keyNameFor = (provider: VisionProvider | ImageProvider): keyof AISettings['keys'] =>
  provider === 'claude' ? 'anthropic' : provider;

/** True when the keys for both the selected vision and image providers are set. */
export const hasRequiredKeys = (settings: AISettings): boolean =>
  !!settings.keys[keyNameFor(settings.visionProvider)]?.trim() &&
  !!settings.keys[keyNameFor(settings.imageProvider)]?.trim();

const STORAGE_KEY = 'one-image-to-3d-scene:ai-settings';

/**
 * Initial settings. API keys come only from environment variables (never from
 * browser storage); providers and model IDs are remembered in localStorage.
 */
export const loadAISettings = (): AISettings => {
  const settings: AISettings = {
    visionProvider: 'gemini',
    imageProvider: 'gemini',
    keys: {
      gemini: import.meta.env.VITE_GEMINI_API_KEY || '',
      anthropic: import.meta.env.VITE_ANTHROPIC_API_KEY || '',
      openai: import.meta.env.VITE_OPENAI_API_KEY || '',
    },
    models: { ...DEFAULT_MODELS },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) {
      if (['gemini', 'claude', 'openai'].includes(saved.visionProvider)) settings.visionProvider = saved.visionProvider;
      if (['gemini', 'openai'].includes(saved.imageProvider)) settings.imageProvider = saved.imageProvider;
      for (const k of Object.keys(DEFAULT_MODELS) as (keyof AIModels)[]) {
        if (typeof saved.models?.[k] === 'string' && saved.models[k].trim()) settings.models[k] = saved.models[k].trim();
      }
    }
  } catch {
    // Storage unavailable or corrupted: use defaults
  }
  return settings;
};

/** Remember providers and model IDs (API keys are intentionally not stored). */
export const saveAISettings = (settings: AISettings): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      visionProvider: settings.visionProvider,
      imageProvider: settings.imageProvider,
      models: settings.models,
    }));
  } catch {
    // Ignore storage errors
  }
};
