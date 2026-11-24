import React from 'react';
import { X, RotateCcw } from 'lucide-react';
import { ARRANGE_PROVIDER_LABELS } from '../services/arrangeProviders';
import { AIKeys, AIModels, AIProvider, AISettings, HFSpaces } from '../types';
import { BG_REMOVAL_LABELS, BG_REMOVAL_SPACE_KEY, DEFAULT_MODELS, DEFAULT_SPACES, MODEL_SUGGESTIONS, PROVIDER_LABELS, usesBgRemoval } from '../services/ai/models';

interface Props {
  settings: AISettings;
  onChange: (settings: AISettings) => void;
  onClose: () => void;
}

const KEY_FIELDS: { key: keyof AIKeys; label: string; placeholder: string }[] = [
  { key: 'openai', label: 'OpenAI API key', placeholder: 'sk-...' },
  { key: 'gemini', label: 'Google Gemini API key', placeholder: 'AIza...' },
  { key: 'anthropic', label: 'Anthropic API key (Arrange with Claude)', placeholder: 'sk-ant-...' },
];

const SPACE_FIELDS: { key: keyof HFSpaces; label: string }[] = [
  { key: 'rmbg2', label: 'BRIA RMBG 2.0' },
  { key: 'rmbg', label: 'BRIA RMBG 3.0' },
  { key: 'depth', label: 'Depth estimation' },
  { key: 'trellis', label: 'TRELLIS.2' },
  { key: 'hunyuan3d', label: 'Hunyuan3D-2.1' },
];

const MODEL_FIELDS: { key: keyof AIModels; label: string; provider: AIProvider | 'anthropic'; role: 'vision' | 'image' | 'arrange' }[] = [
  { key: 'openaiVision', label: 'OpenAI (detection)', provider: 'openai', role: 'vision' },
  { key: 'geminiVision', label: 'Gemini (detection)', provider: 'gemini', role: 'vision' },
  { key: 'openaiImage', label: 'OpenAI (completion)', provider: 'openai', role: 'image' },
  { key: 'geminiImage', label: 'Gemini (completion)', provider: 'gemini', role: 'image' },
  { key: 'claudeArrange', label: 'Claude (3D scene Arrange)', provider: 'anthropic', role: 'arrange' },
];

const SegmentedButtons = <T extends string>({ options, value, onSelect, disabled = false }: {
  options: Record<T, string>;
  value: T;
  onSelect: (value: T) => void;
  disabled?: boolean;
}) => (
  <div className={`inline-flex bg-slate-100 rounded-lg p-0.5 ${disabled ? 'opacity-50' : ''}`}>
    {(Object.keys(options) as T[]).map(option => (
      <button
        key={option}
        type="button"
        disabled={disabled}
        onClick={() => onSelect(option)}
        className={`px-3 py-1 text-sm rounded-md transition-colors disabled:cursor-not-allowed ${value === option ? 'bg-white text-blue-700 font-medium shadow-sm' : 'text-slate-500 enabled:hover:text-slate-700'}`}
      >
        {options[option]}
      </button>
    ))}
  </div>
);

