import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const { captureFromBrowser } = await import('../../src/backend/auth/sso.mjs');

/**
 * Regression test for the Tongji-cookie-name bug:
 *
 *   Old captureFromBrowser filtered cookies by name regex
 *   /^(x-csrf-token|csrf-token|session|sess|sid|jwt|access_token|user_id|uid)$/i,
 *   which excluded every real Tongji hiagent cookie (tenant, x, I18nextLngHiagent).
 *   .sso.enc ended up empty, the watchdog had nothing to re-inject, and the
 *   smart-login feature was effectively a no-op.
 *
 * These tests seed a fake cookies.sqlite with the actual cookie set
 * observed on a real SSO login and assert captureFromBrowser returns them.
 */

function makeFakeCookieDb(cookies) {
    const tmp = path.join(os.tmpdir(), `cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(tmp);
    db.exec(`
        CREATE TABLE moz_cookies (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            value TEXT NOT NULL,
            host TEXT NOT NULL,
            path TEXT NOT NULL,
            expiry INTEGER,
            isSecure INTEGER,
            isHttpOnly INTEGER
        )
    `);
    const insert = db.prepare(
        'INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const c of cookies) {
        insert.run(c.name, c.value, c.host, c.path, c.expiry ?? 0, c.isSecure ?? 0, c.isHttpOnly ?? 0);
    }
    db.close();
    return tmp;
}

// Cookie set observed after a real Tongji hiagent SSO completion on Windows.
// None of these names match the old regex, so the old captureFromBrowser
// dropped ALL of them.
const REAL_TONGJI_COOKIES = [
    { name: 'I18nextLngHiagent', value: 'zh', host: 'agent.tongji.edu.cn', path: '/' },
    { name: 'tenant', value: 'a'.repeat(82), host: 'agent.tongji.edu.cn', path: '/' },
    { name: 'x', value: '1', host: 'iam.tongji.edu.cn', path: '/' },
];

test('captureFromBrowser: captures all Tongji/hiagent cookies (not just regex-matched names)', async () => {
    const cookiePath = makeFakeCookieDb(REAL_TONGJI_COOKIES);
    try {
        const payload = await captureFromBrowser(cookiePath);
        assert.equal(payload.sessionCookies.length, 3, 'all 3 cookies should be captured');
        const names = payload.sessionCookies.map((c) => c.name).sort();
        assert.deepEqual(names, ['I18nextLngHiagent', 'tenant', 'x']);
    } finally {
        fs.unlinkSync(cookiePath);
    }
});

test('captureFromBrowser: derives userIdentifier from `tenant` cookie when no csrf-token present', async () => {
    const cookiePath = makeFakeCookieDb(REAL_TONGJI_COOKIES);
    try {
        const payload = await captureFromBrowser(cookiePath);
        assert.match(payload.userIdentifier, /^sha256:[0-9a-f]{16}$/);
        // userIdentifier must be stable: calling again with the same cookies yields the same hash.
        const again = await captureFromBrowser(cookiePath);
        assert.equal(again.userIdentifier, payload.userIdentifier, 'userIdentifier is stable across captures');
    } finally {
        fs.unlinkSync(cookiePath);
    }
});

test('captureFromBrowser: empty cookies.sqlite throws "SSO incomplete"', async () => {
    const cookiePath = makeFakeCookieDb([
        // Only cookies on non-tongji hosts -- should NOT be captured.
        { name: 'session', value: 'abc', host: 'example.com', path: '/' },
        { name: 'jwt', value: 'def', host: 'google.com', path: '/' },
    ]);
    try {
        await assert.rejects(captureFromBrowser(cookiePath), /SSO incomplete/);
    } finally {
        fs.unlinkSync(cookiePath);
    }
});

test('captureFromBrowser: preserves host as leading-dot domain', async () => {
    const cookiePath = makeFakeCookieDb([
        { name: 'tenant', value: 't', host: 'agent.tongji.edu.cn', path: '/' },
    ]);
    try {
        const payload = await captureFromBrowser(cookiePath);
        assert.equal(payload.sessionCookies[0].domain, '.agent.tongji.edu.cn');
    } finally {
        fs.unlinkSync(cookiePath);
    }
});