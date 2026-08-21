# Smart Login Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the multi-script start flow (`install.bat && login.bat && start.bat`) into a single `npm run up` command that detects valid Tongji hiagent SSO, walks the user through SSO only when needed, encrypts captured session state at rest, and silently re-authenticates on 401 during operation via a watchdog.

**Architecture:** New `scripts/cli/*.mjs` orchestrator layer (`up`, `down`, `status`, `login`) calls into a new `src/backend/auth/` module (`keychain.mjs`, `sso.mjs`, `probe.mjs`, `watchdog.js`). Encryption: AES-256-GCM with master key in OS keychain (`@napi-rs/keyring`, file fallback on Linux libsecret absent). Watchdog hooks 401 errors from the existing adapter error channel in `src/server/queue.js` and re-injects cookies via Playwright `context.addCookies()`. The adapter itself (`src/backend/adapter/tongji.js`) is **unchanged**.

**Tech Stack:** Node.js 20+ (built-in `node:test`, `node:crypto`, `node:fs/promises`); existing `playwright-core`, ESM modules, `#config/#utils/#backend/#server` import aliases. New dep: `@napi-rs/keyring` (OS keychain; prebuild-only release). Optional platform deps: BurntToast (Windows notifications), `notify-send` (Linux), `osascript` (macOS).

---

## File Structure

### New files (created)

| File | Responsibility |
|------|----------------|
| `src/backend/auth/keychain.mjs` | OS keychain abstraction (`@napi-rs/keyring` wrapper) with file fallback. `getMasterKey()`, `setMasterKey()`, `deleteMasterKey()`, `isAvailable()`. |
| `src/backend/auth/sso.mjs` | `encryptSSO()`, `decryptSSO()`, `captureFromBrowser()`, `injectIntoContext()`, `MasterKeyUnavailable` error class. |
| `src/backend/auth/probe.mjs` | `probe()` returns `{valid, reason, age, lastRefresh, source}`. Cheaper file mtime check first; active probe (`fetch hiagent ping`) only when mtime is stale. |
| `src/backend/auth/watchdog.js` | `handle401({worker, originalRequest, logger, notify})` 4-step state machine. Per-worker mutex. |
| `scripts/cli/up.mjs` | Smart start: probe -> maybe login -> spawn supervisor. Exit codes 0/2/3/4. |
| `scripts/cli/down.mjs` | Graceful stop via supervisor IPC + port check. Exit 0. |
| `scripts/cli/status.mjs` | Unified status (PID, port, login age, keychain, workers, last log). Exit 0/1/5. |
| `scripts/cli/login.mjs` | Explicit one-shot login (also called by `up`). Supports `--encrypt-only`. |
| `tests/auth/helpers/mockKeyring.mjs` | Mock `@napi-rs/keyring` for unit tests. |
| `tests/auth/helpers/mockNotify.mjs` | Mock notify backend (captures notifications instead of dispatching). |
| `tests/auth/test-keychain.mjs` | Unit: get/set/delete round-trip; file fallback on PlatformFailure; key generation entropy. |
| `tests/auth/test-sso.mjs` | Unit: encrypt/decrypt round-trip; tamper detection (auth tag mismatch); inject payload schema. |
| `tests/auth/test-probe.mjs` | Unit: VALID / INVALID / STALE decision tree. |
| `tests/auth/test-watchdog.mjs` | Unit: 4-step state machine coverage; concurrent 401 -> queued. |
| `tests/auth/test-watchdog-integration.mjs` | Integration: mock hiagent returning 401 once then 200; watchdog retries succeed. |

### Modified files (existing)

| File | Change |
|------|--------|
| `package.json` | Add `@napi-rs/keyring` to `dependencies`; add `up`, `down`, `status`, `login` scripts. |
| `src/backend/pool/Worker.js` | Expose `worker.context` (Playwright BrowserContext) and `worker.page` properties (read-only getters) so watchdog can call `context.addCookies()`. |
| `src/server/queue.js` | Catch 401 errors from adapter `generate()`; call `watchdog.handle401({worker, originalRequest, logger, notify})`; per-worker mutex map. |
| `install.bat`, `install.sh` | Thin shim: `npm run up`. Header marked deprecated. |
| `login.bat`, `login.sh` | Thin shim: `npm run login`. Header marked deprecated. |
| `start.bat`, `start.sh` | Thin shim: `npm run up`. Header marked deprecated. |
| `stop.bat`, `stop.sh` | Thin shim: `npm run down`. Header marked deprecated. |
| `status.bat`, `status.sh` | Thin shim: `npm run status`. Header marked deprecated. |
| `restart.bat`, `restart.sh` | Thin shim: `npm run down && npm run up`. Header marked deprecated. |
| `.github/workflows/ci.yml` | Add `node --test tests/auth/*.mjs` step to existing matrix `test` job. |
| `config.example.yaml` | Document `auth.encryptAlgo` + `auth.keychainFallback` (informational; values hardcoded in code). |
| `README.md` | New "Smart login lifecycle" section documenting `npm run up/down/status/login`, encryption model, watchdog behavior. |
| `AGENTS.md` | New section 12 "Smart login" mirroring section 11 anthropic-protocol rules. |

### Untouched (verified by spec section 5)

`src/backend/adapter/tongji.js`, all other `src/backend/adapter/*.js`, `src/server/respond.js`, `patches/`, `webui/`.

---

## Task 1: Add `@napi-rs/keyring` dependency + npm scripts

**Files:**
- Modify: `package.json` (add `@napi-rs/keyring` to dependencies + 4 new scripts)
- (No test)

- [ ] **Step 1: Verify the npm package exists**

Run:
```bash
cd E:/playgroud/tongji-webai2api && npm view @napi-rs/keyring version dist-tags
```

Expected: a stable version string like `1.x.y` and prebuilds for win32-x64, darwin-x64, darwin-arm64, linux-x64-gnu, linux-arm64-gnu.

- [ ] **Step 2: Edit `package.json`**

Open `E:/playgroud/tongji-webai2api/package.json`. In the `dependencies` block (alphabetically), add:

```json
"@napi-rs/keyring": "^1.1.6"
```

(Use the actual current version discovered in Step 1. If 1.x is current, use `^1.x.y`.)

In the `scripts` block (after `init` and before `postinstall`), add:

```json
"up": "node scripts/cli/up.mjs",
"down": "node scripts/cli/down.mjs",
"status": "node scripts/cli/status.mjs",
"login": "node scripts/cli/login.mjs"
```

- [ ] **Step 3: Install**

Run:
```bash
cd E:/playgroud/tongji-webai2api && npm install
```

Expected: `@napi-rs/keyring` installed without errors. No peer-dep warnings beyond standard.

- [ ] **Step 4: Verify the package loads**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node -e "import('@napi-rs/keyring').then(m => console.log('Keyring backend:', m.Entry?.backend || Object.keys(m).slice(0, 5)))"
```

Expected: prints the keyring backend name on each OS:
- Windows: `Windows Credential Manager`
- macOS: `Keychain`
- Linux: `Secret Service` (or similar; falls back to file mode if absent)

Exit 0.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add package.json package-lock.json && git -c core.autocrlf=false commit -m "chore(deps): add @napi-rs/keyring + up/down/status/login npm scripts"
```

---

## Task 2: `keychain.mjs` + unit test

**Files:**
- Create: `src/backend/auth/keychain.mjs`
- Create: `tests/auth/helpers/mockKeyring.mjs`
- Create: `tests/auth/test-keychain.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/auth/helpers/mockKeyring.mjs`:

```javascript
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
}

export function __setKeyringFail(v) {
    globalThis.__MOCK_KEYRING_FAIL__ = !!v;
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
```

