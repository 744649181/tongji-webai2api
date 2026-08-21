#!/usr/bin/env node
/**
 * @fileoverview Programmatic capture runner for Tongji/hiagent capability discovery.
 *
 * Unlike scripts/capture-tongji.js (which is a browser-console script that requires
 * manual UI interaction), this runner hits the running server's OpenAI endpoint
 * with deliberately varied scenarios to probe platform behavior.
 *
 * SSE parsing: see parseSseFrames() below — exported for unit testing in
 * tests/cli/test-sse-parser.mjs.
 *
 * Outputs:
 *   - captures/scenario-<n>-<slug>.json — one per scenario, structured request/response
 *   - captures/summary.json — aggregated results with PASS/FAIL/SKIP per scenario
 *
 * Run:  node scripts/capture-tongji-scenarios.mjs
 * Requires: server running on 127.0.0.1:3000 with default API key.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SERVER = 'http://127.0.0.1:3000';
const KEY = 'sk-change-me-to-your-secure-key';
const CAPTURE_DIR = path.join(process.cwd(), 'captures');

mkdirSync(CAPTURE_DIR, { recursive: true });

/**
 * Parse a Server-Sent Events (SSE) text blob into a list of frames.
 *
 * Each frame is { event: string, data: string } where:
 *   - event defaults to "message" if no `event:` line was present
 *   - data is the joined result of all `data:` lines in the frame
 *     (newline-joined per SSE spec)
 *
 * Handles CRLF and LF line endings, leading space after `:`, comment lines
 * (`:...`), and frames with no trailing blank line.
 *
 * @param {string} text
 * @returns {Array<{event:string, data:string}>}
 */
export function parseSseFrames(text) {
    if (typeof text !== 'string' || text.length === 0) return [];

    const frames = [];
    let currentEvent = null;
    let dataLines = [];

    const flush = () => {
        if (currentEvent !== null || dataLines.length > 0) {
            frames.push({
                event: currentEvent || 'message',
                data: dataLines.join('\n'),
            });
        }
        currentEvent = null;
        dataLines = [];
    };

    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        if (line === '') {
            flush();
            continue;
        }
        if (line.startsWith(':')) {
            // SSE comment — ignore
            continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = '';
        if (colon !== -1) {
            value = line.slice(colon + 1);
            // SSE spec: a single leading space after the colon is stripped
            if (value.startsWith(' ')) value = value.slice(1);
        }
        if (field === 'event') currentEvent = value;
        else if (field === 'data') dataLines.push(value);
        // other fields (id, retry) intentionally ignored
    }
    flush(); // capture trailing frame with no terminating blank line
    return frames;
}

/**
 * Hit /v1/chat/completions with a given body, buffering the full response.
 *
 * Implementation: uses Node's built-in http module (not fetch) so we control
 * the response buffering and the SSE parser runs over the entire body. fetch()
 * in Node 24 sometimes returns a buffered body with a non-text/event-stream
 * content-type for streaming responses, which broke the previous parser.
 *
 * Returns:
 *   { ok, status, elapsedMs, stream: bool,
 *     body?: parsed JSON for non-stream responses,
 *     sseFrames?: Array<{event,data}> for SSE responses,
 *     contentLength?, reasoningLength?, finishReason?, usage?,
 *     contentPreview?, reasoningPreview? }
 */
function callChat(body, { timeoutMs = 120_000 } = {}) {
    // body.stream wins; options.stream is just a legacy convenience override.
    const payload = JSON.stringify(body);
    const start = Date.now();

    return new Promise((resolve) => {
        const url = new URL('/v1/chat/completions', SERVER);
        const req = http.request({
            method: 'POST',
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': `Bearer ${KEY}`,
            },
        });

        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`timeout after ${timeoutMs}ms`));
        });

        req.on('error', (err) => {
            finish({ ok: false, error: err.message, elapsedMs: Date.now() - start });
        });

        req.on('response', (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const ct = (res.headers['content-type'] || '').toLowerCase();
                const status = res.statusCode;
                const elapsedMs = Date.now() - start;

                // Decide stream vs non-stream from body shape, not just Content-Type.
                // Server may label SSE as 'application/json' or vice versa;
                // the parser is deterministic so we always try both.
                const sseFrames = parseSseFrames(text);
                const looksLikeSse = sseFrames.length > 0
                    && sseFrames.some(f => f.data && f.data !== '[DONE]' && f.data.startsWith('{'));

                if (looksLikeSse) {
                    let content = '', reasoning = '', finishReason = null, usage = null;
                    for (const f of sseFrames) {
                        if (f.data === '[DONE]') continue;
                        try {
                            const obj = JSON.parse(f.data);
                            const choice = obj.choices?.[0];
                            if (choice?.delta?.content) content += choice.delta.content;
                            if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
                            if (choice?.finish_reason) finishReason = choice.finish_reason;
                            if (obj.usage) usage = obj.usage;
                        } catch {}
                    }
                    finish({
                        ok: status < 400,
                        status,
                        elapsedMs,
                        stream: true,
                        contentType: ct,
                        sseFrameCount: sseFrames.length,
                        finishReason,
                        usage,
                        contentLength: content.length,
                        reasoningLength: reasoning.length,
                        contentPreview: content.slice(0, 200),
                        reasoningPreview: reasoning.slice(0, 200),
                    });
                    return;
                }

                // Non-stream: parse whole body as JSON
                let parsed = null;
                try { parsed = JSON.parse(text); } catch {}
                finish({
                    ok: status < 400,
                    status,
                    elapsedMs,
                    stream: false,
                    contentType: ct,
                    body: parsed ?? text.slice(0, 1000),
                });
            });
        });

        req.end(payload);
    });
}

