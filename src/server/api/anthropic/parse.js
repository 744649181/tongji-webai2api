/**
 * @fileoverview Anthropic -> internal canonical request translation
 * @description Reads an Anthropic-shaped POST body, validates it, applies
 * our model alias map, renders tools (if present) as a prompt suffix, and
 * produces a canonical request shape that queueManager.addTask understands.
 *
 * Throws an `AnthropicParseError` (with .status, .type, .message) on any
 * validation failure. The route handler catches it and calls sendApiError.
 */

import { resolveAlias } from './modelMap.js';
import { toolsToPromptSuffix, renderToolResultForPrompt, renderAssistantToolUseForPrompt } from './tools.js';

export class AnthropicParseError extends Error {
    constructor(status, type, message) {
        super(message);
        this.status = status;
        this.type = type;
    }
}

/**
 * Translate an Anthropic request body into a canonical internal request.
 *
 * @param {object} body - Parsed JSON body of POST /v1/messages.
 * @param {{
 *   apiKey: string,
 *   modelMapOverride: object|null,
 *   requestId: string,
 * }} ctx
 * @returns {{
 *   messages: Array<{role:string, content:string}>,
 *   systemPrompt: string,
 *   model: string,
 *   maxTokens: number,
 *   temperature: number|undefined,
 *   tools: object[]|null,
 *   thinking: {enabled:boolean, budgetTokens:number}|null,
 *   stream: boolean,
 *   meta: {id:string, onDelta:Function|null, reasoning:boolean},
 * }}
 */
export function parseAnthropicRequest(body, ctx) {
    if (!body || typeof body !== 'object') {
        throw new AnthropicParseError(400, 'invalid_request_error', 'request body must be a JSON object');
    }

    const { model, max_tokens, system, messages, tools, thinking, stream, temperature } = body;

    // model
    if (!model || typeof model !== 'string') {
        throw new AnthropicParseError(400, 'invalid_request_error', '`model` is required');
    }
    const resolvedModel = resolveAlias(model, ctx.modelMapOverride);
    if (resolvedModel === null) {
        throw new AnthropicParseError(400, 'not_found_error', `unknown model: ${model}`);
    }

    // max_tokens
    if (typeof max_tokens !== 'number' || max_tokens <= 0) {
        throw new AnthropicParseError(400, 'invalid_request_error', '`max_tokens` must be a positive integer');
    }

    // messages
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new AnthropicParseError(400, 'invalid_request_error', '`messages` must be a non-empty array');
    }
    const hasUser = messages.some((m) => m && m.role === 'user');
    if (!hasUser) {
        throw new AnthropicParseError(400, 'invalid_request_error', '`messages` must contain at least one user message');
    }

    // system
    let systemPrompt = '';
    if (typeof system === 'string') {
        systemPrompt = system;
    } else if (Array.isArray(system)) {
        systemPrompt = system
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n');
    }

    // messages translation
    const out = [];
    for (const msg of messages) {
        if (!msg || typeof msg.role !== 'string') continue;
        if (msg.role === 'user') {
            out.push({ role: 'user', content: renderUserMessage(msg.content) });
        } else if (msg.role === 'assistant') {
            out.push({ role: 'assistant', content: renderAssistantMessage(msg.content) });
        }
    }

    // tools -> prompt suffix
    const toolsList = Array.isArray(tools) ? tools.filter((t) => t && t.name) : null;
    const toolSuffix = toolsList ? toolsToPromptSuffix(toolsList) : '';
    if (toolSuffix && out.length > 0) {
        // Append tool suffix to the LAST user message (hiagent only reads the
        // last user message; system prompt is merged in by the framework's
        // existing parseTextRequest-style wrapping on the server side).
        const last = out[out.length - 1];
        if (last.role === 'user') {
            last.content = `${last.content}\n\n${toolSuffix}`;
        } else {
            out.push({ role: 'user', content: toolSuffix });
        }
    }

    // thinking
    const thinkingCfg = (thinking && thinking.type === 'enabled')
        ? { enabled: true, budgetTokens: typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 1024 }
        : null;

    const streamFlag = stream === true;
    return {
        messages: out,
        systemPrompt,
        model: resolvedModel,
        maxTokens: max_tokens,
        temperature: typeof temperature === 'number' ? temperature : undefined,
        tools: toolsList,
        thinking: thinkingCfg,
        stream: streamFlag,
        meta: {
            id: ctx.requestId,
            onDelta: null, // set by route handler if streaming
            reasoning: !!thinkingCfg,
        },
    };
}

/**
 * Render a user message content field (string or array of blocks) into a
 * single text string. Rejects image blocks with 400.
 */
function renderUserMessage(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        } else if (block.type === 'image') {
            throw new AnthropicParseError(
                400,
                'invalid_request_error',
                'vision not supported by upstream Tongji hiagent; drop image content or use a text-only model'
            );
        } else if (block.type === 'tool_result') {
            parts.push(renderToolResultForPrompt(block.tool_use_id, block.content));
        }
    }
    return parts.join('\n');
}

/**
 * Render an assistant message content field into a single text string.
 * Handles text + tool_use blocks; ignores unknown types.
 */
function renderAssistantMessage(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        } else if (block.type === 'tool_use') {
            parts.push(renderAssistantToolUseForPrompt(block.name, block.input));
        }
    }
    return parts.join('\n');
}

/**
 * Rough token estimate: 1 token ~ 4 chars (English). Used for input_tokens
 * in the Anthropic SSE message_start event.
 *
 * @param {string} systemPrompt
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} model - For future per-model tokenizer support.
 * @returns {number}
 */
export function estimateInputTokens(systemPrompt, messages, _model) {
    let total = (systemPrompt || '').length;
    for (const m of messages) total += (m.content || '').length;
    return Math.max(1, Math.ceil(total / 4));
}