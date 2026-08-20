/**
 * @fileoverview OS keychain abstraction for SSO master key storage.
 *
 * Primary: @napi-rs/keyring (DPAPI / Keychain / libsecret).
 * Fallback: encrypted file at data/.master.key with chmod 600 when keychain
 * reports PlatformFailure (e.g., headless Linux without dbus).
 *
 * NOTE: import('@napi-rs/keyring') is dynamic so the module can be replaced
 * at test time.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SERVICE = 'tongji-webai2api';
const ACCOUNT = 'sso-master-key';
const FALLBACK_PATH = path.join(process.cwd(), 'data', '.master.key');

let _module = null;
let _injected = null;
async function loadModule() {
    if (_injected) return _injected;
    if (!_module) {
        _module = await import('@napi-rs/keyring');
    }
    return _module;
}

function normalize(key) {
    if (key instanceof Buffer) return `b64:${key.toString('base64')}`;
    const s = String(key);
    if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return `hex:${s}`;
    return s;
}

function parseRaw(raw) {
    if (raw.startsWith('hex:')) return Buffer.from(raw.slice(4), 'hex');
    if (raw.startsWith('b64:')) return Buffer.from(raw.slice(4), 'base64');
    if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, 'hex');
    return Buffer.from(raw, 'base64');
}

export class KeychainUnavailable extends Error {
    constructor(cause) {
        super(`OS keychain unavailable: ${cause?.message || cause}`);
        this.cause = cause;
        this.name = 'KeychainUnavailable';
    }
}

/**
 * Read master key from OS keychain.
 * @param {{allowFileFallback?: boolean}} [opts]
 * @returns {Promise<Buffer|null>} 32-byte key, or null if not stored.
 * @throws {KeychainUnavailable} when keychain unreachable and no file fallback allowed.
 */
export async function getMasterKey(opts = {}) {
    const mod = await loadModule();
    const entry = new mod.Entry(SERVICE, ACCOUNT);
    let raw;
    try {
        raw = entry.getPassword();
    } catch (err) {
        if (err?.message?.includes('No entry')) return null;
        if (opts.allowFileFallback) {
            return await readFallback();
        }
        throw new KeychainUnavailable(err);
    }
    return parseRaw(raw);
}

/**
 * Write master key to OS keychain (and optionally to file fallback).
 * @param {Buffer|string} key - 32-byte key OR hex string OR base64 string.
 * @param {{allowFileFallback?: boolean}} [opts]
 */
export async function setMasterKey(key, opts = {}) {
    const mod = await loadModule();
    const entry = new mod.Entry(SERVICE, ACCOUNT);
    const normalized = normalize(key);
    try {
        entry.setPassword(normalized);
    } catch (err) {
        if (opts.allowFileFallback) {
            await writeFallback(Buffer.from(normalized, 'utf8'));
            return;
        }
        throw new KeychainUnavailable(err);
    }
    if (opts.allowFileFallback) {
        await writeFallback(Buffer.from(normalized, 'utf8'));
    }
}

/**
 * Remove master key from OS keychain (and fallback file if present).
 */
export async function deleteMasterKey() {
    const mod = await loadModule();
    const entry = new mod.Entry(SERVICE, ACCOUNT);
    try {
        entry.deletePassword();
    } catch { /* absent is fine */ }
    try {
        await fs.unlink(FALLBACK_PATH);
    } catch { /* absent is fine */ }
}

/**
 * Lightweight reachability probe. Does NOT store or read keys.
 * @returns {Promise<boolean>}
 */
export async function isAvailable() {
    try {
        const mod = await loadModule();
        const entry = new mod.Entry(SERVICE, `${ACCOUNT}.probe`);
        try {
            entry.getPassword();
        } catch (err) {
            if (err?.message?.includes('No entry')) return true;
        }
        return true;
    } catch {
        return false;
    }
}

async function readFallback() {
    try {
        const raw = await fs.readFile(FALLBACK_PATH, 'utf8');
        return parseRaw(raw);
    } catch {
        return null;
    }
}

async function writeFallback(buf) {
    await fs.mkdir(path.dirname(FALLBACK_PATH), { recursive: true });
    await fs.writeFile(FALLBACK_PATH, buf, { mode: 0o600 });
    if (os.platform() !== 'win32') {
        try { await fs.chmod(FALLBACK_PATH, 0o600); } catch { /* ignore */ }
    }
}

/**
 * Test-only: inject a keyring module (e.g., a mock). Pass `null` to clear.
 * Not part of the public API.
 */
export function _setKeyringForTests(mod) {
    _injected = mod;
    _module = null;
}

/**
 * Test-only: clear cached keyring module so next call re-imports.
 * Not part of the public API.
 */
export function _resetForTests() {
    _module = null;
}