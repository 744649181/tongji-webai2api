/**
 * @fileoverview Anthropic-protocol HTTP router
 * @description Exposes /v1/messages, /v1/models, /v1/messages/count_tokens.
 * Validates auth + version, parses body via parse.js, dispatches to
 * queueManager.addTask via the injected `addTask`, and writes either an
 * Anthropic SSE stream or a single JSON message response.
 *
 * Required context (see test-routes-integration.mjs for shape):
 *   - apiKey: string
 *   - modelMapOverride: object|null
 *   - addTask: (canonicalReq, meta) => Promise<{fullText, reasoningText}>
 *   - decorateModels: (models) => decorated models
 *   - rawModels: () => Tongji model list
 */

import { parseAnthropicRequest, estimateInputTokens, AnthropicParseError } from './parse.js';
import { createAnthropicSseWriter } from './sse.js';
import { sendApiError } from './errors.js';
import { decorateModelsForAnthropic } from './modelMap.js';
import { parseToolCallsFromText } from './tools.js';
import { buildStableChatId } from '../../respond.js';
import crypto from 'node:crypto';

const SUPPORTED_ANTHROPIC_VERSIONS = new Set([
    '2023-06-01',
    '2023-06-29',
    '2024-01-01',
    '2024-08-01',
]);

/**
 * Create an Anthropic-protocol HTTP router.
 * @param {{
 *   apiKey: string,
 *   modelMapOverride: object|null,
 *   addTask: Function,
 *   decorateModels?: Function,
 *   rawModels: Function,
 * }} ctx
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse) => Promise<void>}
 */
export function createAnthropicRouter(ctx) {
    const decorate = ctx.decorateModels || decorateModelsForAnthropic;

    return async function router(req, res) {
        const requestId = 'req_' + crypto.randomBytes(8).toString('hex');
        const url = req.url || '';

        // ---- auth (all paths) ----
        const apiKeyHeader = req.headers['x-api-key'];
        if (!apiKeyHeader || apiKeyHeader !== ctx.apiKey) {
            return sendApiError(res, {
                status: 401,
                type: 'authentication_error',
                message: 'missing or invalid x-api-key header',
                requestId,
                isStreaming: false,
            });
        }

        // ---- version (Anthropic-style endpoints) ----
        const needsVersion = url.startsWith('/v1/messages') || url.startsWith('/v1/models');
        if (needsVersion) {
            const v = req.headers['anthropic-version'];
            if (typeof v !== 'string' || !SUPPORTED_ANTHROPIC_VERSIONS.has(v)) {
                return sendApiError(res, {
                    status: 400,
                    type: 'invalid_request_error',
                    message: `unsupported anthropic-version: ${v}; supported: ${[...SUPPORTED_ANTHROPIC_VERSIONS].join(', ')}`,
                    requestId,
                    isStreaming: false,
                });
            }
        }

        // ---- read body (POST only) ----
        if (req.method === 'POST') {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch {
                return sendApiError(res, {
                    status: 400,
                    type: 'invalid_request_error',
                    message: 'request body is not valid JSON',
                    requestId,
                    isStreaming: false,
                });
            }
            try {
                if (url === '/v1/messages') return await handleMessages(req, res, body, ctx, requestId, decorate);
                if (url === '/v1/messages/count_tokens') return await handleCountTokens(req, res, body, ctx, requestId, decorate);
                return sendApiError(res, {
                    status: 404,
                    type: 'not_found_error',
                    message: `unknown path: ${url}`,
                    requestId,
                    isStreaming: false,
                });
            } catch (err) {
                if (err instanceof AnthropicParseError) {
                    return sendApiError(res, {
                        status: err.status,
                        type: err.type,
                        message: err.message,
                        requestId,
                        isStreaming: false,
                    });
                }
                return sendApiError(res, {
                    status: 502,
                    type: 'api_error',
                    message: err?.message || 'upstream error',
                    requestId,
                    isStreaming: false,
                });
            }
        }

        if (req.method === 'GET' && url === '/v1/models') {
            return handleModels(res, ctx, decorate);
        }

        return sendApiError(res, {
            status: 404,
            type: 'not_found_error',
            message: `unknown path: ${req.method} ${url}`,
            requestId,
            isStreaming: false,
        });
    };
}

/**
 * POST /v1/messages
 */
async function handleMessages(_req, res, body, ctx, requestId, _decorate) {
    const parsed = parseAnthropicRequest(body, {
        apiKey: ctx.apiKey,
        modelMapOverride: ctx.modelMapOverride,
        requestId,
    });

    const messageId = buildStableChatId(requestId);
    const inputTokens = estimateInputTokens(parsed.systemPrompt, parsed.messages, parsed.model);

    if (parsed.stream) {
        return runStream(res, parsed, messageId, inputTokens, ctx, requestId);
    }
    return runNonStream(res, parsed, messageId, inputTokens, ctx, requestId);
}

