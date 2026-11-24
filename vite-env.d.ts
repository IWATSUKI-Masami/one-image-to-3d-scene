/// <reference types="vite/client" />

/** Package version and git commit, set in vite.config.ts */
declare const __APP_VERSION__: string

interface ImportMetaEnv {
    readonly VITE_GEMINI_API_KEY?: string
    readonly VITE_OPENAI_API_KEY?: string
    readonly VITE_ANTHROPIC_API_KEY?: string
    readonly VITE_HF_TOKEN?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