export const AISettingsDialog: React.FC<Props> = ({ settings, onChange, onClose }) => {
  const update = (patch: Partial<AISettings>) => onChange({ ...settings, ...patch });
  const setKey = (key: keyof AIKeys, value: string) => update({ keys: { ...settings.keys, [key]: value } });
  const setModel = (key: keyof AIModels, value: string) => update({ models: { ...settings.models, [key]: value } });
  const setSpace = (key: keyof HFSpaces, value: string) => update({ spaces: { ...settings.spaces, [key]: value } });

  const neededKeys = new Set<keyof AIKeys>([settings.visionProvider, settings.imageProvider]);
  // Only the Space of the selected background-removal model is used
  const bgRemovalUsed = usesBgRemoval(settings);
  const isSpaceActive = (key: keyof HFSpaces) =>
    (key !== 'rmbg' && key !== 'rmbg2') || (bgRemovalUsed && key === BG_REMOVAL_SPACE_KEY[settings.bgRemoval]);
  const isActive = (field: typeof MODEL_FIELDS[number]) =>
    field.role === 'arrange' ? settings.arrangeProvider === 'anthropic'
      : field.role === 'vision' ? field.provider === settings.visionProvider : field.provider === settings.imageProvider;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="AI Settings"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-900">AI Settings</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-500" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Providers */}
          <section className="space-y-3">
            <div>
              <div className="text-sm font-semibold text-slate-700 mb-1">Object detection & checks</div>
              <SegmentedButtons
                options={PROVIDER_LABELS}
                value={settings.visionProvider}
                onSelect={visionProvider => update({ visionProvider })}
              />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-700 mb-1">Arrange (3D scene)</div>
              <SegmentedButtons
                options={ARRANGE_PROVIDER_LABELS}
                value={settings.arrangeProvider}
                onSelect={arrangeProvider => update({ arrangeProvider })}
              />
              <p className="mt-1 text-xs text-slate-500">
                Model for <b>Arrange</b> in the 3D scene: Claude uses its own model setting below; OpenAI and Gemini use their detection model.
              </p>
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-700 mb-1">Image completion</div>
              <SegmentedButtons
                options={PROVIDER_LABELS}
                value={settings.imageProvider}
                onSelect={imageProvider => update({ imageProvider })}
              />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-700 mb-1">Background removal</div>
              <SegmentedButtons
                options={BG_REMOVAL_LABELS}
                value={settings.bgRemoval}
                onSelect={bgRemoval => update({ bgRemoval })}
                disabled={!bgRemovalUsed}
              />
              <p className="mt-1 text-xs text-slate-500">
                {bgRemovalUsed
                  ? 'Used after Gemini completion. RMBG 2.0 is much lighter (a duplicate runs on a T4); RMBG 3.0 is the newer model.'
                  : 'Not used: OpenAI completions already have a transparent background.'}
              </p>
            </div>
          </section>

          {/* API keys */}
          <section className="space-y-2">
            <div className="text-sm font-semibold text-slate-700">API keys</div>
            {KEY_FIELDS.map(field => (
              <label key={field.key} className="block">
                <span className={`text-xs ${neededKeys.has(field.key) ? 'text-slate-700 font-medium' : 'text-slate-400'}`}>
                  {field.label}{neededKeys.has(field.key) && ' (required)'}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  value={settings.keys[field.key]}
                  placeholder={field.placeholder}
                  onChange={e => setKey(field.key, e.target.value)}
                  className="mt-0.5 w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-blue-500 font-mono"
                />
              </label>
            ))}
            <p className="text-xs text-slate-500">
              Keys are kept in memory only and sent directly from your browser to each provider. To set them on startup, use <code>.env.local</code>.
            </p>
          </section>

          {/* Models */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-700">Models</div>
              <button
                type="button"
                onClick={() => update({ models: { ...DEFAULT_MODELS } })}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <RotateCcw size={12} /> Reset to defaults
              </button>
            </div>
            {MODEL_FIELDS.map(field => (
              <label key={field.key} className="flex items-center gap-2">
                <span className={`w-40 shrink-0 text-xs ${isActive(field) ? 'text-slate-700 font-medium' : 'text-slate-400'}`}>
                  {field.label}
                </span>
                <input
                  type="text"
                  list={`models-${field.key}`}
                  value={settings.models[field.key]}
                  onChange={e => setModel(field.key, e.target.value)}
                  className="flex-1 min-w-0 px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-blue-500 font-mono"
                />
                <datalist id={`models-${field.key}`}>
                  {MODEL_SUGGESTIONS[field.key].map(m => <option key={m} value={m} />)}
                </datalist>
              </label>
            ))}
          </section>

          {/* Hugging Face Spaces */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-700">Hugging Face Spaces</div>
              <button
                type="button"
                onClick={() => update({ spaces: { ...DEFAULT_SPACES } })}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
              >
                <RotateCcw size={12} /> Reset to defaults
              </button>
            </div>
            {SPACE_FIELDS.map(field => (
              <label key={field.key} className="flex items-center gap-2">
                <span className={`w-40 shrink-0 text-xs ${isSpaceActive(field.key) ? 'text-slate-700 font-medium' : 'text-slate-400'}`}>
                  {field.label}
                </span>
                <input
                  type="text"
                  value={settings.spaces[field.key]}
                  placeholder={DEFAULT_SPACES[field.key]}
                  onChange={e => setSpace(field.key, e.target.value)}
                  disabled={(field.key === 'rmbg' || field.key === 'rmbg2') && !bgRemovalUsed}
                  className="flex-1 min-w-0 px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:border-blue-500 font-mono disabled:bg-slate-50 disabled:text-slate-400"
                />
              </label>
            ))}
            <p className="text-xs text-slate-500">
              The official Spaces run on ZeroGPU with a daily quota. To avoid it, duplicate a Space to your account, give it a dedicated GPU, and enter its ID (<code>your-name/Space-Name</code>). Private Spaces need an HF token with read access.
            </p>
          </section>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
