import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAlias, decorateModelsForAnthropic } from '../../src/server/api/anthropic/modelMap.js';

test('resolveAlias: claude-sonnet-4-5 → DeepSeek-V4-Pro', () => {
    assert.equal(resolveAlias('claude-sonnet-4-5'), 'DeepSeek-V4-Pro');
});

test('resolveAlias: claude-haiku-4-5 → DeepSeek-V4-Flash', () => {
    assert.equal(resolveAlias('claude-haiku-4-5'), 'DeepSeek-V4-Flash');
});

test('resolveAlias: claude-opus-4-1 → DeepSeek-R1', () => {
    assert.equal(resolveAlias('claude-opus-4-1'), 'DeepSeek-R1');
});

test('resolveAlias: stable date tags also resolve', () => {
    assert.equal(resolveAlias('claude-sonnet-4-5-20250929'), 'DeepSeek-V4-Pro');
    assert.equal(resolveAlias('claude-haiku-4-5-20251001'), 'DeepSeek-V4-Flash');
    assert.equal(resolveAlias('claude-opus-4-1-20250805'), 'DeepSeek-R1');
});

test('resolveAlias: raw Tongji name passes through unchanged', () => {
    assert.equal(resolveAlias('DeepSeek-V4-Pro'), 'DeepSeek-V4-Pro');
    assert.equal(resolveAlias('GLM-5.1'), 'GLM-5.1');
    assert.equal(resolveAlias('Kimi-K2.6'), 'Kimi-K2.6');
});

test('resolveAlias: config override beats default', () => {
    const result = resolveAlias('claude-sonnet-4-5', { 'claude-sonnet-4-5': 'GLM-5.1' });
    assert.equal(result, 'GLM-5.1');
});

test('resolveAlias: unknown claude-* alias returns null', () => {
    assert.equal(resolveAlias('claude-unknown-future'), null);
});

test('decorateModelsForAnthropic: adds display_name to each model', () => {
    const decorated = decorateModelsForAnthropic([
        { id: 'DeepSeek-V4-Pro', imagePolicy: 'forbidden', type: 'text' },
        { id: 'GLM-5.1', imagePolicy: 'forbidden', type: 'text' },
    ]);
    assert.equal(decorated.length, 2);
    assert.equal(typeof decorated[0].display_name, 'string');
    assert.ok(decorated[0].display_name.length > 0);
});