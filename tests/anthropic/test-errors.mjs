import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockRes } from './helpers/mockRes.js';
import { sendApiError, anthropicErrorBody } from '../../src/server/api/anthropic/errors.js';

test('anthropicErrorBody: standard shape', () => {
    const body = anthropicErrorBody({
        type: 'authentication_error',
        message: 'invalid x-api-key',
        requestId: 'req_abc123',
    });
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
    assert.equal(body.error.message, 'invalid x-api-key');
    assert.equal(body.error.request_id, 'req_abc123');
});

test('sendApiError: non-streaming JSON response', () => {
    const res = createMockRes();
    sendApiError(res, {
        status: 401,
        type: 'authentication_error',
        message: 'bad key',
        requestId: 'req_xyz',
        isStreaming: false,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['Content-Type'], 'application/json');
    const body = JSON.parse(res.body);
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
});

test('sendApiError: streaming sends error event then closes', () => {
    const res = createMockRes();
    sendApiError(res, {
        status: 503,
        type: 'overloaded_error',
        message: 'queue full',
        requestId: 'req_stream',
        isStreaming: true,
    });
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /^event: error\ndata: /);
    assert.match(res.body, /"type":"overloaded_error"/);
});