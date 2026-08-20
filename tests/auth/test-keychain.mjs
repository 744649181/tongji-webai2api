import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockKeyring, __resetKeyringMock, __setKeyringFail } from './helpers/mockKeyring.mjs';

const { getMasterKey, setMasterKey, deleteMasterKey, isAvailable, _resetForTests, _setKeyringForTests } =
    await import('../../src/backend/auth/keychain.mjs');

function setupMock() {
    __resetKeyringMock();
    _resetForTests();
    _setKeyringForTests(mockKeyring());
}

test('keychain: isAvailable returns true when keychain reachable', async () => {
    setupMock();
    assert.equal(await isAvailable(), true);
});

test('keychain: getMasterKey returns null when no key stored', async () => {
    setupMock();
    assert.equal(await getMasterKey(), null);
});

test('keychain: setMasterKey then getMasterKey round-trips', async () => {
    setupMock();
    const key = Buffer.alloc(32, 7);
    await setMasterKey(key);
    const got = await getMasterKey();
    assert.ok(got instanceof Buffer, 'returned Buffer');
    assert.equal(got.length, 32);
    assert.ok(got.equals(key), 'round-trip bytes match');
});

test('keychain: setMasterKey accepts hex string too', async () => {
    setupMock();
    const hex = 'aa'.repeat(32);
    await setMasterKey(hex);
    const got = await getMasterKey();
    assert.equal(got.toString('hex'), hex);
});

test('keychain: deleteMasterKey clears the entry', async () => {
    setupMock();
    await setMasterKey(Buffer.alloc(32, 1));
    await deleteMasterKey();
    assert.equal(await getMasterKey(), null);
});

test('keychain: file fallback when PlatformFailure', async () => {
    setupMock();
    __setKeyringFail(true);
    await setMasterKey(Buffer.alloc(32, 9), { allowFileFallback: true });
    __setKeyringFail(false);
    _resetForTests();
    _setKeyringForTests(mockKeyring());
    __setKeyringFail(true);
    const got = await getMasterKey({ allowFileFallback: true });
    assert.ok(got && got.length === 32, 'file fallback returned the key');
});

test('keychain: file fallback refuses when allowFileFallback not set', async () => {
    setupMock();
    __setKeyringFail(true);
    await assert.rejects(getMasterKey(), /KeychainUnavailable|PlatformFailure/);
});