import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Regression test for the missing-tongji-worker bug:
 *
 *   1. login.mjs hardcodes `-login=tongji` and reads cookies from
 *      data/camoufoxUserData_tongji/cookies.sqlite.
 *   2. server.js -login mode initializes only the requested worker; if no
 *      worker named "tongji" exists in any instance, the pool fails and the
 *      server enters safe mode -- browser never opens.
 *   3. So config.example.yaml MUST include a tongji worker entry, and that
 *      entry's userDataMark MUST be "tongji" to match login.mjs's path.
 *
 * This test fails if a rebase from upstream drops the entry, or if someone
 * renames it without updating login.mjs.
 */

const EXAMPLE_CONFIG = path.join(process.cwd(), 'config.example.yaml');

test('config.example.yaml: contains a tongji worker entry', () => {
    const cfg = parseYaml(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
    const instances = cfg?.backend?.pool?.instances || [];
    const tongjiWorker = findWorker(instances, 'tongji', 'tongji');
    assert.ok(
        tongjiWorker,
        'config.example.yaml must declare an instance with a worker named "tongji" of type "tongji"',
    );
});

test('config.example.yaml: tongji instance uses userDataMark=tongji (matches login.mjs COOKIE_PATH)', () => {
    const cfg = parseYaml(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
    const instances = cfg?.backend?.pool?.instances || [];
    const instance = findInstanceWithWorker(instances, 'tongji');
    assert.ok(instance, 'tongji worker instance must exist');
    assert.equal(
        instance.userDataMark,
        'tongji',
        'tongji instance.userDataMark must be "tongji" so cookies land in data/camoufoxUserData_tongji (the path login.mjs hardcodes)',
    );
});

function findWorker(instances, workerName, workerType) {
    for (const inst of instances) {
        for (const w of inst.workers || []) {
            if (w.name === workerName && w.type === workerType) return w;
        }
    }
    return null;
}

function findInstanceWithWorker(instances, workerName) {
    for (const inst of instances) {
        for (const w of inst.workers || []) {
            if (w.name === workerName) return inst;
        }
    }
    return null;
}