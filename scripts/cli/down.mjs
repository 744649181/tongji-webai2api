#!/usr/bin/env node
/**
 * @fileoverview Graceful stop: SIGTERM via supervisor IPC, fall back to PID kill.
 *
 * Usage: node scripts/cli/down.mjs
 * Exit: 0 on success, 1 if no supervisor running.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { logger } from '../../src/utils/logger.js';

const PID_PATH = path.join(process.cwd(), 'data', 'supervisor.pid');
const IPC_PATH = os.platform() === 'win32'
    ? '\\\\.\\pipe\\webai2api-supervisor'
    : path.join(os.tmpdir(), 'webai2api-supervisor.sock');

async function stopViaIpc() {
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
    await new Promise((r) => setTimeout(r, 1500));
    try { unlinkSync(PID_PATH); } catch { /* ignore */ }
    logger.info('down', 'supervisor stopped');
    process.exit(0);
}

main().catch((err) => {
    logger.error('down', err.message);
    process.exit(1);
});