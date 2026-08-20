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

    logger.info('login', 'SSO completed; capturing cookies');
    const payload = await captureFromBrowser(COOKIE_PATH);
    const blob = await encryptSSO(payload, key);
    await saveBlob(SSO_PATH, blob);
    logger.info('login', `encrypted SSO state written to ${SSO_PATH}`);

    if (!args.encryptOnly) {
        logger.info('login', 'done. Run `npm run up` to start the server.');
    }
}

main().catch((err) => {
    logger.error('login', err.message);
    process.exit(2);
});