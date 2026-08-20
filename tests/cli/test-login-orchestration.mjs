import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runLoginOrchestration } = await import('../../scripts/cli/login.mjs');

function fakeDeps(overrides = {}) {
    const calls = [];
    const base = {
        ensureMasterKey: async () => Buffer.alloc(32, 1),
        spawnLoginServer: () => { calls.push('spawn'); return { exitCode: null, killed: false, kill() { calls.push('kill'); }, on() {} }; },
        waitForLoginCompletion: async () => { calls.push('wait'); },
        killServer: async () => { calls.push('kill'); },
        captureFromBrowser: async () => ({
            sessionCookies: [{ name: 'x-csrf-token', value: 'abc', host: '.tongji.edu.cn', path: '/' }],
            userIdentifier: 'sha256:abc',
            capturedAt: '2026-08-20T00:00:00Z',
        }),
        encryptSSO: async () => ({ version: 1, iv: 'a', ct: 'b', tag: 'c', userHash: 'sha256:abc' }),
        saveBlob: async () => { calls.push('save'); },
        encryptOnly: true,
        cookiePath: '/fake/cookies.sqlite',
        ssoPath: '/fake/.sso.enc',
        log: () => {},
    };
    return { calls, deps: { ...base, ...overrides } };
}

test('login orchestration: spawns server BEFORE waiting when cookies are missing', async () => {
    // Regression test for the inverted-flow bug: previously main() called
    // waitForLoginCompletion() before spawnLoginServer(), which made the
    // first-time user sit for 5 minutes with no browser open.
    const { calls, deps } = fakeDeps({ cookieExists: false });
    await runLoginOrchestration(deps);
    assert.deepEqual(
        calls,
        ['spawn', 'wait', 'save', 'kill'],
        'spawn -> wait -> save -> kill when cookies.sqlite is missing',
    );
});

test('login orchestration: skips spawn and wait when cookies already exist (idempotent)', async () => {
    const { calls, deps } = fakeDeps({ cookieExists: true });
    await runLoginOrchestration(deps);
    assert.deepEqual(
        calls,
        ['save'],
        'cookieExists=true should skip spawn/wait/kill; only save runs',
    );
});

test('login orchestration: ensureMasterKey is the first step in both modes', async () => {
    const order = [];
    const deps = fakeDeps({
        cookieExists: false,
        ensureMasterKey: async () => { order.push('key'); return Buffer.alloc(32, 1); },
        spawnLoginServer: () => { order.push('spawn'); return { exitCode: null, kill() { order.push('kill'); }, on() {} }; },
        waitForLoginCompletion: async () => { order.push('wait'); },
        killServer: async () => { order.push('kill'); },
        saveBlob: async () => { order.push('save'); },
    }).deps;
    await runLoginOrchestration(deps);
    assert.deepEqual(order, ['key', 'spawn', 'wait', 'save', 'kill']);
});

test('login orchestration: killServer runs even if captureFromBrowser throws', async () => {
    // Regression test: the server must be killed in finally so it doesn't
    // linger on port 3000. If capture throws, we should still clean up.
    const calls = [];
    const deps = fakeDeps({
        cookieExists: false,
        spawnLoginServer: () => { calls.push('spawn'); return { exitCode: null, kill() { calls.push('kill'); }, on() {} }; },
        waitForLoginCompletion: async () => { calls.push('wait'); },
        killServer: async () => { calls.push('kill'); },
        captureFromBrowser: async () => { throw new Error('no session cookies captured; SSO incomplete'); },
    }).deps;
    await assert.rejects(runLoginOrchestration(deps), /SSO incomplete/);
    assert.deepEqual(calls, ['spawn', 'wait', 'kill'], 'kill must run in finally even when capture throws');
});