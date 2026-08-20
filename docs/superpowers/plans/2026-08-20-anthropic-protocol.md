# Anthropic-protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Anthropic-protocol HTTP API surface (`/v1/messages`, `/v1/models`, `/v1/messages/count_tokens`) to tongji-webai2api, alongside the existing OpenAI-compatible surface. Client integration: `@anthropic-ai/sdk` and Claude Code CLI work without modification.

**Architecture:** A new `src/server/api/anthropic/` package routes HTTP requests, translates Anthropic request shape to the existing internal canonical request, calls `queueManager.addTask(...)` (zero changes to the tongji adapter), and writes Anthropic SSE events from the `onDelta` callback stream. Six new files; one supervisor mount; one devDep; no changes to `tongji.js`, `queue.js`, `respond.js`, `pool/`, or any upstream adapter.

**Tech Stack:** Node.js 20+ (built-in `node:test`, `node:http`, `node:assert`); existing `playwright-core`, `camoufox-js`, ESM modules, `#config/#utils/#backend/#server` import aliases. New devDep: `@anthropic-ai/sdk@^0.40` (smoke test only, not a runtime dep).

---

## File Structure

### New files (created)

| File | Responsibility |
|------|----------------|
| `src/server/api/anthropic/errors.js` | Anthropic error shape: `{type:"error", error:{type,message,request_id}}`; HTTP status mapping table; `sendApiError(res, {status, type, message, requestId, isStreaming})` |
| `src/server/api/anthropic/modelMap.js` | Resolve Anthropic alias (`claude-sonnet-4-5`) → Tongji model (`DeepSeek-V4-Pro`). Default table + `data/config.yaml#anthropic.modelMap` override. `resolveAlias(name)`; `decorateModelsForAnthropic(models)` |
| `src/server/api/anthropic/tools.js` | Pure functions: `toolsToPromptSuffix(tools)` → string; `parseToolCallsFromText(text, tools)` → `{toolUses: [...], warning: string|null}`; `renderToolResultForPrompt(toolUseId, content)` → string; `renderAssistantToolUseForPrompt(name, input)` → string |
| `src/server/api/anthropic/sse.js` | Anthropic SSE writer: `createAnthropicSseWriter(res, {messageId, model, inputTokens})` returning `{startTextBlock, writeTextDelta, startThinkingBlock, writeThinkingDelta, stopBlock, startToolUseBlock, writeToolInputDelta, stopToolUseBlock, writeMessageDelta, writeMessageStop, writeError, writePing, end}`. Stateful writer that emits events in correct order and never emits `content_block_stop` twice for the same index. |
| `src/server/api/anthropic/parse.js` | Translate Anthropic request → canonical request: `parseAnthropicRequest(body, ctx)` returning `{messages, systemPrompt, model, maxTokens, temperature, tools, thinking, stream, meta}`. Validates: x-api-key, anthropic-version, schema. Rejects vision (400). Calls modelMap + tools. |
| `src/server/api/anthropic/routes.js` | HTTP router: `createAnthropicRouter(ctx)` returning `(req, res) => Promise<void>`. Three handlers: `handleMessages`, `handleModels`, `handleCountTokens`. Mounts on `POST /v1/messages`, `GET /v1/models`, `POST /v1/messages/count_tokens`. |
| `tests/anthropic/test-modelMap.mjs` | Unit test for `modelMap.js` |
| `tests/anthropic/test-errors.mjs` | Unit test for `errors.js` |
| `tests/anthropic/test-tools.mjs` | Unit test for `tools.js` |
| `tests/anthropic/test-sse.mjs` | Unit test for `sse.js` |
| `tests/anthropic/test-parse.mjs` | Unit test for `parse.js` |
| `tests/anthropic/test-routes-integration.mjs` | Integration test: spawns router in-process, sends requests, asserts response shapes |
| `scripts/smoke-test-anthropic.mjs` | Live E2E smoke test (requires running server) |

### Modified files

| File | Change |
|------|--------|
| `supervisor.js` | Add import of `createAnthropicRouter`; mount it on the HTTP server. ~10 lines. |
| `config.example.yaml` | Document new optional `anthropic.modelMap` field under root. ~5 lines. |
| `package.json` | Add `@anthropic-ai/sdk@^0.40` to `devDependencies`. |
| `.github/workflows/ci.yml` | Add `anthropic-smoke` job (manual `workflow_dispatch` trigger) + structural check step. |
| `AGENTS.md` | Add new §11 "Anthropic protocol" mirroring §3 (hard guardrails + adapter contract extensions). |
| `README.md` | Add "Anthropic API" section with `curl` example and Claude Code CLI setup. |

### Untouched (verified by spec §5)

`src/backend/adapter/tongji.js`, all other `src/backend/adapter/*.js`, `src/server/queue.js`, `src/server/respond.js`, `src/backend/pool/`, `src/backend/registry.js`, `src/backend/strategies/`, `patches/`, `webui/`.

---

## Task 1: Add dev dependency for smoke test

**Files:**
- Modify: `package.json` (add `@anthropic-ai/sdk` to devDependencies)
- (No test)

- [ ] **Step 1: Verify the SDK version we need**

Run:

```bash
cd E:/playgroud/tongji-webai2api && npm view @anthropic-ai/sdk version
```

Expected: a stable version string like `0.40.1` (or whatever is current). The SDK's API has been stable since 0.20+, so any `^0.30.0` or higher is fine.

- [ ] **Step 2: Edit `package.json`**

Open `E:/playgroud/tongji-webai2api/package.json`. After the `"type": "module"` line (or wherever devDependencies would naturally go), add a `devDependencies` block:

```json
"devDependencies": {
  "@anthropic-ai/sdk": "^0.40.0"
}
```

(Use the actual current major version discovered in Step 1; if it's `0.41.0`, use `^0.41.0`.)

- [ ] **Step 3: Install**

Run:

```bash
cd E:/playgroud/tongji-webai2api && npm install
```

Expected: `@anthropic-ai/sdk` added to `node_modules/`, no errors, no peer-dep warnings beyond the standard ones.

- [ ] **Step 4: Verify the SDK loads**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node -e "import('@anthropic-ai/sdk').then(m => console.log('SDK exports:', Object.keys(m).slice(0,5)))"
```

Expected: prints an array of export names like `['Anthropic', 'APIError', ...]`. Exit 0.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add package.json package-lock.json && git commit -m "chore(deps): add @anthropic-ai/sdk devDep for smoke test"
```

---

## Task 2: `modelMap.js` + unit test

**Files:**
- Create: `src/server/api/anthropic/modelMap.js`
- Create: `tests/anthropic/test-modelMap.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/anthropic/test-modelMap.mjs`:

```javascript
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

test('resolveAlias: unknown alias returns null', () => {
    assert.equal(resolveAlias('gpt-99-ultra'), null);
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
```

- [ ] **Step 2: Run the test — it must fail**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-modelMap.mjs
```

Expected: FAIL with `Cannot find module '../../src/server/api/anthropic/modelMap.js'` or similar.

- [ ] **Step 3: Implement `modelMap.js`**

Create `E:/playgroud/tongji-webai2api/src/server/api/anthropic/modelMap.js`:

```javascript
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
 *   3. name itself (passthrough if it looks like a valid Tongji model name)
 *   4. null (unknown)
 */
export function resolveAlias(name, overrideMap) {
    if (typeof name !== 'string' || !name) return null;
    if (overrideMap && typeof overrideMap[name] === 'string') return overrideMap[name];
    if (Object.prototype.hasOwnProperty.call(DEFAULT_ALIASES, name)) return DEFAULT_ALIASES[name];
    // Passthrough: if the name contains a hyphen (Tongji model naming style)
    // and is not an unknown claude-* alias, accept it as-is.
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
```

- [ ] **Step 4: Run the test — it must pass**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-modelMap.mjs
```

Expected: 8 tests pass, 0 fail. Output ends with `# tests 8 / # pass 8 / # fail 0`.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/server/api/anthropic/modelMap.js tests/anthropic/test-modelMap.mjs && git commit -m "feat(anthropic): model alias resolver + display decoration"
```

---

## Task 3: `errors.js` + unit test

**Files:**
- Create: `src/server/api/anthropic/errors.js`
- Create: `tests/anthropic/test-errors.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/anthropic/test-errors.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockRes } from './helpers/mockRes.js';
import { sendApiError, anthropicErrorBody } from '../../src/server/api/anthropic/errors.js';

test('anthropicErrorBody: standard shape', () => {
    const body = anthropicErrorBody({
        type: 'authentication_error',
        message: 'invalid x-api-key',
        requestId: 'req_abc123',
    });
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
    assert.equal(body.error.message, 'invalid x-api-key');
    assert.equal(body.error.request_id, 'req_abc123');
});

test('sendApiError: non-streaming JSON response', () => {
    const res = createMockRes();
    sendApiError(res, {
        status: 401,
        type: 'authentication_error',
        message: 'bad key',
        requestId: 'req_xyz',
        isStreaming: false,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['Content-Type'], 'application/json');
    const body = JSON.parse(res.body);
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
});

test('sendApiError: streaming sends error event then closes', () => {
    const res = createMockRes();
    sendApiError(res, {
        status: 503,
        type: 'overloaded_error',
        message: 'queue full',
        requestId: 'req_stream',
        isStreaming: true,
    });
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /^event: error\ndata: /);
    assert.match(res.body, /"type":"overloaded_error"/);
});
```

Also create `E:/playgroud/tongji-webai2api/tests/anthropic/helpers/mockRes.js`:

```javascript
/**
 * Minimal mock of node:http.ServerResponse for unit tests.
 * Captures statusCode, headers, and body writes.
 */
export function createMockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: '',
        writableEnded: false,
        writeHead(code, headers) {
            this.statusCode = code;
            this.headers = { ...this.headers, ...headers };
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        write(chunk) {
            if (this.writableEnded) return;
            this.body += chunk;
            return true;
        },
        end(chunk) {
            if (chunk) this.body += chunk;
            this.writableEnded = true;
        },
    };
    return res;
}
```

- [ ] **Step 2: Run the test — it must fail**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-errors.mjs
```