/**
 * Save one scenario capture.
 */
function saveCapture(name, scenario, result) {
    const file = path.join(CAPTURE_DIR, `scenario-${name}.json`);
    const data = {
        capturedAt: new Date().toISOString(),
        scenario,
        result,
    };
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return file;
}

/**
 * Print scenario summary line.
 */
function report(name, result, notes = '') {
    const status = result.ok ? 'PASS' : (result.error ? 'ERROR' : 'FAIL');
    const tag = status === 'PASS' ? '\x1b[32m' : status === 'ERROR' ? '\x1b[31m' : '\x1b[33m';
    const reset = '\x1b[0m';
    console.log(`${tag}[${status.padEnd(5)}]\x1b[0m ${name.padEnd(35)} status=${result.status ?? '-'} elapsed=${result.elapsedMs ?? '-'}ms${notes ? '  // ' + notes : ''}`);
}

async function main() {
const summary = [];

// ==================== Scenarios ====================
//
// NOTE: scenarios run inside main() which is called only when this module
// is the program entry point (guarded at the bottom). Without this guard,
// importing parseSseFrames() from a test would re-trigger the whole capture
// run as a module side effect, silently overwriting captures/. Same
// anti-pattern as fix(login) in CONTRIBUTING.md.

// 1. Baseline — single turn, short prompt, stream off (easier to parse)
{
    const result = await callChat(
        { model: 'Qwen3-235B', messages: [{ role: 'user', content: 'say hi in 3 words' }], stream: false },
        { timeoutMs: 60_000 }
    );
    saveCapture('01-baseline-nonstream', 'baseline: short prompt, no stream', result);
    report('01-baseline-nonstream', result);
    summary.push({ name: '01-baseline-nonstream', ok: result.ok, status: result.status });
}

// 2. Streaming — same prompt, stream on, verify SSE frames
{
    const result = await callChat(
        { model: 'Qwen3-235B', messages: [{ role: 'user', content: 'say hi' }], stream: true },
        { timeoutMs: 60_000 }
    );
    saveCapture('02-baseline-stream', 'baseline: short prompt, streaming', result);
    report('02-baseline-stream', result, `frames=${result.sseFrameCount} finishReason=${result.finishReason}`);
    summary.push({ name: '02-baseline-stream', ok: result.ok, frameCount: result.sseFrameCount });
}

// 3. Multi-turn — 3 messages, verify SessionID preserves context
{
    const r1 = await callChat(
        { model: 'Qwen3-235B', messages: [{ role: 'user', content: '记住这个密码: PURPLE-OCEAN-9' }], stream: false },
        { timeoutMs: 60_000 }
    );
    // Use same model — adapter should reuse SessionID via SessionID-by-model caching.
    const r2 = await callChat(
        { model: 'Qwen3-235B', messages: [{ role: 'user', content: '我刚才告诉你的密码是什么?' }], stream: false },
        { timeoutMs: 60_000 }
    );
    const result = {
        ok: r1.ok && r2.ok,
        turn1Content: r1.body?.choices?.[0]?.message?.content,
        turn2Content: r2.body?.choices?.[0]?.message?.content,
        rememberedSecret: r2.body?.choices?.[0]?.message?.content?.includes('PURPLE-OCEAN-9'),
    };
    saveCapture('03-multiturn', 'multi-turn: 2 messages same session', result);
    report('03-multiturn', result, result.rememberedSecret ? '✓ context preserved' : '✗ context NOT preserved');
    summary.push({ name: '03-multiturn', ok: result.ok, remembered: result.rememberedSecret });
}

// 4. Reasoning model — DeepSeek-R1, expect reasoning_content
{
    const result = await callChat(
        { model: 'DeepSeek-R1', messages: [{ role: 'user', content: '7 * 8 = ?' }], stream: true },
        { timeoutMs: 120_000 }
    );
    saveCapture('04-reasoning-deepseek-r1', 'reasoning model: DeepSeek-R1 with math prompt', result);
    report('04-reasoning-deepseek-r1', result, `reasoning=${result.reasoningLength}c content=${result.contentLength}c`);
    summary.push({ name: '04-reasoning', ok: result.ok, reasoningChars: result.reasoningLength });
}

// 5. Long response — ask for 400-word essay, see if it truncates
{
    const result = await callChat(
        { model: 'Qwen3-235B', messages: [{ role: 'user', content: 'Write a 400-word overview of MNIST (the digit-recognition dataset). Use plain prose, no lists.' }], stream: true },
        { timeoutMs: 180_000 }
    );
    saveCapture('05-long-response', 'long response: 400-word essay', result);
    report('05-long-response', result, `frames=${result.sseFrameCount} content=${result.contentLength}c finishReason=${result.finishReason}`);
    summary.push({ name: '05-long-response', ok: result.ok, frameCount: result.sseFrameCount, contentLength: result.contentLength });
}

// 6. max_tokens boundary — set very high, see if accepted (capture shows max=16384)
{
    const result = await callChat(
        { model: 'Qwen3-235B', messages: [{ role: 'user', content: 'List numbers 1 to 10, comma-separated' }], stream: false, max_tokens: 16384 },
        { timeoutMs: 60_000 }
    );
    saveCapture('06-max-tokens-boundary', 'max_tokens=16384 (the documented upper bound)', result);
    report('06-max-tokens-boundary', result);
    summary.push({ name: '06-max-tokens-boundary', ok: result.ok });
}

// 7. Invalid model — what does platform return?
{
    const result = await callChat(
        { model: 'DOES-NOT-EXIST-XYZ', messages: [{ role: 'user', content: 'hi' }], stream: false },
        { timeoutMs: 60_000 }
    );
    saveCapture('07-invalid-model', 'error case: invalid model name', result);
    report('07-invalid-model', result);
    summary.push({ name: '07-invalid-model', ok: result.ok, status: result.status });
}

// 8. Image input (Anthropic-style) — should 400
{
    const result = await callChat(
        {
            model: 'Qwen3-235B',
            messages: [{ role: 'user', content: [
                { type: 'text', text: 'what is this?' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ]}],
            stream: false,
        },
        { timeoutMs: 30_000 }
    );
    saveCapture('08-image-input', 'error case: image input', result);
    report('08-image-input', result);
    summary.push({ name: '08-image-input', ok: result.ok, status: result.status });
}

// 9. Tool-call-style prompt — ask the model to call a function (using prompt-only approach)
{
    const result = await callChat(
        {
            model: 'Qwen3-235B',
            messages: [{ role: 'user', content: 'What is the weather in Shanghai? Use the get_weather function with city="Shanghai". Reply with `<tool_use>{"name":"get_weather","input":{"city":"Shanghai"}}</tool_use>`. Do not include any other text.' }],
            stream: false,
        },
        { timeoutMs: 60_000 }
    );
    saveCapture('09-tool-call-attempt', 'tool call: prompt-only style (model decides)', result);
    const content = result.body?.choices?.[0]?.message?.content || '';
    const toolUseMatch = content.match(/<tool_use>([\s\S]*?)<\/tool_use>/);
    report('09-tool-call-attempt', result, toolUseMatch ? `✓ tool_use JSON found` : '✗ no <tool_use> block');
    summary.push({ name: '09-tool-call', ok: result.ok, producedToolUse: !!toolUseMatch });
}

// 10. Model switch — different model in same conversation
{
    const r1 = await callChat(
        { model: 'Qwen3-235B', messages: [{ role: 'user', content: 'hi' }], stream: false },
        { timeoutMs: 60_000 }
    );
    const r2 = await callChat(
        { model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false },
        { timeoutMs: 60_000 }
    );
    const result = {
        ok: r1.ok && r2.ok,
        model1: r1.body?.model,
        model2: r2.body?.model,
        switched: r1.body?.model !== r2.body?.model,
    };
    saveCapture('10-model-switch', 'model switch: same conversation, different model', result);
    report('10-model-switch', result);
    summary.push({ name: '10-model-switch', ok: result.ok });
}

writeFileSync(path.join(CAPTURE_DIR, 'summary.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    scenarios: summary,
}, null, 2), 'utf8');

console.log('\n=== DONE ===');
console.log(`Summary: ${path.join(CAPTURE_DIR, 'summary.json')}`);
console.log(`Per-scenario JSONs in: ${CAPTURE_DIR}`);
} // end main()

// Guard: only run when invoked directly, not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error('capture-tongji-scenarios failed:', err.stack || err.message);
        process.exit(1);
    });
}