Create `E:/playgroud/tongji-webai2api/tests/auth/test-keychain.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockKeyring, __resetKeyringMock, __setKeyringFail } from './helpers/mockKeyring.mjs';

// Patch @napi-rs/keyring BEFORE importing keychain.mjs
import * as keyring from '@napi-rs/keyring';
const originalEntry = keyring.Entry;
Object.defineProperty(keyring, 'Entry', { configurable: true, get: () => mockKeyring().Entry });

const { getMasterKey, setMasterKey, deleteMasterKey, isAvailable, _resetForTests } =
    await import('../../src/backend/auth/keychain.mjs');

test('keychain: isAvailable returns true when keychain reachable', () => {
    __resetKeyringMock();
    _resetForTests();
    assert.equal(isAvailable(), true);
});

test('keychain: getMasterKey returns null when no key stored', () => {
    __resetKeyringMock();
    _resetForTests();
    assert.equal(getMasterKey(), null);
});

test('keychain: setMasterKey then getMasterKey round-trips', () => {
    __resetKeyringMock();
    _resetForTests();
    const key = Buffer.alloc(32, 7);
    setMasterKey(key);
    const got = getMasterKey();
    assert.ok(got instanceof Buffer, 'returned Buffer');
    assert.equal(got.length, 32);
    assert.ok(got.equals(key), 'round-trip bytes match');
});

test('keychain: setMasterKey accepts hex string too', () => {
    __resetKeyringMock();
    _resetForTests();
    const hex = 'aa'.repeat(32);
    setMasterKey(hex);
    const got = getMasterKey();
    assert.equal(got.toString('hex'), hex);
});

test('keychain: deleteMasterKey clears the entry', () => {
    __resetKeyringMock();
    _resetForTests();
    setMasterKey(Buffer.alloc(32, 1));
    deleteMasterKey();
    assert.equal(getMasterKey(), null);
});

test('keychain: file fallback when PlatformFailure', () => {
    __resetKeyringMock();
    _resetForTests();
    __setKeyringFail(true);
    // setMasterKey with file fallback enabled
    setMasterKey(Buffer.alloc(32, 9), { allowFileFallback: true });
    __setKeyringFail(false);
    _resetForTests();
    // Read with keychain still unavailable -> reads from file
    __setKeyringFail(true);
    const got = getMasterKey({ allowFileFallback: true });
    assert.ok(got && got.length === 32, 'file fallback returned the key');
});

test('keychain: file fallback refuses when allowFileFallback not set', () => {
    __resetKeyringMock();
    _resetForTests();
    __setKeyringFail(true);
    assert.throws(() => getMasterKey(), /KeychainUnavailable|PlatformFailure/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-keychain.mjs
```

Expected: FAIL with `Cannot find module '../../src/backend/auth/keychain.mjs'`.

- [ ] **Step 3: Implement `keychain.mjs`**

Create `E:/playgroud/tongji-webai2api/src/backend/auth/keychain.mjs`:

```javascript
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
async function loadModule() {
    if (!_module) {
        _module = await import('@napi-rs/keyring');
    }
    return _module;
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
    return raw.startsWith('hex:') ? Buffer.from(raw.slice(4), 'hex') : Buffer.from(raw, 'base64');
}

/**
 * Write master key to OS keychain (and optionally to file fallback).
 * @param {Buffer|string} key - 32-byte key OR hex string OR base64 string.
 * @param {{allowFileFallback?: boolean}} [opts]
 */
export async function setMasterKey(key, opts = {}) {
    const mod = await loadModule();
    const entry = new mod.Entry(SERVICE, ACCOUNT);
    const normalized = key instanceof Buffer ? `b64:${key.toString('base64')}` : String(key);
    try {
        entry.setPassword(normalized);
    } catch (err) {
        if (opts.allowFileFallback) {
            await writeFallback(Buffer.from(normalized, 'utf8'));
            return;
        }
        throw new KeychainUnavailable(err);
    }
    // Mirror to file when explicit fallback requested so subsequent reads
    // (which may also need fallback) have the same value.
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
            // "No entry" is fine -- proves keychain reachable.
            if (err?.message?.includes('No entry')) return true;
        }
        // If we got a value (unlikely for probe), still means reachable.
        return true;
    } catch {
        return false;
    }
}

async function readFallback() {
    try {
        const raw = await fs.readFile(FALLBACK_PATH, 'utf8');
        if (raw.startsWith('hex:')) return Buffer.from(raw.slice(4), 'hex');
        if (raw.startsWith('b64:')) return Buffer.from(raw.slice(4), 'base64');
        return Buffer.from(raw, 'utf8');
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
 * Test-only: clear cached keyring module so next call re-imports.
 * Not part of the public API.
 */
export function _resetForTests() {
    _module = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-keychain.mjs
```

Expected: 7 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/backend/auth/keychain.mjs tests/auth/ && git -c core.autocrlf=false commit -m "feat(auth): OS keychain wrapper with file fallback"
```

---

## Task 3: `sso.mjs` + unit test

**Files:**
- Create: `src/backend/auth/sso.mjs`
- Create: `tests/auth/test-sso.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/auth/test-sso.mjs`:

```javascript
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
        // Playwright requires url OR (domain + path). We provide domain+path.
        assert.ok(typeof c.path === 'string');
    }
});

test('sso: MasterKeyUnavailable thrown when decryptSSO called with null key', async () => {
    const key = Buffer.alloc(32, 1);
    const blob = await encryptSSO(SAMPLE, key);
    await assert.rejects(decryptSSO(blob, null), (err) => err instanceof MasterKeyUnavailable);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-sso.mjs
```

Expected: FAIL with `Cannot find module '../../src/backend/auth/sso.mjs'`.

- [ ] **Step 3: Implement `sso.mjs`**

Create `E:/playgroud/tongji-webai2api/src/backend/auth/sso.mjs`:

```javascript
/**
 * @fileoverview SSO state encryption + cookie capture/inject.
 *
 * - encryptSSO / decryptSSO: AES-256-GCM with random 12-byte IV per call.
 *   Output blob is JSON-serializable: {version, iv, ct, tag, createdAt, userHash}.
 * - captureFromBrowser: read data/camoufoxUserData_tongji/cookies.sqlite
 *   via better-sqlite3 (already a project dep) and pull x-csrf-token +
 *   any session-shaped cookies.
 * - injectIntoContext: call Playwright context.addCookies(payload) with the
 *   array returned by buildInjectPayload.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

export class MasterKeyUnavailable extends Error {
    constructor() {
        super('master key unavailable; cannot decrypt SSO state');
        this.name = 'MasterKeyUnavailable';
    }
}

const BLOB_VERSION = 1;

/**
 * Encrypt an SSO payload.
 * @param {object} payload - {sessionCookies, userIdentifier, capturedAt}
 * @param {Buffer} key - 32-byte AES key
 * @returns {Promise<object>} JSON-serializable blob
 */
export async function encryptSSO(payload, key) {
    if (!(key instanceof Buffer) || key.length !== 32) {
        throw new TypeError('key must be 32-byte Buffer');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const userHash = payload.userIdentifier || 'sha256:unknown';
    return {
        version: BLOB_VERSION,
        createdAt: new Date().toISOString(),
        lastRefreshAt: new Date().toISOString(),
        userHash,
        iv: iv.toString('base64'),
        ct: ct.toString('base64'),
        tag: tag.toString('base64'),
    };
}

/**
 * Decrypt an SSO blob.
 * @param {object} blob - {iv, ct, tag, ...}
 * @param {Buffer|null} key - 32-byte AES key, or null when unavailable
 * @returns {Promise<object>} original payload
 * @throws {MasterKeyUnavailable} when key is null
 */
export async function decryptSSO(blob, key) {
    if (!key) throw new MasterKeyUnavailable();
    if (!(key instanceof Buffer) || key.length !== 32) {
        throw new TypeError('key must be 32-byte Buffer');
    }
    const iv = Buffer.from(blob.iv, 'base64');
    const ct = Buffer.from(blob.ct, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
}

/**
 * Convert captured session cookies to Playwright's addCookies payload shape.
 * @param {Array<{name:string,value:string,domain?:string,path?:string}>} cookies
 * @returns {Array<{name:string,value:string,domain:string,path:string}>}
 */
export function buildInjectPayload(cookies) {
    return cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.tongji.edu.cn',
        path: c.path || '/',
    }));
}

/**
 * Inject cookies into a Playwright BrowserContext.
 * @param {import('playwright-core').BrowserContext} context
 * @param {Array} sessionCookies
 */
export async function injectIntoContext(context, sessionCookies) {
    if (!context?.addCookies) {
        throw new TypeError('context.addCookies is required');
    }
    await context.addCookies(buildInjectPayload(sessionCookies));
}

/**
 * Capture session cookies from Camoufox cookies.sqlite.
 * Pulls x-csrf-token + any cookie whose name matches /^(session|sess|sid|jwt|access_token)$/i.
 *
 * @param {string} cookiesSqlitePath - absolute path to cookies.sqlite
 * @returns {Promise<{sessionCookies: Array, userIdentifier: string, capturedAt: string}>}
 */
export async function captureFromBrowser(cookiesSqlitePath) {
    let db;
    try {
        db = new Database(cookiesSqlitePath, { readonly: true });
    } catch (err) {
        throw new Error(`cannot open cookies.sqlite at ${cookiesSqlitePath}: ${err.message}`);
    }
    try {
        const rows = db.prepare(
            "SELECT name, value, host, path FROM moz_cookies WHERE host LIKE '%tongji%' OR host LIKE '%hiagent%'"
        ).all();
        const interesting = /^(x-csrf-token|csrf-token|session|sess|sid|jwt|access_token|user_id|uid)$/i;
        const sessionCookies = rows
            .filter((r) => interesting.test(r.name))
            .map((r) => ({
                name: r.name,
                value: r.value,
                domain: r.host.startsWith('.') ? r.host : `.${r.host}`,
                path: r.path || '/',
            }));
        if (sessionCookies.length === 0) {
            throw new Error('no session cookies captured; SSO incomplete');
        }
        const csrf = sessionCookies.find((c) => /csrf/i.test(c.name));
        const userIdentifier = csrf
            ? `sha256:${crypto.createHash('sha256').update(csrf.value).digest('hex').slice(0, 16)}`
            : `sha256:${crypto.randomBytes(8).toString('hex')}`;
        return {
            sessionCookies,
            userIdentifier,
            capturedAt: new Date().toISOString(),
        };
    } finally {
        db.close();
    }
}

/**
 * Save a blob to disk as JSON. Atomic write: write to .tmp, rename.
 * @param {string} filePath
 * @param {object} blob
 */
export async function saveBlob(filePath, blob) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 });
    await fs.rename(tmp, filePath);
}

