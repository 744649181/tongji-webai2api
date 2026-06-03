# Contributing back to foxhui/WebAI2API

This document explains how to extract the changes from this fork and submit
them as a PR to the upstream [foxhui/WebAI2API](https://github.com/foxhui/WebAI2API) repo.

---

## What's new in this fork

| File | Status | Description |
|------|--------|-------------|
| `src/backend/adapter/tongji.js` | **new** | Adapter for agent.tongji.edu.cn hiagent MaaS. Pure-HTTP, OpenAI SSE compatible. |
| `src/server/respond.js` | modified | Added `buildChatCompletionDelta` + `buildStableChatId` (streaming) |
| `src/server/queue.js` | modified | Added `onDelta` callback + adaptive heartbeat + `streamedByAdapter` path |
| `src/server/api/openai/parse.js` | modified | Pass-through `messages` array |
| `src/server/api/openai/routes.js` | modified | Forward `messages` into `addTask` meta |
| `src/backend/registry.js` | modified | `validateManifest` allows `models=[]` if `discoverModels` exists; `setDynamicModels` + merged `getModelsForAdapter` |
| `src/backend/pool/Worker.js` | modified | Call `discoverModels` after init, register in registry |
| `scripts/capture-tongji.js` | **new** | Browser console capture script (for reverse-engineering other web-chat backends) |
| `scripts/smoke-test-tongji.ps1` | **new** | v1 baseline test |
| `scripts/smoke-test-tongji-v2.ps1` | **new** | v2 full test (streaming + multi-turn + dynamic + model-switch) |

All 19 upstream adapters are preserved untouched. All v2 framework changes are
backward-compatible: adapters that don't call `onDelta` still work via the
old `buildChatCompletionChunk` path.

---

## How to extract a clean diff against upstream

```bash
# 1. Add upstream as a remote (do this once)
git remote add upstream https://github.com/foxhui/WebAI2API.git
git fetch upstream

# 2. Find the latest upstream release tag
git tag -l 'upstream/*' 'v*' | sort -V | tail -5
# Use the latest tag, e.g. v3.0.0

# 3. Generate the diff against the upstream baseline
git diff upstream/main HEAD -- \
    src/backend/adapter/tongji.js \
    src/backend/registry.js \
    src/backend/pool/Worker.js \
    src/server/respond.js \
    src/server/queue.js \
    src/server/api/openai/parse.js \
    src/server/api/openai/routes.js \
  > tongji-v2-framework.patch

# 4. Add the new files separately
git diff --no-index /dev/null src/backend/adapter/tongji.js > tongji-adapter.patch
# (Note: --no-index with /dev/null may require git config; alternative below)
git format-patch upstream/main -1 --stdout -- src/backend/adapter/tongji.js > tongji-adapter.patch
```

Or, more robustly, use a feature branch:

```bash
# 1. Branch off upstream
git checkout -b feat/tongji-adapter upstream/main

# 2. Cherry-pick the commits from this fork
git fetch origin  # add 'origin' = this fork's clone
git cherry-pick <commit-sha-of-initial-commit>

# 3. Push the branch to your fork
git push -u origin feat/tongji-adapter

# 4. Open a PR from your fork's feat/tongji-adapter -> foxhui/WebAI2API:main
```

---

## Suggested PR structure

If you want to split the PR for easier review:

**PR 1: Framework v2 changes** (independent of tongji)
- `src/server/respond.js`
- `src/server/queue.js`
- `src/server/api/openai/parse.js`
- `src/server/api/openai/routes.js`
- `src/backend/registry.js`
- `src/backend/pool/Worker.js`

Title: `feat: v2 framework — true streaming, native multi-turn messages[], dynamic model discovery`

**PR 2: tongji adapter** (depends on PR 1)
- `src/backend/adapter/tongji.js`
- `scripts/capture-tongji.js` (optional but useful)
- `scripts/smoke-test-tongji.ps1` (optional)
- `scripts/smoke-test-tongji-v2.ps1` (optional)

Title: `feat: add tongji adapter (agent.tongji.edu.cn hiagent)`

---

## Verification before PR

Run the smoke test against the upstream branch:

```bash
# In a clean checkout of foxhui/WebAI2API + this PR applied:
pnpm install
node scripts/init.js
# Add tongji worker to data/config.yaml
pnpm start -- -login=tongji     # first-time login
pnpm start
powershell -File scripts/smoke-test-tongji-v2.ps1
```

Expected output (all 4 tests PASS):

1. streaming: 11 chunks, 0.16s span
2. multi-turn: Call 1 → "OK" / Call 2 → "Alice" (or "Your name is Alice.")
3. dynamic models: 25 discovered
4. model switch: GLM-5.1 response when `model: 'GLM-5.1'`