Expected: FAIL — `errors.js` does not exist.

- [ ] **Step 3: Implement `errors.js`**

Create `E:/playgroud\tongji-webai2api\src\server\api\anthropic\errors.js`:

```javascript
/**
 * @fileoverview Anthropic-protocol error formatting
 * @description Maps internal error conditions to Anthropic's
 * {type:"error", error:{type, message, request_id}} shape and writes
 * the appropriate HTTP/SSE response.
 */

/**
 * Build an Anthropic-shaped error body (no HTTP interaction).
 * @param {{type: string, message: string, requestId: string}} opts
 * @returns {{type: "error", error: {type: string, message: string, request_id: string}}}
 */
export function anthropicErrorBody({ type, message, requestId }) {
    return {
        type: 'error',
        error: {
            type,
            message,
            request_id: requestId,
        },
    };
}

/**
 * Send an Anthropic-shaped error response.
 *
 * Non-streaming: JSON body, headers flushed immediately.
 * Streaming: SSE response with one `event: error` data line, then end.
 *   Note: per Anthropic convention, NO `message_stop` after a mid-stream
 *   error event. The stream simply ends.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   status: number,
 *   type: string,
 *   message: string,
 *   requestId: string,
 *   isStreaming?: boolean,
 * }} opts
 */
export function sendApiError(res, { status, type, message, requestId, isStreaming = false }) {
    if (res.writableEnded) return;
    const body = anthropicErrorBody({ type, message, requestId });
    if (isStreaming) {
        res.writeHead(status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
        res.end();
        return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
```

- [ ] **Step 4: Run the test — it must pass**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-errors.mjs
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/server/api/anthropic/errors.js tests/anthropic/ && git commit -m "feat(anthropic): error formatting + streaming error event"
```

---

## Task 4: `tools.js` (prompt formatter + parser) + unit test

**Files:**
- Create: `src/server/api/anthropic/tools.js`
- Create: `tests/anthropic/test-tools.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/anthropic/test-tools.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    toolsToPromptSuffix,
    parseToolCallsFromText,
    renderToolResultForPrompt,
    renderAssistantToolUseForPrompt,
} from '../../src/server/api/anthropic/tools.js';

const SAMPLE_TOOLS = [
    {
        name: 'get_weather',
        description: '获取指定城市的天气',
        input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
        },
    },
    {
        name: 'search_docs',
        description: '搜索文档',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    },
];

test('toolsToPromptSuffix: lists every tool with name, description, schema', () => {
    const suffix = toolsToPromptSuffix(SAMPLE_TOOLS);
    assert.match(suffix, /get_weather/);
    assert.match(suffix, /获取指定城市的天气/);
    assert.match(suffix, /search_docs/);
    assert.match(suffix, /搜索文档/);
    // JSON schema is dumped verbatim
    assert.match(suffix, /"city"/);
    assert.match(suffix, /"type":\s*"object"/);
    // Includes call-format instructions
    assert.match(suffix, /<tool_use>/);
    assert.match(suffix, /\{"name":/);
});

test('toolsToPromptSuffix: empty input returns empty string', () => {
    assert.equal(toolsToPromptSuffix([]), '');
    assert.equal(toolsToPromptSuffix(null), '');
    assert.equal(toolsToPromptSuffix(undefined), '');
});

test('parseToolCallsFromText: extracts a single valid tool_use', () => {
    const text = '我帮你查天气。\n<tool_use>{"name":"get_weather","arguments":{"city":"上海"}}</tool_use>';
    const result = parseToolCallsFromText(text, SAMPLE_TOOLS);
    assert.equal(result.warning, null);
    assert.equal(result.toolUses.length, 1);
    assert.equal(result.toolUses[0].name, 'get_weather');
    assert.deepEqual(result.toolUses[0].input, { city: '上海' });
});

test('parseToolCallsFromText: appends warning and returns no toolUse on bad JSON', () => {
    const text = '<tool_use>{"name":"get_weather","arguments":not_json}</tool_use>';
    const result = parseToolCallsFromText(text, SAMPLE_TOOLS);
    assert.equal(result.toolUses.length, 0);
    assert.match(result.warning, /tool_parse_failed/);
});

test('parseToolCallsFromText: rejects unknown tool name', () => {
    const text = '<tool_use>{"name":"unknown_tool","arguments":{}}</tool_use>';
    const result = parseToolCallsFromText(text, SAMPLE_TOOLS);
    assert.equal(result.toolUses.length, 0);
    assert.match(result.warning, /unknown tool/);
});

test('parseToolCallsFromText: strips surrounding prose', () => {
    const text = '好的，我查一下。\n<tool_use>{"name":"search_docs","arguments":{"query":"hiagent"}}</tool_use>\n请稍等。';
    const result = parseToolCallsFromText(text, SAMPLE_TOOLS);
    assert.equal(result.toolUses.length, 1);
    assert.equal(result.toolUses[0].name, 'search_docs');
});

test('renderToolResultForPrompt: serializes tool_result for next user message', () => {
    const out = renderToolResultForPrompt('toolu_abc', { temp: 22 });
    assert.match(out, /toolu_abc/);
    assert.match(out, /"temp":\s*22/);
});

test('renderAssistantToolUseForPrompt: serializes tool_use for assistant history', () => {
    const out = renderAssistantToolUseForPrompt('get_weather', { city: '北京' });
    assert.match(out, /get_weather/);
    assert.match(out, /北京/);
    assert.match(out, /<tool_use>/);
});
```

- [ ] **Step 2: Run the test — it must fail**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-tools.mjs
```

Expected: FAIL — `tools.js` does not exist.

- [ ] **Step 3: Implement `tools.js`**

Create `E:/playgroud/tongji-webai2api/src/server/api/anthropic/tools.js`:

```javascript
/**
 * @fileoverview Soft tool synthesis for Anthropic-protocol surface.
 * @description Hiagent (Tongji upstream) has no native tool-use API, so we:
 *   - Render Anthropic tool definitions as a prompt suffix instructing the
 *     model to emit `<tool_use>{json}</tool_use>` when it wants to call a tool.
 *   - Parse the model's output for those blocks and convert to Anthropic
 *     `tool_use` content blocks.
 *   - Render `tool_result` and assistant `tool_use` history entries back
 *     into the prompt for multi-turn tool workflows.
 *
 * Limitations: no JSON Schema validator, no streaming input_json_delta,
 * tool_choice is honored as a hint only. See spec §10.
 */

/**
 * @typedef {{name:string, description?:string, input_schema?:object}} AnthropicTool
 */

/**
 * Render a tool list as a prompt suffix that instructs the model how to
 * call a tool via JSON wrapped in <tool_use> tags.
 *
 * @param {AnthropicTool[]|null|undefined} tools
 * @returns {string} Prompt suffix (empty if no tools).
 */
export function toolsToPromptSuffix(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    const lines = [
        '[系统指令：你可以使用以下工具之一来回答用户问题。',
        '调用格式：严格 JSON，紧跟你的文本后，用<tool_use>...</tool_use> 包起来。]',
        '',
    ];
    tools.forEach((tool, i) => {
        if (!tool || typeof tool.name !== 'string') return;
        lines.push(`工具 ${i + 1}:`);
        lines.push(`名称: ${tool.name}`);
        if (tool.description) lines.push(`描述: ${tool.description}`);
        lines.push('参数 schema:');
        lines.push(JSON.stringify(tool.input_schema || {}));
        lines.push('');
    });
    lines.push('[用户问完之后，如果你决定调用工具，请这样输出：]');
    lines.push('<tool_use>');
    lines.push('{"name":"<tool_name>","arguments":{<args>}}');
    lines.push('</tool_use>');
    lines.push('');
    lines.push('[不要在 JSON 之外描述工具调用。每次回答最多一个工具调用。]');
    return lines.join('\n');
}

/**
 * Scan model output for `<tool_use>...</tool_use>` JSON blocks and
 * validate them against the provided tool list.
 *
 * @param {string} text - Full model output (after stream ends, or non-stream).
 * @param {AnthropicTool[]} tools - Tool definitions for validation.
 * @returns {{toolUses: Array<{name:string, input:object}>, warning: string|null}}
 */
export function parseToolCallsFromText(text, tools) {
    const out = { toolUses: [], warning: null };
    if (typeof text !== 'string' || !text) return out;
    const toolList = Array.isArray(tools) ? tools : [];
    const nameToTool = new Map(toolList.filter((t) => t && t.name).map((t) => [t.name, t]));
    const re = /<tool_use>([\s\S]*?)<\/tool_use>/g;
    let m;
    let malformed = 0;
    while ((m = re.exec(text)) !== null) {
        const raw = m[1].trim();
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            malformed++;
            continue;
        }
        if (!parsed || typeof parsed.name !== 'string' || !nameToTool.has(parsed.name)) {
            malformed++;
            continue;
        }
        const input = (parsed.arguments && typeof parsed.arguments === 'object') ? parsed.arguments : {};
        out.toolUses.push({ name: parsed.name, input });
    }
    if (malformed > 0) {
        out.warning = `[tool_parse_failed: ${malformed} block(s) rejected]`;
    }
    return out;
}

/**
 * Render a `tool_result` content block (from a previous user turn) as a
 * prompt segment for the next model invocation.
 *
 * @param {string} toolUseId - The Anthropic tool_use id (e.g. "toolu_abc").
 * @param {object|string} content - The tool result content (object or string).
 * @returns {string}
 */
export function renderToolResultForPrompt(toolUseId, content) {
    const body = typeof content === 'string' ? content : JSON.stringify(content ?? null);
    return `[上次工具调用结果]\nTOOL_ID: ${toolUseId}\nRESULT: ${body}\n`;
}

/**
 * Render an assistant `tool_use` content block (from a previous assistant
 * turn) as a prompt segment for the next model invocation.
 *
 * @param {string} name - Tool name.
 * @param {object} input - Tool arguments.
 * @returns {string}
 */
export function renderAssistantToolUseForPrompt(name, input) {
    return `[我上次决定调用工具]\n<tool_use>{"name":${JSON.stringify(name)},"arguments":${JSON.stringify(input ?? {})}}</tool_use>\n`;
}
```

- [ ] **Step 4: Run the test — it must pass**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-tools.mjs
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/server/api/anthropic/tools.js tests/anthropic/test-tools.mjs && git commit -m "feat(anthropic): soft tool prompt formatting + parser"
```

---

## Task 5: `sse.js` (stateful SSE writer) + unit test

**Files:**
- Create: `src/server/api/anthropic/sse.js`
- Create: `tests/anthropic/test-sse.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/anthropic/test-sse.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockRes } from './helpers/mockRes.js';
import { createAnthropicSseWriter } from '../../src/server/api/anthropic/sse.js';

