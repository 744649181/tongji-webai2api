import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    toolsToPromptSuffix,
    parseToolCallsFromText,
    renderToolResultForPrompt,
    renderAssistantToolUseForPrompt,
} from '../../src/server/api/anthropic/tools.js';

const SAMPLE_TOOLS = [
    {
        name: 'get_weather',
        description: 'Get weather for a city',
        input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
        },
    },
    {
        name: 'search_docs',
        description: 'Search documents',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    },
];

test('toolsToPromptSuffix: lists every tool with name, description, schema', () => {
    const suffix = toolsToPromptSuffix(SAMPLE_TOOLS);
    assert.match(suffix, /get_weather/);
    assert.match(suffix, /Get weather for a city/);
    assert.match(suffix, /search_docs/);
    assert.match(suffix, /Search documents/);
    assert.match(suffix, /"city"/);
    assert.match(suffix, /"type":\s*"object"/);
    assert.match(suffix, /<tool_use>/);
    assert.match(suffix, /\{"name":/);
});

test('toolsToPromptSuffix: empty input returns empty string', () => {
    assert.equal(toolsToPromptSuffix([]), '');
    assert.equal(toolsToPromptSuffix(null), '');
    assert.equal(toolsToPromptSuffix(undefined), '');
});

test('parseToolCallsFromText: extracts a single valid tool_use', () => {
    const text = 'I will check the weather.\n<tool_use>{"name":"get_weather","arguments":{"city":"Shanghai"}}</tool_use>';
    const result = parseToolCallsFromText(text, SAMPLE_TOOLS);
    assert.equal(result.warning, null);
    assert.equal(result.toolUses.length, 1);
    assert.equal(result.toolUses[0].name, 'get_weather');
    assert.deepEqual(result.toolUses[0].input, { city: 'Shanghai' });
});

test('parseToolCallsFromText: appends warning and returns no toolUse on bad JSON', () => {
    const text = '<tool_use>{"name":"get_weather","arguments":not_json}</tool_use>';
    const result = parseToolCallsFromText(text, SAMPLE_TOOLS);
    assert.equal(result.toolUses.length, 0);
    assert.match(result.warning, /tool_parse_failed/);
});

test('parseToolCallsFromText: rejects unknown tool name', () => {
    const text = '<tool_use>{"name":"unknown_tool","arguments":{}}</tool_use>';
    const result = parseToolCallsFromText(text, SAMPLE_TOOLS);
    assert.equal(result.toolUses.length, 0);
    assert.match(result.warning, /tool_parse_failed|unknown/i);
});

test('parseToolCallsFromText: strips surrounding prose', () => {
    const text = 'OK, let me look.\n<tool_use>{"name":"search_docs","arguments":{"query":"hiagent"}}</tool_use>\nPlease wait.';
    const result = parseToolCallsFromText(text, SAMPLE_TOOLS);
    assert.equal(result.toolUses.length, 1);
    assert.equal(result.toolUses[0].name, 'search_docs');
});

test('renderToolResultForPrompt: serializes tool_result for next user message', () => {
    const out = renderToolResultForPrompt('toolu_abc', { temp: 22 });
    assert.match(out, /toolu_abc/);
    assert.match(out, /"temp":\s*22/);
});

test('renderAssistantToolUseForPrompt: serializes tool_use for assistant history', () => {
    const out = renderAssistantToolUseForPrompt('get_weather', { city: 'Beijing' });
    assert.match(out, /get_weather/);
    assert.match(out, /Beijing/);
    assert.match(out, /<tool_use>/);
});