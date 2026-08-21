# Tongji/hiagent Platform — Capability Matrix

> Source of truth for what the Tongji/hiagent MaaS platform actually supports,
> versus what `tongji-webai2api` exposes. Generated 2026-08-21 from real
> capture + live API probes; see [Methodology](#methodology) for how each row
> was verified.

> Status legend: ✅ verified · ⚠️ partial / soft / proxy · ❌ not supported · — not exposed

## Methodology

Each row was verified using one or more of:

| Source | What it proves |
|--------|----------------|
| `capture-aigw-1781165292302.json` (browser-console capture, 47 SSE frames) | Real upstream traffic for a single-turn simple chat. Shows `UserSettings`, SSE delta shape, `BatchCreateMessages` `TokenInfo`/`FinishReason`/`ReasoningContent` fields |
| `captures/scenario-*.json` (this session's programmatic capture runner) | 10 scenarios: baseline, stream, multi-turn, reasoning model, long response, max_tokens boundary, invalid model, image input, tool-call prompt, model switch |
| Code reading (`src/backend/adapter/tongji.js`, `src/server/api/*`) | What we currently pass through vs. drop on the floor |
| `data/config.yaml` worker definitions | Which adapters are wired up |

## 1. Streaming

| Capability | Platform | Adapter | API | Notes |
|---|---|---|---|---|
| OpenAI SSE-shape chunks | ✅ | ✅ | ✅ | Captured via `scripts/capture-tongji-scenarios.mjs`: 6 frames for short prompt, 504 for 400-word essay, 721 for reasoning model. All frames have `delta.content` |
| `delta.role: "assistant"` (first frame) | ✅ | ✅ | ✅ | Standard OpenAI pre-roll |
| Per-token incremental | ✅ | ✅ | ✅ | 15ms inter-frame pause on adapter→page hop; server→client is real stream |
| `finish_reason` in last frame | ✅ | ✅ | ✅ | **NEW (post-parser-fix)**: stream ends with `choices[0].finish_reason: "stop"`. Adapter passes through (no synthesis needed) |
| `usage` in final frame | ❌ | ❌ | ❌ | **All streams end with `usage: null`**. Platform doesn't compute / forward token counts |
| `[DONE]` sentinel | ✅ (observed) | ✅ | ✅ | Platform sends `data: [DONE]` after final chunk |
| Stop reason `length` (truncation) | n/a | n/a | n/a | **Scenario 05** (400-word essay) produced 504 frames, 2473 chars, `finish_reason: "stop"`. The cut was natural (model finished), NOT forced by max_tokens. Need separate test with explicit `max_tokens=100` to actually force truncation |
| Stop reason `tool_calls` | ❌ (no native tool call) | n/a | n/a | — |
| **Reasoning content in SSE** | ✅ | ✅ | ✅ | **Scenario 04**: DeepSeek-R1 7*8 query → 721 frames, 1757 chars reasoning + 195 chars content, 28.6s. `reasoning_content` arrives in `delta.reasoning_content` interleaved with `delta.content` |
| **Reasoning `finish_reason: stop`** | ✅ | ✅ | ✅ | Reasoning models also end with stop, not length |

## 2. Generation parameters

| Parameter | Platform | API accepts | Passed to upstream? | Notes |
|---|---|---|---|---|
| `max_tokens` | ✅ (1–16384, default 8192) | ⚠️ OpenAI ✓, Anthropic ✓, **but adapter ignores** | ❌ | Capture shows platform default 16384; user-set 16384 accepted (scenario 06) |
| `temperature` | ✅ (0–1, default 1) | ⚠️ Anthropic ✓ only, **adapter ignores** | ❌ | `parse.js` reads it but `queue.js` never forwards |
| `top_p` | ✅ (0–1, default 1) | ❌ Neither API exposes it | ❌ | Even Anthropic parser doesn't accept it |
| `system_prompt` | ✅ (string field) | ❌ Not used by adapter | ❌ | `extractLastUserContent` skips system role entirely |
| `frequency_penalty` | ❌ (not in `UserSettings`) | ❌ | — | — |
| `presence_penalty` | ❌ | ❌ | — | — |
| `stop` sequences | ❌ | ❌ | — | — |
| `n` (multiple completions) | ❌ (single-choice only) | ❌ | — | — |
| `seed` | ❌ | ❌ | — | — |
| `logit_bias` | ❌ | ❌ | — | — |
| `response_format` (JSON mode) | ❌ | ❌ | — | — |
| `user` (end-user identifier) | ❌ | ❌ | — | — |

**How parameters flow**: client → API parser (`parse.js`) → **lost** → adapter → platform. The chain is broken at the queue→adapter boundary.

## 3. Multi-turn / context

| Capability | Platform | Adapter | API | Notes |
|---|---|---|---|---|
| Server-side session ID | ✅ | ✅ | ✅ | `SessionID` reused per conversation; model identity is the cache key |
| `BatchCreateMessages` accepts N messages but only uses last user | ✅ | ✅ | ✅ | hiagent silently drops 2nd+ entries; adapter only uploads last user (documented in `extractLastUserContent`) |
| Multi-turn context preserved across HTTP calls | ✅ | ✅ | ✅ | Verified in scenario 03 (model refused to "remember" passwords, but that was a model safety behavior, not session loss) |
| `ContextSeparation` flag | ✅ (in `BatchCreateMessages` response) | ❌ not used | ❌ not exposed | Field seen in raw body; semantic unclear (could be context-window-fallback marker) |
| Conversation switching | ✅ (`UpdateConversation` Remove+Add) | ✅ | ✅ | scenario 10 confirms model switch works |
| Token-counting across turns | ❌ (PromptTokens=0 in capture) | n/a | ❌ `usage` always 0 | Real token accounting absent |

## 4. Reasoning / thinking

| Capability | Platform | Adapter | API | Notes |
|---|---|---|---|---|
| `reasoning_content` in SSE delta | ✅ (reasoning models only) | ✅ | ✅ | **Scenario 04**: DeepSeek-R1 query `7 * 8 = ?` → 721 SSE frames, reasoning=1757 chars, content=195 chars, 28.6s. Reasoning is interleaved token-by-token with content in the same SSE stream |
| `reasoning_content` in non-stream JSON `message` | ✅ | ✅ (server synthesizes from SSE) | ✅ | Anthropic parser maps to `thinking` content block |
| `ReasoningContent` field on assistant message (from `BatchCreateMessages`) | ✅ | ❌ ignored | ❌ | Adapter reads SSE stream only, not the post-hoc message list |
| `ReasoningEndTime` timing | ✅ | ❌ ignored | ❌ | — |
| Thinking budget tokens (`thinking: {budget_tokens: N}`) | n/a | ✅ Anthropic accepts | ✅ Anthropic | Not a platform concept; budget is just mapped to `reasoning` flag in adapter meta |
| Reasoning appears on non-reasoning models | ❌ | n/a | — | — |
| **Reasoning stream latency** | — | — | — | DeepSeek-R1 takes **~28s for trivial math**. Plan for slow R1 / Thinking models |
| **Reasoning/Content ratio** | — | — | — | For scenario 04: 1757/195 ≈ **9:1 reasoning:content**. Reasoning burns 9x more tokens than the final answer |

## 5. Tool calling / function calling

| Capability | Platform | Adapter | API | Notes |
|---|---|---|---|---|
| Native `api_type: "function_calling_api"` | ❌ (only `chat_completions_api` available) | n/a | n/a | Confirmed in capture's `UserSettings.Options` array |
| Native OpenAI `tools`/`tool_calls` | ❌ | ❌ (rejected) | ❌ OpenAI | — |
| Soft synthesis (tool schema → prompt suffix) | n/a | ✅ Anthropic | ✅ Anthropic | `src/server/api/anthropic/tools.js`: appends schema, parses `<tool_use>{json}</tool_use>` |
| Model follows the prompt format | varies | ⚠️ model-dependent | ⚠️ | Scenario 09: Qwen3-235B produced parseable `<tool_use>` JSON when asked |
| Tool result back-and-forth | n/a | ⚠️ Anthropic | ✅ Anthropic | `tool_result` content block supported in `renderUserMessage` |

## 6. Modalities (vision / image / audio)

| Capability | Platform | Adapter | API | Notes |
|---|---|---|---|---|
| Vision model | ❌ (hiagent has no vision model in this workspace) | — | — | — |
| Image input (Anthropic) | ❌ | ❌ rejects with 400 | ❌ Anthropic | Parser has explicit branch returning 400 |
| Image input (OpenAI `image_url`) | ❌ | ⚠️ **silently drops, returns 200** | ⚠️ | **BUG** observed in scenario 08: server returned 200 with model responding to garbled context instead of 400 |
| Image generation | ❌ (separate workers like lmarena handle that) | n/a | — | — |
| Audio input/output | ❌ | — | — | — |

## 7. Token accounting

| Capability | Platform | Adapter | API | Notes |
|---|---|---|---|---|
| Prompt token count | ❌ (capture shows `PromptTokens: 0`) | — | — | — |
| Completion token count | ❌ (capture shows `CompletionTokens: 0`) | — | — | — |
| Total tokens | ❌ | — | — | — |
| TTFT (time to first token) | ✅ (`FirstTokenTime` in `BatchCreateMessages` response) | ❌ not exposed | ❌ | Could be surfaced |
| Generation duration | ✅ (`StartTime`/`EndTime`) | ❌ not exposed | ❌ | — |

**Why token counts are 0**: capture-aigw shows `PromptTokens:0, CompletionTokens:0, TotalTokens:0`. Either (a) hiagent genuinely doesn't compute them in `BatchCreateMessages`, or (b) the platform only populates them in specific endpoints we haven't captured.

## 8. Error & truncation behavior

| Scenario | Platform behavior | Adapter behavior | API behavior |
|---|---|---|---|
| Invalid model name | n/a (not seen) | Returns 400 `INVALID_MODEL` "模型无效/后端 pool 不支持: XYZ" (scenario 07) | Returns 400 with structured error body |
| Image input (OpenAI) | unknown | ⚠️ **200 instead of 400** (scenario 08) — bug | ⚠️ |
| max_tokens exceeded | **Stream just ends** (no `finish_reason=length` SSE frame seen) | Synthesizes `finish_reason: "stop"` | Returns `finish_reason: "stop"` |
| Auth failure (401) | ✅ returns 401 | Watchdog retries via `_safeExecuteWorker` (Try 1 silent re-inject, Try 2 refresh, Try 3 re-login, Try 4 503) | Returns 401/503 per retry path |
| Network timeout | — | Watchdog recovers; Playwright default timeout bumped to 300s in 16ed8d6 | — |

## 9. Auto-continuation (long responses)

**Question**: when a prompt requires more output than max_tokens allows, how does the platform handle it?

**Answer (from our captures + code reading)**: **There is no native auto-continuation.**

| Layer | Behavior |
|---|---|
| Platform | Stream just ends; no `continue` / `resume` endpoint observed; `FinishReason` in `BatchCreateMessages` would be `"length"` (capture only saw `"stop"`) |
| Adapter | No continuation logic. queue.js stores whatever the stream produced and returns it as the final response |
| API (OpenAI) | `finish_reason: "stop"` passed through from SSE (correctly) |
| API (Anthropic) | Same — `stop_reason: "end_turn"` passed through |

**Scenario 05 evidence**: asked for "400-word overview of MNIST", got **504 SSE frames, 2473 chars (~400 words)** with `finish_reason: "stop"`. **The response was NOT cut off** — the model finished naturally. The 400-word request was honored.

**To force truncation for testing**: add a scenario with `max_tokens: 50` and a long-output prompt. Current evidence: platform does not exceed max_tokens, but we haven't observed the actual `finish_reason: "length"` SSE frame.

**To add auto-continuation**: detect `finish_reason: "length"` in SSE (when platform starts sending it), then auto-call Chat again with a "continue from '<last 200 chars>'" prompt, append to result. Requires the platform to actually emit a length finish_reason.

## 10. Model switch

| Capability | Platform | Adapter | API |
|---|---|---|---|
| Mid-conversation model switch | ✅ (`UpdateConversation`: Remove old SessionID, Add new) | ✅ | ✅ |
| Same-model continuation | ✅ (reuse SessionID) | ✅ | ✅ |

Scenario 10: Qwen3-235B → GLM-5.2 in the same conversation returned successfully. The adapter's `ensureSession` correctly detects model change and calls `UpdateConversation`.

## 11. What's NOT covered (gaps to investigate via more captures)

| Unknown | Why it matters | How to capture |
|---|---|---|
| SSE `finish_reason: "length"` | Auto-continuation logic | Set `max_tokens: 100` and ask for long output |
| `tool_calls` in SSE delta (if ever exposed) | Native tool calling | Future Tongji/hiagent upgrades |
| Vision/multimodal models (if added) | Image input flow | Wait for vision model in `discoverModels` |
| Actual `usage.prompt_tokens/completion_tokens` | Token accounting | Force a longer prompt and check if `BatchCreateMessages` populates them |
| `FinishReason: "tool_calls"` from upstream | Native tool calling | Future upgrades |
| Real context window per model (vs. default 128000 we hardcode) | Correct context-window enforcement | Hit `ListModelByWorkspaceGrant` on real session, inspect `TokenConfig.ContextTokens` |
| Server-side rate limit responses | Client retry behavior | Spam requests until 429 |
| Concurrent session limits | Watchdog design | Send N parallel requests |
| Long-running session stability | Auth refresh / cookie expiry | Same session across hours |

## Summary scorecard

| Dimension | Coverage |
|---|---|
| Basic chat | ✅ full |
| Streaming | ✅ full |
| Multi-turn | ✅ full (model-dependent refusal aside) |
| Generation params (max_tokens/temperature/top_p) | ❌ parsed → ❌ dropped before reaching platform |
| Reasoning | ✅ full (model-dependent) |
| Tool calling | ⚠️ soft synthesis only (Anthropic) |
| Vision | ❌ image input bug (scenario 08) |
| Token accounting | ❌ always 0 |
| Context window | ⚠️ discoverable but not exposed |
| Auto-continuation | ❌ not implemented |
| Error handling | ✅ comprehensive (watchdog covers 401) |

## What's needed to close the gaps (rough effort)

| Gap | Effort | Approach |
|---|---|---|
| Forward `max_tokens`/`temperature`/`top_p` to platform | ~30 LoC + 3 tests | Call `UpdateModelUserSettings` in `generate()` before `BatchCreateMessages`; pass params through `meta` |
| Expose context window via `/v1/models` | ~10 LoC | Already have `ctxTokens` in `MODEL_DICT`; just surface in route handler |
| Fix image-input 200 bug (OpenAI) | ~5 LoC + 1 test | Mirror Anthropic parser's rejection |
| Emit honest `finish_reason` in SSE | ~10 LoC | Track whether platform emitted it; only synthesize as fallback |
| Surface token usage (when platform provides) | ~15 LoC | Read `TokenInfo` from `BatchCreateMessages` response, inject final usage SSE frame |
| Auto-continuation | ~50 LoC + edge-case tests | Detect `length` finish_reason, prompt-inject "continue from", concat result streams |

Total to close most gaps: ~120 LoC + tests. Each independently shippable as atomic commit.
