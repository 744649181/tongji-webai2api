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
            return { ok: true, waited: false };
        },
    };
}