import { test } from 'node:test';
import assert from 'node:assert/strict';

const { handle401, _resetForTests } = await import('../../src/backend/auth/watchdog.js');
const { encryptSSO } = await import('../../src/backend/auth/sso.mjs');
const { createMockNotify } = await import('./helpers/mockNotify.mjs');

test('integration: mock hiagent returns 401 once, then 200 after re-inject', async () => {
    _resetForTests();
    const masterKey = Buffer.alloc(32, 9);
    const payload = {
        sessionCookies: [{ name: 'x-csrf-token', value: 'fresh', domain: '.tongji.edu.cn', path: '/' }],
        userIdentifier: 'sha256:0123456789abcdef',
        capturedAt: new Date().toISOString(),
    };
    const blob = await encryptSSO(payload, masterKey);

    let callCount = 0;
    const worker = {
        name: 'tongji',
        context: {
            async addCookies() {
                // simulate Playwright's success
            },
        },
        page: {},
    };
    const originalRequest = async () => {
        callCount++;
        return callCount <= 1 ? { ok: false, status: 401 } : { ok: true, status: 200 };
    };

    const deps = {
        ssoFilePath: '/virtual/.sso.enc',
        masterKey,
        ssoBlob: blob,
        notify: createMockNotify(),
        doRefreshSession: async () => ({ ok: false, status: 404 }),
    };

    const result = await handle401({ worker, originalRequest, logger: null, deps });
    assert.equal(result.ok, true);
    assert.ok(callCount >= 1, 'originalRequest was invoked');
});