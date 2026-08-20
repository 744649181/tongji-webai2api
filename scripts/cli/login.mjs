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
import crypto from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    captureFromBrowser,
    encryptSSO,
    saveBlob,
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
    key = crypto.randomBytes(32);
    await setMasterKey(key, { allowFileFallback: true });
    return key;
}

async function waitForLoginCompletion(timeoutMs = 5 * 60 * 1000) {
    if (existsSync(COOKIE_PATH)) return; // already present (idempotent)
    const intervalMs = 500;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (existsSync(COOKIE_PATH)) return;
        await wait(intervalMs);
    }
    throw new Error(`login timed out: cookies.sqlite never appeared at ${COOKIE_PATH}`);
}

/**
 * Spawn server.js in -login mode to open the Camoufox browser.
 * Returns the child handle. Caller is responsible for killing it --
 * the server does NOT auto-exit after SSO completes (legacy behavior;
 * changing it is out of scope for this CLI).
 */
function spawnLoginServer() {
    const child = spawn(process.execPath, ['src/server/server.js', '-login=tongji'], {
        cwd: process.cwd(),
        stdio: 'inherit',
    });
    child.on('error', (err) => {
        // Surface spawn errors via the unhandledRejection guard in main's
        // catch -- but don't crash the process here, the caller might not
        // be waiting on this child (idempotent path).
        logger.error('login', `server spawn error: ${err.message}`);
    });
    return child;
}

/**
 * Send SIGTERM to the spawned login server, fall back to SIGKILL after
 * `timeoutMs`. Resolves when the child exits (or after force-kill).
 * Safe to call with null / already-exited child.
 */
function killServer(child, timeoutMs = 5000) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, timeoutMs);
        child.on('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
    });
}

async function main() {
    const args = parseArgs(process.argv);
    logger.info('login', args.encryptOnly ? 'login + encrypt only' : 'login + start server');

    await runLoginOrchestration({
        cookieExists: existsSync(COOKIE_PATH),
        ensureMasterKey,
        spawnLoginServer,
        waitForLoginCompletion,
        killServer,
        captureFromBrowser,
        encryptSSO,
        saveBlob,
        encryptOnly: args.encryptOnly,
        cookiePath: COOKIE_PATH,
        ssoPath: SSO_PATH,
        log: (msg) => logger.info('login', msg),
    });
}

/**
 * Orchestrate the one-shot login flow.
 *
 * @param {object} deps
 * @param {boolean} deps.cookieExists - true if cookies.sqlite already on disk (idempotent re-run).
 * @param {() => Promise<Buffer>} deps.ensureMasterKey
 * @param {() => Promise<void>} deps.spawnLoginServer
 * @param {() => Promise<void>} deps.waitForLoginCompletion
 * @param {(path: string) => Promise<object>} deps.captureFromBrowser
 * @param {(payload: object, key: Buffer) => Promise<object>} deps.encryptSSO
 * @param {(path: string, blob: object) => Promise<void>} deps.saveBlob
 * @param {boolean} deps.encryptOnly
 * @param {string} deps.cookiePath
 * @param {string} deps.ssoPath
 * @param {(msg: string) => void} deps.log
 */
export async function runLoginOrchestration({
    cookieExists,
    ensureMasterKey,
    spawnLoginServer,
    waitForLoginCompletion,
    killServer,
    captureFromBrowser,
    encryptSSO,
    saveBlob,
    encryptOnly,
    cookiePath,
    ssoPath,
    log,
}) {
    const key = await ensureMasterKey();
    let serverChild = null;

    try {
        if (!cookieExists) {
            // Fresh login: spawn the server in -login mode to open the browser,
            // then poll until cookies.sqlite appears (means SSO completed).
            // spawnLoginServer returns a child handle; do NOT await its exit --
            // the server doesn't auto-exit after SSO, and waiting on it would
            // hang the whole flow. The caller (this function) kills it in finally.
            log('opening browser; complete SSO to continue');
            serverChild = spawnLoginServer();
            await waitForLoginCompletion();
        }
        // If cookieExists: idempotent re-run -- skip the spawn+wait, just re-capture.

        log('SSO completed; capturing cookies');
        const payload = await captureFromBrowser(cookiePath);
        const blob = await encryptSSO(payload, key);
        await saveBlob(ssoPath, blob);
        log(`encrypted SSO state written to ${ssoPath}`);

        if (!encryptOnly) {
            log('done. Run `npm run up` to start the server.');
        }
    } finally {
        // Always kill the spawned server so it doesn't linger on port 3000.
        if (serverChild) {
            log('stopping login-mode server');
            await killServer(serverChild);
        }
    }
}

// Only run main() when this file is the script's entry point.
// Prevents tests from importing this module and accidentally
// spawning the real server / probing the real keychain.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
    main().catch((err) => {
        logger.error('login', err.message);
        process.exit(2);
    });
}