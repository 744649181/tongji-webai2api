/**
 * @fileoverview Helper to invoke the watchdog from inside PoolManager where
 * the real worker (with browser context + page) is available. This is what
 * makes Try 1 (silent re-inject) actually work -- queue.js cannot reach
 * the worker PoolManager picked, so its watchdog calls must use a stub.
 *
 * Used by src/backend/pool/PoolManager.js _safeExecuteWorker after the
 * adapter returns a 401-shaped error.
 */

import path from 'node:path';
import { handle401 } from './watchdog.js';
import { loadBlob } from './sso.mjs';
import { getMasterKey } from './keychain.mjs';

/**
 * @param {{worker: {name: string, browser: any, page: any}, logger: any, originalRequest: () => Promise<object>}} args
 * @returns {Promise<{ok: boolean, status?: number, reason?: string, recovered?: object}>}
 */
export async function tryWatchdogRecovery({ worker, logger, originalRequest }) {
    const SSO_PATH = path.join(process.cwd(), 'data', '.sso.enc');
    let blob = null;
    let masterKey = null;
    try {
        blob = await loadBlob(SSO_PATH);
        masterKey = await getMasterKey({ allowFileFallback: true });
    } catch (err) {
        logger?.warn?.('recovery', `master key unavailable: ${err.message}`);
    }
    // Worker.browser is the Playwright BrowserContext (see Worker.js _initNewBrowser).
    return handle401({
        worker: {
            name: worker.name,
            context: worker.browser,
            page: worker.page,
        },
        originalRequest,
        logger,
        deps: {
            ssoFilePath: SSO_PATH,
            masterKey,
            ssoBlob: blob,
            notify: {
                desktop: (m) => logger?.warn?.('recovery-notify', `[desktop] ${m}`),
                prompt: (m) => logger?.warn?.('recovery-notify', `[prompt] ${m}`),
                launchBrowserLogin: async () => {
                    logger?.warn?.('recovery', 'interactive re-login requested at PoolManager layer; not auto-launched (use npm run login)');
                    return { ok: false, reason: 'pool_context_no_auto_browser' };
                },
            },
            doRefreshSession: async () => ({ ok: false, status: 404 }),
        },
    });
}

/**
 * Match a 401-shaped error from the adapter.
 * The hiagent adapter returns the error message as a string; we sniff for
 * "401", "403", "unauthorized", or "session expired".
 *
 * @param {any} result
 * @returns {boolean}
 */
export function is401Result(result) {
    if (!result || typeof result !== 'object' || !result.error) return false;
    const msg = result.error;
    if (typeof msg !== 'string') return false;
    return /\b(401|403)\b/.test(msg) || /unauthor/i.test(msg) || /session[ _-]?expired/i.test(msg);
}