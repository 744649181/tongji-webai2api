import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSSO, decryptSSO, buildInjectPayload, MasterKeyUnavailable } from '../../src/backend/auth/sso.mjs';

const SAMPLE = {
    sessionCookies: [
        { name: 'x-csrf-token', value: 'abc123', domain: '.tongji.edu.cn', path: '/' },
        { name: 'session', value: 'xyz789', domain: '.tongji.edu.cn', path: '/' },
    ],
    userIdentifier: 'sha256:deadbeef12345678',
    capturedAt: '2026-08-20T11:00:00Z',
};

test('sso: encrypt + decrypt round-trip preserves payload', async () => {
    const key = Buffer.alloc(32, 1);
    const blob = await encryptSSO(SAMPLE, key);
    assert.equal(blob.version, 1);
    assert.ok(blob.iv && blob.iv.length > 0);
    assert.ok(blob.ct && blob.ct.length > 0);
    assert.ok(blob.tag && blob.tag.length > 0);
    const decrypted = await decryptSSO(blob, key);
    assert.deepEqual(decrypted, SAMPLE);
});

test('sso: decrypt fails with wrong key (auth tag mismatch)', async () => {
    const key = Buffer.alloc(32, 1);
    const wrong = Buffer.alloc(32, 2);
    const blob = await encryptSSO(SAMPLE, key);
    await assert.rejects(decryptSSO(blob, wrong), /tag|auth/i);
});

test('sso: decrypt fails when blob tampered', async () => {
    const key = Buffer.alloc(32, 1);
    const blob = await encryptSSO(SAMPLE, key);
    const tampered = { ...blob, ct: Buffer.from('x'.repeat(blob.ct.length)) };
    await assert.rejects(decryptSSO(tampered, key), /tag|auth/i);
});

test('sso: encrypt uses fresh IV each call', async () => {
    const key = Buffer.alloc(32, 1);
    const blob1 = await encryptSSO(SAMPLE, key);
    const blob2 = await encryptSSO(SAMPLE, key);
    assert.notDeepEqual(blob1.iv, blob2.iv, 'IVs differ between calls');
});

test('sso: buildInjectPayload produces Playwright-shaped cookies', () => {
    const payload = buildInjectPayload(SAMPLE.sessionCookies);
    assert.ok(Array.isArray(payload));
    assert.equal(payload.length, 2);
    for (const c of payload) {
        assert.ok(typeof c.name === 'string');
        assert.ok(typeof c.value === 'string');
        assert.ok(typeof c.domain === 'string');
        assert.ok(typeof c.path === 'string');
    }
});

test('sso: MasterKeyUnavailable thrown when decryptSSO called with null key', async () => {
    const key = Buffer.alloc(32, 1);
    const blob = await encryptSSO(SAMPLE, key);
    await assert.rejects(decryptSSO(blob, null), (err) => err instanceof MasterKeyUnavailable);
});