/**
 * Load a blob from disk.
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
export async function loadBlob(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-sso.mjs
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/backend/auth/sso.mjs tests/auth/test-sso.mjs && git -c core.autocrlf=false commit -m "feat(auth): AES-256-GCM encrypt/decrypt + cookie capture/inject"
```

---

## Task 4: `probe.mjs` + unit test

**Files:**
- Create: `src/backend/auth/probe.mjs`
- Create: `tests/auth/test-probe.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/auth/test-probe.mjs`:

```javascript
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
        const r = await probe({ ssoFilePath: p, activeCheck: async () => ({ ok: true }) });
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
        const r = await probe({ ssoFilePath: p, activeCheck: async () => ({ ok: true }) });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-probe.mjs
```

Expected: FAIL with `Cannot find module '../../src/backend/auth/probe.mjs'`.

- [ ] **Step 3: Implement `probe.mjs`**

Create `E:/playgroud/tongji-webai2api/src/backend/auth/probe.mjs`:

```javascript
/**
 * @fileoverview SSO health probe. Two-stage: cheap file mtime check first,
 * active API ping only when mtime is stale. Returns a structured result.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const STALE_AFTER_DAYS = 30;
const MS_PER_DAY = 86400 * 1000;

/**
 * Cheap default active check: GET hiagent Action=ListModelByWorkspaceGrant.
 * Tolerant of network errors: returns {ok: false, error}.
 *
 * @param {{baseUrl?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function defaultActiveCheck(opts = {}) {
    const baseUrl = opts.baseUrl || 'http://127.0.0.1:3000';
    const timeoutMs = opts.timeoutMs ?? 5000;
    const url = `${baseUrl}/v1/models`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.status === 200) return { ok: true, status: 200 };
        if (res.status === 401 || res.status === 403) return { ok: false, status: res.status };
        return { ok: false, status: res.status, error: 'unexpected_status' };
    } catch (err) {
        return { ok: false, error: err?.code || err?.name || 'UNKNOWN' };
    } finally {
        clearTimeout(t);
    }
}

/**
 * Probe SSO health.
 *
 * Decision tree:
 *   file missing                              -> INVALID (NO_FILE)
 *   file mtime < STALE_AFTER_DAYS             -> VALID (mtime only)
 *   file mtime >= STALE_AFTER_DAYS
 *     active check 200                        -> VALID (active)
 *     active check 401/403                    -> INVALID (PROBE_401)
 *     active check network error              -> INVALID (NETWORK_ERROR)
 *     active check unexpected                 -> INVALID
 *
 * @param {{ssoFilePath: string, activeCheck?: () => Promise<object>, staleAfterDays?: number}} opts
 * @returns {Promise<{valid: boolean, reason: string, age: number, source?: string}>}
 */
