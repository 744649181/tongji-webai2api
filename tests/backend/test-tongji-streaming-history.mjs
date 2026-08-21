/**
 * Regression test for: WebUI Tools/Request page shows "无响应" (no response)
 * for streaming requests, even though the SSE stream itself delivers content.
 *
 * Root cause: src/backend/adapter/tongji.js had a bug where its `generate()`
 * returned `{ text: '' }` for streaming mode, discarding the accumulated
 * `fullText`. As a result, queue.js (which reads `result.text` to populate
 * the history DB row's `response_text` column) stored empty string. The WebUI
 * then renders `record.response_text || '无响应'`.
 *
 * This test exercises the contract: when streaming, the adapter MUST return
 * a non-empty `text` field so the history layer can persist it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifest as tongjiManifest } from '../../src/backend/adapter/tongji.js';

const generate = tongjiManifest.generate;

const SAMPLE_SSE_BODY = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":", world!"}}]}',
    '',
    'data: {"choices":[{"delta":{}}],"finish_reason":"stop"}',
    '',
    'data: [DONE]',
    '',
].join('\n');

const CREATE_CONV_RESPONSE = {
    ok: true,
    status: 200,
    json: {
        Result: {
            ConversationInfo: {
                ConversationID: 'conv-test-1',
                ProjectList: [{ SessionID: 'sess-test-1' }],
            },
        },
    },
};

const BATCH_MSG_RESPONSE = {
    ok: true,
    status: 200,
    json: {
        Result: {
            MessageList: [{ MessageID: 'msg-test-1', AuthorRole: 2 }],
        },
    },
};

const CHAT_RESPONSE = {
    ok: true,
    status: 200,
    body: SAMPLE_SSE_BODY,
};

/**
 * Build a minimal Playwright `page` mock. Routes `page.evaluate` calls by the
 * Action in the URL argument and returns canned upstream responses.
 *
 * Also stubs page.setDefaultTimeout / page._defaultTimeout because main's
 * 16ed8d6 commit wraps streamChat's page.evaluate in a Playwright default
 * timeout bump (workaround for Playwright's 30s default action timeout
 * killing long generations).
 */
function buildMockPage() {
    return {
        _defaultTimeout: 30000,
        setDefaultTimeout(ms) { this._defaultTimeout = ms; },
        async evaluate(fn, arg) {
            const url = arg?.url || '';
            if (url.includes('Action=CreateConversation')) return CREATE_CONV_RESPONSE;
            if (url.includes('Action=BatchCreateMessages')) return BATCH_MSG_RESPONSE;
            if (url.includes('Action=Chat')) return CHAT_RESPONSE;
            throw new Error(`unmocked URL in test: ${url}`);
        },
    };
}

test('tongji adapter streaming mode returns accumulated text (not empty)', async () => {
    const page = buildMockPage();
    const deltas = [];
    const onDelta = (d) => {
        if (typeof d?.content === 'string') deltas.push(d.content);
    };

    // Use the default model so the fallback serviceId path is taken
    // (avoids needing to populate MODEL_DICT first).
    const result = await generate(
        { page },
        'test prompt',
        [],
        'DeepSeek-V4-Pro',
        { id: 'req-test-1', onDelta }
    );

    assert.equal(result.error, undefined, `unexpected error: ${result?.error}`);
    assert.equal(typeof result.text, 'string', 'result.text should be a string');
    assert.notEqual(
        result.text,
        '',
        'BUG REGRESSION: streaming result.text must NOT be empty — queue.js ' +
        'uses it to populate the history row, which the WebUI displays.'
    );
    assert.equal(
        result.text,
        'Hello, world!',
        'result.text should contain the accumulated SSE content'
    );

    // Also sanity-check that onDelta was actually called for streaming
    assert.equal(deltas.join(''), 'Hello, world!');
});

test('tongji adapter non-streaming mode returns accumulated text', async () => {
    const page = buildMockPage();
    const result = await generate(
        { page },
        'test prompt',
        [],
        'DeepSeek-V4-Pro',
        { id: 'req-test-2' /* no onDelta → non-streaming path */ }
    );

    assert.equal(result.error, undefined, `unexpected error: ${result?.error}`);
    assert.equal(result.text, 'Hello, world!');
});
