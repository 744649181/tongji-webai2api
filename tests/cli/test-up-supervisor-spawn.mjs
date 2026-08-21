/**
 * Regression test for: `npm run up` (in PowerShell via npm.cmd) reports
 * `supervisor started (PID ...)` then the supervisor dies almost immediately.
 *
 * Root cause: scripts/cli/up.mjs spawns supervisor.js with
 *   stdio: 'inherit', detached: true
 * On Windows, `stdio: 'inherit'` ties the child's stdio handles to the parent's
 * console. When the parent process (npm.cmd → node up.mjs) exits, those
 * handles close and the detached child receives an early termination signal
 * BEFORE main() ever runs.
 *
 * The fix is to make the child's stdio independent of the parent's console —
 * typically by passing an open file descriptor as stdio[1]/stdio[2], or by
 * piping stdout/stderr to a log file the child writes to independently.
 *
 * These tests are static (source-level) because the actual process-lifecycle
 * behavior is too heavy to test in a single Node process — but they catch
 * the exact regression that broke npm run up on Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const UP_MJS_PATH = new URL('../../scripts/cli/up.mjs', import.meta.url);
const UP_MJS_SRC = fs.readFileSync(UP_MJS_PATH, 'utf8');

/** Find the spawn() call that launches supervisor.js inside spawnSupervisor(). */
function extractSupervisorSpawnOptions(src) {
    // Match: spawn(process.execPath, ['supervisor.js'], { ...options })
    // Allow variable whitespace and any opts body (single regex pass, non-greedy).
    const m = src.match(/spawn\(\s*process\.execPath\s*,\s*\[\s*['"]supervisor\.js['"]\s*\][\s\S]*?\}\s*\)/);
    if (!m) throw new Error('Could not locate spawn(process.execPath, [supervisor.js], {...}) call in up.mjs');
    // Extract just the options object contents.
    const optsMatch = m[0].match(/,\s*\{([\s\S]*)\}\s*\)\s*$/);
    if (!optsMatch) throw new Error('Could not extract options body from spawn() call');
    return optsMatch[1];
}

test('up.mjs spawns supervisor with detached: true (so child survives parent exit)', () => {
    const opts = extractSupervisorSpawnOptions(UP_MJS_SRC);
    assert.match(
        opts,
        /detached:\s*true/,
        'spawn options must include `detached: true`. Without it, child dies when npm.cmd exits.'
    );
});

test('up.mjs does NOT use stdio: inherit for supervisor (causes early child death on Windows via npm.cmd)', () => {
    const opts = extractSupervisorSpawnOptions(UP_MJS_SRC);
    assert.doesNotMatch(
        opts,
        /stdio:\s*['"]inherit['"]/,
        'stdio: inherit ties child stdio to parent console; on Windows, npm.cmd exiting closes the inherited handles and kills the detached child before main() runs. Use a log file fd or independent pipe instead.'
    );
});

test('up.mjs forwards supervisor output to a file (so console.log is not lost when stdio is decoupled from parent)', () => {
    // After the fix, supervisor's stdout goes somewhere persistent (a log file).
    // We accept either: (a) stdio array has an fd (numeric or via identifier),
    // and a corresponding openSync/open call exists in the same file, or
    // (b) the script attaches a stdout pipe that writes to a file.
    const opts = extractSupervisorSpawnOptions(UP_MJS_SRC);

    // stdio must be an array (not 'inherit'), with at least 3 entries (stdin/stdout/stderr)
    const stdioIsArray = /stdio:\s*\[\s*['"][^'"]*['"]\s*,/.test(opts);
    const hasOpenSync = /\bopen(?:Sync)?\s*\(/.test(UP_MJS_SRC);
    const hasPipeForwarding = /stdout\.pipe\s*\(/.test(UP_MJS_SRC)
        || /stdout\.on\(\s*['"]data['"]/.test(UP_MJS_SRC)
        || /appendFile(?:Sync)?\s*\(/.test(UP_MJS_SRC);

    assert.ok(
        stdioIsArray && (hasOpenSync || hasPipeForwarding),
        'must forward supervisor output to a persistent log file. ' +
        'Currently: stdio array not configured AND no openSync/open/appendFile is set up in up.mjs.'
    );
});
