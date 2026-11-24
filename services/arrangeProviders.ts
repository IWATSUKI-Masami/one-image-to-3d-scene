/**
 * Chat adapters for Arrange: the same tool loop (images in, tool calls out, tool
 * results with images back) on Claude (Anthropic), OpenAI (Responses API) and Gemini.
 * Each adapter keeps the conversation in its provider's own format, including the
 * provider's reasoning items (Claude thinking blocks, OpenAI reasoning items, Gemini
 * thought signatures), which have to be sent back unchanged.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI, type Content, type Part } from '@google/genai';

export type ArrangeProvider = 'anthropic' | 'openai' | 'gemini';

export const ARRANGE_PROVIDER_LABELS: Record<ArrangeProvider, string> = {
    anthropic: 'Claude',
    openai: 'OpenAI',
    gemini: 'Gemini',
};

/** Short provider name for file names */
export const ARRANGE_PROVIDER_FILE_NAMES: Record<ArrangeProvider, string> = { anthropic: 'claude', openai: 'openai', gemini: 'gemini' };

/**
 * State of a scene's placements for file names: "edited" (set by hand) or
 * "arranged-<provider>" (by the last Arrange run, possibly corrected by hand afterwards);
 * "" when everything is placed automatically.
 */
export const sceneEditState = (layout: { models: unknown[]; arrangeRuns?: { provider: ArrangeProvider }[] } | null | undefined): string => {
    if (!layout || layout.models.length === 0) return '';
    const last = layout.arrangeRuns?.[layout.arrangeRuns.length - 1];
    return last ? `arranged-${ARRANGE_PROVIDER_FILE_NAMES[last.provider]}` : 'edited';
};

/** Content shared by all providers: text, or a base64 JPEG */
export type Block = { type: 'text'; text: string } | { type: 'image'; base64: string };

export interface ToolSpec {
    name: string;
    description: string;
    /** JSON schema of the input (object with additionalProperties: false) */
    schema: Record<string, unknown>;
}

