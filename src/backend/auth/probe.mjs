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
    if (!activeCheck) {
        if (ageDays < staleAfterDays) {
            return { valid: true, reason: 'VALID_MTIME', age: ageDays, source: 'mtime' };
        }
        return { valid: false, reason: 'STALE_MTIME', age: ageDays };
    }
    const r = await activeCheck();
    if (r.ok) {
        return { valid: true, reason: 'VALID_ACTIVE', age: ageDays, source: 'active' };
    }
    if (r.status === 401 || r.status === 403) {
        return { valid: false, reason: 'PROBE_401', age: ageDays, source: 'active' };
    }
    return { valid: false, reason: r.error ? 'NETWORK_ERROR' : 'PROBE_OTHER', age: ageDays, source: 'active' };
}