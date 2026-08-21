/**
 * @fileoverview Anthropic-protocol SSE writer
 * @description Stateful writer that translates the framework's `onDelta`
 * callback stream into Anthropic's typed SSE event sequence. All event
 * ordering follows Anthropic's reference: message_start -> content_block_*
 * -> message_delta -> message_stop. Mid-stream errors emit `event: error`
 * with no trailing message_stop.
 */

import crypto from 'node:crypto';

/**
 * @typedef {Object} AnthropicSseWriter
 * @property {() => void} startTextBlock
 * @property {(idx:number, text:string) => void} writeTextDelta
 * @property {() => void} startThinkingBlock
 * @property {(idx:number, thinking:string) => void} writeThinkingDelta
 * @property {(idx:number) => void} stopBlock
 * @property {(idx:number, id:string, name:string, input:object) => void} startToolUseBlock
 * @property {(idx:number, partialJson:string) => void} writeToolInputDelta
 * @property {({stop_reason:string, output_tokens:number}) => void} writeMessageDelta
 * @property {() => void} writeMessageStop
 * @property {() => void} writePing
 * @property {({type:string, message:string, requestId:string}) => void} writeError
 * @property {() => void} end
 */

/**
 * Create a stateful Anthropic SSE writer bound to a Node HTTP response.
 *
 * The first call writes headers (`Content-Type: text/event-stream`).
 * Subsequent calls append SSE frames until `end()` or `writeError()`.
 * Block lifecycle: startXxxBlock(idx) -> writeXxxDelta(idx, ...) -> stopBlock(idx).
 * Calling writeXxxDelta after stopBlock is a defensive no-op.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{messageId:string, model:string, inputTokens:number}} init
 * @returns {AnthropicSseWriter}
 */
export function createAnthropicSseWriter(res, init) {
    const { messageId, model, inputTokens } = init;
    let headersWritten = false;
    let ended = false;
    /** @type {Set<number>} */
    const stoppedBlocks = new Set();

    function ensureHeaders() {
        if (headersWritten || ended) return;
        if (res.writableEnded) { ended = true; return; }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        headersWritten = true;
    }

    function sendEvent(eventName, dataObj) {
        if (ended || res.writableEnded) return;
        ensureHeaders();
        if (ended) return;
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
    }

    function sendRaw(raw) {
        if (ended || res.writableEnded) return;
        ensureHeaders();
        if (ended) return;
        res.write(raw);
    }

    function shortId() {
        return 'toolu_' + crypto.randomBytes(6).toString('hex');
    }

    // message_start is emitted lazily on first block to keep ordering correct
    let messageStartEmitted = false;
    function emitMessageStartOnce() {
        if (messageStartEmitted) return;
        messageStartEmitted = true;
        sendEvent('message_start', {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
        });
    }

    return {
        startTextBlock(idx) {
            if (ended || stoppedBlocks.has(idx)) return;
            emitMessageStartOnce();
            sendEvent('content_block_start', {
                type: 'content_block_start',
                index: idx,
                content_block: { type: 'text', text: '' },
            });
        },
        writeTextDelta(idx, text) {
            if (ended || stoppedBlocks.has(idx) || !text) return;
            sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: idx,
                delta: { type: 'text_delta', text },
            });
        },
        startThinkingBlock(idx) {
            if (ended || stoppedBlocks.has(idx)) return;
            emitMessageStartOnce();
            sendEvent('content_block_start', {
                type: 'content_block_start',
                index: idx,
                content_block: { type: 'thinking', thinking: '' },
            });
        },
        writeThinkingDelta(idx, thinking) {
            if (ended || stoppedBlocks.has(idx) || !thinking) return;
            sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: idx,
                delta: { type: 'thinking_delta', thinking },
            });
        },
        stopBlock(idx) {
            if (ended || stoppedBlocks.has(idx)) return;
            stoppedBlocks.add(idx);
            sendEvent('content_block_stop', {
                type: 'content_block_stop',
                index: idx,
            });
        },
        startToolUseBlock(idx, id, name, input) {
            if (ended || stoppedBlocks.has(idx)) return;
            const toolId = id || shortId();
            emitMessageStartOnce();
            sendEvent('content_block_start', {
                type: 'content_block_start',
                index: idx,
                content_block: {
                    type: 'tool_use',
                    id: toolId,
                    name,
                    input: input || {},
                },
            });
        },
        writeToolInputDelta(idx, partialJson) {
            if (ended || stoppedBlocks.has(idx) || !partialJson) return;
            sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: idx,
                delta: { type: 'input_json_delta', partial_json: partialJson },
            });
        },
        writeMessageDelta({ stop_reason, output_tokens }) {
            if (ended) return;
            emitMessageStartOnce();
            sendEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stop_reason || 'end_turn', stop_sequence: null },
                usage: { output_tokens: output_tokens || 0 },
            });
        },
        writeMessageStop() {
            if (ended) return;
            emitMessageStartOnce();
            sendEvent('message_stop', { type: 'message_stop' });
        },
        writePing() {
            if (ended) return;
            sendRaw('event: ping\ndata: {"type":"ping"}\n\n');
        },
        writeError({ type, message, requestId }) {
            if (ended) return;
            sendEvent('error', {
                type: 'error',
                error: { type, message, request_id: requestId },
            });
            ended = true;
            try { res.end(); } catch { /* ignore */ }
        },
        end() {
            if (ended) return;
            ended = true;
            try { res.end(); } catch { /* ignore */ }
        },
    };
}