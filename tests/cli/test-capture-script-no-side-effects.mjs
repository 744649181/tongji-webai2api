/**
 * Regression test for: importing `scripts/capture-tongji-scenarios.mjs` from
 * a test file (e.g. tests/cli/test-sse-parser.mjs which imports parseSseFrames)
 * was triggering the entire 10-scenario capture run as a module side effect,
 * silently overwriting captures/ on every `node --test` invocation.
 *
 * Same anti-pattern as the `fix(login): guard main() against test-import
 * side-effect` already documented in CONTRIBUTING.md.
 *
 * Strategy: BEFORE import, ensure captures/summary.json does NOT exist
 * (simulate the fresh-test-run state). Then import the module. Then
 * assert captures/summary.json still does NOT exist (import did not
 * trigger main()).
 *
 * If the guard regresses, importing the script will run main(), which
 * writes captures/summary.json, and this test will fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';

const CAPTURE_DIR = path.join(process.cwd(), 'captures');
const SUMMARY = path.join(CAPTURE_DIR, 'summary.json');

function rmrf(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) rmrf(p);
        else unlinkSync(p);
    }
}

test('importing capture script does NOT run scenarios as a side effect', async () => {
    // Simulate "fresh test run" state: no captures/ contents.
    rmrf(CAPTURE_DIR);

    // Now import — if main() runs as a side effect, it'll recreate captures/.
    const mod = await import('../../scripts/capture-tongji-scenarios.mjs');

    // Exported helpers still callable.
    assert.equal(typeof mod.parseSseFrames, 'function', 'parseSseFrames must be exported');
    assert.equal(typeof mod.SERVER, 'string', 'SERVER constant must be exported');

    // Captures/ must STILL be empty (import did NOT run scenarios).
    const stillEmpty = !existsSync(SUMMARY) && (readdirSync(CAPTURE_DIR).length === 0);
    assert.ok(
        stillEmpty,
        `importing the capture script ran main() as a side effect — ` +
        `captures/summary.json was created. contents: ${readdirSync(CAPTURE_DIR).join(', ')}`
    );
});
