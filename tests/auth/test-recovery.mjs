import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mockKeyring, __resetKeyringMock } from './helpers/mockKeyring.mjs';

const { tryWatchdogRecovery, is401Result } = await import('../../src/backend/auth/recovery.mjs');
const { encryptSSO } = await import('../../src/backend/auth/sso.mjs');

function makeWorker({ contextOk = true, pageOk = true } = {}) {
    const calls = { addCookies: 0 };
    return {
        name: 'tongji',
        browser: contextOk ? { async addCookies(c) { calls.addCookies++; } } : null,
        page: pageOk ? { async evaluate() { return null; } } : null,
        _calls: calls,
    };
}

function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

async function withCwd(dir, fn) {
    const orig = process.cwd();
    process.chdir(dir);
    try { return await fn(); } finally {
        process.chdir(orig);
        rmSync(dir, { recursive: true, force: true });
    }
}

async function withKeyringMock(masterKey, fn) {
    const keychain = await import('../../src/backend/auth/keychain.mjs');
    __resetKeyringMock();
    keychain._resetForTests();
    keychain._setKeyringForTests(mockKeyring());
    try {
        await keychain.setMasterKey(masterKey, { allowFileFallback: true });
        return await fn(keychain);
    } finally {
        __resetKeyringMock();
        keychain._resetForTests();
        keychain._setKeyringForTests(null);
    }
}

test('is401Result: matches 401 in error string', () => {
    assert.equal(is401Result({ error: 'request failed: 401' }), true);
    assert.equal(is401Result({ error: 'unauthorized access' }), true);
    assert.equal(is401Result({ error: 'session expired' }), true);
    assert.equal(is401Result({ error: 'session_expired' }), true);
});

test('is401Result: rejects non-401 errors', () => {
    assert.equal(is401Result({ error: 'timeout' }), false);
    assert.equal(is401Result({ error: '' }), false);
    assert.equal(is401Result(null), false);
    assert.equal(is401Result({}), false);
    assert.equal(is401Result({ error: 42 }), false);
});

test('tryWatchdogRecovery: missing sso.enc -> no Try 1, Try 3 disabled -> 503', async () => {
    await withCwd(mkdtempSync(path.join(tmpdir(), 'rec-test-')), async () => {
        const result = await tryWatchdogRecovery({
            worker: makeWorker(),
            logger: silentLogger(),
            originalRequest: async () => ({ ok: true }),
        });
        assert.equal(result.ok, false);
    });
});

test('tryWatchdogRecovery: with valid encrypted blob -> Try 1 silent re-inject + retry succeeds', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rec-test-'));
    const masterKey = Buffer.alloc(32, 11);
    const payload = {
        sessionCookies: [{ name: 'x-csrf-token', value: 'fresh', domain: '.tongji.edu.cn', path: '/' }],
        userIdentifier: 'sha256:0123456789abcdef',
        capturedAt: new Date().toISOString(),
    };
    const blob = await encryptSSO(payload, masterKey);
    mkdirSync(path.join(dir, 'data'), { recursive: true });
    writeFileSync(path.join(dir, 'data', '.sso.enc'), JSON.stringify(blob, null, 2));

    await withCwd(dir, async () => {
        await withKeyringMock(masterKey, async () => {
            const worker = makeWorker();
            // The watchdog calls originalRequest ONCE inside Try 1 (the post-inject
            // retry). The pre-watchdog 401 happened in PoolManager before this
            // helper was invoked. So first call here = "retry after re-inject".
            const originalRequest = async () => ({ ok: true, status: 200 });
            const result = await tryWatchdogRecovery({
                worker,
                logger: silentLogger(),
                originalRequest,
            });
            assert.equal(result.ok, true, 'Try 1 succeeded');
            assert.equal(worker._calls.addCookies, 1, 'addCookies called once');
        });
    });
    rmSync(dir, { recursive: true, force: true });
});

test('tryWatchdogRecovery: Try 1 addCookies failure -> Try 2 + Try 3 fall through -> 503', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rec-test-'));
    const masterKey = Buffer.alloc(32, 12);
    const payload = {
        sessionCookies: [{ name: 'x-csrf-token', value: 'x', domain: '.tongji.edu.cn', path: '/' }],
    };
    const blob = await encryptSSO(payload, masterKey);
    mkdirSync(path.join(dir, 'data'), { recursive: true });
    writeFileSync(path.join(dir, 'data', '.sso.enc'), JSON.stringify(blob, null, 2));

    await withCwd(dir, async () => {
        await withKeyringMock(masterKey, async () => {
            const worker = makeWorker();
            worker.browser.addCookies = async () => { throw new Error('cookie schema invalid'); };
            const originalRequest = async () => ({ ok: false, status: 401 });
            const result = await tryWatchdogRecovery({
                worker,
                logger: silentLogger(),
                originalRequest,
            });
            assert.equal(result.ok, false);
            assert.equal(result.status, 503);
        });
    });
    rmSync(dir, { recursive: true, force: true });
});