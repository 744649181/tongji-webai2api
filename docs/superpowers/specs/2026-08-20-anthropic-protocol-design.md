# Anthropic-Protocol Support for tongji-webai2api

- **Date**: 2026-08-20
- **Status**: Approved (brainstorming complete, awaiting user sign-off)
- **Owner**: LyonBian
- **Upstream**: foxhui/WebAI2API v3.0.0 (frozen)
- **This fork**: tongji-webai2api v3.1.0

## 1. Goal

Add an **Anthropic-protocol** HTTP API surface (`/v1/messages`,
`/v1/models`, `/v1/messages/count_tokens`) alongside the existing
OpenAI-compatible surface (`/v1/chat/completions`, `/v1/models`,
`/v1/cookies`). The new surface must accept the Anthropic SDK
(`@anthropic-ai/sdk`) and the Claude Code CLI without client-side
changes.

Both surfaces share the same `tongji.js` adapter, `queueManager`,
and PoolManager. No upstream adapter or v2 framework code is
modified.

## 2. Scope (v1)

**In scope:**

- `POST /v1/messages` (streaming + non-streaming)
- `GET  /v1/models`
- `POST /v1/messages/count_tokens`
- Anthropic model aliases (`claude-*`) that resolve to existing
  Tongji hiagent models
- Native chat pass-through (text-in, text-out)
- Extended thinking (`thinking: {type:"enabled", budget_tokens:N}`)
  mapped from hiagent `reasoning_content`
- Soft-synthesized tool_use: tool schemas → prompt suffix; output
  `<tool_use>{...}</tool_use>` blocks parsed back into Anthropic
  `tool_use` content blocks
- Anthropic-shaped error responses for unsupported surfaces
  (vision)
- Cross-platform Node ESM smoke test (replaces the PowerShell-only
  pattern of `smoke-test-tongji-v2.ps1`)

**Out of scope (v1):**

- True native tool calling (hiagent upstream has no tool API)
- Vision / image inputs (hiagent has no vision model)
- Prompt caching (`cache_control` markers — hiagent has no hook)
- Batch API (`/v1/messages/batches`)
- Admin / org endpoints (`/v1/organizations/*`)
- Streaming `input_json_delta` (hiagent cannot stream structured
  JSON; tool_use is reconstructed from final text)

## 3. Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│ server.js (HTTP entry — no logic change)                       │
└─────────────────┬──────────────────────────────────┬────────────┘
                  │ /v1/chat/completions             │ /v1/messages
                  │ /v1/models │ /v1/models
                  │ /v1/cookies                      │ /v1/messages/count_tokens
                  ▼ ▼
        ┌────────────────────┐            ┌──────────────────────────┐
        │ openai/ │            │ anthropic/    (NEW)         │
        │   routes.js        │            │   routes.js   (HTTP)     │
        │   parse.js         │            │   parse.js    (translate)│
        │                    │            │   sse.js (Anthropic SSE) │
        │                    │            │   modelMap.js (aliases)  │
        │                    │            │   tools.js  (soft tools) │
        │                    │            │   errors.js (Anthropic) │
        └─────────┬──────────┘            └─────────────┬────────────┘
                  │  addTask(CanonicalReq, {onDelta, ...})│
                  └─────────────────┬───────────────────┘
                                    ▼
                        ┌───────────────────────┐
                        │ queueManager (no chg) │
                        │   + PoolManager        │
                        │   + tongji.js (no chg) │
                        └───────────┬───────────┘
                                    │ onDelta({content|reasoning_content})
                                    ▼
                        ┌───────────────────────┐
                        │ Anthropic SSE Writer  │ (NEW)
                        │ — translate delta →   │
                        │   Anthropic events    │
                        └───────────────────────┘