test('SSE writer: message_start then text delta then message_stop', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, {
        messageId: 'msg_test1',
        model: 'claude-sonnet-4-5',
        inputTokens: 42,
    });
    w.startTextBlock(0);
    w.writeTextDelta(0, 'hello ');
    w.writeTextDelta(0, 'world');
    w.stopBlock(0);
    w.writeMessageDelta({ stop_reason: 'end_turn', output_tokens: 5 });
    w.writeMessageStop();
    w.end();

    // First chunk: message_start
    assert.match(res.body, /event: message_start\ndata: /);
    assert.match(res.body, /"id":"msg_test1"/);
    assert.match(res.body, /"model":"claude-sonnet-4-5"/);
    assert.match(res.body, /"input_tokens":42/);

    // text_delta events
    const textDeltaMatches = res.body.match(/event: content_block_delta\ndata: /g) || [];
    assert.ok(textDeltaMatches.length >= 2);

    // content_block_stop + message_delta + message_stop
    assert.match(res.body, /event: content_block_stop/);
    assert.match(res.body, /event: message_delta\ndata: /);
    assert.match(res.body, /"stop_reason":"end_turn"/);
    assert.match(res.body, /event: message_stop\ndata: /);
    assert.equal(res.writableEnded, true);
});

test('SSE writer: thinking block variant', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_t1', model: 'm', inputTokens: 1 });
    w.startThinkingBlock(0);
    w.writeThinkingDelta(0, 'reasoning step 1');
    w.stopBlock(0);
    w.startTextBlock(1);
    w.writeTextDelta(1, 'final answer');
    w.stopBlock(1);
    w.writeMessageDelta({ stop_reason: 'end_turn', output_tokens: 10 });
    w.writeMessageStop();
    w.end();

    assert.match(res.body, /"type":"thinking"/);
    assert.match(res.body, /"type":"thinking_delta"/);
    assert.match(res.body, /"thinking":"reasoning step 1"/);
    assert.match(res.body, /"type":"text_delta"/);
});

test('SSE writer: tool_use block reconstruction', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_tool', model: 'm', inputTokens: 1 });
    w.startTextBlock(0);
    w.writeTextDelta(0, 'ok ');
    w.stopBlock(0);
    w.startToolUseBlock(1, 'toolu_xyz', 'get_weather', { city: '上海' });
    w.writeToolInputDelta(1, JSON.stringify({ city: '上海' }));
    w.stopBlock(1);
    w.writeMessageDelta({ stop_reason: 'tool_use', output_tokens: 3 });
    w.writeMessageStop();
    w.end();

    assert.match(res.body, /"type":"tool_use"/);
    assert.match(res.body, /"id":"toolu_xyz"/);
    assert.match(res.body, /"name":"get_weather"/);
    assert.match(res.body, /"type":"input_json_delta"/);
    assert.match(res.body, /"stop_reason":"tool_use"/);
});

test('SSE writer: ping event', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_p', model: 'm', inputTokens: 0 });
    w.writePing();
    w.end();
    assert.match(res.body, /event: ping\ndata: \{"type":"ping"\}/);
});

test('SSE writer: writeError emits event: error and closes', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_e', model: 'm', inputTokens: 0 });
    w.writeError({ type: 'overloaded_error', message: 'queue full', requestId: 'req_e' });
    assert.equal(res.writableEnded, true);
    assert.match(res.body, /event: error\ndata: /);
    assert.match(res.body, /"type":"overloaded_error"/);
    // NO message_stop after error
    assert.doesNotMatch(res.body, /event: message_stop/);
});

test('SSE writer: subsequent writeTextDelta after stopBlock is a no-op (defensive)', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_def', model: 'm', inputTokens: 0 });
    w.startTextBlock(0);
    w.writeTextDelta(0, 'a');
    w.stopBlock(0);
    const before = res.body;
    w.writeTextDelta(0, 'b'); // no-op
    assert.equal(res.body, before);
});

test('SSE writer: emits Content-Type and headers on first call', () => {
    const res = createMockRes();
    const w = createAnthropicSseWriter(res, { messageId: 'msg_h', model: 'm', inputTokens: 0 });
    w.startTextBlock(0);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.equal(res.headers['Cache-Control'], 'no-cache');
});
```

- [ ] **Step 2: Run the test — it must fail**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-sse.mjs
```

Expected: FAIL — `sse.js` does not exist.

- [ ] **Step 3: Implement `sse.js`**

Create `E:/playgroud/tongji-webai2api/src/server/api/anthropic/sse.js`:

```javascript
/**
 * @fileoverview Anthropic-protocol SSE writer
 * @description Stateful writer that translates the framework's `onDelta`
 * callback stream into Anthropic's typed SSE event sequence. All event
 * ordering follows Anthropic's reference: message_start → content_block_*
 * → message_delta → message_stop. Mid-stream errors emit `event: error`
 * with no trailing message_stop.
 */

import crypto from 'node:crypto';

/**
 * @typedef {Object} AnthropicSseWriter
 * @property {() => void} startTextBlock
 * @property {(idx:number, text:string) => void} writeTextDelta
 * @property {() => void} startThinkingBlock
 * @property {(idx:number, thinking:string) => void} writeThinkingDelta
 * @property {(idx:number) => void} stopBlock
 * @property {(idx:number, id:string, name:string, input:object) => void} startToolUseBlock
 * @property {(idx:number, partialJson:string) => void} writeToolInputDelta
 * @property {({stop_reason:string, output_tokens:number}) => void} writeMessageDelta
 * @property {() => void} writeMessageStop
 * @property {() => void} writePing
 * @property {({type:string, message:string, requestId:string}) => void} writeError
 * @property {() => void} end
 */

/**
 * Create a stateful Anthropic SSE writer bound to a Node HTTP response.
 *
 * The first call writes headers (`Content-Type: text/event-stream`).
 * Subsequent calls append SSE frames until `end()` or `writeError()`.
 * Block lifecycle: startXxxBlock(idx) → writeXxxDelta(idx, ...) → stopBlock(idx).
 * Calling writeXxxDelta after stopBlock is a defensive no-op.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{messageId:string, model:string, inputTokens:number}} init
 * @returns {AnthropicSseWriter}
 */
export function createAnthropicSseWriter(res, init) {
    const { messageId, model, inputTokens } = init;
    let headersWritten = false;
    let ended = false;
    /** @type {Set<number>} */
    const stoppedBlocks = new Set();

    function ensureHeaders() {
        if (headersWritten || ended) return;
        if (res.writableEnded) { ended = true; return; }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        headersWritten = true;
    }

    function sendEvent(eventName, dataObj) {
        if (ended || res.writableEnded) return;
        ensureHeaders();
        if (ended) return;
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
    }

    function sendRaw(raw) {
        if (ended || res.writableEnded) return;
        ensureHeaders();
        if (ended) return;
        res.write(raw);
    }

    function shortId() {
        return 'toolu_' + crypto.randomBytes(6).toString('hex');
    }

    // message_start is emitted lazily on first block to keep ordering correct
    let messageStartEmitted = false;
    function emitMessageStartOnce() {
        if (messageStartEmitted) return;
        messageStartEmitted = true;
        sendEvent('message_start', {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
        });
    }

    return {
        startTextBlock(idx) {
            if (ended || stoppedBlocks.has(idx)) return;
            emitMessageStartOnce();
            sendEvent('content_block_start', {
                type: 'content_block_start',
                index: idx,
                content_block: { type: 'text', text: '' },
            });
        },
        writeTextDelta(idx, text) {
            if (ended || stoppedBlocks.has(idx) || !text) return;
            sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: idx,
                delta: { type: 'text_delta', text },
            });
        },
        startThinkingBlock(idx) {
            if (ended || stoppedBlocks.has(idx)) return;
            emitMessageStartOnce();
            sendEvent('content_block_start', {
                type: 'content_block_start',
                index: idx,
                content_block: { type: 'thinking', thinking: '' },
            });
        },
        writeThinkingDelta(idx, thinking) {
            if (ended || stoppedBlocks.has(idx) || !thinking) return;
            sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: idx,
                delta: { type: 'thinking_delta', thinking },
            });
        },
        stopBlock(idx) {
            if (ended || stoppedBlocks.has(idx)) return;
            stoppedBlocks.add(idx);
            sendEvent('content_block_stop', {
                type: 'content_block_stop',
                index: idx,
            });
        },
        startToolUseBlock(idx, id, name, input) {
            if (ended || stoppedBlocks.has(idx)) return;
            const toolId = id || shortId();
            emitMessageStartOnce();
            sendEvent('content_block_start', {
                type: 'content_block_start',
                index: idx,
                content_block: {
                    type: 'tool_use',
                    id: toolId,
                    name,
                    input: input || {},
                },
            });
        },
        writeToolInputDelta(idx, partialJson) {
            if (ended || stoppedBlocks.has(idx) || !partialJson) return;
            sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: idx,
                delta: { type: 'input_json_delta', partial_json: partialJson },
            });
        },
        writeMessageDelta({ stop_reason, output_tokens }) {
            if (ended) return;
            emitMessageStartOnce();
            sendEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stop_reason || 'end_turn', stop_sequence: null },
                usage: { output_tokens: output_tokens || 0 },
            });
        },
        writeMessageStop() {
            if (ended) return;
            emitMessageStartOnce();
            sendEvent('message_stop', { type: 'message_stop' });
        },
        writePing() {
            if (ended) return;
            sendRaw('event: ping\ndata: {"type":"ping"}\n\n');
        },
        writeError({ type, message, requestId }) {
            if (ended) return;
            sendEvent('error', {
                type: 'error',
                error: { type, message, request_id: requestId },
            });
            ended = true;
            try { res.end(); } catch { /* ignore */ }
        },
        end() {
            if (ended) return;
            ended = true;
            try { res.end(); } catch { /* ignore */ }
        },
    };
}
```

- [ ] **Step 4: Run the test — it must pass**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-sse.mjs
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/server/api/anthropic/sse.js tests/anthropic/test-sse.mjs && git commit -m "feat(anthropic): stateful SSE writer with correct event ordering"
```

---

## Task 6: `parse.js` (request translation) + unit test

**Files:**
- Create: `src/server/api/anthropic/parse.js`
- Create: `tests/anthropic/test-parse.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/anthropic/test-parse.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnthropicRequest } from '../../src/server/api/anthropic/parse.js';

const CTX = {
    apiKey: 'sk-test',
    modelMapOverride: null,
    requestId: 'req_unit',
};

test('parseAnthropicRequest: minimal valid request', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
    }, CTX);
    assert.equal(r.model, 'DeepSeek-V4-Pro');
    assert.equal(r.maxTokens, 1024);
    assert.equal(r.stream, false);
    assert.deepEqual(r.systemPrompt, '');
    assert.equal(r.messages[0].role, 'user');
    assert.equal(r.messages[0].content, 'hi');
    assert.equal(r.meta.id, 'req_unit');
});

test('parseAnthropicRequest: resolves alias via config override', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'q' }],
    }, { ...CTX, modelMapOverride: { 'claude-sonnet-4-5': 'GLM-5.1' } });
    assert.equal(r.model, 'GLM-5.1');
});

test('parseAnthropicRequest: passes raw Tongji name through', () => {
    const r = parseAnthropicRequest({
        model: 'Kimi-K2.6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'q' }],
    }, CTX);
    assert.equal(r.model, 'Kimi-K2.6');
});

test('parseAnthropicRequest: rejects unknown model', () => {
    assert.throws(
        () => parseAnthropicRequest({
            model: 'gpt-99-ultra',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'q' }],
        }, CTX),
        /not_found_error|unknown model/i
    );
});

test('parseAnthropicRequest: extracts system prompt as string', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'q' }],
    }, CTX);
    assert.equal(r.systemPrompt, 'You are helpful.');
});

test('parseAnthropicRequest: extracts system prompt from array of blocks', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        system: [
            { type: 'text', text: 'Rule 1.' },
            { type: 'text', text: 'Rule 2.' },
        ],
        messages: [{ role: 'user', content: 'q' }],
    }, CTX);
    assert.match(r.systemPrompt, /Rule 1\./);
    assert.match(r.systemPrompt, /Rule 2\./);
});

test('parseAnthropicRequest: rejects image content with 400', () => {
    assert.throws(
        () => parseAnthropicRequest({
            model: 'claude-sonnet-4-5',
            max_tokens: 100,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fake' } },
                ],
            }],
        }, CTX),
        /vision/i
    );
});

test('parseAnthropicRequest: stream=true sets meta.reasoning when thinking.enabled', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'q' }],
    }, CTX);
    assert.equal(r.stream, true);
    assert.equal(r.meta.reasoning, true);
    assert.equal(r.thinking.budgetTokens, 1024);
});

test('parseAnthropicRequest: tools produce prompt suffix', () => {
    const r = parseAnthropicRequest({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        tools: [{
            name: 'get_weather',
            description: '查询天气',
            input_schema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
            },
        }],
        messages: [{ role: 'user', content: '上海天气如何？' }],
    }, CTX);
    assert.equal(r.tools.length, 1);
    assert.match(r.systemPrompt + r.messages[0].content, /get_weather/);
});

test('parseAnthropicRequest: rejects empty messages', () => {
    assert.throws(
        () => parseAnthropicRequest({
            model: 'claude-sonnet-4-5',
            max_tokens: 100,
            messages: [],
        }, CTX),
        /messages/i
    );
});

test('parseAnthropicRequest: rejects request with no user message', () => {
    assert.throws(
        () => parseAnthropicRequest({
            model: 'claude-sonnet-4-5',
            max_tokens: 100,
            messages: [{ role: 'assistant', content: 'I am alone.' }],
        }, CTX),
        /user/i
    );
});
```

- [ ] **Step 2: Run the test — it must fail**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-parse.mjs
```

Expected: FAIL — `parse.js` does not exist.

- [ ] **Step 3: Implement `parse.js`**

Create `E:/playgroud/tongji-webai2api/src/server/api/anthropic/parse.js`:

```javascript
/**
 * @fileoverview Anthropic → internal canonical request translation
 * @description Reads an Anthropic-shaped POST body, validates it, applies
 * our model alias map, renders tools (if present) as a prompt suffix, and
 * produces a canonical request shape that queueManager.addTask understands.
 *
 * Throws an `AnthropicParseError` (with .status, .type, .message) on any
 * validation failure. The route handler catches it and calls sendApiError.
 */

import { resolveAlias } from './modelMap.js';
import { toolsToPromptSuffix, renderToolResultForPrompt, renderAssistantToolUseForPrompt } from './tools.js';

export class AnthropicParseError extends Error {
    constructor(status, type, message) {
        super(message);
        this.status = status;
        this.type = type;
    }
}

/**
 * Translate an Anthropic request body into a canonical internal request.
 *
 * @param {object} body - Parsed JSON body of POST /v1/messages.
 * @param {{
 *   apiKey: string,
 *   modelMapOverride: object|null,
 *   requestId: string,
 * }} ctx
 * @returns {{
 *   messages: Array<{role:string, content:string}>,
 *   systemPrompt: string,
 *   model: string,
 *   maxTokens: number,
 *   temperature: number|undefined,
 *   tools: object[]|null,
 *   thinking: {enabled:boolean, budgetTokens:number}|null,
 *   stream: boolean,
 *   meta: {id:string, onDelta:Function|null, reasoning:boolean},
 * }}
 */
export function parseAnthropicRequest(body, ctx) {
    if (!body || typeof body !== 'object') {
        throw new AnthropicParseError(400, 'invalid_request_error', 'request body must be a JSON object');
    }

    const { model, max_tokens, system, messages, tools, thinking, stream, temperature } = body;

    // model
    if (!model || typeof model !== 'string') {
        throw new AnthropicParseError(400, 'invalid_request_error', '`model` is required');
    }
    const resolvedModel = resolveAlias(model, ctx.modelMapOverride);
    if (resolvedModel === null) {
        throw new AnthropicParseError(400, 'not_found_error', `unknown model: ${model}`);
    }

    // max_tokens
    if (typeof max_tokens !== 'number' || max_tokens <= 0) {
        throw new AnthropicParseError(400, 'invalid_request_error', '`max_tokens` must be a positive integer');
    }

    // messages
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new AnthropicParseError(400, 'invalid_request_error', '`messages` must be a non-empty array');
    }
    const hasUser = messages.some((m) => m && m.role === 'user');
    if (!hasUser) {
        throw new AnthropicParseError(400, 'invalid_request_error', '`messages` must contain at least one user message');
    }

    // system
    let systemPrompt = '';
    if (typeof system === 'string') {
        systemPrompt = system;
    } else if (Array.isArray(system)) {
        systemPrompt = system
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n');
    }

    // messages translation
    const out = [];
    for (const msg of messages) {
        if (!msg || typeof msg.role !== 'string') continue;
        if (msg.role === 'user') {
            out.push({ role: 'user', content: renderUserMessage(msg.content) });
        } else if (msg.role === 'assistant') {
            out.push({ role: 'assistant', content: renderAssistantMessage(msg.content) });
        }
    }

    // tools → prompt suffix
    const toolsList = Array.isArray(tools) ? tools.filter((t) => t && t.name) : null;
    const toolSuffix = toolsList ? toolsToPromptSuffix(toolsList) : '';
    if (toolSuffix && out.length > 0) {
        // Append tool suffix to the LAST user message (hiagent only reads the
        // last user message; system prompt is merged in by the framework's
        // existing parseTextRequest-style wrapping on the server side).
        const last = out[out.length - 1];
        if (last.role === 'user') {
            last.content = `${last.content}\n\n${toolSuffix}`;
        } else {
            out.push({ role: 'user', content: toolSuffix });
        }
    }

    // thinking
    const thinkingCfg = (thinking && thinking.type === 'enabled')
        ? { enabled: true, budgetTokens: typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 1024 }
        : null;

    const streamFlag = stream === true;
    return {
        messages: out,
        systemPrompt,
        model: resolvedModel,
        maxTokens: max_tokens,
        temperature: typeof temperature === 'number' ? temperature : undefined,
        tools: toolsList,
        thinking: thinkingCfg,
        stream: streamFlag,
        meta: {
            id: ctx.requestId,
            onDelta: null, // set by route handler if streaming
            reasoning: !!thinkingCfg,
        },
    };
}

/**
 * Render a user message content field (string or array of blocks) into a
 * single text string. Rejects image blocks with 400.
 */
function renderUserMessage(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        } else if (block.type === 'image') {
            throw new AnthropicParseError(
                400,
                'invalid_request_error',
                'vision not supported by upstream Tongji hiagent; drop image content or use a text-only model'
            );
        } else if (block.type === 'tool_result') {
            parts.push(renderToolResultForPrompt(block.tool_use_id, block.content));
        }
    }
    return parts.join('\n');
}

/**
 * Render an assistant message content field into a single text string.
 * Handles text + tool_use blocks; ignores unknown types.
 */
function renderAssistantMessage(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        } else if (block.type === 'tool_use') {
            parts.push(renderAssistantToolUseForPrompt(block.name, block.input));
        }
    }
    return parts.join('\n');
}

/**
 * Rough token estimate: 1 token ≈ 4 chars (English). Used for input_tokens
 * in the Anthropic SSE message_start event.
 *
 * @param {string} systemPrompt
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} model - For future per-model tokenizer support.
 * @returns {number}
 */
export function estimateInputTokens(systemPrompt, messages, _model) {
    let total = (systemPrompt || '').length;
    for (const m of messages) total += (m.content || '').length;
    return Math.max(1, Math.ceil(total / 4));
}
```

- [ ] **Step 4: Run the test — it must pass**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-parse.mjs
```

Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/server/api/anthropic/parse.js tests/anthropic/test-parse.mjs && git commit -m "feat(anthropic): request parser with vision rejection + tool synthesis"
```

---

## Task 7: `routes.js` (HTTP handlers) + integration test

**Files:**
- Create: `src/server/api/anthropic/routes.js`
- Create: `tests/anthropic/test-routes-integration.mjs`

- [ ] **Step 1: Write the failing test**

Create `E:/playgroud/tongji-webai2api/tests/anthropic/test-routes-integration.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAnthropicRouter } from '../../src/server/api/anthropic/routes.js';
import { buildStableChatId } from '../../src/server/respond.js';

const PORT = 0; // OS-assigned

function startServer(router) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => router(req, res));
        server.listen(PORT, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port });
        });
    });
}

function request(port, { method, path, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                ...headers,
            },
        }, (res) => {
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const CTX = {
    apiKey: 'sk-test-key',
    modelMapOverride: null,
    // Stub addTask that returns canned text and emits a couple of deltas
    addTask: (req, meta) => {
        return new Promise((resolve) => {
            if (meta.onDelta) {
                meta.onDelta({ content: 'hello ' });
                meta.onDelta({ content: 'world' });
            }
            resolve({ fullText: 'hello world', reasoningText: '' });
        });
    },
    decorateModels: (models) => models.map((m) => ({ ...m, display_name: m.id })),
    rawModels: () => ([
        { id: 'DeepSeek-V4-Pro', imagePolicy: 'forbidden', type: 'text' },
        { id: 'GLM-5.1', imagePolicy: 'forbidden', type: 'text' },
    ]),
};

test('POST /v1/messages: missing x-api-key → 401', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            body: { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
        });
        assert.equal(res.status, 401);
        const body = JSON.parse(res.body);
        assert.equal(body.type, 'error');
        assert.equal(body.error.type, 'authentication_error');
    } finally {
        server.close();
    }
});

test('POST /v1/messages: wrong x-api-key → 401', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'wrong', 'anthropic-version': '2023-06-01' },
            body: { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
        });
        assert.equal(res.status, 401);
    } finally { server.close(); }
});

test('POST /v1/messages: missing anthropic-version → 400', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key' },
            body: { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
        });
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.error.type, 'invalid_request_error');
    } finally { server.close(); }
});

test('POST /v1/messages: non-stream returns single message JSON', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: {
                model: 'claude-sonnet-4-5',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
            },
        });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.role, 'assistant');
        assert.equal(body.model, 'DeepSeek-V4-Pro');
        assert.equal(body.content[0].type, 'text');
        assert.equal(body.content[0].text, 'hello world');
        assert.equal(body.stop_reason, 'end_turn');
    } finally { server.close(); }
});

test('POST /v1/messages: stream returns SSE event sequence', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: {
                model: 'claude-haiku-4-5',
                max_tokens: 100,
                stream: true,
                messages: [{ role: 'user', content: 'stream please' }],
            },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');
        assert.match(res.body, /event: message_start/);
        assert.match(res.body, /event: content_block_delta/);
        assert.match(res.body, /"text":"hello "/);
        assert.match(res.body, /"text":"world"/);
        assert.match(res.body, /event: message_delta/);
        assert.match(res.body, /event: message_stop/);
    } finally { server.close(); }
});

test('POST /v1/messages: unknown model → 400 not_found_error', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: { model: 'gpt-99-ultra', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] },
        });
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.error.type, 'not_found_error');
    } finally { server.close(); }
});

test('POST /v1/messages: vision content → 400 invalid_request_error', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: {
                model: 'claude-sonnet-4-5',
                max_tokens: 100,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'look' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fake' } },
                    ],
                }],
            },
        });
        assert.equal(res.status, 400);
        const body = JSON.parse(res.body);
        assert.match(body.error.message, /vision/i);
    } finally { server.close(); }
});

test('GET /v1/models: returns decorated list', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'GET',
            path: '/v1/models',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
        });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.ok(Array.isArray(body.data));
        assert.ok(body.data.length >= 2);
        assert.ok(body.data.every((m) => typeof m.display_name === 'string'));
    } finally { server.close(); }
});

test('POST /v1/messages/count_tokens: returns input_tokens estimate', async () => {
    const { server, port } = await startServer(createAnthropicRouter(CTX));
    try {
        const res = await request(port, {
            method: 'POST',
            path: '/v1/messages/count_tokens',
            headers: { 'x-api-key': 'sk-test-key', 'anthropic-version': '2023-06-01' },
            body: {
                model: 'claude-sonnet-4-5',
                messages: [{ role: 'user', content: 'hello world' }],
            },
        });
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(typeof body.input_tokens, 'number');
        assert.ok(body.input_tokens > 0);
    } finally { server.close(); }
});
```