export interface ToolCall { id: string; name: string; input: unknown }
export interface ToolResult { id: string; name: string; isError?: boolean; blocks: Block[] }
/** Tokens of one API call (reasoning tokens are part of the output; cache reads part of the input) */
export interface Usage { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
export interface Turn { texts: string[]; calls: ToolCall[]; usage: Usage; model?: string }

export interface ArrangeChat {
    /** Ask the model for its next turn */
    next(): Promise<Turn>;
    /** Results of the tool calls of the last turn (all of them, in one message) */
    addToolResults(results: ToolResult[]): void;
    /** A plain user message (after a turn without tool calls) */
    addText(text: string): void;
}

export interface ChatOptions {
    provider: ArrangeProvider;
    apiKey: string;
    model: string;
    system: string;
    tools: ToolSpec[];
    /** The first user message */
    first: Block[];
    signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Claude (Anthropic Messages API)
// ---------------------------------------------------------------------------

/** Models that accept the server-side refusal fallback ("default" form) */
const CLAUDE_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-opus-5']);

const claudeBlocks = (blocks: Block[]): (Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam)[] =>
    blocks.map(b => b.type === 'text'
        ? { type: 'text' as const, text: b.text }
        : { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: b.base64 } });

const claudeChat = (o: ChatOptions): ArrangeChat => {
    const client = new Anthropic({ apiKey: o.apiKey, dangerouslyAllowBrowser: true });
    const tools: Anthropic.Beta.BetaTool[] = o.tools.map(t => ({
        name: t.name, description: t.description, strict: true,
        input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema,
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: claudeBlocks(o.first) }];
    const useFallbacks = CLAUDE_FALLBACK_MODELS.has(o.model);
    return {
        async next() {
            const response = await client.beta.messages.create({
                model: o.model,
                max_tokens: 16000,
                system: o.system,
                tools,
                messages,
                output_config: { effort: 'high' },
                ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
            }, { signal: o.signal });
            if (response.stop_reason === 'refusal') {
                throw new Error(`Claude declined to arrange the scene${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}.`);
            }
            if (response.stop_reason === 'max_tokens') throw new Error('Claude\'s answer was cut off (max_tokens).');
            // Keep the whole assistant turn (thinking blocks included) unchanged
            messages.push({ role: 'assistant', content: response.content });
            const u = response.usage;
            return {
                texts: response.content.flatMap(b => b.type === 'text' && b.text.trim() ? [b.text.trim()] : []),
                calls: response.content.flatMap(b => b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []),
                // input_tokens excludes cached tokens; count them in the input as well
                usage: {
                    input: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
                    output: u?.output_tokens ?? 0,
                    cacheRead: u?.cache_read_input_tokens ?? 0,
                    cacheWrite: u?.cache_creation_input_tokens ?? 0,
                },
                model: response.model,
            };
        },
        addToolResults(results) {
            messages.push({
                role: 'user',
                content: results.map(r => ({
                    type: 'tool_result' as const,
                    tool_use_id: r.id,
                    ...(r.isError ? { is_error: true } : {}),
                    content: claudeBlocks(r.blocks),
                })),
            });
        },
        addText(text) {
            messages.push({ role: 'user', content: [{ type: 'text', text }] });
        },
    };
};

// ---------------------------------------------------------------------------
// OpenAI (Responses API)
// ---------------------------------------------------------------------------

const openaiChat = (o: ChatOptions): ArrangeChat => {
    const client = new OpenAI({ apiKey: o.apiKey, dangerouslyAllowBrowser: true });
    const tools: OpenAI.Responses.FunctionTool[] = o.tools.map(t => ({
        type: 'function', name: t.name, description: t.description,
        // Strict mode would require every property, and these edits have optional fields
        strict: false,
        parameters: t.schema,
    }));
    const input: OpenAI.Responses.ResponseInputItem[] = [{
        role: 'user',
        content: o.first.map(b => b.type === 'text'
            ? { type: 'input_text' as const, text: b.text }
            : { type: 'input_image' as const, image_url: `data:image/jpeg;base64,${b.base64}`, detail: 'high' as const }),
    }];
    return {
        async next() {
            const response = await client.responses.create({
                model: o.model,
                instructions: o.system,
                input,
                tools,
                reasoning: { effort: 'high' },
            }, { signal: o.signal });
            if (response.status === 'incomplete') {
                throw new Error(`OpenAI's answer was incomplete (${response.incomplete_details?.reason ?? 'unknown reason'}).`);
            }
            // Send the output back unchanged (reasoning items included)
            input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
            const texts: string[] = [];
            const calls: ToolCall[] = [];
            for (const item of response.output) {
                if (item.type === 'message') {
                    for (const c of item.content) {
                        if (c.type === 'output_text' && c.text.trim()) texts.push(c.text.trim());
                        if (c.type === 'refusal') throw new Error(`OpenAI declined to arrange the scene: ${c.refusal}`);
                    }
                } else if (item.type === 'function_call') {
                    let args: unknown = {};
                    try { args = JSON.parse(item.arguments || '{}'); } catch { args = { _invalid_json: item.arguments }; }
                    calls.push({ id: item.call_id, name: item.name, input: args });
                }
            }
            const u = response.usage;
            return {
                texts, calls, model: response.model,
                usage: {
                    input: u?.input_tokens ?? 0,
                    output: u?.output_tokens ?? 0,
                    reasoning: u?.output_tokens_details?.reasoning_tokens ?? 0,
                    cacheRead: u?.input_tokens_details?.cached_tokens ?? 0,
                },
            };
        },
        addToolResults(results) {
            for (const r of results) {
                input.push({
                    type: 'function_call_output',
                    call_id: r.id,
                    output: r.blocks.map(b => b.type === 'text'
                        ? { type: 'input_text' as const, text: (r.isError ? 'Error: ' : '') + b.text }
                        : { type: 'input_image' as const, image_url: `data:image/jpeg;base64,${b.base64}`, detail: 'high' as const }),
                });
            }
        },
        addText(text) {
            input.push({ role: 'user', content: [{ type: 'input_text', text }] });
        },
    };
};

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const geminiParts = (blocks: Block[]): Part[] =>
    blocks.map(b => b.type === 'text' ? { text: b.text } : { inlineData: { mimeType: 'image/jpeg', data: b.base64 } });

const geminiChat = (o: ChatOptions): ArrangeChat => {
    const ai = new GoogleGenAI({ apiKey: o.apiKey, apiVersion: 'v1beta' });
    const contents: Content[] = [{ role: 'user', parts: geminiParts(o.first) }];
    let callCount = 0;
    return {
        async next() {
            const response = await ai.models.generateContent({
                model: o.model,
                contents,
                config: {
                    systemInstruction: o.system,
                    tools: [{ functionDeclarations: o.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }],
                    abortSignal: o.signal,
                },
            });
            const candidate = response.candidates?.[0];
            if (!candidate?.content) {
                const reason = candidate?.finishReason ?? response.promptFeedback?.blockReason ?? 'no answer';
                throw new Error(`Gemini returned no answer (${reason}).`);
            }
            // Send the model turn back unchanged (thought signatures included)
            contents.push(candidate.content);
            const texts: string[] = [];
            const calls: ToolCall[] = [];
            for (const part of candidate.content.parts ?? []) {
                if (part.thought) continue;
                if (part.text?.trim()) texts.push(part.text.trim());
                if (part.functionCall?.name) {
                    calls.push({ id: part.functionCall.id ?? `call_${++callCount}`, name: part.functionCall.name, input: part.functionCall.args ?? {} });
                }
            }
            const u = response.usageMetadata;
            return {
                texts, calls, model: response.modelVersion,
                // Gemini counts thinking separately from the candidates; both are billed as output
                usage: {
                    input: u?.promptTokenCount ?? 0,
                    output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
                    reasoning: u?.thoughtsTokenCount ?? 0,
                    cacheRead: u?.cachedContentTokenCount ?? 0,
                },
            };
        },
        addToolResults(results) {
            // Function responses first, then the renderings as images in the same user turn
            const parts: Part[] = [];
            for (const r of results) {
                const text = r.blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
                parts.push({ functionResponse: { id: r.id.startsWith('call_') ? undefined : r.id, name: r.name, response: r.isError ? { error: text } : { output: text } } });
            }
            // (the first text block is already in the function response; the rest are the
            // renderings with their captions)
            for (const r of results) parts.push(...geminiParts(r.blocks[0]?.type === 'text' ? r.blocks.slice(1) : r.blocks));
            contents.push({ role: 'user', parts });
        },
        addText(text) {
            contents.push({ role: 'user', parts: [{ text }] });
        },
    };
};

export const createArrangeChat = (o: ChatOptions): ArrangeChat =>
    o.provider === 'openai' ? openaiChat(o) : o.provider === 'gemini' ? geminiChat(o) : claudeChat(o);