```

## 4. New files

| File | Purpose | Est. lines |
|------|---------|-----------:|
| `src/server/api/anthropic/routes.js` | HTTP handlers for `/v1/messages`, `/v1/models`, `/v1/messages/count_tokens` | 250 |
| `src/server/api/anthropic/parse.js` | Anthropic request → canonical internal request | 180 |
| `src/server/api/anthropic/sse.js` | Anthropic SSE event-sequence writer + OpenAI-delta translation | 150 |
| `src/server/api/anthropic/modelMap.js` | `claude-*` alias table (built-in defaults + `data/config.yaml#anthropic.modelMap` override) | 80 |
| `src/server/api/anthropic/tools.js` | Soft tool synthesis: schema → prompt suffix; output → `tool_use` blocks | 150 |
| `src/server/api/anthropic/errors.js` | Anthropic error shape + HTTP status mapping | 80 |
| `scripts/smoke-test-anthropic.mjs` | Cross-platform Node ESM smoke test (9 cases) | 200 |

**Total new code: ~1090 lines.**

## 5. Untouched boundaries

- `src/backend/adapter/tongji.js` — zero changes
- `src/backend/adapter/*.js` (the 19 upstream adapters) — zero changes
- `src/server/queue.js` — zero changes (reuse `meta.onDelta`)
- `src/server/respond.js` — zero changes (Anthropic SSE writer is its own concern)
- `src/backend/pool/Worker.js` — zero changes
- `src/backend/registry.js` — zero changes
- `patches/` — zero changes
- `package.json` runtime deps — no additions (Anthropic SDK is a smoke-test devDep only)

## 6. Mount point

In `supervisor.js` (or wherever the OpenAI router is mounted),
add:

```js
import { createAnthropicRouter } from './src/server/api/anthropic/routes.js';
app.use(createAnthropicRouter(ctx));
```

Routing keys (the route file exports per-path handlers):

| Method | Path | Handler |
|--------|------|---------|
| POST | `/v1/messages` | `handleMessages` (stream + non-stream) |
| GET  | `/v1/models` | `handleModels` (OpenAI aliases alongside) |
| POST | `/v1/messages/count_tokens` | `handleCountTokens` |

`GET /v1/models` is shared with OpenAI but each surface can decorate
the response (Anthropic surface adds `display_name`).

## 7. Request translation (`parse.js`)

Canonical internal request shape:

```js
{
  // From Anthropic input
  messages: Array<{role, content}>,  // normalized
  model: 'DeepSeek-V4-Pro',          // alias-resolved
  systemPrompt: string,              // from system field
  maxTokens: number,
  temperature: number,
  tools: Array<ToolDef> | null,      // for soft synthesis
  thinking: { enabled: boolean, budgetTokens: number } | null,
  stream: boolean,

  // v2 framework context (mirrors existing meta)
  meta: {
    id: requestId,
    onDelta: Function,               // for stream:true
    reasoning: boolean,              // derived from thinking.enabled
  }
}
```

Translation rules:

- **system**: Anthropic `system` field (string or array of text
  blocks) → `systemPrompt` (joined with `\n`). Appended to every
  user message by `parseTextRequest`-style virtual-context wrapping
  (re-use existing `parse.js#parseTextRequest` logic).
- **messages**:
  - `user` text blocks → pass through.
  - `user` `image` blocks → reject with 400 (vision not supported).
  - `user` `tool_result` blocks → render into prompt as
    `[上次工具调用结果]\nTOOL: name\nRESULT: {...}`.
  - `assistant` text blocks → pass through (multi-turn).
  - `assistant` `tool_use` blocks → render into prompt as
    `[我上次决定调用工具]\n<tool_use>{...}</tool_use>`.
- **tools**: array of `{name, description, input_schema}` →
  rendered into prompt suffix by `tools.js` (see §10).
- **model**: `claude-sonnet-4-5` → `modelMap.resolve(model)` →
  `DeepSeek-V4-Pro` (or any tongji-supported name). Aliases
  configured in `data/config.yaml#anthropic.modelMap`, defaults
  shipped in `modelMap.js`.