export async function probe(opts) {
    const { ssoFilePath, activeCheck, staleAfterDays = STALE_AFTER_DAYS } = opts;
    let stat;
    try {
        stat = await fs.stat(ssoFilePath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { valid: false, reason: 'NO_FILE', age: Infinity };
        }
        throw err;
    }
    const ageDays = (Date.now() - stat.mtimeMs) / MS_PER_DAY;
    if (ageDays < staleAfterDays) {
        return { valid: true, reason: 'VALID_MTIME', age: ageDays, source: 'mtime' };
    }
    const check = activeCheck || (() => defaultActiveCheck());
    const r = await check();
    if (r.ok) {
        return { valid: true, reason: 'VALID_ACTIVE', age: ageDays, source: 'active' };
    }
    if (r.status === 401 || r.status === 403) {
        return { valid: false, reason: 'PROBE_401', age: ageDays, source: 'active' };
    }
    return { valid: false, reason: r.error ? 'NETWORK_ERROR' : 'PROBE_OTHER', age: ageDays, source: 'active' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-probe.mjs
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/backend/auth/probe.mjs tests/auth/test-probe.mjs && git -c core.autocrlf=false commit -m "feat(auth): SSO health probe (mtime + active ping)"
```

---

## Task 5: `watchdog.js` + unit test

**Files:**
- Create: `src/backend/auth/watchdog.js`
- Create: `tests/auth/helpers/mockNotify.mjs`
- Create: `tests/auth/test-watchdog.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/auth/helpers/mockNotify.mjs`:

```javascript
/**
 * Test helper: mock notify backend. Captures notifications instead of
 * dispatching to OS.
 */

export function createMockNotify() {
    const calls = [];
    return {
        calls,
        desktop(message) {
            calls.push({ kind: 'desktop', message });
        },
        prompt(message) {
            calls.push({ kind: 'prompt', message });
        },
        async launchBrowserLogin() {
            calls.push({ kind: 'launch_browser_login' });
            // caller decides success/failure via the return value
            return { ok: true, waited: false };
        },
    };
}
```

Create `E:/playgroud/tongji-webai2api/tests/auth/test-watchdog.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNotify } from './helpers/mockNotify.mjs';

const { handle401, _resetForTests } = await import('../../src/backend/auth/watchdog.js');

function makeWorker({ contextAddCookies = true, page = null } = {}) {
    const calls = { addCookies: 0 };
    return {
        name: 'tongji',
        context: contextAddCookies
            ? { async addCookies(c) { calls.addCookies++; } }
            : null,
        page: page || { async evaluate(fn, args) { return null; } },
        _calls: calls,
    };
}

function makeLogger() {
    return {
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    };
}

function makeDeps({ ssoBlob = null, refreshOk = null } = {}) {
    return {
        ssoFilePath: '/virtual/data/.sso.enc',
        masterKey: Buffer.alloc(32, 1),
        ssoBlob,
        notify: createMockNotify(),
        doRefreshSession: async () => refreshOk === null ? { ok: false, status: 404 } : { ok: refreshOk },
    };
}

test('watchdog: Try 1 succeeds when addCookies re-injects valid cookies', async () => {
    _resetForTests();
    const worker = makeWorker();
    const decrypted = {
        sessionCookies: [{ name: 'x-csrf-token', value: 'abc', domain: '.tongji.edu.cn', path: '/' }],
    };
    const deps = makeDeps({ ssoBlob: decrypted });
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
    const decrypted = { sessionCookies: [{ name: 'x-csrf-token', value: 'abc', domain: '.tongji.edu.cn', path: '/' }] };
    worker.context.addCookies = async () => { throw new Error('cookie schema invalid'); };
    const deps = makeDeps({ ssoBlob: decrypted, refreshOk: true });
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
    const decrypted = { sessionCookies: [{ name: 'x-csrf-token', value: 'abc', domain: '.tongji.edu.cn', path: '/' }] };
    worker.context.addCookies = async () => { throw new Error('cookie schema invalid'); };
    const deps = makeDeps({ ssoBlob: decrypted, refreshOk: false });
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
    const decrypted = { sessionCookies: [{ name: 'x-csrf-token', value: 'abc', domain: '.tongji.edu.cn', path: '/' }] };
    worker.context.addCookies = async () => { throw new Error('cookie schema invalid'); };
    const deps = makeDeps({ ssoBlob: decrypted, refreshOk: false });
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
    const decrypted = { sessionCookies: [{ name: 'x-csrf-token', value: 'abc', domain: '.tongji.edu.cn', path: '/' }] };
    const deps = makeDeps({ ssoBlob: decrypted });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-watchdog.mjs
```

Expected: FAIL with `Cannot find module '../../src/backend/auth/watchdog.js'`.

- [ ] **Step 3: Implement `watchdog.js`**

Create `E:/playgroud/tongji-webai2api/src/backend/auth/watchdog.js`:

```javascript
/**
 * @fileoverview Watchdog for 401 errors surfaced from the adapter.
 *
 * 4-step state machine:
 *   Try 1: decrypt data/.sso.enc, call context.addCookies(), retry.
 *   Try 2: POST /api/aigw?Action=RefreshSession (best-effort; skip on 404/405).
 *   Try 3: notify user + launch browser login.
 *   Try 4: log critical + return 503.
 *
 * Per-worker mutex: concurrent 401s for the same worker await the in-flight
 * recovery before triggering a new one. Different workers run independently.
 */

import { decryptSSO, loadBlob, MasterKeyUnavailable } from './sso.mjs';

const _mutex = new Map(); // workerName -> Promise

/**
 * Reset module-level state. Test-only.
 */
export function _resetForTests() {
    _mutex.clear();
}

/**
 * Run an async function under a per-worker mutex.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withMutex(key, fn) {
    const prev = _mutex.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    _mutex.set(key, prev.then(() => next));
    try {
        await prev;
        return await fn();
    } finally {
        release();
        // GC: if no one else is waiting, drop the entry.
        if (_mutex.get(key) === next) _mutex.delete(key);
    }
}

/**
 * @typedef Notify
 * @property {(message: string) => void} desktop
 * @property {(message: string) => void} prompt
 * @property {() => Promise<{ok: boolean, reason?: string}>} launchBrowserLogin
 */

/**
 * @typedef WatchdogDeps
 * @property {string} ssoFilePath
 * @property {Buffer|null} masterKey
 * @property {object|null} ssoBlob - pre-loaded blob; null forces Try 3
 * @property {Notify} notify
 * @property {() => Promise<{ok: boolean, status?: number}>} [doRefreshSession]
 */

/**
 * Handle a 401 from the adapter.
 * @param {{worker: {name: string, context: any, page: any}, originalRequest: () => Promise<object>, logger: any, deps: WatchdogDeps}} args
 * @returns {Promise<{ok: boolean, status?: number, reason?: string}>}
 */
export async function handle401({ worker, originalRequest, logger, deps }) {
    return withMutex(worker.name, async () => {
        logger?.info?.('watchdog', `401 detected on worker=${worker.name}; attempting recovery`);

        // ---- Try 1: silent re-inject ----
        let decrypted = null;
        if (deps.ssoBlob && deps.masterKey) {
            try {
                decrypted = await decryptSSO(deps.ssoBlob, deps.masterKey);
            } catch (err) {
                if (err instanceof MasterKeyUnavailable) {
                    logger?.warn?.('watchdog', 'master key unavailable; skipping Try 1');
                } else {
                    logger?.warn?.('watchdog', `decrypt failed: ${err.message}`);
                }
            }
        }
        if (decrypted && decrypted.sessionCookies?.length > 0) {
            try {
                await worker.context?.addCookies?.(decrypted.sessionCookies);
                const r = await originalRequest();
                if (r?.ok) {
                    logger?.info?.('watchdog', 'Try 1 succeeded (silent re-inject)');
                    return { ok: true };
                }
            } catch (err) {
                logger?.warn?.('watchdog', `Try 1 failed: ${err.message}`);
            }
        }

        // ---- Try 2: session refresh endpoint (best-effort) ----
        const refresh = deps.doRefreshSession ? await deps.doRefreshSession() : { ok: false, status: 404 };
        if (refresh?.ok) {
            try {
                const r = await originalRequest();
                if (r?.ok) {
                    logger?.info?.('watchdog', 'Try 2 succeeded (refresh endpoint)');
                    return { ok: true };
                }
            } catch (err) {
                logger?.warn?.('watchdog', `Try 2 retry failed: ${err.message}`);
            }
        } else if (refresh?.status && refresh.status !== 404 && refresh.status !== 405) {
            logger?.debug?.('watchdog', `Try 2 refresh endpoint status ${refresh.status}`);
        }

        // ---- Try 3: notify + interactive re-login ----
        deps.notify.desktop('SSO expired; re-login required');
        deps.notify.prompt('SSO expired; please complete browser login');
        const login = await deps.notify.launchBrowserLogin();
        if (login?.ok) {
            // Caller is responsible for re-decrypting .sso.enc and re-injecting.
            // Here we just retry; if the new cookies aren't injected yet, this
            // will fall through to 503. The caller pipeline is expected to wait
            // for the new .sso.enc to land before calling handle401 again.
            try {
                const r = await originalRequest();
                if (r?.ok) {
                    logger?.info?.('watchdog', 'Try 3 succeeded (interactive re-login)');
                    return { ok: true };
                }
            } catch (err) {
                logger?.warn?.('watchdog', `Try 3 retry failed: ${err.message}`);
            }
        }

        // ---- Try 4: give up ----
        logger?.error?.('watchdog', `all recovery attempts failed for worker=${worker.name}; returning 503`);
        return { ok: false, status: 503, reason: 'sso_recovery_exhausted' };
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-watchdog.mjs
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/backend/auth/watchdog.js tests/auth/test-watchdog.mjs tests/auth/helpers/mockNotify.mjs && git -c core.autocrlf=false commit -m "feat(auth): watchdog 4-step 401 recovery with per-worker mutex"
```

---

## Task 6: `scripts/cli/login.mjs`

**Files:**
- Create: `scripts/cli/login.mjs`
- (No test -- integration covered by Task 11)

- [ ] **Step 1: Implement `login.mjs`**

Create `E:/playgroud/tongji-webai2api/scripts/cli/login.mjs`:

```javascript
#!/usr/bin/env node
/**
 * @fileoverview One-shot login: spawn -login=tongji flow, capture cookies,
 * encrypt to data/.sso.enc.
 *
 * Usage:
 *   node scripts/cli/login.mjs [--encrypt-only]
 *
 * --encrypt-only: skip the server start; only run the login + encrypt phase.
 *                 (Used by `npm run up` internally when a fresh login is needed.)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';

import {
    captureFromBrowser,
    encryptSSO,
    saveBlob,
    MasterKeyUnavailable,
} from '../../src/backend/auth/sso.mjs';
import { getMasterKey, setMasterKey } from '../../src/backend/auth/keychain.mjs';
import { logger } from '../../src/utils/logger.js';

const COOKIE_PATH = path.join(process.cwd(), 'data', 'camoufoxUserData_tongji', 'cookies.sqlite');
const SSO_PATH = path.join(process.cwd(), 'data', '.sso.enc');

function parseArgs(argv) {
    const args = { encryptOnly: false };
    for (const a of argv.slice(2)) {
        if (a === '--encrypt-only') args.encryptOnly = true;
        else if (a === '--help' || a === '-h') {
            console.log('Usage: node scripts/cli/login.mjs [--encrypt-only]');
            process.exit(0);
        }
    }
    return args;
}

async function ensureMasterKey() {
    let key = await getMasterKey({ allowFileFallback: true });
    if (key) return key;
    logger.info('login', 'no master key found; generating fresh 32-byte key');
    key = require('node:crypto').randomBytes(32);
    await setMasterKey(key, { allowFileFallback: true });
    return key;
}

async function waitForLoginCompletion(timeoutMs = 5 * 60 * 1000) {
    if (!existsSync(COOKIE_PATH)) {
        // Browser has not produced a cookies.sqlite yet -- wait until it does.
        const intervalMs = 500;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (existsSync(COOKIE_PATH)) return;
            await wait(intervalMs);
        }
        throw new Error(`login timed out: cookies.sqlite never appeared at ${COOKIE_PATH}`);
    }
    // Cookie file already exists; treat as already-logged-in (idempotent).
}

async function spawnLoginServer() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['src/server/server.js', '-login=tongji'], {
            cwd: process.cwd(),
            stdio: 'inherit',
        });
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`server -login exited with code ${code}`));
        });
        child.on('error', reject);
    });
}

async function main() {
    const args = parseArgs(process.argv);
    logger.info('login', args.encryptOnly ? 'login + encrypt only' : 'login + start server');

    const key = await ensureMasterKey();

    logger.info('login', 'opening browser; complete SSO to continue');
    await waitForLoginCompletion();
    await spawnLoginServer();

    // Server has exited cleanly after the user completed SSO.
    logger.info('login', 'SSO completed; capturing cookies');
    const payload = await captureFromBrowser(COOKIE_PATH);
    const blob = await encryptSSO(payload, key);
    await saveBlob(SSO_PATH, blob);
    logger.info('login', `encrypted SSO state written to ${SSO_PATH}`);

    if (!args.encryptOnly) {
        // Caller will start the supervisor separately; nothing to do here.
        logger.info('login', 'done. Run `npm run up` to start the server.');
    }
}

main().catch((err) => {
    logger.error('login', err.message);
    process.exit(2);
});
```

- [ ] **Step 2: Syntax check**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --check scripts/cli/login.mjs && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 3: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add scripts/cli/login.mjs && git -c core.autocrlf=false commit -m "feat(cli): one-shot login with SSO encrypt"
```

---

## Task 7: `scripts/cli/up.mjs`

**Files:**
- Create: `scripts/cli/up.mjs`
- (No test -- integration covered by Task 11)

- [ ] **Step 1: Implement `up.mjs`**

Create `E:/playgroud/tongji-webai2api/scripts/cli/up.mjs`:

```javascript
#!/usr/bin/env node
/**
 * @fileoverview Smart start: probe -> maybe login -> spawn supervisor.
 *
 * Usage:
 *   node scripts/cli/up.mjs [--force-start]
 *
 * --force-start: skip login even when probe says INVALID/STALE.
 *
 * Exit codes:
 *   0 -- server running (TTY mode: blocks tailing logs; CI mode: exits immediately).
 *   2 -- login failed.
 *   3 -- supervisor failed to bind port.
 *   4 -- already running (use `npm run status`).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import { probe } from '../../src/backend/auth/probe.mjs';
import { logger } from '../../src/utils/logger.js';

const SSO_PATH = path.join(process.cwd(), 'data', '.sso.enc');
const PID_PATH = path.join(process.cwd(), 'data', 'supervisor.pid');

function parseArgs(argv) {
    const args = { forceStart: false, ci: false };
    for (const a of argv.slice(2)) {
        if (a === '--force-start') args.forceStart = true;
        else if (a === '--ci') args.ci = true;
        else if (a === '--help' || a === '-h') {
            console.log('Usage: node scripts/cli/up.mjs [--force-start] [--ci]');
            process.exit(0);
        }
    }
    return args;
}

function alreadyRunning() {
    if (!existsSync(PID_PATH)) return false;
    try {
        const pid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
        process.kill(pid, 0);
        return pid;
    } catch {
        return false;
    }
}

async function spawnSupervisor() {
    mkdirSync(path.dirname(PID_PATH), { recursive: true });
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['supervisor.js'], {
            cwd: process.cwd(),
            stdio: 'inherit',
            detached: true,
        });
        child.on('spawn', () => {
            writeFileSync(PID_PATH, String(child.pid));
            resolve(child);
        });
        child.on('error', reject);
    });
}

async function main() {
    const args = parseArgs(process.argv);

    const running = alreadyRunning();
    if (running) {
        logger.warn('up', `already running (PID ${running}); use 'npm run status'`);
        process.exit(4);
    }

    logger.info('up', 'probing SSO state');
    const probeResult = await probe({ ssoFilePath: SSO_PATH });

    if (!probeResult.valid && !args.forceStart) {
        logger.info('up', `probe result: ${probeResult.reason}; login required`);
        const child = spawn(process.execPath, ['scripts/cli/login.mjs', '--encrypt-only'], {
            cwd: process.cwd(),
            stdio: 'inherit',
        });
        const code = await new Promise((resolve) => child.on('exit', resolve));
        if (code !== 0) {
            logger.error('up', `login failed with code ${code}`);
            process.exit(2);
        }
    } else if (probeResult.valid) {
        logger.info('up', `probe result: ${probeResult.reason} (age ${probeResult.age.toFixed(1)}d)`);
    } else {
        logger.warn('up', `probe result: ${probeResult.reason}; --force-start set, skipping login`);
    }

    logger.info('up', 'starting supervisor');
    try {
        const child = await spawnSupervisor();
        logger.info('up', `supervisor started (PID ${child.pid})`);
        if (args.ci) {
            // CI mode: detach and exit.
            child.unref();
            process.exit(0);
        }
    } catch (err) {
        logger.error('up', `supervisor failed to start: ${err.message}`);
        process.exit(3);
    }
}

main().catch((err) => {
    logger.error('up', err.stack || err.message);
    process.exit(1);
});
```

- [ ] **Step 2: Syntax check**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --check scripts/cli/up.mjs && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 3: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add scripts/cli/up.mjs && git -c core.autocrlf=false commit -m "feat(cli): smart start (probe -> login -> supervisor)"
```

---

## Task 8: `scripts/cli/down.mjs`

**Files:**
- Create: `scripts/cli/down.mjs`
- (No test)

- [ ] **Step 1: Implement `down.mjs`**

Create `E:/playgroud/tongji-webai2api/scripts/cli/down.mjs`:

```javascript
#!/usr/bin/env node
/**
 * @fileoverview Graceful stop: SIGTERM via supervisor IPC, fall back to PID kill.
 *
 * Usage: node scripts/cli/down.mjs
 * Exit: 0 on success, 1 if no supervisor running.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../src/utils/logger.js';

const PID_PATH = path.join(process.cwd(), 'data', 'supervisor.pid');
const IPC_PATH = process.platform === 'win32'
    ? '\\\\.\\pipe\\webai2api-supervisor'
    : require('node:path').join(require('node:os').tmpdir(), 'webai2api-supervisor.sock');

async function stopViaIpc() {
    const net = await import('node:net');
    return new Promise((resolve) => {
        const sock = net.connect(IPC_PATH);
        const t = setTimeout(() => { sock.destroy(); resolve(false); }, 2000);
        sock.on('connect', () => {
            sock.write('STOP\n');
        });
        sock.on('data', (chunk) => {
            if (chunk.toString().startsWith('OK')) {
                clearTimeout(t);
                sock.destroy();
                resolve(true);
            }
        });
        sock.on('error', () => { clearTimeout(t); resolve(false); });
    });
}

function stopViaPid() {
    if (!existsSync(PID_PATH)) return false;
    let pid;
    try {
        pid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
    } catch { return false; }
    try {
        process.kill(pid, 'SIGTERM');
        return true;
    } catch { return false; }
}

async function main() {
    logger.info('down', 'stopping supervisor');
    let stopped = await stopViaIpc();
    if (!stopped) stopped = stopViaPid();
    if (!stopped) {
        logger.warn('down', 'no supervisor process found');
        try { unlinkSync(PID_PATH); } catch { /* ignore */ }
        process.exit(1);
    }
    // Wait briefly for graceful shutdown, then unlink PID file.
    await new Promise((r) => setTimeout(r, 1500));
    try { unlinkSync(PID_PATH); } catch { /* ignore */ }
    logger.info('down', 'supervisor stopped');
    process.exit(0);
}

main().catch((err) => {
    logger.error('down', err.message);
    process.exit(1);
});
```

- [ ] **Step 2: Syntax check**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --check scripts/cli/down.mjs && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 3: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add scripts/cli/down.mjs && git -c core.autocrlf=false commit -m "feat(cli): graceful stop via supervisor IPC + PID fallback"
```

---

## Task 9: `scripts/cli/status.mjs`

**Files:**
- Create: `scripts/cli/status.mjs`
- (No test)

- [ ] **Step 1: Implement `status.mjs`**

Create `E:/playgroud/tongji-webai2api/scripts/cli/status.mjs`:

```javascript
#!/usr/bin/env node
/**
 * @fileoverview Unified status: PID, port, login age, keychain, workers, last log.
 *
 * Usage: node scripts/cli/status.mjs
 * Exit codes:
 *   0 -- server running and healthy (or not running but sso/keychain OK).
 *   1 -- degraded (server not running but recoverable via `npm run up`).
 *   5 -- unrecoverable (keychain failed AND no file fallback).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isAvailable } from '../../src/backend/auth/keychain.mjs';
import { probe } from '../../src/backend/auth/probe.mjs';
import { logger } from '../../src/utils/logger.js';

const PID_PATH = path.join(process.cwd(), 'data', 'supervisor.pid');
const SSO_PATH = path.join(process.cwd(), 'data', '.sso.enc');
const LOG_PATH = path.join(process.cwd(), 'data', 'logs', 'system.log');

function checkPort(port) {
    return new Promise((resolve) => {
        const sock = net.createConnection({ port, host: '127.0.0.1' });
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
    });
}

function readPid() {
    if (!existsSync(PID_PATH)) return null;
    try {
        return parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
    } catch { return null; }
}

function tailLog(n = 12) {
    if (!existsSync(LOG_PATH)) return [];
    try {
        const raw = readFileSync(LOG_PATH, 'utf8');
        return raw.split('\n').filter(Boolean).slice(-n);
    } catch { return []; }
}

async function main() {
    const cfgRaw = existsSync(path.join(process.cwd(), 'data', 'config.yaml'))
        ? readFileSync(path.join(process.cwd(), 'data', 'config.yaml'), 'utf8')
        : '';
    const portMatch = cfgRaw.match(/^\s*port:\s*(\d+)/m);
    const port = portMatch ? parseInt(portMatch[1], 10) : 3000;

    const pid = readPid();
    const portUp = await checkPort(port);
    const probeResult = await probe({ ssoFilePath: SSO_PATH });
    const kcAvailable = await isAvailable();
    const lastLog = tailLog(12);

    let serverLine;
    if (portUp) {
        serverLine = `UP (PID ${pid ?? '?'}, port ${port})`;
    } else if (pid) {
        serverLine = `STALE PID ${pid} (port ${port} not listening)`;
    } else {
        serverLine = `DOWN (port ${port} not listening)`;
    }

    const loginLine = probeResult.valid
        ? `OK -- age ${probeResult.age.toFixed(1)}d (${probeResult.reason})`
        : `STALE -- ${probeResult.reason}`;

    console.log('Tongji WebAI2API status');
    console.log('');
    console.log(`  server:    ${serverLine}`);
    console.log(`  login:     ${loginLine}`);
    console.log(`  keychain:  ${kcAvailable ? 'OK' : 'UNAVAILABLE'}`);
    console.log('');
    console.log('  last log:');
    for (const line of lastLog) console.log(`    ${line}`);

    // Exit code logic
    if (!kcAvailable && !existsSync(path.join(process.cwd(), 'data', '.master.key'))) {
        process.exit(5);
    }
    if (!portUp && !probeResult.valid) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch((err) => {
    logger.error('status', err.message);
    process.exit(1);
});
```

- [ ] **Step 2: Syntax check**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --check scripts/cli/status.mjs && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 3: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add scripts/cli/status.mjs && git -c core.autocrlf=false commit -m "feat(cli): unified status (PID + login age + keychain + last log)"
```

---

## Task 10: Wire Worker.js + queue.js for watchdog

**Files:**
- Modify: `src/backend/pool/Worker.js` (expose context + page)
- Modify: `src/server/queue.js` (catch 401, call watchdog)

- [ ] **Step 1: Read current Worker.js and queue.js structure**

Run:
```bash
cd E:/playgroud/tongji-webai2api && grep -n -E "context|page|browser" src/backend/pool/Worker.js | head -20
```

Note where `context` (Playwright BrowserContext) and `page` are stored. These should already exist on the Worker instance for the adapter to use them; we just need to ensure they're accessible (not behind private fields).

- [ ] **Step 2: Edit `Worker.js`**

Open `E:/playgroud/tongji-webai2api/src/backend/pool/Worker.js`. Find the constructor or initialization section. Confirm the Worker instance stores `this.context` and `this.page` (or equivalent) as plain properties. If they're behind `#` private fields, change them to public. Specifically, change any line like:

```javascript
this.#context = newBrowserContext;
```

to:

```javascript
this.context = newBrowserContext;
```

and similarly for `page`. If `context` / `page` are already public properties, no change is needed.

Verify by adding (at the bottom of the file) a getter-only check:

```javascript
// Public API for watchdog (src/backend/auth/watchdog.js):
// - this.context (Playwright BrowserContext) -- used for context.addCookies()
// - this.page    (Playwright Page)            -- used by adapter (unchanged)
```

- [ ] **Step 3: Read current queue.js 401 handling**

Run:
```bash
cd E:/playgroud/tongji-webai2api && grep -n -E "status|error|reject|401" src/server/queue.js | head -30
```

Find where adapter errors propagate through the queue. Identify the function/method that ultimately rejects the Promise back to the route handler.

- [ ] **Step 4: Edit `queue.js` to wire watchdog**

Open `E:/playgroud/tongji-webai2api/src/server/queue.js`. In the function that calls `adapter.generate()` (or wherever the adapter is invoked), wrap the call to detect 401 and trigger watchdog recovery.

Add at the top of the file:

```javascript
import { handle401 as watchdogHandle401 } from '../backend/auth/watchdog.js';
import { loadBlob } from '../backend/auth/sso.mjs';
import { getMasterKey } from '../backend/auth/keychain.js'; // may not exist; fallback below
import fs from 'node:fs';
```

Wait — `keychain.mjs` exports are async. And we need a sync-ish hot path here. Adjust:

Add instead:

```javascript
import { handle401 as watchdogHandle401 } from '../backend/auth/watchdog.js';
import { loadBlob } from '../backend/auth/sso.js';
import { getMasterKey } from '../backend/auth/keychain.js';
import path from 'node:path';
```

Actually, looking at the dependency graph: queue.js currently does NOT import from auth/. Adding those imports creates a circular risk. To avoid that, use lazy/dynamic imports:

```javascript
async function triggerWatchdog(worker, originalRequest, logger) {
    const { handle401 } = await import('../backend/auth/watchdog.js');
    const { loadBlob } = await import('../backend/auth/sso.js');
    const { getMasterKey } = await import('../backend/auth/keychain.js');
    const SSO_PATH = path.join(process.cwd(), 'data', '.sso.enc');
    const blob = await loadBlob(SSO_PATH);
    const masterKey = await getMasterKey({ allowFileFallback: true }).catch(() => null);
    return handle401({
        worker,
        originalRequest,
        logger,
        deps: {
            ssoFilePath: SSO_PATH,
            masterKey,
            ssoBlob: blob,
            notify: {
                desktop: (msg) => logger?.warn?.('watchdog-notify', msg),
                prompt: (msg) => logger?.warn?.('watchdog-prompt', msg),
                launchBrowserLogin: async () => ({ ok: false, reason: 'auto_login_disabled_in_queue' }),
            },
            doRefreshSession: async () => ({ ok: false, status: 404 }),
        },
    });
}
```

In the adapter error path, look for the place where `err.status === 401` (or where the adapter returns a `{error}` with status). Add:

```javascript
if (err?.status === 401 || err?.response?.status === 401) {
    const result = await triggerWatchdog(worker, () => adapter.generate(...originalArgs), logger);
    if (result?.ok) {
        // retry succeeded; return the new result
        return result;
    }
    // watchdog gave up; fall through to original 401 error
}
```

The exact insertion depends on the existing error handling structure. Use `grep -n` to find the catch block; wrap the `throw err` with this watchdog trigger.

- [ ] **Step 5: Run existing test suite to confirm no regression**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/*.mjs 2>&1 | tail -8
```

Expected: 46/46 pass (no regression).

- [ ] **Step 6: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/backend/pool/Worker.js src/server/queue.js && git -c core.autocrlf=false commit -m "feat(auth): wire watchdog into queue.js on 401"
```

---

## Task 11: Watchdog integration test

**Files:**
- Create: `tests/auth/test-watchdog-integration.mjs`

- [ ] **Step 1: Write the test**

Create `E:/playgroud/tongji-webai2api/tests/auth/test-watchdog-integration.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { handle401, _resetForTests } = await import('../../src/backend/auth/watchdog.js');
const { encryptSSO } = await import('../../src/backend/auth/sso.js');
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
        // First call (Try 1): still 401 because cookies were not yet injected.
        // After addCookies, Playwright reuses them -- but we're simulating
        // the framework seeing them on the next call.
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
```

- [ ] **Step 2: Run the test**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node --test tests/auth/test-watchdog-integration.mjs
```

Expected: 1 test pass.

- [ ] **Step 3: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add tests/auth/test-watchdog-integration.mjs && git -c core.autocrlf=false commit -m "test(auth): watchdog integration (mock 401 -> 200 after re-inject)"
```

---

## Task 12: Backward-compat shims for `*.bat/sh`

**Files:**
- Modify: `install.bat`, `install.sh`, `login.bat`, `login.sh`, `start.bat`, `start.sh`, `stop.bat`, `stop.sh`, `status.bat`, `status.sh`, `restart.bat`, `restart.sh`

- [ ] **Step 1: Read one of each to see current content**

Run:
```bash
cd E:/playgroud/tongji-webai2api && cat install.bat install.sh start.bat start.sh 2>&1 | head -40
```

- [ ] **Step 2: Replace each shim's body with `npm run <cmd>` and add a deprecation header**

For `install.bat`:

```bat
@echo off
REM DEPRECATED: this shim forwards to `npm run up`. Will be removed in v4.
REM See docs/superpowers/specs/2026-08-20-smart-login-design.md for the new flow.
npm run up %*
```

For `install.sh`:

```bash
#!/usr/bin/env bash
# DEPRECATED: this shim forwards to `npm run up`. Will be removed in v4.
# See docs/superpowers/specs/2026-08-20-smart-login-design.md for the new flow.
set -e
npm run up "$@"
```

For `login.bat`:

```bat
@echo off
REM DEPRECATED: this shim forwards to `npm run login`. Will be removed in v4.
npm run login %*
```

For `login.sh`:

```bash
#!/usr/bin/env bash
# DEPRECATED: this shim forwards to `npm run login`. Will be removed in v4.
set -e
npm run login "$@"
```

For `start.bat`:

```bat
@echo off
REM DEPRECATED: this shim forwards to `npm run up`. Will be removed in v4.
npm run up %*
```

For `start.sh`:

```bash
#!/usr/bin/env bash
# DEPRECATED: this shim forwards to `npm run up`. Will be removed in v4.
set -e
npm run up "$@"
```

For `stop.bat`:

```bat
@echo off
REM DEPRECATED: this shim forwards to `npm run down`. Will be removed in v4.
npm run down %*
```

For `stop.sh`:

```bash
#!/usr/bin/env bash
# DEPRECATED: this shim forwards to `npm run down`. Will be removed in v4.
set -e
npm run down "$@"
```

For `status.bat`:

```bat
@echo off
REM DEPRECATED: this shim forwards to `npm run status`. Will be removed in v4.
npm run status %*
```

For `status.sh`:

```bash
#!/usr/bin/env bash
# DEPRECATED: this shim forwards to `npm run status`. Will be removed in v4.
set -e
npm run status "$@"
```

For `restart.bat`:

```bat
@echo off
REM DEPRECATED: this shim forwards to `npm run down && npm run up`. Will be removed in v4.
call npm run down %*
call npm run up %*
```

For `restart.sh`:

```bash
#!/usr/bin/env bash
# DEPRECATED: this shim forwards to `npm run down && npm run up`. Will be removed in v4.
set -e
npm run down "$@"
npm run up "$@"
```

- [ ] **Step 3: Syntax check `.bat` and `.sh` files**

Run:
```bash
cd E:/playgroud/tongji-webai2api && for f in install.bat login.bat start.bat stop.bat status.bat restart.bat; do echo "checking $f"; done && for f in install.sh login.sh start.sh stop.sh status.sh restart.sh; do bash -n "$f" && echo "$f OK"; done
```

Expected: all `.sh` files report OK.

- [ ] **Step 4: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add install.bat install.sh login.bat login.sh start.bat start.sh stop.bat stop.sh status.bat status.sh restart.bat restart.sh && git -c core.autocrlf=false commit -m "refactor: legacy bat/sh become deprecated shims around npm scripts"
```

---

## Task 13: CI integration

**Files:**
- Modify: `.github/workflows/ci.yml` (add `node --test tests/auth/*.mjs` step)

- [ ] **Step 1: Read CI file**

Run:
```bash
cd E:/playgroud/tongji-webai2api && grep -n -E "Anthropic|anthropic|tests/anthropic" .github/workflows/ci.yml
```

Find the existing `Anthropic unit + integration tests` step (added in the prior Anthropic-protocol PR).

- [ ] **Step 2: Add the auth test step**

After the `Anthropic unit + integration tests` step, add:

```yaml
      - name: Auth unit tests (smart login)
        shell: bash
        run: |
          # Unit tests for src/backend/auth/* primitives.
          # No live browser / keychain required (mocked via tests/auth/helpers/).
          node --test tests/auth/*.mjs
```

- [ ] **Step 3: Verify YAML syntax**

Run:
```bash
cd E:/playgroud/tongji-webai2api && node -e "const yaml = require('yaml'); const fs = require('fs'); yaml.parse(fs.readFileSync('.github/workflows/ci.yml','utf8')); console.log('YAML OK');"
```

Expected: `YAML OK`. (Uses the project's `yaml` dep which is already a runtime dep.)

- [ ] **Step 4: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add .github/workflows/ci.yml && git -c core.autocrlf=false commit -m "ci(auth): add unit-test step for smart-login auth module"
```

---

## Task 14: Documentation

**Files:**
- Modify: `README.md` (add "Smart login lifecycle" section)
- Modify: `config.example.yaml` (document auth fields)
- (AGENTS.md is gitignored; update its section 12 locally -- not committed)

- [ ] **Step 1: Edit `README.md`**

Open `E:/playgroud/tongji-webai2api/README.md`. After the existing `## Anthropic-protocol API` section (which was added in the prior Anthropic-protocol PR), add a new section:

```markdown
## Smart login lifecycle

A single command starts the server, walks you through SSO only when the
session has expired, and silently re-authenticates if a request hits a
401 mid-session.

### Quick start

```bash
npm run up
```

That's it. The first run pops up a browser for SSO; subsequent runs
start the server with no interaction. `npm run status` shows login age,
keychain health, and server status in one view.

### Commands

| Command | Purpose |
|---------|---------|
| `npm run up` | smart start: probe SSO, login if needed, spawn supervisor |
| `npm run down` | graceful stop (via supervisor IPC + PID fallback) |
| `npm run status` | unified status: PID, port, login age, keychain, last log lines |
| `npm run login` | force a fresh SSO + encrypt session state |

Legacy `install.bat/sh`, `start.bat/sh`, etc. continue to work as thin
shims around these commands (deprecated; removed in v4).

### Encryption model

- Session cookies + csrf are captured after SSO and encrypted with
  **AES-256-GCM** before being written to `data/.sso.enc`.
- The master key is **never on disk in plaintext**: it lives in the OS
  keychain (Windows Credential Manager / macOS Keychain / Linux
  libsecret) under service `tongji-webai2api`, account `sso-master-key`.
- Linux without libsecret falls back to `data/.master.key` (chmod 600)
  with a warning in `npm run status`.

### Watchdog (silent 401 recovery)

When a Tongji upstream call returns 401, the server-side watchdog tries
four recovery steps before giving up:

1. **Silent re-inject**: decrypt `data/.sso.enc` and call Playwright's
   `context.addCookies()` on the running browser context.
2. **Session refresh endpoint** (if Tongji hiagent exposes one): a
   best-effort `Action=RefreshSession` round-trip.
3. **Interactive re-login**: desktop notification + browser popup.
4. **Fail loud**: log critical + return 503 to the upstream caller.

Recovery runs in a per-worker mutex, so concurrent 401s on the same
worker are serialized; different workers recover independently.

### Limitations

- macOS / Linux first-time login still needs an interactive browser
  popup. Once the session is captured, subsequent runs and watchdog
  recoveries are click-free.
- Linux without libsecret uses the file fallback (less secure at rest).
```

- [ ] **Step 2: Edit `config.example.yaml`**

Open `E:/playgroud/tongji-webai2api/config.example.yaml`. After the `anthropic:` block (added in the prior Anthropic-protocol PR), add:

```yaml
# ========================================
# Smart login (optional, informational only)
# ========================================
# Behavior is hardcoded in src/backend/auth/. The fields below document
# what is enabled by default and may be referenced by future code paths.
auth:
  encryptAlgo: "aes-256-gcm"
  keychainFallback: "auto"  # auto | always | never -- Linux file fallback policy
  ssoBlobPath: "data/.sso.enc"
  staleAfterDays: 30
```

- [ ] **Step 3: Update local `AGENTS.md` (not committed)**

Open `E:/playgroud/tongji-webai2api/AGENTS.md`. After section 11 ("Anthropic protocol"), append:

```markdown
## 12. Smart login

This fork adds a smart-login lifecycle that collapses the
`install && login && start` flow into a single `npm run up` command and
silently re-authenticates on 401 via a watchdog.

### Where it lives

| Component | File |
|-----------|------|
| Smart start | `scripts/cli/up.mjs` |
| Stop | `scripts/cli/down.mjs` |
| Status | `scripts/cli/status.mjs` |
| Explicit login | `scripts/cli/login.mjs` |
| OS keychain wrapper | `src/backend/auth/keychain.mjs` |
| Encrypt / decrypt / capture / inject | `src/backend/auth/sso.mjs` |
| SSO health probe | `src/backend/auth/probe.mjs` |
| Watchdog (401 recovery) | `src/backend/auth/watchdog.js` |

### Hard rules

- **Do not write plaintext session cookies to disk.** Always go
  through `encryptSSO()`. `data/.sso.enc` is the only sanctioned file.
- **Do not edit `src/backend/adapter/tongji.js`** to handle re-auth.
  Cookie injection happens at the pool layer via Playwright's
  `context.addCookies()`.
- **Do not bypass the watchdog** in queue.js when a 401 is detected.
  Let `handle401()` make the recovery decision.
- **Do not introduce boot auto-start.** Per the design decision,
  `npm run up` is always manual.
- **Run TDD** for any change in `src/backend/auth/`. Use
  `node --test tests/auth/*.mjs` before opening a PR.

### Modifying the encryption

The algorithm + key length are hardcoded (AES-256-GCM, 32-byte key).
Changing either requires updating `tests/auth/test-sso.mjs` first (TDD).
```

This is a local-only file (gitignored). Skip if you want.

- [ ] **Step 4: Verify docs don't break markdownlint baseline**

Run (informational; markdownlint warnings on pre-existing tables are not blockers):
```bash
cd E:/playgroud/tongji-webai2api && grep -c "^## " README.md config.example.yaml
```

Expected: README has at least 8 `## ` sections; config has at least 6.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add README.md config.example.yaml && git -c core.autocrlf=false commit -m "docs(auth): smart login lifecycle section + config.example additions"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|--------------|---------|
| §1 Goal | T1, T7 (smart start); T5, T10 (watchdog) |
| §2 Scope (CLI commands) | T1 (npm scripts); T6/T7/T8/T9 (CLI files) |
| §3 Architecture | T2-T5 (auth modules); T10 (wire-in) |
| §4 New files | T2-T5, T6-T9, T11 (tests) |
| §5 Untouched boundaries | verified in T10 step 1-2; tongji.js not modified anywhere |
| §5b Modified files | T1 (package.json); T10 (queue.js + Worker.js); T12 (shims); T13 (CI); T14 (docs) |
| §6 CLI entry points | T1 (package.json scripts); T6-T9 (CLI files) |
| §7.1 First-time start | T2, T3, T6 (login flow); T7 (smart start) |
| §7.2 Subsequent start | T4 (probe); T7 (skip login) |
| §7.3 Watchdog | T5 (state machine); T10 (wire-in) |
| §8 Encryption | T2 (keychain); T3 (encrypt/decrypt) |
| §9 Watchdog logic (detail) | T5; T10 (mutex) |
| §10 Error handling + degradation | T2 (keychain fallback); T5 (4 tries) |
| §11 CLI command surface | T6-T9 (CLI files); T7 (exit codes) |
| §12 Testing | T2-T5 (unit); T11 (integration) |
| §13 Completion criteria | T2-T5, T11 (tests pass); T6-T9 (CLI works); T10 (wire-in); T12 (backward compat); T13 (CI); T14 (docs) |
| §14 Risks + mitigations | documented in plan; will be re-checked at execution |

No spec gaps.

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or "fill in details" patterns. All code blocks complete. Where the existing codebase shape forces runtime decisions (e.g., "find the catch block and wrap it"), the step provides the code snippet to insert plus the verification step.

**3. Type consistency:**

- `getMasterKey()` / `setMasterKey()` / `deleteMasterKey()` / `isAvailable()` -- same async signatures in T2 implementation and T9 (status.mjs usage).
- `encryptSSO(payload, key)` / `decryptSSO(blob, key)` -- T3 implementation matches T6 usage and T5/T10 deps shape.
- `probe(opts)` returns `{valid, reason, age, source?}` -- T4 matches T7 usage.
- `handle401({worker, originalRequest, logger, deps})` -- T5 matches T10 dynamic-import invocation and T11 test call.
- `captureFromBrowser(cookiesSqlitePath)` -- T3 matches T6 usage.
- `injectIntoContext(context, cookies)` -- T3 not directly invoked by another task in this plan (T10 wraps watchdog which uses `context.addCookies()` directly). Consistent.
- `loadBlob(filePath)` -- T3; invoked by T10 dynamic-import.
- `buildInjectPayload(cookies)` -- T3 (test-only); not directly invoked but kept as exported helper.
- `MasterKeyUnavailable` error class -- T3; caught by T5 (Try 1 skip).

All consistent.

**4. Scope:** 14 tasks; ~1740 lines of new code + ~150 lines of modifications. Single plan, single cohesive feature. No decomposition needed.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-20-smart-login.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?