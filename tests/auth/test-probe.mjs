import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { probe } = await import('../../src/backend/auth/probe.mjs');

function makeDir() {
    return mkdtempSync(path.join(tmpdir(), 'probe-test-'));
}

function touch(p, ageDays) {
    writeFileSync(p, '{}');
    const atime = new Date(Date.now() - ageDays * 86400 * 1000);
    const mtime = atime;
    utimesSync(p, atime, mtime);
}

test('probe: missing file -> INVALID', async () => {
    const dir = makeDir();
    try {
        const r = await probe({ ssoFilePath: path.join(dir, 'no-such.json') });
        assert.equal(r.valid, false);
        assert.equal(r.reason, 'NO_FILE');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('probe: fresh file (< 30d) without active check -> VALID_MTIME', async () => {
    const dir = makeDir();
    const p = path.join(dir, 'sso.json');
    try {
        touch(p, 5);
        const r = await probe({ ssoFilePath: p });
        assert.equal(r.valid, true);
        assert.equal(r.reason, 'VALID_MTIME');
        assert.equal(r.source, 'mtime');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('probe: stale file (> 30d) without active check -> STALE', async () => {
    const dir = makeDir();
    const p = path.join(dir, 'sso.json');
    try {
        touch(p, 35);
        const r = await probe({ ssoFilePath: p });
        assert.equal(r.valid, false);
        assert.equal(r.reason, 'STALE_MTIME');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('probe: fresh file but active check 401 -> INVALID', async () => {
    const dir = makeDir();
    const p = path.join(dir, 'sso.json');
    try {
        touch(p, 5);
        const r = await probe({
            ssoFilePath: p,
            activeCheck: async () => ({ ok: false, status: 401 }),
        });
        assert.equal(r.valid, false);
        assert.equal(r.reason, 'PROBE_401');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('probe: stale file but active check 200 -> VALID_ACTIVE', async () => {
    const dir = makeDir();
    const p = path.join(dir, 'sso.json');
    try {
        touch(p, 35);
        const r = await probe({
            ssoFilePath: p,
            activeCheck: async () => ({ ok: true }),
        });
        assert.equal(r.valid, true);
        assert.equal(r.reason, 'VALID_ACTIVE');
        assert.equal(r.source, 'active');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('probe: stale file and active check network error -> INVALID', async () => {
    const dir = makeDir();
    const p = path.join(dir, 'sso.json');
    try {
        touch(p, 35);
        const r = await probe({
            ssoFilePath: p,
            activeCheck: async () => ({ ok: false, error: 'ECONNREFUSED' }),
        });
        assert.equal(r.valid, false);
        assert.equal(r.reason, 'NETWORK_ERROR');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});