import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnthropicRequest } from '../../src/server/api/anthropic/parse.js';

const CTX = {
    apiKey: 'sk-test',
    modelMapOverride: null,
    requestId: 'req_unit',
};

test('parseAnthropicRequest: minimal valid request', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
    }, CTX);
    assert.equal(r.model, 'DeepSeek-V4-Pro');
    assert.equal(r.maxTokens, 1024);
    assert.equal(r.stream, false);
    assert.deepEqual(r.systemPrompt, '');
    assert.equal(r.messages[0].role, 'user');
    assert.equal(r.messages[0].content, 'hi');
    assert.equal(r.meta.id, 'req_unit');
});

test('parseAnthropicRequest: resolves alias via config override', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'q' }],
    }, { ...CTX, modelMapOverride: { 'claude-sonnet-4-5': 'GLM-5.1' } });
    assert.equal(r.model, 'GLM-5.1');
});

test('parseAnthropicRequest: passes raw Tongji name through', () => {
    const r = parseAnthropicRequest({
        model: 'Kimi-K2.6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'q' }],
    }, CTX);
    assert.equal(r.model, 'Kimi-K2.6');
});

test('parseAnthropicRequest: rejects unknown model', () => {
    assert.throws(
        () => parseAnthropicRequest({
            model: 'claude-unknown-future',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'q' }],
        }, CTX),
        /not_found_error|unknown model/i
    );
});

test('parseAnthropicRequest: extracts system prompt as string', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'q' }],
    }, CTX);
    assert.equal(r.systemPrompt, 'You are helpful.');
});

test('parseAnthropicRequest: extracts system prompt from array of blocks', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        system: [
            { type: 'text', text: 'Rule 1.' },
            { type: 'text', text: 'Rule 2.' },
        ],
        messages: [{ role: 'user', content: 'q' }],
    }, CTX);
    assert.match(r.systemPrompt, /Rule 1\./);
    assert.match(r.systemPrompt, /Rule 2\./);
});

test('parseAnthropicRequest: rejects image content with 400', () => {
    assert.throws(
        () => parseAnthropicRequest({
            model: 'claude-sonnet-4-5',
            max_tokens: 100,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fake' } },
                ],
            }],
        }, CTX),
        /vision/i
    );
});

test('parseAnthropicRequest: stream=true sets meta.reasoning when thinking.enabled', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'q' }],
    }, CTX);
    assert.equal(r.stream, true);
    assert.equal(r.meta.reasoning, true);
    assert.equal(r.thinking.budgetTokens, 1024);
});

test('parseAnthropicRequest: tools produce prompt suffix', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        tools: [{
            name: 'get_weather',
            description: 'Get weather for a city',
            input_schema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
            },
        }],
        messages: [{ role: 'user', content: 'How is the weather in Shanghai?' }],
    }, CTX);
    assert.equal(r.tools.length, 1);
    assert.match(r.systemPrompt + r.messages[0].content, /get_weather/);
});

test('parseAnthropicRequest: rejects empty messages', () => {
    assert.throws(
        () => parseAnthropicRequest({
            model: 'claude-sonnet-4-5',
            max_tokens: 100,
            messages: [],
        }, CTX),
        /messages/i
    );
});

test('parseAnthropicRequest: rejects request with no user message', () => {
    assert.throws(
        () => parseAnthropicRequest({
            model: 'claude-sonnet-4-5',
            max_tokens: 100,
            messages: [{ role: 'assistant', content: 'I am alone.' }],
        }, CTX),
        /user/i
    );
});