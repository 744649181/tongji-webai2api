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
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

import { probe } from '../../src/backend/auth/probe.mjs';
import { logger } from '../../src/utils/logger.js';

const SSO_PATH = path.join(process.cwd(), 'data', '.sso.enc');
const PID_PATH = path.join(process.cwd(), 'data', 'supervisor.pid');
const SUPERVISOR_LOG_PATH = path.join(process.cwd(), 'data', 'logs', 'supervisor.log');

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
    mkdirSync(path.dirname(SUPERVISOR_LOG_PATH), { recursive: true });
    // Open a log file BEFORE spawning. We pass its file descriptor as the
    // supervisor's stdout/stderr so the child's console.log output is
    // captured persistently — independent of any parent's console handles.
    //
    // We deliberately avoid `stdio: 'inherit'` here: on Windows, when this
    // script runs via `npm.cmd`, inheriting stdio ties the supervisor to
    // npm.cmd's console, and the supervisor dies almost immediately after
    // we exit (closes the inherited handles before main() runs).
    // detached: true + a real file fd makes the child self-sufficient.
    const logFd = openSync(SUPERVISOR_LOG_PATH, 'a');
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['supervisor.js'], {
            cwd: process.cwd(),
            stdio: ['ignore', logFd, logFd],
            detached: true,
        });
        child.on('spawn', () => {
            writeFileSync(PID_PATH, String(child.pid));
            writeFileSync(SUPERVISOR_LOG_PATH,
                `[up.mjs ${new Date().toISOString()}] supervisor spawned PID=${child.pid}\n`,
                { flag: 'a' });
            resolve(child);
        });
        child.on('error', (err) => {
            writeFileSync(SUPERVISOR_LOG_PATH,
                `[up.mjs ${new Date().toISOString()}] spawn error: ${err.message}\n`,
                { flag: 'a' });
            reject(err);
        });
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