- **max_tokens, temperature**: passthrough.
- **thinking**: if present and `enabled=true`, set
  `meta.reasoning = true`. `budget_tokens` is recorded for usage
  reporting but does NOT limit reasoning length (hiagent is
  upstream-controlled).
- **stream**: passthrough.

## 8. SSE event mapping (`sse.js`)

| OpenAI onDelta | Anthropic SSE event |
|---|---|
| (start) | `message_start` (message.id, model, role:"assistant", type:"message", usage.input_tokens=ESTIMATE) |
| (start, non-thinking) | `content_block_start` index=0 type="text" content_block={text:""} |
| (start, thinking) | `content_block_start` index=0 type="thinking" content_block={thinking:""} |
| `delta.content` | `content_block_delta` index=0 delta.type="text_delta" delta.text="..." |
| `delta.reasoning_content` | `content_block_delta` index=0 delta.type="thinking_delta" delta.thinking="..." |
| (end of block) | `content_block_stop` index=0 |
| (tool_use added) | `content_block_start` index=1 type="tool_use" content_block={id:"toolu_xxx", name, input:{}} |
| (tool args finalized) | `content_block_delta` index=1 delta.type="input_json_delta" delta.partial_json="..." |
| (tool block end) | `content_block_stop` index=1 |
| adapter finish | `message_delta` delta.stop_reason="end_turn"\|"tool_use" usage.output_tokens |
| | `message_stop` |
| (3s silence) | `event: ping\ndata: {type:"ping"}` (queue heartbeat) |

**Invariants:**

- `message.id` = `buildStableChatId(meta.id)` (reuse from
  `respond.js` — import or copy the impl; not affected by protocol)
- `created` = shared per-request timestamp (Unix seconds)
- `usage.input_tokens` = estimate = `Math.ceil(totalChars / 4)`
  computed at parse time from canonical request
- `usage.output_tokens` = cumulative content length / 4 during
  stream, or full text length / 4 for non-stream

## 9. Error handling (`errors.js`)

Anthropic error shape:

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error" | "invalid_request_error" |
            "permission_error" | "not_found_error" |
            "rate_limit_error" | "api_error" | "overloaded_error",
    "message": "...",
    "request_id": "req_xxx"
  }
}
```

HTTP status mapping:

| Scenario | HTTP | type |
|----------|------|------|
| Missing / wrong `x-api-key` | 401 | `authentication_error` |
| `anthropic-version` not in supported set | 400 | `invalid_request_error` |
| Body JSON parse fail | 400 | `invalid_request_error` |
| Empty `messages`, no user | 400 | `invalid_request_error` |
| `image` content block | 400 | `invalid_request_error` (`"vision not supported by upstream Tongji hiagent"`) |
| Unknown model alias | 400 | `not_found_error` |
| Non-stream queue full | 503 | `overloaded_error` |
| Upstream hiagent 5xx | 502 | `api_error` |
| Upstream hiagent network | 503 | `api_error` |
| Tool parse failure | 200 | response with `stop_reason:"end_turn"` + warning text |

**Stream errors:**

- Pre-stream errors (401/400/403/404): non-SSE JSON response
  (HTTP error before headers flushed)
- Mid-stream errors (502/503 from upstream, 504 timeout):
  `event: error\ndata: {type:"error", error:{...}}` then end
  (no `message_stop` after error per Anthropic convention)

## 10. Soft tool synthesis (`tools.js`)

**Prompt suffix format** (appended to user message):

```text
[系统指令：你可以使用以下工具之一来回答用户问题。
调用格式：严格 JSON，紧跟你的文本后，用<tool_use>...</tool_use> 包起来。]

工具 1:
名称: get_weather
描述: 获取指定城市的天气
参数 schema:
{"type":"object","properties":{"city":{"type":"string"},"unit":{"type":"string","enum":["celsius","fahrenheit"]}},"required":["city"]}

工具 2:
名称: search_docs
描述: 在文档库中搜索
参数 schema:
{...}

