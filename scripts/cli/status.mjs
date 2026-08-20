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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isAvailable } from '../../src/backend/auth/keychain.mjs';
import { probe } from '../../src/backend/auth/probe.mjs';
import { logger } from '../../src/utils/logger.js';

const PID_PATH = path.join(process.cwd(), 'data', 'supervisor.pid');
const SSO_PATH = path.join(process.cwd(), 'data', '.sso.enc');
const LOG_PATH = path.join(process.cwd(), 'data', 'logs', 'system.log');
const MASTER_KEY_FALLBACK = path.join(process.cwd(), 'data', '.master.key');

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
    const cfgPath = path.join(process.cwd(), 'data', 'config.yaml');
    const cfgRaw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
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

    if (!kcAvailable && !existsSync(MASTER_KEY_FALLBACK)) {
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