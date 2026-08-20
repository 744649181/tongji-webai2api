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
 *
 * Captures ALL cookies whose host matches a Tongji hiagent domain
 * (host LIKE '%tongji%' OR host LIKE '%hiagent%'). This is intentionally
 * broad — the upstream WebAI2API regex assumed English cookie names
 * (session / csrf / jwt), but Tongji's actual SSO sets cookies named
 * `tenant`, `x`, `I18nextLngHiagent`, etc. A name-based filter would
 * drop every single one.
 *
 * The trade-off: we may capture UI-preference cookies (e.g. UI language)
 * alongside auth cookies. Playwright's addCookies is happy to re-inject
 * extras, and the cost is a few extra bytes in .sso.enc.
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
        const sessionCookies = rows.map((r) => ({
            name: r.name,
            value: r.value,
            domain: r.host.startsWith('.') ? r.host : `.${r.host}`,
            path: r.path || '/',
        }));
        if (sessionCookies.length === 0) {
            throw new Error('no session cookies captured; SSO incomplete');
        }
        // userIdentifier derivation (stable per SSO session):
        //   1. Prefer csrf-token if present (back-compat with existing logs).
        //   2. Else prefer `tenant` cookie (stable Tongji tenant id).
        //   3. Else hash the sorted cookie names (still stable across
        //      value rotations, just less specific).
        const csrf = sessionCookies.find((c) => /csrf/i.test(c.name));
        const tenant = sessionCookies.find((c) => c.name === 'tenant');
        const seed = csrf
            ? csrf.value
            : tenant
            ? tenant.value
            : sessionCookies.map((c) => c.name).sort().join('|');
        const userIdentifier = `sha256:${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
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