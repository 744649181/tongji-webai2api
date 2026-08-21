#!/usr/bin/env node
/**
 * @fileoverview Cross-platform Anthropic-protocol smoke test (9 cases).
 * Requires a running server with valid Tongji SSO cookies.
 * Run with: node scripts/smoke-test-anthropic.mjs
 *
 * Cases:
 *   1. stream with claude-sonnet-4-5 (real hiagent SSE)
 *   2. non-stream with claude-haiku-4-5
 *   3. multi-turn (server-side SessionID preserves history)
 *   4. extended thinking (DeepSeek-R1 reasoning -> thinking block)
 *   5. tool_use soft synthesis (model emits <tool_use>{json}</tool_use>)
 *   6. vision rejection (400 invalid_request_error)
 *   7. count_tokens estimate
 *   8. auth failures (wrong key, missing version)
 *   9. raw name passthrough (model: "GLM-5.1" instead of alias)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// -------- config --------
const cfgRaw = readFileSync(resolve(ROOT, 'data/config.yaml'), 'utf8');
const portMatch = cfgRaw.match(/^\s*port:\s*(\d+)/m);
const authMatch = cfgRaw.match(/^\s*auth:\s*(\S+)/m);
if (!portMatch || !authMatch) {
    console.error('Could not parse data/config.yaml for port/auth');
    process.exit(2);
}
const PORT = parseInt(portMatch[1], 10);
const API_KEY = authMatch[1];

const BASE_URL = `http://127.0.0.1:${PORT}`;

const client = new Anthropic({
    baseURL: BASE_URL,
    apiKey: API_KEY,
});

// -------- test framework --------
let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
    process.stdout.write(`\n--- ${name} ---\n`);
    try {
        await fn();
        console.log(`PASS: ${name}`);
        passed++;
        results.push({ name, status: 'pass' });
    } catch (err) {
        console.log(`FAIL: ${name}`);
        console.log(`  ${err.message}`);
        if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
        failed++;
        results.push({ name, status: 'fail', error: err.message });
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// -------- cases --------

await test('1. stream with claude-sonnet-4-5', async () => {
    const stream = client.messages.stream({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Reply with exactly the word OK.' }],
    });
    let textChunks = 0;
    let finalText = '';
    stream.on('text', (delta) => { textChunks++; finalText += delta; });
    const msg = await stream.finalMessage();
    assert(textChunks >= 1, `expected >= 1 text chunk, got ${textChunks}`);
    assert(msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop', `stop_reason=${msg.stop_reason}`);
    assert(msg.usage.output_tokens > 0, `output_tokens=${msg.usage?.output_tokens}`);
    console.log(`  text: ${JSON.stringify(finalText).slice(0, 80)}`);
});

await test('2. non-stream with claude-haiku-4-5', async () => {
    const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    assert(msg.role === 'assistant', `role=${msg.role}`);
    assert(Array.isArray(msg.content) && msg.content.length >= 1, 'content non-empty');
    const textBlock = msg.content.find((b) => b.type === 'text');
    assert(textBlock && /PONG/i.test(textBlock.text), `text=${JSON.stringify(textBlock?.text)}`);
});

await test('3. multi-turn native session', async () => {
    const c1 = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    assert(/OK/i.test(c1.content.find((b) => b.type === 'text')?.text || ''), `c1 text=${JSON.stringify(c1.content)}`);
    const c2 = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 128,
        messages: [
            { role: 'user', content: 'My name is Alice. Reply with exactly: OK' },
            { role: 'assistant', content: 'OK' },
            { role: 'user', content: 'What is my name? Reply with just the name.' },
        ],
    });
    const t2 = c2.content.find((b) => b.type === 'text')?.text || '';
    assert(/Alice/i.test(t2), `c2 text=${JSON.stringify(t2)}`);
});

await test('4. extended thinking', async () => {
    const msg = await client.messages.create({
        model: 'claude-opus-4-1',
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 256 },
        messages: [{ role: 'user', content: 'What is 17 * 23? Show your reasoning then the answer.' }],
    });
    const types = msg.content.map((b) => b.type);
    assert(types.includes('thinking'), `expected thinking block; types=${JSON.stringify(types)}`);
    assert(types.includes('text'), `expected text block; types=${JSON.stringify(types)}`);
});

await test('5. tool_use soft synthesis', async () => {
    const msg = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        tools: [{
            name: 'get_weather',
            description: 'Get weather for a city',
            input_schema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
            },
        }],
        messages: [{ role: 'user', content: 'How is the weather in Shanghai? Use get_weather.' }],
    });
    const toolUse = msg.content.find((b) => b.type === 'tool_use');
    // Note: tool_use synthesis depends on model instruction-following; flaky.
    if (!toolUse) {
        throw new Error(`expected tool_use block; content=${JSON.stringify(msg.content)}`);
    }
    assert(toolUse.name === 'get_weather', `tool name=${toolUse.name}`);
    assert(toolUse.input && typeof toolUse.input === 'object', 'tool.input present');
});

await test('6. vision rejection', async () => {
    let caught = null;
    try {
        await client.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 100,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
                ],
            }],
        });
    } catch (err) {
        caught = err;
    }
    assert(caught, 'expected error to be thrown');
    assert(caught.status === 400, `status=${caught.status}`);
    assert(/vision/i.test(caught.message), `message=${caught.message}`);
});

await test('7. count_tokens', async () => {
    const res = await fetch(`${BASE_URL}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: 'hello world this is a test' }],
        }),
    });
    assert(res.status === 200, `status=${res.status}`);
    const body = await res.json();
    assert(typeof body.input_tokens === 'number' && body.input_tokens > 0, `input_tokens=${body.input_tokens}`);
});

await test('8. auth failures', async () => {
    // wrong key
    const wrong = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }),
    });
    assert(wrong.status === 401, `wrong-key status=${wrong.status}`);
    const wrongBody = await wrong.json();
    assert(wrongBody.error?.type === 'authentication_error', `wrong-key type=${wrongBody.error?.type}`);

    // missing version
    const noVer = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }),
    });
    assert(noVer.status === 400, `no-version status=${noVer.status}`);
});

await test('9. raw name passthrough', async () => {
    const msg = await client.messages.create({
        model: 'GLM-5.1',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with exactly: RAW_OK' }],
    });
    const t = msg.content.find((b) => b.type === 'text')?.text || '';
    assert(msg.model === 'GLM-5.1', `model echoed=${msg.model}`);
    assert(/RAW_OK/i.test(t), `text=${JSON.stringify(t)}`);
});

// -------- summary --------
console.log(`\n=== summary ===`);
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);