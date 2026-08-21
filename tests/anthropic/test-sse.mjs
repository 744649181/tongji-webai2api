import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockRes } from './helpers/mockRes.js';
import { createAnthropicSseWriter } from '../../src/server/api/anthropic/sse.js';

test('SSE writer: message_start then text delta then message_stop', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, {
        messageId: 'msg_test1',
        model: 'claude-sonnet-4-5',
        inputTokens: 42,
    });
    w.startTextBlock(0);
    w.writeTextDelta(0, 'hello ');
    w.writeTextDelta(0, 'world');
    w.stopBlock(0);
    w.writeMessageDelta({ stop_reason: 'end_turn', output_tokens: 5 });
    w.writeMessageStop();
    w.end();

    assert.match(res.body, /event: message_start\ndata: /);
    assert.match(res.body, /"id":"msg_test1"/);
    assert.match(res.body, /"model":"claude-sonnet-4-5"/);
    assert.match(res.body, /"input_tokens":42/);

    const textDeltaMatches = res.body.match(/event: content_block_delta\ndata: /g) || [];
    assert.ok(textDeltaMatches.length >= 2);

    assert.match(res.body, /event: content_block_stop/);
    assert.match(res.body, /event: message_delta\ndata: /);
    assert.match(res.body, /"stop_reason":"end_turn"/);
    assert.match(res.body, /event: message_stop\ndata: /);
    assert.equal(res.writableEnded, true);
});

test('SSE writer: thinking block variant', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_t1', model: 'm', inputTokens: 1 });
    w.startThinkingBlock(0);
    w.writeThinkingDelta(0, 'reasoning step 1');
    w.stopBlock(0);
    w.startTextBlock(1);
    w.writeTextDelta(1, 'final answer');
    w.stopBlock(1);
    w.writeMessageDelta({ stop_reason: 'end_turn', output_tokens: 10 });
    w.writeMessageStop();
    w.end();

    assert.match(res.body, /"type":"thinking"/);
    assert.match(res.body, /"type":"thinking_delta"/);
    assert.match(res.body, /"thinking":"reasoning step 1"/);
    assert.match(res.body, /"type":"text_delta"/);
});

test('SSE writer: tool_use block reconstruction', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_tool', model: 'm', inputTokens: 1 });
    w.startTextBlock(0);
    w.writeTextDelta(0, 'ok ');
    w.stopBlock(0);
    w.startToolUseBlock(1, 'toolu_xyz', 'get_weather', { city: 'Shanghai' });
    w.writeToolInputDelta(1, JSON.stringify({ city: 'Shanghai' }));
    w.stopBlock(1);
    w.writeMessageDelta({ stop_reason: 'tool_use', output_tokens: 3 });
    w.writeMessageStop();
    w.end();

    assert.match(res.body, /"type":"tool_use"/);
    assert.match(res.body, /"id":"toolu_xyz"/);
    assert.match(res.body, /"name":"get_weather"/);
    assert.match(res.body, /"type":"input_json_delta"/);
    assert.match(res.body, /"stop_reason":"tool_use"/);
});

test('SSE writer: ping event', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_p', model: 'm', inputTokens: 0 });
    w.writePing();
    w.end();
    assert.match(res.body, /event: ping\ndata: \{"type":"ping"\}/);
});

test('SSE writer: writeError emits event: error and closes', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_e', model: 'm', inputTokens: 0 });
    w.writeError({ type: 'overloaded_error', message: 'queue full', requestId: 'req_e' });
    assert.equal(res.writableEnded, true);
    assert.match(res.body, /event: error\ndata: /);
    assert.match(res.body, /"type":"overloaded_error"/);
    assert.doesNotMatch(res.body, /event: message_stop/);
});

test('SSE writer: subsequent writeTextDelta after stopBlock is a no-op (defensive)', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_def', model: 'm', inputTokens: 0 });
    w.startTextBlock(0);
    w.writeTextDelta(0, 'a');
    w.stopBlock(0);
    const before = res.body;
    w.writeTextDelta(0, 'b'); // no-op
    assert.equal(res.body, before);
});

test('SSE writer: emits Content-Type and headers on first call', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_h', model: 'm', inputTokens: 0 });
    w.startTextBlock(0);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.equal(res.headers['Cache-Control'], 'no-cache');
});