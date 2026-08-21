/**
 * @fileoverview Anthropic-protocol error formatting
 * @description Maps internal error conditions to Anthropic's
 * {type:"error", error:{type, message, request_id}} shape and writes
 * the appropriate HTTP/SSE response.
 */

/**
 * Build an Anthropic-shaped error body (no HTTP interaction).
 * @param {{type: string, message: string, requestId: string}} opts
 * @returns {{type: "error", error: {type: string, message: string, request_id: string}}}
 */
export function anthropicErrorBody({ type, message, requestId }) {
    return {
        type: 'error',
        error: {
            type,
            message,
            request_id: requestId,
        },
    };
}

/**
 * Send an Anthropic-shaped error response.
 *
 * Non-streaming: JSON body, headers flushed immediately.
 * Streaming: SSE response with one `event: error` data line, then end.
 *   Note: per Anthropic convention, NO `message_stop` after a mid-stream
 *   error event. The stream simply ends.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   status: number,
 *   type: string,
 *   message: string,
 *   requestId: string,
 *   isStreaming?: boolean,
 * }} opts
 */
export function sendApiError(res, { status, type, message, requestId, isStreaming = false }) {
    if (res.writableEnded) return;
    const body = anthropicErrorBody({ type, message, requestId });
    if (isStreaming) {
        res.writeHead(status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
        res.end();
        return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}