- [ ] **Step 2: Run the test — it must fail**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-routes-integration.mjs
```

Expected: FAIL — `routes.js` does not exist. The integration test will also need `buildStableChatId` to exist in `respond.js` — verify it does:

```bash
cd E:/playgroud/tongji-webai2api && grep -n "buildStableChatId" src/server/respond.js
```

If not present, read `src/server/respond.js` first to find an equivalent (the existing v2 framework uses `chatcmpl-<id>` style). If truly absent, stub it locally in the test for now and open a follow-up.

- [ ] **Step 3: Implement `routes.js`**

Create `E:/playgroud/tongji-webai2api/src/server/api/anthropic/routes.js`:

```javascript
/**
 * @fileoverview Anthropic-protocol HTTP router
 * @description Exposes /v1/messages, /v1/models, /v1/messages/count_tokens.
 * Validates auth + version, parses body via parse.js, dispatches to
 * queueManager.addTask via the injected `addTask`, and writes either an
 * Anthropic SSE stream or a single JSON message response.
 *
 * Required context (see test-routes-integration.mjs for shape):
 *   - apiKey: string
 *   - modelMapOverride: object|null
 *   - addTask: (canonicalReq, meta) => Promise<{fullText, reasoningText}>
 *   - decorateModels: (models) => decorated models
 *   - rawModels: () => Tongji model list
 */

import { parseAnthropicRequest, estimateInputTokens, AnthropicParseError } from './parse.js';
import { createAnthropicSseWriter } from './sse.js';
import { sendApiError } from './errors.js';
import { decorateModelsForAnthropic } from './modelMap.js';
import { parseToolCallsFromText } from './tools.js';
import { buildStableChatId } from '../../respond.js';
import crypto from 'node:crypto';

const SUPPORTED_ANTHROPIC_VERSIONS = new Set([
    '2023-06-01',
    '2023-06-29',
    '2024-01-01',
    '2024-08-01',
]);

/**
 * Create an Anthropic-protocol HTTP router.
 * @param {{
 *   apiKey: string,
 *   modelMapOverride: object|null,
 *   addTask: Function,
 *   decorateModels?: Function,
 *   rawModels: Function,
 * }} ctx
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse) => Promise<void>}
 */
export function createAnthropicRouter(ctx) {
    const decorate = ctx.decorateModels || decorateModelsForAnthropic;

    return async function router(req, res) {
        const requestId = 'req_' + crypto.randomBytes(8).toString('hex');
        const url = req.url || '';

        // ---- auth (all paths) ----
        const apiKeyHeader = req.headers['x-api-key'];
        if (!apiKeyHeader || apiKeyHeader !== ctx.apiKey) {
            return sendApiError(res, {
                status: 401,
                type: 'authentication_error',
                message: 'missing or invalid x-api-key header',
                requestId,
                isStreaming: false,
            });
        }

        // ---- version (Anthropic-style endpoints) ----
        const needsVersion = url.startsWith('/v1/messages') || url.startsWith('/v1/models');
        if (needsVersion) {
            const v = req.headers['anthropic-version'];
            if (typeof v !== 'string' || !SUPPORTED_ANTHROPIC_VERSIONS.has(v)) {
                return sendApiError(res, {
                    status: 400,
                    type: 'invalid_request_error',
                    message: `unsupported anthropic-version: ${v}; supported: ${[...SUPPORTED_ANTHROPIC_VERSIONS].join(', ')}`,
                    requestId,
                    isStreaming: false,
                });
            }
        }

        // ---- read body (POST only) ----
        if (req.method === 'POST') {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch {
                return sendApiError(res, {
                    status: 400,
                    type: 'invalid_request_error',
                    message: 'request body is not valid JSON',
                    requestId,
                    isStreaming: false,
                });
            }
            try {
                if (url === '/v1/messages') return await handleMessages(req, res, body, ctx, requestId, decorate);
                if (url === '/v1/messages/count_tokens') return await handleCountTokens(req, res, body, ctx, requestId, decorate);
                return sendApiError(res, {
                    status: 404,
                    type: 'not_found_error',
                    message: `unknown path: ${url}`,
                    requestId,
                    isStreaming: false,
                });
            } catch (err) {
                if (err instanceof AnthropicParseError) {
                    return sendApiError(res, {
                        status: err.status,
                        type: err.type,
                        message: err.message,
                        requestId,
                        isStreaming: false,
                    });
                }
                // upstream / framework failure
                return sendApiError(res, {
                    status: 502,
                    type: 'api_error',
                    message: err?.message || 'upstream error',
                    requestId,
                    isStreaming: false,
                });
            }
        }

        if (req.method === 'GET' && url === '/v1/models') {
            return handleModels(res, ctx, decorate);
        }

        return sendApiError(res, {
            status: 404,
            type: 'not_found_error',
            message: `unknown path: ${req.method} ${url}`,
            requestId,
            isStreaming: false,
        });
    };
}

/**
 * POST /v1/messages
 */
async function handleMessages(req, res, body, ctx, requestId, _decorate) {
    const parsed = parseAnthropicRequest(body, {
        apiKey: ctx.apiKey,
        modelMapOverride: ctx.modelMapOverride,
        requestId,
    });

    // stream OR non-stream dispatch
    const messageId = buildStableChatId(requestId);
    const inputTokens = estimateInputTokens(parsed.systemPrompt, parsed.messages, parsed.model);

    if (parsed.stream) {
        return runStream(res, parsed, messageId, inputTokens, ctx, requestId);
    }
    return runNonStream(res, parsed, messageId, inputTokens, ctx, requestId);
}

async function runStream(res, parsed, messageId, inputTokens, ctx, requestId) {
    const writer = createAnthropicSseWriter(res, {
        messageId,
        model: parsed.model,
        inputTokens,
    });

    // First block: text or thinking
    let nextIdx = 0;
    let textBuffer = '';
    let reasoningBuffer = '';
    const blockIsThinking = parsed.meta.reasoning;
    const activeBlockIdx = 0;
    if (blockIsThinking) {
        writer.startThinkingBlock(activeBlockIdx);
    } else {
        writer.startTextBlock(activeBlockIdx);
    }

    parsed.meta.onDelta = (delta) => {
        if (res.writableEnded) return;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
            textBuffer += delta.content;
            if (blockIsThinking) {
                // close thinking, open text, then forward
                writer.stopBlock(activeBlockIdx);
                writer.startTextBlock(1);
                writer.writeTextDelta(1, delta.content);
                nextIdx = 1;
            } else {
                writer.writeTextDelta(activeBlockIdx, delta.content);
            }
        } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            reasoningBuffer += delta.reasoning_content;
            if (blockIsThinking) {
                writer.writeThinkingDelta(activeBlockIdx, delta.reasoning_content);
            }
        }
    };

    try {
        const result = await ctx.addTask(parsed, parsed.meta);
        // Close the final text block if we opened a separate text block
        if (blockIsThinking && nextIdx === 1) {
            writer.stopBlock(1);
        } else if (!blockIsThinking) {
            writer.stopBlock(activeBlockIdx);
        }

        // Tool synthesis (reconstruct from final text)
        if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
            const parse = parseToolCallsFromText(result.fullText, parsed.tools);
            if (parse.toolUses.length > 0) {
                const toolIdx = (blockIsThinking ? 2 : 1);
                for (let i = 0; i < parse.toolUses.length; i++) {
                    const t = parse.toolUses[i];
                    writer.startToolUseBlock(toolIdx + i, null, t.name, t.input);
                    writer.writeToolInputDelta(toolIdx + i, JSON.stringify(t.input));
                    writer.stopBlock(toolIdx + i);
                }
                writer.writeMessageDelta({ stop_reason: 'tool_use', output_tokens: Math.max(1, Math.ceil(textBuffer.length / 4)) });
            } else {
                writer.writeMessageDelta({ stop_reason: 'end_turn', output_tokens: Math.max(1, Math.ceil(textBuffer.length / 4)) });
            }
            if (parse.warning) {
                // Append warning as a final text block (if no tool_use was emitted)
                if (parse.toolUses.length === 0) {
                    const warnIdx = blockIsThinking ? 2 : 1;
                    writer.startTextBlock(warnIdx);
                    writer.writeTextDelta(warnIdx, parse.warning);
                    writer.stopBlock(warnIdx);
                }
            }
        } else {
            writer.writeMessageDelta({ stop_reason: 'end_turn', output_tokens: Math.max(1, Math.ceil(textBuffer.length / 4)) });
        }
        writer.writeMessageStop();
        writer.end();
    } catch (err) {
        writer.writeError({
            type: 'api_error',
            message: err?.message || 'upstream error',
            requestId,
        });
    }
}

async function runNonStream(res, parsed, messageId, inputTokens, ctx, requestId) {
    try {
        const result = await ctx.addTask(parsed, parsed.meta);
        const content = [];
        if (parsed.meta.reasoning && result.reasoningText) {
            content.push({ type: 'thinking', thinking: result.reasoningText });
        }
        let textOut = result.fullText || '';
        let stopReason = 'end_turn';
        if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
            const parse = parseToolCallsFromText(textOut, parsed.tools);
            if (parse.toolUses.length > 0) {
                for (const t of parse.toolUses) {
                    content.push({ type: 'tool_use', id: 'toolu_' + crypto.randomBytes(6).toString('hex'), name: t.name, input: t.input });
                }
                stopReason = 'tool_use';
            }
            if (parse.warning) textOut += '\n' + parse.warning;
        }
        content.push({ type: 'text', text: textOut });
        const body = {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: Math.max(1, Math.ceil(textOut.length / 4)) },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    } catch (err) {
        sendApiError(res, {
            status: 502,
            type: 'api_error',
            message: err?.message || 'upstream error',
            requestId,
            isStreaming: false,
        });
    }
}

