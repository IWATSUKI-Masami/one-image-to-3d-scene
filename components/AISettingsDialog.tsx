import React from 'react';
import { X, RotateCcw } from 'lucide-react';
import { AIKeys, AIModels, AISettings, ImageProvider, VisionProvider } from '../types';
import { DEFAULT_MODELS, IMAGE_PROVIDER_LABELS, MODEL_SUGGESTIONS, VISION_PROVIDER_LABELS, keyNameFor } from '../services/ai/models';

interface Props {
  settings: AISettings;
  onChange: (settings: AISettings) => void;
  onClose: () => void;
}

const KEY_FIELDS: { key: keyof AIKeys; label: string; placeholder: string }[] = [
  { key: 'gemini', label: 'Google Gemini API key', placeholder: 'AIza...' },
  { key: 'anthropic', label: 'Anthropic (Claude) API key', placeholder: 'sk-ant-...' },
  { key: 'openai', label: 'OpenAI API key', placeholder: 'sk-...' },
];

const MODEL_FIELDS: { key: keyof AIModels; label: string; provider: VisionProvider | ImageProvider; role: 'vision' | 'image' }[] = [
  { key: 'geminiVision', label: 'Gemini (detection)', provider: 'gemini', role: 'vision' },
  { key: 'claudeVision', label: 'Claude (detection)', provider: 'claude', role: 'vision' },
  { key: 'openaiVision', label: 'OpenAI (detection)', provider: 'openai', role: 'vision' },
  { key: 'geminiImage', label: 'Gemini (completion)', provider: 'gemini', role: 'image' },
  { key: 'openaiImage', label: 'OpenAI (completion)', provider: 'openai', role: 'image' },
];

const SegmentedButtons = <T extends string>({ options, value, onSelect }: {
  options: Record<T, string>;
  value: T;
  onSelect: (value: T) => void;
}) => (
  <div className="inline-flex bg-slate-100 rounded-lg p-0.5">
    {(Object.keys(options) as T[]).map(option => (
      <button
        key={option}
        type="button"
        onClick={() => onSelect(option)}
        className={`px-3 py-1 text-sm rounded-md transition-colors ${value === option ? 'bg-white text-blue-700 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
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

  const neededKeys = new Set([keyNameFor(settings.visionProvider), keyNameFor(settings.imageProvider)]);
  const isActive = (field: typeof MODEL_FIELDS[number]) =>
    field.role === 'vision' ? field.provider === settings.visionProvider : field.provider === settings.imageProvider;

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
                options={VISION_PROVIDER_LABELS}
                value={settings.visionProvider}
                onSelect={visionProvider => update({ visionProvider })}
              />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-700 mb-1">Image completion</div>
              <SegmentedButtons
                options={IMAGE_PROVIDER_LABELS}
                value={settings.imageProvider}
                onSelect={imageProvider => update({ imageProvider })}
              />
              <p className="text-xs text-slate-500 mt-1">Claude cannot generate images, so it is not available for completion.</p>
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