[用户问完之后，如果你决定调用工具，请这样输出：]
<tool_use>
{"name":"get_weather","arguments":{"city":"上海","unit":"celsius"}}
</tool_use>

[不要在 JSON 之外描述工具调用。每次回答最多一个工具调用。]
```

**Output parsing:**

- After `delta.content` stream completes (or for non-stream, after
  full text returned), scan full text for `<tool_use>...</tool_use>`
  blocks
- For each block: `JSON.parse`, validate against
  `tools[i].input_schema` (basic type check; no full JSON Schema
  validator to keep deps low)
- If valid: emit a `tool_use` content block in the response
- If invalid: append `[tool_parse_failed]` to final text, no
  `tool_use` block, `stop_reason="end_turn"`

**Multi-turn tool_use:**

- Anthropic `tool_result` content blocks in subsequent user
  messages render back into prompt as `[上次工具调用结果]`.
- Anthropic `tool_use` content blocks in assistant messages render
  as `[我上次决定调用工具]\n<tool_use>...</tool_use>`.

**Known limitations** (documented in `tools.js` JSDoc):

- Accuracy depends on model instruction-following. DeepSeek-V4-Pro
  and GLM-5.1 are stable; smaller models may emit non-JSON output.
- `tool_choice: "any"` / `"tool"` / specific tool is honored as a
  *hint* in the prompt suffix, not enforced. hiagent has no native
  tool_choice.
- Streaming `input_json_delta` is **not** used; tool_use blocks are
  reconstructed from the final text after the stream completes (the
  `content_block_start` for `tool_use` is emitted between
  `message_delta` and `message_stop`, or in non-stream at the end
  of the response).

## 11. Model aliases (`modelMap.js`)

Default table shipped in code (overridable by
`data/config.yaml#anthropic.modelMap`):

| Anthropic alias | Tongji model | Notes |
|-----------------|--------------|-------|
| `claude-sonnet-4-5` | `DeepSeek-V4-Pro` | Default; balanced |
| `claude-sonnet-4-5-20250929` | `DeepSeek-V4-Pro` | Stable tag (alias of above) |
| `claude-haiku-4-5` | `DeepSeek-V4-Flash` | Faster, lighter |
| `claude-haiku-4-5-20251001` | `DeepSeek-V4-Flash` | Stable tag |
| `claude-opus-4-1` | `DeepSeek-R1` | Reasoning |
| `claude-opus-4-1-20250805` | `DeepSeek-R1` | Stable tag |

Resolution order:

1. Exact match in `data/config.yaml#anthropic.modelMap` (if present)
2. Default table in `modelMap.js`
3. Otherwise: pass through as-is (assumes client sent a valid
   Tongji model name like `DeepSeek-V4-Pro` directly). On miss →
   400 `not_found_error`.

