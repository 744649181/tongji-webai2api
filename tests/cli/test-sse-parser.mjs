/**
 * Regression test for: `scripts/capture-tongji-scenarios.mjs` reported
 * `frames=undefined` / `contentLength=undefined` for streaming scenarios,
 * because the original inline SSE parser only triggered when
 * `Content-Type: text/event-stream` was present. Some Node 24 fetch paths
 * surface SSE responses under a different content-type, or the parser's
 * frame accumulator had off-by-one bugs.
 *
 * The fix: extract SSE parsing into a pure function, test it independently
 * with synthetic SSE inputs, and use a more robust HTTP client (Node http)
 * that buffers the full response so the parser can be deterministic.
 *
 * NOTE: scripts/capture-tongji-scenarios.mjs is a dev-only capture tool,
 * not shipped code. But its parser logic was unreliable; tests cover the
 * extracted helpers so future refactors don't regress.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseFrames } from '../../scripts/capture-tongji-scenarios.mjs';

test('parseSseFrames: single frame with one data line', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
    const frames = parseSseFrames(sse);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].event, 'message');
    assert.equal(frames[0].data, '{"choices":[{"delta":{"content":"hi"}}]}');
});

test('parseSseFrames: multi-frame with [DONE] sentinel', () => {
    const sse = [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"Hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"!"}}],"finish_reason":"stop"}',
        '',
        'data: [DONE]',
        '',
    ].join('\n');
    const frames = parseSseFrames(sse);
    assert.equal(frames.length, 4);
    assert.equal(frames[3].data, '[DONE]');
});

test('parseSseFrames: event: line before data: line', () => {
    const sse = [
        'event: completion',
        'data: {"id":"x"}',
        '',
    ].join('\n');
    const frames = parseSseFrames(sse);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].event, 'completion');
    assert.equal(frames[0].data, '{"id":"x"}');
});

test('parseSseFrames: multiline data (joined with newline)', () => {
    const sse = [
        'data: {"choices":[{"delta":{',
        'data: "content":"hi"',
        'data: }}]}',
        '',
    ].join('\n');
    const frames = parseSseFrames(sse);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data, '{"choices":[{"delta":{\n"content":"hi"\n}}]}');
});

test('parseSseFrames: empty input → no frames', () => {
    assert.deepEqual(parseSseFrames(''), []);
});

test('parseSseFrames: CR LF line endings (\\r\\n)', () => {
    const sse = 'data: {"a":1}\r\n\r\n';
    const frames = parseSseFrames(sse);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data, '{"a":1}');
});

test('parseSseFrames: comment lines (":...") are ignored', () => {
    const sse = [
        ': this is a comment',
        'data: {"x":1}',
        '',
    ].join('\n');
    const frames = parseSseFrames(sse);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data, '{"x":1}');
});

test('parseSseFrames: trailing frame with no trailing blank line is captured', () => {
    const sse = 'data: {"x":1}\n\ndata: {"y":2}';
    const frames = parseSseFrames(sse);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].data, '{"x":1}');
    assert.equal(frames[1].data, '{"y":2}');
});