/**
 * GET /v1/models
 */
function handleModels(res, ctx, decorate) {
    const models = ctx.rawModels ? ctx.rawModels() : [];
    const decorated = decorate(models);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        data: decorated,
        first_id: decorated[0]?.id || null,
        last_id: decorated[decorated.length - 1]?.id || null,
        has_more: false,
    }));
}

/**
 * POST /v1/messages/count_tokens
 */
async function handleCountTokens(req, res, body, ctx, requestId, _decorate) {
    if (!body || !Array.isArray(body.messages)) {
        return sendApiError(res, {
            status: 400,
            type: 'invalid_request_error',
            message: '`messages` is required',
            requestId,
            isStreaming: false,
        });
    }
    const systemStr = typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
            ? body.system.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
            : '';
    const messageTexts = body.messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => (typeof m.content === 'string' ? m.content : ''));
    let total = systemStr.length;
    for (const t of messageTexts) total += t.length;
    const inputTokens = Math.max(1, Math.ceil(total / 4));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: inputTokens }));
}
```

- [ ] **Step 4: Run the test — it must pass**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --test tests/anthropic/test-routes-integration.mjs
```

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add src/server/api/anthropic/routes.js tests/anthropic/test-routes-integration.mjs && git commit -m "feat(anthropic): HTTP router with auth, version check, SSE/JSON dispatch"
```

---

## Task 8: Mount Anthropic router in `supervisor.js`

**Files:**
- Modify: `supervisor.js` (add import + mount)
- (No new test — covered by Task 9 live smoke test)

- [ ] **Step 1: Locate the OpenAI router mount**

Run:

```bash
cd E:/playgroud/tongji-webai2api && grep -n -E "createOpenAIRouter|/v1|openai" supervisor.js
```

Note the line numbers; this is where the OpenAI router is mounted.

- [ ] **Step 2: Add the Anthropic import + mount**

Open `supervisor.js`. Right after the import of `createOpenAIRouter` (or wherever openai routes are imported), add:

```javascript
import { createAnthropicRouter } from './src/server/api/anthropic/routes.js';
```

Then, right after the OpenAI router is mounted, add the Anthropic mount:

```javascript
const anthropicRouter = createAnthropicRouter({
    apiKey: config.server?.auth,
    modelMapOverride: config.anthropic?.modelMap || null,
    addTask: (req, meta) => queueManager.addTask({...req, requestId: meta.id}, { ...meta, onDelta: meta.onDelta }),
    rawModels: () => queueManager.getModels ? queueManager.getModels().data : [],
});
```

Then in the HTTP request handler (where OpenAI routes are dispatched based on `req.url`), add Anthropic paths to the matcher. The simplest approach is a URL-prefix match:

```javascript
if (req.url.startsWith('/v1/messages') || req.url === '/v1/models') {
    return anthropicRouter(req, res);
}
```

This must run BEFORE the OpenAI `/v1/models` matcher (since `/v1/models` is shared) — actually, since both routers handle `/v1/models`, pick whichever surface the client identifies via headers (`x-api-key` for Anthropic, `Authorization: Bearer` for OpenAI). The simplest correct behavior: try Anthropic first when `x-api-key` is present, else OpenAI:

```javascript
if (req.headers['x-api-key']) {
    return anthropicRouter(req, res);
}
```

(For `/v1/chat/completions` and `/v1/cookies`, OpenAI handles — Anthropic router returns 404 not_found_error, which is fine.)

- [ ] **Step 3: Verify it compiles (no syntax error)**

Run:

```bash
cd E:/playgroud/tongji-webai2api && node --check supervisor.js
```

Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add supervisor.js && git commit -m "feat(anthropic): mount router in supervisor alongside OpenAI"
```

---

## Task 9: Live smoke test (`scripts/smoke-test-anthropic.mjs`)

**Files:**
- Create: `scripts/smoke-test-anthropic.mjs`

- [ ] **Step 1: Verify the server can start**

Run:

```bash
cd E:/playgroud/tongji-webai2api && cat data/config.yaml | head -30
```

Confirm `server.auth` is set and `server.port` matches what we'll hit. (Default 3000.)

- [ ] **Step 2: Write the smoke test**

Create `E:/playgroud/tongji-webai2api/scripts/smoke-test-anthropic.mjs`:

```javascript
#!/usr/bin/env node
/**
 * @fileoverview Cross-platform Anthropic-protocol smoke test (9 cases).
 * Requires a running server. Run with: node scripts/smoke-test-anthropic.mjs
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// -------- config --------
const cfgRaw = readFileSync(resolve(ROOT, 'data/config.yaml'), 'utf8');
const portMatch = cfgRaw.match(/^\s*port:\s*(\d+)/m);
const authMatch = cfgRaw.match(/^\s*auth:\s*(\S+)/m);
if (!portMatch || !authMatch) {
    console.error('Could not parse data/config.yaml for port/auth');
    process.exit(2);
}
const PORT = parseInt(portMatch[1], 10);
const API_KEY = authMatch[1];

const BASE_URL = `http://127.0.0.1:${PORT}`;

const client = new Anthropic({
    baseURL: BASE_URL,
    apiKey: API_KEY,
});

// -------- test framework --------
let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
    process.stdout.write(`\n--- ${name} ---\n`);
    try {
        await fn();
        console.log(`PASS: ${name}`);
        passed++;
        results.push({ name, status: 'pass' });
    } catch (err) {
        console.log(`FAIL: ${name}`);
        console.log(`  ${err.message}`);
        if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
        failed++;
        results.push({ name, status: 'fail', error: err.message });
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// -------- cases --------

await test('1. stream with claude-sonnet-4-5', async () => {
    const stream = client.messages.stream({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Reply with exactly the word OK.' }],
    });
    let textChunks = 0;
    let finalText = '';
    let stopReason = null;
    stream.on('text', (delta) => { textChunks++; finalText += delta; });
    const msg = await stream.finalMessage();
    stopReason = msg.stop_reason;
    assert(textChunks >= 1, `expected ≥1 text chunk, got ${textChunks}`);
    assert(msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop', `stop_reason=${msg.stop_reason}`);
    assert(msg.usage.output_tokens > 0, `output_tokens=${msg.usage?.output_tokens}`);
});

await test('2. non-stream with claude-haiku-4-5', async () => {
    const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    assert(msg.role === 'assistant', `role=${msg.role}`);
    assert(Array.isArray(msg.content) && msg.content.length >= 1, 'content non-empty');
    const textBlock = msg.content.find((b) => b.type === 'text');
    assert(textBlock && /PONG/i.test(textBlock.text), `text=${JSON.stringify(textBlock?.text)}`);
});

await test('3. multi-turn native session', async () => {
    const c1 = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    assert(/OK/i.test(c1.content.find((b) => b.type === 'text')?.text || ''), `c1 text=${JSON.stringify(c1.content)}`);
    const c2 = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 128,
        messages: [
            { role: 'user', content: 'My name is Alice. Reply with exactly: OK' },
            { role: 'assistant', content: 'OK' },
            { role: 'user', content: 'What is my name? Reply with just the name.' },
        ],
    });
    const t2 = c2.content.find((b) => b.type === 'text')?.text || '';
    assert(/Alice/i.test(t2), `c2 text=${JSON.stringify(t2)}`);
});

await test('4. extended thinking', async () => {
    const msg = await client.messages.create({
        model: 'claude-opus-4-1',
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 256 },
        messages: [{ role: 'user', content: 'What is 17 * 23? Show your reasoning then the answer.' }],
    });
    const types = msg.content.map((b) => b.type);
    assert(types.includes('thinking'), `expected thinking block; types=${JSON.stringify(types)}`);
    assert(types.includes('text'), `expected text block; types=${JSON.stringify(types)}`);
});

await test('5. tool_use soft synthesis', async () => {
    const msg = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        tools: [{
            name: 'get_weather',
            description: '查询指定城市的天气',
            input_schema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
            },
        }],
        messages: [{ role: 'user', content: '上海天气如何？用 get_weather 工具查询。' }],
    });
    const toolUse = msg.content.find((b) => b.type === 'tool_use');
    assert(toolUse, `expected tool_use block; content=${JSON.stringify(msg.content)}`);
    assert(toolUse.name === 'get_weather', `tool name=${toolUse.name}`);
    assert(toolUse.input && typeof toolUse.input === 'object', 'tool.input present');
});

await test('6. vision rejection', async () => {
    let caught = null;
    try {
        await client.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 100,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
                ],
            }],
        });
    } catch (err) {
        caught = err;
    }
    assert(caught, 'expected error to be thrown');
    assert(caught.status === 400, `status=${caught.status}`);
    assert(/vision/i.test(caught.message), `message=${caught.message}`);
});