`/v1/models` response includes BOTH the Anthropic aliases and the
underlying Tongji model IDs (with `display_name` populated so
Claude Code's picker can show a friendly name).

## 12. Authentication

- Header: `x-api-key: <server.auth value from data/config.yaml>`
- Optional header: `anthropic-version: 2023-06-01` (or any
  `>= 2023-06-01`; reject older with 400)
- Same `data/config.yaml#server.auth` key as OpenAI surface —
  clients using both surfaces share one key. (Confirmed by user
  during brainstorming.)

## 13. Files modified (existing)

- `supervisor.js` (or wherever the OpenAI router is mounted):
  add a single `app.use(createAnthropicRouter(ctx))` line.
- `config.example.yaml` + `AGENTS.md#§3`: document new
  `anthropic.modelMap` field.
- `README.md`: add an "Anthropic API" section with `curl` and
  Claude Code CLI examples.

## 14. Testing (`scripts/smoke-test-anthropic.mjs`)

Cross-platform Node ESM. Uses `@anthropic-ai/sdk` as a devDep.
Run with: `node scripts/smoke-test-anthropic.mjs`.

| # | Case | Assertion |
|---|------|-----------|
| 1 | Stream with `claude-sonnet-4-5` | ≥ 5 `text_delta` events; final `message_stop`; `stop_reason="end_turn"`; accumulated output_tokens > 0 |
| 2 | Non-stream with `claude-haiku-4-5` | Single complete message; `content[0].type="text"`; non-empty text |
| 3 | Multi-turn | Call 1: "OK"; Call 2: "Alice" |
| 4 | Extended thinking | `thinking:{enabled,budget_tokens:1024}`; response has both `type:"thinking"` and `type:"text"` blocks |
| 5 | Tool use soft synthesis | `tools:[get_weather]` schema; response includes parsed `tool_use` block with valid JSON |
| 6 | Vision rejection | `content` includes `type:"image"`; expect 400 `invalid_request_error` mentioning "vision not supported" |
| 7 | count_tokens | `POST /v1/messages/count_tokens` returns `{input_tokens: N}` consistent with char count |
| 8 | Auth | Wrong `x-api-key` → 401 `authentication_error`; missing `anthropic-version` → 400 |
| 9 | Raw name passthrough | `model: "DeepSeek-V4-Pro"` (no alias) accepted and routed correctly |

Any assertion fail → script exits non-zero.

### CI integration

Add a new job `anthropic-smoke` in
`.github/workflows/ci.yml`, triggered only by `workflow_dispatch`
(manual) to avoid burdening automatic CI. Same label pattern as
the existing `run-smoke` gate.

### Structural check (CI always-on)

Add a CI step that dynamic-imports `src/server/api/anthropic/routes.js`,
verifies it exports `createAnthropicRouter`, and runs a single
synthetic `POST /v1/messages` with a known-invalid body to confirm
it returns an Anthropic-shaped error. No live browser required.

## 15. Completion criteria

The implementation is complete when **all** of the following are
satisfied:

1. `node scripts/smoke-test-anthropic.mjs` passes all 9 cases.
2. Claude Code CLI can be configured with
   `ANTHROPIC_BASE_URL=http://127.0.0.1:3000` and a single chat
   round-trip succeeds (Claude Code → Anthropic SDK → our server
   → tongji adapter → hiagent → response → Anthropic SDK → Claude
   Code UI).
3. `@anthropic-ai/sdk` (Node) can perform a streaming + non-stream
   chat with `claude-sonnet-4-5` alias.
4. Existing `scripts/smoke-test-tongji-v2.ps1` still passes
   (no regression in OpenAI surface).
5. `README.md` documents the new Anthropic surface with at least
   one `curl` example and one Claude Code setup example.
6. `AGENTS.md` updated with Anthropic-protocol rules (mirror of
   OpenAI-protocol rules in §3).

## 16. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| hiagent upstream transient 5xx → user-visible failure | `failover` strategy in `data/config.yaml` (existing); Anthropic `message_delta.stop_reason="end_turn"` with warning text on parse failure |
| SSE event ordering off-by-one (e.g., tool_use block emitted before `message_delta`) | Unit test the writer with a synthetic event sequence; mirror Anthropic SDK reference trace byte-for-byte |
| Vision rejection message is too cryptic | Error message names the supported path: "Tongji hiagent has no vision model. Drop image content or use text-only." |
| Soft tool synthesis breaks on small models | Document the accuracy variance; suggest `claude-sonnet-4-5` for tool-heavy workloads |
| `count_tokens` estimate diverges from real token count | Document it's an estimate; ensure `input_tokens` is monotonically > 0 |

## 17. Open questions deferred to implementation

None. All design decisions resolved during brainstorming:

- Surface scope: full Claude API surface (modulo upstream limits)
- Auth: reuse `data/config.yaml#server.auth` via `x-api-key`
- Model: alias map + raw-name passthrough
- Vision/tools/caching: hybrid (chat+thinking native, tools soft,
  vision reject)
- Test client: Anthropic SDK + Claude Code CLI