async function runStream(res, parsed, messageId, inputTokens, ctx, requestId) {
    const writer = createAnthropicSseWriter(res, {
        messageId,
        model: parsed.model,
        inputTokens,
    });

    let textBuffer = '';
    let reasoningBuffer = '';
    const blockIsThinking = parsed.meta.reasoning;
    const activeBlockIdx = 0;
    if (blockIsThinking) {
        writer.startThinkingBlock(activeBlockIdx);
    } else {
        writer.startTextBlock(activeBlockIdx);
    }

    parsed.meta.onDelta = (delta) => {
        if (res.writableEnded) return;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
            textBuffer += delta.content;
            if (blockIsThinking) {
                writer.stopBlock(activeBlockIdx);
                writer.startTextBlock(1);
                writer.writeTextDelta(1, delta.content);
            } else {
                writer.writeTextDelta(activeBlockIdx, delta.content);
            }
        } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            reasoningBuffer += delta.reasoning_content;
            if (blockIsThinking) {
                writer.writeThinkingDelta(activeBlockIdx, delta.reasoning_content);
            }
        }
    };

    try {
        const result = await ctx.addTask(parsed, parsed.meta);
        if (blockIsThinking) {
            writer.stopBlock(1);
        } else {
            writer.stopBlock(activeBlockIdx);
        }

        if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
            const parse = parseToolCallsFromText(result.fullText, parsed.tools);
            if (parse.toolUses.length > 0) {
                const toolIdx = (blockIsThinking ? 2 : 1);
                for (let i = 0; i < parse.toolUses.length; i++) {
                    const t = parse.toolUses[i];
                    writer.startToolUseBlock(toolIdx + i, null, t.name, t.input);
                    writer.writeToolInputDelta(toolIdx + i, JSON.stringify(t.input));
                    writer.stopBlock(toolIdx + i);
                }
                writer.writeMessageDelta({ stop_reason: 'tool_use', output_tokens: Math.max(1, Math.ceil(textBuffer.length / 4)) });
            } else {
                writer.writeMessageDelta({ stop_reason: 'end_turn', output_tokens: Math.max(1, Math.ceil(textBuffer.length / 4)) });
            }
            if (parse.warning && parse.toolUses.length === 0) {
                const warnIdx = blockIsThinking ? 2 : 1;
                writer.startTextBlock(warnIdx);
                writer.writeTextDelta(warnIdx, parse.warning);
                writer.stopBlock(warnIdx);
            }
        } else {
            writer.writeMessageDelta({ stop_reason: 'end_turn', output_tokens: Math.max(1, Math.ceil(textBuffer.length / 4)) });
        }
        writer.writeMessageStop();
        writer.end();
    } catch (err) {
        writer.writeError({
            type: 'api_error',
            message: err?.message || 'upstream error',
            requestId,
        });
    }
}

async function runNonStream(res, parsed, messageId, inputTokens, ctx, requestId) {
    try {
        const result = await ctx.addTask(parsed, parsed.meta);
        const content = [];
        if (parsed.meta.reasoning && result.reasoningText) {
            content.push({ type: 'thinking', thinking: result.reasoningText });
        }
        let textOut = result.fullText || '';
        let stopReason = 'end_turn';
        if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
            const parse = parseToolCallsFromText(textOut, parsed.tools);
            if (parse.toolUses.length > 0) {
                for (const t of parse.toolUses) {
                    content.push({ type: 'tool_use', id: 'toolu_' + crypto.randomBytes(6).toString('hex'), name: t.name, input: t.input });
                }
                stopReason = 'tool_use';
            }
            if (parse.warning) textOut += '\n' + parse.warning;
        }
        content.push({ type: 'text', text: textOut });
        const body = {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: Math.max(1, Math.ceil(textOut.length / 4)) },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    } catch (err) {
        sendApiError(res, {
            status: 502,
            type: 'api_error',
            message: err?.message || 'upstream error',
            requestId,
            isStreaming: false,
        });
    }
}

/**
 * GET /v1/models
 */
function handleModels(res, ctx, decorate) {
    const models = ctx.rawModels ? ctx.rawModels() : [];
    const decorated = decorate(models);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        data: decorated,
        first_id: decorated[0]?.id || null,
        last_id: decorated[decorated.length - 1]?.id || null,
        has_more: false,
    }));
}

/**
 * POST /v1/messages/count_tokens
 */
async function handleCountTokens(_req, res, body, _ctx, requestId, _decorate) {
    if (!body || !Array.isArray(body.messages)) {
        return sendApiError(res, {
            status: 400,
            type: 'invalid_request_error',
            message: '`messages` is required',
            requestId,
            isStreaming: false,
        });
    }
    const systemStr = typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
            ? body.system.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
            : '';
    const messageTexts = body.messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => (typeof m.content === 'string' ? m.content : ''));
    let total = systemStr.length;
    for (const t of messageTexts) total += t.length;
    const inputTokens = Math.max(1, Math.ceil(total / 4));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: inputTokens }));
}