await test('7. count_tokens', async () => {
    const res = await fetch(`${BASE_URL}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: 'hello world this is a test' }],
        }),
    });
    assert(res.status === 200, `status=${res.status}`);
    const body = await res.json();
    assert(typeof body.input_tokens === 'number' && body.input_tokens > 0, `input_tokens=${body.input_tokens}`);
});

await test('8. auth failures', async () => {
    // wrong key
    const wrong = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }),
    });
    assert(wrong.status === 401, `wrong-key status=${wrong.status}`);
    const wrongBody = await wrong.json();
    assert(wrongBody.error?.type === 'authentication_error', `wrong-key type=${wrongBody.error?.type}`);

    // missing version
    const noVer = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }),
    });
    assert(noVer.status === 400, `no-version status=${noVer.status}`);
});

await test('9. raw name passthrough', async () => {
    const msg = await client.messages.create({
        model: 'GLM-5.1',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with exactly: RAW_OK' }],
    });
    const t = msg.content.find((b) => b.type === 'text')?.text || '';
    assert(msg.model === 'GLM-5.1', `model echoed=${msg.model}`);
    assert(/RAW_OK/i.test(t), `text=${JSON.stringify(t)}`);
});

// -------- summary --------
console.log(`\n=== summary ===`);
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 3: Start the server (if not running)**

If the supervisor isn't already running:

```bash
cd E:/playgroud/tongji-webai2api && ./start.sh
```

(Windows: `start.bat`.)

Wait ~5 seconds, then verify it's up:

```bash
cd E:/playgroud/tongji-webai2api && ./status.sh
```

Expected: server reports "Server is running on http://127.0.0.1:3000".

- [ ] **Step 4: Run the smoke test**

```bash
cd E:/playgroud/tongji-webai2api && node scripts/smoke-test-anthropic.mjs
```

Expected: all 9 tests PASS. (Some flakiness is acceptable on case 5 — tool_use parsing — depending on the upstream model.)

- [ ] **Step 5: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add scripts/smoke-test-anthropic.mjs && git commit -m "test(anthropic): 9-case cross-platform smoke test using SDK"
```

---

## Task 10: CI integration

**Files:**
- Modify: `.github/workflows/ci.yml` (add `anthropic-smoke` job + structural check step)

- [ ] **Step 1: Read the existing CI file**

```bash
cd E:/playgroud/tongji-webai2api && cat .github/workflows/ci.yml | head -80
```

Note the existing job structure and the pattern for `run-smoke` (the self-hosted-runner job that runs the v2 smoke test).

- [ ] **Step 2: Add the `anthropic-smoke` job (manual `workflow_dispatch`)**

Append a new job to `.github/workflows/ci.yml`:

```yaml
  anthropic-smoke:
    name: Anthropic smoke test (manual)
    runs-on: self-hosted
    if: contains(github.event.label.name, 'run-anthropic-smoke') || github.event_name == 'workflow_dispatch'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: ./start.sh
      - run: sleep 5
      - run: node scripts/smoke-test-anthropic.mjs
```

- [ ] **Step 3: Add a structural check step to the existing default CI**

Find the existing CI job that runs structural checks (it does `bash -n`, `package.json` integrity, etc.) and add a step that dynamic-imports `src/server/api/anthropic/routes.js` to verify the module loads:

```yaml
      - name: Anthropic router structural check
        run: |
          node -e "import('./src/server/api/anthropic/routes.js').then(m => { if (typeof m.createAnthropicRouter !== 'function') throw new Error('createAnthropicRouter missing'); console.log('OK: anthropic router loads'); })"
```

- [ ] **Step 4: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add .github/workflows/ci.yml && git commit -m "ci(anthropic): add manual smoke job + structural import check"
```

---

## Task 11: Documentation updates

**Files:**
- Modify: `config.example.yaml` (document `anthropic.modelMap`)
- Modify: `AGENTS.md` (add Anthropic-protocol rules section)
- Modify: `README.md` (add Anthropic API section)

- [ ] **Step 1: Update `config.example.yaml`**

Open `E:/playgroud/tongji-webai2api/config.example.yaml`. After the root-level `server:` block, add:

```yaml
# Optional Anthropic-protocol surface configuration
anthropic:
  # Override default Claude-name → Tongji-model alias mapping
  # (defaults shipped in src/server/api/anthropic/modelMap.js)
  modelMap:
    # claude-sonnet-4-5: DeepSeek-V4-Pro
    # claude-haiku-4-5: DeepSeek-V4-Flash
    # claude-opus-4-1: DeepSeek-R1
```

- [ ] **Step 2: Update `AGENTS.md`**

Open `E:/playgroud/tongji-webai2api/AGENTS.md`. After §10 ("Workflow (agent edition)"), add a new section:

```markdown
## 11. Anthropic protocol

This fork exposes an Anthropic-protocol surface at `/v1/messages`,
`/v1/models`, and `/v1/messages/count_tokens`, alongside the existing
OpenAI-compatible surface. The Anthropic and OpenAI paths share one
`tongji.js` adapter and one `queueManager.addTask` pipeline — the
adapter itself is unchanged.

### Surface mapping

| Anthropic | Where it lives |
|-----------|----------------|
| `POST /v1/messages` | `src/server/api/anthropic/routes.js` `handleMessages` |
| `GET /v1/models` | shared with OpenAI; Anthropic surface decorates with `display_name` |
| `POST /v1/messages/count_tokens` | `handleCountTokens` |

### Hard rules

- **Do not edit `src/backend/adapter/tongji.js`** to add Anthropic
  awareness. Translate in `parse.js` instead.
- **Do not introduce native tool-use in the adapter** — the Anthropic
  surface synthesizes tools via prompt suffix + post-stream JSON parse.
- **Do not implement vision** — return `400 invalid_request_error`
  with `"vision not supported by upstream Tongji hiagent"`.
- **Reuse `data/config.yaml#server.auth`** for the Anthropic
  `x-api-key` header. Do not introduce a separate Anthropic key.
- **Keep the SSE event ordering**: `message_start` → `content_block_*`
  → `message_delta` → `message_stop`. Mid-stream errors emit
  `event: error` with no trailing `message_stop`.

### Adding new model aliases

Add an entry to `src/server/api/anthropic/modelMap.js` `DEFAULT_ALIASES`
OR override in `data/config.yaml#anthropic.modelMap`. Format:
`<anthropic-name>: <tongji-model-id>`.
```

- [ ] **Step 3: Update `README.md`**

Open `E:/playgroud/tongji-webai2api/README.md`. After the "Available
models" section, add a new section:

```markdown
## Anthropic-protocol API

The server also exposes an Anthropic-protocol surface so you can use
the Anthropic SDK (`@anthropic-ai/sdk`) or the Claude Code CLI
without client-side changes.

### Quick start with Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_API_KEY=<auth from data/config.yaml>
claude "Hello, world"
```

### `curl` example

```bash
KEY=$(grep "auth:" data/config.yaml | head -1 | awk '{print $2}')

curl -N http://127.0.0.1:3000/v1/messages \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Supported features

- Chat (streaming + non-streaming)
- Extended thinking (`thinking: {type: "enabled", budget_tokens: N}`)
- Multi-turn conversations
- Soft-synthesized tool use (function calling)
- Token counting via `/v1/messages/count_tokens`

### Limitations

- **Vision / image inputs** — not supported (return 400). Tongji
  hiagent has no vision model.
- **Prompt caching** — ignored. Tongji has no cache_control hook.
- **Tool calling** is best-effort: tool definitions are appended to
  the prompt; the model's output is scanned for
  `<tool_use>{...}</tool_use>` JSON blocks. Accuracy depends on the
  upstream model's instruction-following. Use `claude-sonnet-4-5`
  (DeepSeek-V4-Pro) for best results.
```

- [ ] **Step 4: Commit**

```bash
cd E:/playgroud/tongji-webai2api && git add config.example.yaml AGENTS.md README.md && git commit -m "docs(anthropic): config field + AGENTS rules + README how-to"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|--------------|------|
| §2 Scope (chat/thinking/tools/vision) | T2 (aliases), T4 (tools), T5 (SSE), T6 (parse rejects vision), T7 (route) |
| §3 Architecture | T2-T7 file structure |
| §6 Mount | T8 |
| §7 Translation | T6 |
| §8 SSE mapping | T5 |
| §9 Errors | T3 |
| §10 Tools | T4 |
| §11 Model aliases | T2 |
| §12 Auth | T7 |
| §14 Testing | T9 (smoke), T10 (CI) |
| §15 Completion criteria | T9 + T11 (docs) |
| §16 Risks | T5 unit test for ordering, T7 integration for vision rejection |

**2. Placeholder scan:** No "TBD", "TODO", or "implement later" patterns. All code blocks are complete and runnable.

**3. Type consistency:**
- `resolveAlias(name, override)` — same signature used in `parse.js` and `modelMap.js` tests.
- `toolsToPromptSuffix(tools)` — same in `tools.js`, `parse.js`, tests.
- `parseToolCallsFromText(text, tools)` — same in `tools.js`, `parse.js`, `routes.js`.
- `createAnthropicSseWriter(res, init)` — same in `sse.js`, `routes.js`, tests.
- `sendApiError(res, {status, type, message, requestId, isStreaming})` — same in `errors.js`, `routes.js`, tests.
- `parseAnthropicRequest(body, ctx)` returns `{messages, systemPrompt, model, maxTokens, temperature, tools, thinking, stream, meta}` — referenced consistently in `routes.js`.
- `estimateInputTokens(systemPrompt, messages, model)` — exported from `parse.js`, used in `routes.js`.

All consistent. No mismatches found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-20-anthropic-protocol.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?