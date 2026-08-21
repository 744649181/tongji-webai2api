# Tongji Models — Usage Scenarios & Recommendations

> Practical guide for choosing the right Tongji model per use case.
> Pairs with [capabilities.md](./capabilities.md) (what's actually supported).
> Models list refreshed 2026-08-21 from `discoverModels` live capture.

## TL;DR — Decision Tree

```
What do you need?
├── Long-form reasoning / math / code with step-by-step thinking
│   └── DeepSeek-R1  (reasoning, ~13s latency)
├── General Q&A, writing, chat — balanced quality
│   └── DeepSeek-V4-Pro  (default for most use cases)
├── Low-latency / high-throughput / cheap completion
│   └── DeepSeek-V4-Flash  (mapped to claude-haiku-4-5)
├── Massive context (need to fit a book or many files)
│   └── Qwen3.5-397B  or  Qwen3.5-122B  (long-context tiers)
├── Vision / multimodal (images in input)
│   └── Qwen3-VL-235B  ← only vision-capable model in this workspace
├── Tool calling / function calling
│   └── DeepSeek-V4-Pro  (best instruction-following for soft-synthesized tool use)
│       OR Qwen3-235B-Thinking for tool + reasoning combos
├── Latest rolling Qwen build (frequently updated)
│   └── qwen-plus-latest
├── MoE / massive parameter count
│   └── Qwen3.8-2.4T-A95B  (2.4 trillion params active)
├── Chinese-language optimization
│   └── GLM-5.2  (Zhipu)
├── Long-context generalist
│   └── kimi-k3  (Moonshot — historically strong long context)
└── Default / "I don't know what to use"
    └── DeepSeek-V4-Pro  (mapped to claude-sonnet-4-5)
```

## Model Inventory

| Model ID | Family | What it's good for | Cost / Speed | Caveats |
|----------|--------|--------------------|--------------|---------|
| `DeepSeek-V4-Pro` | DeepSeek V4 | General chat, writing, code. Best tool-call instruction-following. | Mid-tier | Default fallback; works in 95% of cases |
| `DeepSeek-V4-Flash` | DeepSeek V4 | Fast / cheap. Use for routing, classification, short Q&A. | Fastest | Quality lower than Pro; not for nuanced tasks |
| `DeepSeek-R1` | DeepSeek R1 | Math, logic, step-by-step reasoning. **Outputs reasoning_content**. | Slow (~13s for trivial) | Reasoning burns tokens; expect high latency |
| `DeepSeek-V3` | DeepSeek V3 | Legacy general chat. | Mid-tier | Superseded by V4-Pro |
| `Qwen3-235B` | Qwen 3 | General chat, decent instruction-following. | Mid-tier | Default non-reasoning Qwen |
| `Qwen3-235B-Thinking` | Qwen 3 (think) | Reasoning + tool combo. | Slow | Similar pattern to R1 |
| `Qwen3-VL-235B` | Qwen 3 VL | **ONLY vision-capable model.** Image input. | Mid-tier | Adapter still rejects image — see bug in capabilities.md §6 |
| `Qwen3.5-122B` | Qwen 3.5 | Long-context generalist. | Slow | 122B context window tier |
| `Qwen3.5-397B` | Qwen 3.5 | Massive context (full-book analysis, large repo). | Slowest | 397B context tier — expect 30s+ first-token |
| `Qwen3.8-27B` | Qwen 3.8 | Newer mid-size. | Mid-tier | — |
| `Qwen3.8-2.4T-A95B` | Qwen 3.8 MoE | Total active param count is 2.4 trillion (MoE routing). | Very slow | When you need the absolute highest quality |
| `GLM-5.2` | Zhipu GLM | Chinese-language tasks, Chinese-style prompts. | Mid-tier | — |
| `kimi-k3` | Moonshot Kimi | Long documents, summarization. | Slow | Strong at reading comprehension |
| `MiMo-V2.5` | Xiaomi MiMo | General chat, Chinese-language tasks. | Mid-tier | — |
| `MiniMax-M2.5` | MiniMax | Compact general chat. | Fast | — |
| `MiniMax-M3` | MiniMax | Newer compact general chat. | Fast | — |
| `qwen-plus-latest` | Qwen (rolling) | Latest non-numbered Qwen build; subject to silent upgrades. | Mid-tier | **Avoid for reproducibility** — model identity may change under same name |

## Per-Use-Case Recipes

### 1. Code generation (single function or file)

```python
# Recommended
model = "DeepSeek-V4-Pro"

# If you want reasoning before code (debugging, complex logic)
model = "DeepSeek-R1"  # ~13s but high-quality reasoning trace
```

- Pro: best instruction-following for tool-style prompts
- R1: heavy thinking per request; batch your questions

### 2. Codebase-wide Q&A (need context)

```python
# For mid-sized repos
model = "Qwen3-235B"

# For very large codebases / multi-file refactors
model = "Qwen3.5-397B"   # longest context in the workspace
# Expect 30s+ first-token latency on full-repo dumps
```

- **Caveat**: `usage` is always 0, so you can't programmatically enforce a context window. Estimate via chars/4 (current Anthropic parser behavior).
- **Tip**: chunk before sending — even 397B context has practical latency limits.

### 3. Vision / image input

```python
model = "Qwen3-VL-235B"   # only option
```

- **Currently broken** in adapter — image input returns 200 with garbled context instead of 400. See `docs/capabilities.md` §6.
- Workaround: extract text from image separately (e.g. via OCR), pass as text prompt.

### 4. Tool calling / function calling

```python
# Soft synthesis works best with
model = "DeepSeek-V4-Pro"

# Or for reasoning + tools combo
model = "Qwen3-235B-Thinking"
```

- Soft synthesis: tool schemas are appended to prompt; model is expected to emit `<tool_use>{...}</tool_use>` blocks (see `src/server/api/anthropic/tools.js`).
- **Caveat**: 100% model-cooperation required. Pro model follows format ~95% of the time. Other models may emit plain text instead of JSON.
- **Test prompt format**: `"Use the get_weather function with city=Shanghai. Reply with <tool_use>{...}</tool_use>. Do not include any other text."` (verified in capture scenario 09).

### 5. Reasoning / math / logic

```python
model = "DeepSeek-R1"   # explicit reasoning_content
# or
model = "Qwen3-235B-Thinking"
```

- R1 has ~13s latency for a trivial math prompt. Plan for slow.
- Use `reasoning_content` from the SSE stream if you need to show reasoning steps to the user (Anthropic route maps to `thinking` content block).

### 6. Long-form writing (essays, reports)

```python
model = "DeepSeek-V4-Pro"
max_tokens = 8192   # platform default; user can override up to 16384
```

- **Note**: `max_tokens` parameter is currently NOT forwarded to the platform (adapter bug). Setting it in API has no effect — see capabilities.md §2.
- Workaround: rely on platform default (16384) and trust the model to stop naturally.
- Issue: long responses don't get auto-continued if cut off — see capabilities.md §9.

### 7. Multi-turn conversation with memory

Any model works for multi-turn. Tested with Qwen3-235B and DeepSeek-V4-Pro in scenario 03.

- **Caveat**: model safety can override explicit "remember X" requests (R1/Pro refused the password test). Design prompts to embed state, don't rely on raw recall.
- Tip: hiagent's `BatchCreateMessages` only consumes the LAST user message anyway (documented in `extractLastUserContent`). The full history is preserved server-side by `SessionID`.

### 8. High-throughput batch jobs

```python
model = "DeepSeek-V4-Flash"   # or "MiniMax-M2.5" / "MiniMax-M3"
```

- Flash is fastest in our tests (~300ms for simple responses).
- Note: server has `maxConcurrent: 2, queueBuffer: 2` — see `data/config.yaml`. You can only have 4 in-flight requests before queueing kicks in.

### 9. Chinese language tasks

```python
# Native Chinese model
model = "GLM-5.2"

# Or for Chinese + general
model = "MiniMax-M3"  # or "MiMo-V2.5"
```

- GLM-5.2 from Zhipu has best Chinese idiom / classical reference handling.
- Use system_prompt (currently ignored by adapter — bug) to set Chinese persona; for now, put Chinese in the user message.

### 10. Reproducible research / evals

```python
# AVOID
model = "qwen-plus-latest"     # rolling — silently upgrades

# USE
model = "DeepSeek-V4-Pro"      # pinned
```

- `qwen-plus-latest` is a rolling release. The same model name may give different answers on different days.
- For reproducible benchmarks, always use a fully-versioned model name.

## Quick Selection Cheat Sheet

| Use case | Best choice | Latency | Why |
|----------|-------------|---------|-----|
| Don't know | `DeepSeek-V4-Pro` | ~700ms | Safe default |
| Speed matters | `DeepSeek-V4-Flash` | ~300ms | Fastest in workspace |
| Reasoning required | `DeepSeek-R1` | ~13s | Step-by-step reasoning content |
| Vision | `Qwen3-VL-235B` | ~3s | Only vision model (but adapter buggy) |
| Massive context | `Qwen3.5-397B` | ~30s+ TTFT | Longest context |
| Chinese | `GLM-5.2` | ~700ms | Native Chinese |
| Tool calling | `DeepSeek-V4-Pro` | ~800ms | Best instruction-following |
| Reproducible | `DeepSeek-V4-Pro` (pinned) | ~700ms | Not rolling |

## Anti-patterns (don't do this)

| Anti-pattern | Why |
|--------------|-----|
| Set `max_tokens` and expect it to limit the platform | Adapter doesn't forward it — currently no-op |
| Set `temperature` to a specific value via API | Same — adapter doesn't forward |
| Try `image_url` on any model except `Qwen3-VL-235B` | Will return 200 with garbled text instead of 400 |
| Use `qwen-plus-latest` in a benchmark | Model silently upgrades under the same name |
| Send a 50KB prompt and assume "context window allows it" | No token accounting; estimate via chars/4 |
| Expect auto-continuation of truncated responses | Not implemented; long responses just stop |
| Set `tool_choice: "required"` (OpenAI) or `tool_choice: "any"` | Adapter ignores; tool use is prompt-only |
| Trust `usage` field for billing | Always 0 |

## What's still broken (must-fix to fully use the platform)

The adapter drops several things on the floor. If you need any of these, the work is small (~30–120 LoC, atomic commits possible):

| Gap | Impact | Effort |
|-----|--------|--------|
| `max_tokens` not forwarded to platform | Clients can't control output length | ~30 LoC |
| `temperature` / `top_p` not forwarded | Clients can't control sampling | ~30 LoC |
| Image input returns 200 (OpenAI) instead of 400 | Confusing silent failure | ~5 LoC |
| Context window not exposed via API | Can't enforce token limits | ~10 LoC |
| Token usage always 0 | No billing / context tracking | ~15 LoC |
| Auto-continuation not implemented | Long responses truncated without warning | ~50 LoC |
| `finish_reason` synthesized to `"stop"` (never `"length"`) | Misleading stop reasons | ~10 LoC |

Total gap: ~150 LoC. Each fix is independent and testable.

See [capabilities.md](./capabilities.md) §"Summary scorecard" for full audit.
