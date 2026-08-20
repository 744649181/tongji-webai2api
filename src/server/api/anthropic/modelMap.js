/**
 * @fileoverview Anthropic model alias resolution + decoration
 * @description Maps Claude-style aliases (claude-sonnet-4-5) to Tongji hiagent
 * model names (DeepSeek-V4-Pro). Default table is hardcoded; data/config.yaml
 * overrides via the optional `anthropic.modelMap` field.
 */

const DEFAULT_ALIASES = Object.freeze({
    'claude-sonnet-4-5': 'DeepSeek-V4-Pro',
    'claude-sonnet-4-5-20250929': 'DeepSeek-V4-Pro',
    'claude-haiku-4-5': 'DeepSeek-V4-Flash',
    'claude-haiku-4-5-20251001': 'DeepSeek-V4-Flash',
    'claude-opus-4-1': 'DeepSeek-R1',
    'claude-opus-4-1-20250805': 'DeepSeek-R1',
});

/**
 * Resolve an Anthropic model alias to a Tongji model name.
 * @param {string} name - The model name from the Anthropic request.
 * @param {Object} [overrideMap] - Optional override map (from data/config.yaml).
 * @returns {string|null} The resolved Tongji model name, or null if unknown.
 *
 * Resolution order:
 *   1. overrideMap[name] (if provided)
 *   2. DEFAULT_ALIASES[name]
 *   3. name itself (passthrough if it does not start with "claude-")
 *   4. null (unknown)
 */
export function resolveAlias(name, overrideMap) {
    if (typeof name !== 'string' || !name) return null;
    if (overrideMap && typeof overrideMap[name] === 'string') return overrideMap[name];
    if (Object.prototype.hasOwnProperty.call(DEFAULT_ALIASES, name)) return DEFAULT_ALIASES[name];
    // Passthrough: any non-claude-* name is treated as a raw Tongji model id.
    if (!name.startsWith('claude-')) return name;
    return null;
}

/**
 * Decorate a list of Tongji models with Anthropic-friendly fields.
 * @param {Array<{id:string, imagePolicy?:string, type?:string}>} models
 * @returns {Array<{id:string, display_name:string, type:string}>}
 */
export function decorateModelsForAnthropic(models) {
    if (!Array.isArray(models)) return [];
    return models.map((m) => ({
        id: m.id,
        display_name: m.id,
        type: m.type || 'text',
    }));
}