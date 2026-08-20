import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNotify } from './helpers/mockNotify.mjs';
import { encryptSSO } from '../../src/backend/auth/sso.mjs';

const { handle401, _resetForTests } = await import('../../src/backend/auth/watchdog.js');

const MASTER_KEY = Buffer.alloc(32, 1);
const PAYLOAD = {
    sessionCookies: [{ name: 'x-csrf-token', value: 'abc', domain: '.tongji.edu.cn', path: '/' }],
};
const ENCRYPTED = await encryptSSO(PAYLOAD, MASTER_KEY);

function makeWorker({ contextAddCookies = true } = {}) {
    const calls = { addCookies: 0 };
    return {
        name: 'tongji',
        context: contextAddCookies
            ? { async addCookies(c) { calls.addCookies++; } }
            : null,
        page: { async evaluate(fn, args) { return null; } },
        _calls: calls,
    };
}

function makeLogger() {
    return {
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    };
}

function makeDeps({ ssoBlob = ENCRYPTED, refreshOk = null } = {}) {
    return {
        ssoFilePath: '/virtual/data/.sso.enc',
        masterKey: MASTER_KEY,
        ssoBlob,
        notify: createMockNotify(),
        doRefreshSession: async () => refreshOk === null ? { ok: false, status: 404 } : { ok: refreshOk },
    };
}

test('watchdog: Try 1 succeeds when addCookies re-injects valid cookies', async () => {
    _resetForTests();
    const worker = makeWorker();
    const deps = makeDeps();
    const result = await handle401({
        worker,
        logger: makeLogger(),
        deps,
        originalRequest: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(result.ok, true);
    assert.equal(worker._calls.addCookies, 1, 'addCookies called once');
});

test('watchdog: Try 1 fails (addCookies throws) -> Try 2 succeeds', async () => {
    _resetForTests();
    const worker = makeWorker();
    worker.context.addCookies = async () => { throw new Error('cookie schema invalid'); };
    const deps = makeDeps({ refreshOk: true });
    const result = await handle401({
        worker,
        logger: makeLogger(),
        deps,
        originalRequest: async () => ({ ok: true }),
    });
    assert.equal(result.ok, true);
});

test('watchdog: Try 1 fails + Try 2 fails + Try 3 succeeds', async () => {
    _resetForTests();
    const worker = makeWorker();
    worker.context.addCookies = async () => { throw new Error('cookie schema invalid'); };
    const deps = makeDeps({ refreshOk: false });
    deps.notify.launchBrowserLogin = async () => {
        deps.notify.calls.push({ kind: 'launch_browser_login' });
        return { ok: true };
    };
    const result = await handle401({
        worker,
        logger: makeLogger(),
        deps,
        originalRequest: async () => ({ ok: true }),
    });
    assert.equal(result.ok, true);
    assert.ok(deps.notify.calls.find((c) => c.kind === 'launch_browser_login'), 'launchBrowserLogin invoked');
});

test('watchdog: all tries fail -> 503 + notify', async () => {
    _resetForTests();
    const worker = makeWorker();
    worker.context.addCookies = async () => { throw new Error('cookie schema invalid'); };
    const deps = makeDeps({ refreshOk: false });
    deps.notify.launchBrowserLogin = async () => ({ ok: false, reason: 'user_did_not_complete' });
    const result = await handle401({
        worker,
        logger: makeLogger(),
        deps,
        originalRequest: async () => ({ ok: false, status: 401 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.ok(deps.notify.calls.find((c) => c.kind === 'desktop'), 'desktop notification fired');
});

test('watchdog: missing ssoBlob -> Try 3 immediately', async () => {
    _resetForTests();
    const worker = makeWorker();
    const deps = makeDeps({ ssoBlob: null });
    deps.notify.launchBrowserLogin = async () => ({ ok: true });
    const result = await handle401({
        worker,
        logger: makeLogger(),
        deps,
        originalRequest: async () => ({ ok: true }),
    });
    assert.equal(result.ok, true);
});

test('watchdog: concurrent 401 for same worker are serialized', async () => {
    _resetForTests();
    const worker = makeWorker();
    const deps = makeDeps();
    let inflight = 0;
    let maxInflight = 0;
    deps.originalRequest = async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        return { ok: true };
    };
    const fn = handle401;
    const results = await Promise.all([
        fn({ worker, logger: makeLogger(), deps, originalRequest: deps.originalRequest }),
        fn({ worker, logger: makeLogger(), deps, originalRequest: deps.originalRequest }),
    ]);
    assert.ok(maxInflight <= 1, `concurrent in-flight <= 1, got ${maxInflight}`);
    assert.equal(results.filter((r) => r.ok).length, 2);
});