import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAnthropicRouter } from '../../src/server/api/anthropic/routes.js';
import { buildStableChatId } from '../../src/server/respond.js';

function startServer(router) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => router(req, res));
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port });
        });
    });
}

function request(port, { method, path, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                ...headers,
            },
        }, (res) => {
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const CTX = {
    apiKey: 'sk-test-key',
    modelMapOverride: null,
    addTask: (_req, meta) => {
        return new Promise((resolve) => {
            if (meta.onDelta) {
                meta.onDelta({ content: 'hello ' });
                meta.onDelta({ content: 'world' });
            }
            resolve({ fullText: 'hello world', reasoningText: '' });
        });
    },
    decorateModels: (models) => models.map((m) => ({ ...m, display_name: m.id })),
    rawModels: () => ([
        { id: 'DeepSeek-V4-Pro', imagePolicy: 'forbidden', type: 'text' },
        { id: 'GLM-5.1', imagePolicy: 'forbidden', type: 'text' },
    ]),
};

test('POST /v1/messages: missing x-api-key -> 401', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            body: { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
        });
        assert.equal(res.status, 401);
        const body = JSON.parse(res.body);
        assert.equal(body.type, 'error');
        assert.equal(body.error.type, 'authentication_error');
    } finally {
        server.close();
    }
});

test('POST /v1/messages: wrong x-api-key -> 401', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'wrong', 'anthropic-version': '2023-06-01' },
            body: { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
        });
        assert.equal(res.status, 401);
    } finally { server.close(); }
});

test('POST /v1/messages: missing anthropic-version -> 400', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key' },
            body: { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
        });
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.error.type, 'invalid_request_error');
    } finally { server.close(); }
});

test('POST /v1/messages: non-stream returns single message JSON', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: {
                model: 'claude-sonnet-4-5',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
            },
        });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.role, 'assistant');
        assert.equal(body.model, 'DeepSeek-V4-Pro');
        assert.equal(body.content[0].type, 'text');
        assert.equal(body.content[0].text, 'hello world');
        assert.equal(body.stop_reason, 'end_turn');
    } finally { server.close(); }
});

test('POST /v1/messages: stream returns SSE event sequence', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: {
                model: 'claude-haiku-4-5',
                max_tokens: 100,
                stream: true,
                messages: [{ role: 'user', content: 'stream please' }],
            },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');
        assert.match(res.body, /event: message_start/);
        assert.match(res.body, /event: content_block_delta/);
        assert.match(res.body, /"text":"hello "/);
        assert.match(res.body, /"text":"world"/);
        assert.match(res.body, /event: message_delta/);
        assert.match(res.body, /event: message_stop/);
    } finally { server.close(); }
});

test('POST /v1/messages: unknown model -> 400 not_found_error', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: { model: 'claude-unknown-future', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
        });
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.error.type, 'not_found_error');
    } finally { server.close(); }
});

test('POST /v1/messages: vision content -> 400 invalid_request_error', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: {
                model: 'claude-sonnet-4-5',
                max_tokens: 100,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'look' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fake' } },
                    ],
                }],
            },
        });
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.match(body.error.message, /vision/i);
    } finally { server.close(); }
});

test('GET /v1/models: returns decorated list', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'GET',
            path: '/v1/models',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
        });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.ok(Array.isArray(body.data));
        assert.ok(body.data.length >= 2);
        assert.ok(body.data.every((m) => typeof m.display_name === 'string'));
    } finally { server.close(); }
});

test('POST /v1/messages/count_tokens: returns input_tokens estimate', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages/count_tokens',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: {
                model: 'claude-sonnet-4-5',
                messages: [{ role: 'user', content: 'hello world' }],
            },
        });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(typeof body.input_tokens, 'number');
        assert.ok(body.input_tokens > 0);
    } finally { server.close(); }
});