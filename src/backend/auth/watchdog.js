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

import { decryptSSO, MasterKeyUnavailable } from './sso.mjs';

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