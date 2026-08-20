/**
 * Test helper: in-memory mock for @napi-rs/keyring.
 * Set platform failure via `globalThis.__MOCK_KEYRING_FAIL__ = true` before
 * importing keychain.mjs.
 */

const store = new Map();
let failNext = false;

export function __resetKeyringMock() {
    store.clear();
    failNext = false;
    delete globalThis.__MOCK_KEYRING_FAIL__;
    delete globalThis.__MOCK_KEYRING_RETURN_NULL__;
}

export function __setKeyringFail(v) {
    globalThis.__MOCK_KEYRING_FAIL__ = !!v;
}

export function __setKeyringReturnNull(v) {
    globalThis.__MOCK_KEYRING_RETURN_NULL__ = !!v;
}

export class MockEntry {
    constructor(service, account) {
        this.service = service;
        this.account = account;
        this._key = `${service}::${account}`;
    }
    setPassword(value) {
        if (globalThis.__MOCK_KEYRING_FAIL__) {
            failNext = false;
            throw new Error('PlatformFailure (mock): keychain unavailable');
        }
        store.set(this._key, String(value));
    }
    getPassword() {
        if (globalThis.__MOCK_KEYRING_FAIL__) {
            failNext = false;
            throw new Error('PlatformFailure (mock): keychain unavailable');
        }
        if (globalThis.__MOCK_KEYRING_RETURN_NULL__) {
            return null;
        }
        const v = store.get(this._key);
        if (v === undefined) throw new Error('No entry found in secure storage');
        return v;
    }
    deletePassword() {
        store.delete(this._key);
    }
}

export function mockKeyring() {
    return {
        Entry: MockEntry,
        backend: 'mock',
    };
}