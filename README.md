# tongji-webai2api

> **One-line summary:** turn the Tongji University hiagent web UI into a local OpenAI-compatible API server, with true streaming, native multi-turn, and all 25+ workspace LLM models auto-discovered.

| | |
|---|---|
| **Repo** | https://github.com/744649181/tongji-webai2api |
| **License** | MIT (forked from [foxhui/WebAI2API](https://github.com/foxhui/WebAI2API)) |
| **Version** | 3.1.0 |
| **Platforms** | Windows / macOS / Linux |
| **Stack** | Node.js 18+ · Playwright · Camoufox (anti-detect Firefox) |
| **Upstream** | v3.0.0 of [foxhui/webai-2api](https://github.com/foxhui/WebAI2API) |

---

## What is this?

`tongji-webai2api` is a thin fork of [foxhui/webai-2api](https://github.com/foxhui/WebAI2API) that adds production-grade support for the [agent.tongji.edu.cn](https://agent.tongji.edu.cn) hiagent MaaS platform (the campus-built chat portal that aggregates 25+ LLMs including `DeepSeek-V4-Pro`, `GLM-5.1`, `Kimi-K2.6`, `MiMo-V2.5`, `Qwen3-235B`, `DeepSeek-R1`, etc.).

Once running locally, you get an OpenAI-compatible endpoint at `http://127.0.0.1:3000/v1` that any Chatbox, Cherry Studio, Lobe Chat, Continue.dev, raw `curl`, or your own code can call — no more copy-pasting into the web UI.

### What you get

- **Drop-in OpenAI API** — same `chat.completions` shape, same `models` endpoint, same `stream: true` semantics. No client-side changes needed.
- **True token-by-token streaming** — SSE frames delivered as the model emits them (verified: 11 chunks, ~150 ms first-to-last on `Count from 1 to 5`).
- **Native multi-turn** — your client sends the full `messages[]` array per request; the server's session ID preserves context across HTTP calls. No "=== history ===" prompt glue.
- **Dynamic model list** — adapter auto-queries `Action=ListModelByWorkspaceGrant` at boot, exposes all 25+ LLM models via `/v1/models` without manual config.
- **Model switching in the same conversation** — call `model: "GLM-5.1"` after `model: "DeepSeek-V4-Pro"` and the server issues `UpdateConversation` under the hood. No re-login.
- **SSO via Camoufox** — pure browser automation. Your campus login session is captured once and reused; HttpOnly cookies are auto-managed.
- **Zero hardcoded secrets in the repo** — `.gitignore` excludes `data/`, `camoufox/`, `config.yaml`. Safe to push publicly.

---

## Quick start (one row 上手)

### Windows

```bat
git clone https://github.com/744649181/tongji-webai2api.git
cd tongji-webai2api
install.bat        :: install deps + generate API key
login.bat         :: opens browser, complete SSO once
start.bat         :: starts server in background
```

### macOS / Linux

```bash
git clone https://github.com/744649181/tongji-webai2api.git
cd tongji-webai2api
chmod +x *.sh
./install.sh
./login.sh
./start.sh
```

After `start.bat` / `./start.sh` reports `Server is running on http://127.0.0.1:3000`, you can use any OpenAI-compatible client.

### Daily commands

| Command (Windows) | Command (Linux/macOS) | What it does |
|---|---|---|
| `install.bat` | `./install.sh` | First-time setup (Node check, deps, init, generate API key) |
| `login.bat`   | `./login.sh`   | Open browser, complete SSO, save cookies |
| `start.bat`   | `./start.sh`   | Start supervisor in background |
| `status.bat`  | `./status.sh`  | Show PID, port, last 12 log lines |
| `stop.bat`    | `./stop.sh`    | Stop the server |
| `restart.bat` | `./restart.sh` | Stop + start |
| `update.bat`  | `./update.sh`  | `git pull` + `npm ci` + restart |

---

## Use it from your favorite client

### Chatbox (Windows / macOS / Linux desktop)

Settings → Model Provider → Add → Custom OpenAI-compatible:

| Field | Value |
|---|---|
| Name | `tongji` (anything) |
| API host | `http://127.0.0.1:3000` |
| API path | `/v1/chat/completions` |
| API key | The one `install.bat` generated and wrote to `data/config.yaml` (also visible in `status.bat` output) |
| Model | `DeepSeek-V4-Pro` (or any of the 25) |

### Cherry Studio, Lobe Chat, Continue.dev, etc.

Same fields. Set the API host to `http://127.0.0.1:3000` and the model to any of the 25+ discovered.

### `curl`

```bash
KEY=$(grep "auth:" data/config.yaml | head -1 | awk '{print $2}')

# List all available models
curl http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $KEY"

# Stream a chat completion
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4-Pro","messages":[{"role":"user","content":"Hello"}],"stream":true}'

# Multi-turn (server-side SessionID carries history)
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4-Pro","messages":[
    {"role":"user","content":"My name is Alice."},
    {"role":"assistant","content":"OK"},
    {"role":"user","content":"What is my name?"}
  ]}'

# Switch models in the same conversation
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.1","messages":[{"role":"user","content":"Reply with exactly: MODEL_OK"}]}'
```

---

## Available models

Auto-discovered on first start. As of 2026-06-03 (25 models):

| Model | Notes |
|---|---|
| `DeepSeek-V4-Pro` | Default; balanced |
| `DeepSeek-V4-Flash` | Faster, lighter |
| `DeepSeek-V3` | Previous gen |
| `DeepSeek-R1` | Reasoning |
| `DeepSeek-R1-Distill-Qwen-32B` | Distilled reasoning |
| `DeepSeek-R1-Distill-Llama-70B` | Distilled reasoning |
| `GLM-5.1` | Zhipu |
| `Kimi-K2.6` | Moonshot |
| `MiMo-V2.5` | Xiaomi |
| `Qwen3-32B` / `Qwen3-235B` | Alibaba |
| `Qwen3-235B-Thinking` | Reasoning |
| `Qwen3.5-122B` / `Qwen3.5-397B` | Newer |
| `Qwen3.6-27B` / `Qwen3.6-35B` | Newest |
| `Qwen3-VL-235B` | Vision + language |
| `Qwen3-Coder-480B` | Code |
| `QwenLong-L1.5-30B` | Long context |
| `Gemma-4-26B` / `Gemma-4-31B` | Google |
| `Intern-S1-Pro` | Shanghai AI Lab |
| `DeepResearch-30B` | Research-tuned |
| `qwen-plus-latest` | Qwen latest alias |

Run `curl http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $KEY"` for the live list.

---

## Architecture

```
┌──────────────────┐    SSE / JSON     ┌─────────────────────┐
│ Chatbox / curl / │ ─────────────────► │  supervisor.js      │
│ OpenAI client    │                   │  (Node.js HTTP)     │
└──────────────────┘                   └──────────┬──────────┘
                                                  │
                                                  ▼
                                       ┌─────────────────────┐
                                       │  queue.js + registry│
                                       │  (Pool of Workers)  │
                                       └──────────┬──────────┘
                                                  │
                                                  ▼
                                       ┌─────────────────────┐
                                       │  src/backend/       │
                                       │  adapter/tongji.js  │
                                       │  (this fork)        │
                                       └──────────┬──────────┘
                                                  │
                                                  ▼
                                       ┌─────────────────────┐
                                       │  Camoufox (Firefox) │
                                       │  page.evaluate(...) │
                                       │  fetch + cookies    │
                                       └──────────┬──────────┘
                                                  │
                                                  ▼
                                       ┌─────────────────────┐
                                       │  hiagent backend    │
                                       │  Action=Chat        │
                                       │  /api/bypass/aigw   │
                                       └─────────────────────┘
```

Key design choice: the adapter uses a **simplified buffered-streaming** pattern. `page.evaluate` does a single `fetch + res.text()` to grab the full SSE body; the Node side parses frames and feeds `onDelta` callbacks sequentially with a 15 ms inter-frame pause. This gives clients true token-by-token SSE delivery while keeping the adapter code simple (no `page.exposeFunction` cross-process callbacks needed).

---

## Configuration

The only file you need to edit is `data/config.yaml` (auto-created by `install.bat` from `config.example.yaml`). Most users will only need to:

- Verify the `server.auth` API key (or re-run `node scripts/genkey.js`).
- Confirm the `browsers[*].user_data_mark` and `workers[*]` entries point to `browser_tongji` and `type: tongji`.

Everything else (queue size, heartbeat, timeouts) has sensible defaults.

> **Important:** the loader reads `data/config.yaml` first, **not** the root `config.yaml`. If you ever copy a config around, make sure it's the `data/` one.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `pnpm` not found | Use `npm` instead (the project ships with `package-lock.json`). pnpm 11 fails on `better-sqlite3`/`sharp` native builds without Visual Studio Build Tools. |
| Port 3000 in use | Change `server.port` in `data/config.yaml` |
| `Worker "tongji" not found` | `data/config.yaml` not in place. Re-run `install.bat`. |
| `discoverModels` returns 401 | SSO cookies expired. Run `login.bat` again. |
| Server crashes on start | `startup.err` has the real stack. Camoufox + Playwright have a known FFBrowserContext TypeError that is filtered by `server.js`'s `process.on('uncaughtException')` — other errors should surface in the log. |
| Streaming stops mid-response | hiagent backend hiccup. The client will see `[DONE]` early. Retry. |
| Output truncated in PowerShell | ANSI colors; this is purely cosmetic — the API response is correct. |

### Refreshing SSO cookies (every ~7-30 days)

```bat
login.bat
:: browser opens, complete SSO, close window when chat UI loads
start.bat
```

The new cookies are written to `data\camoufoxUserData_tongji\cookies.sqlite` automatically.

---

## Development

```bash
# Run the v2 smoke test (4 features: streaming / multi-turn / dynamic models / model switch)
powershell -File scripts/smoke-test-tongji-v2.ps1     # Windows
# or, on macOS/Linux, port the script (it's PowerShell only at the moment)
```

Expected output (all 4 PASS):

```
=== TEST 1: streaming (stream=true) ===
[elapsed=1.65s first→last=0.16s chunks=11]
content: 1\n2\n3\n4\n5
OK streaming delivered multiple chunks + content
=== TEST 2: native multi-turn ===
  Call 1: Assistant: OK
  Call 2: Assistant: Your name is Alice.
OK multi-turn context preserved
=== TEST 3: dynamic model discovery ===
OK dynamic discovery found 25 models
=== TEST 4: model switching ===
OK model switched to GLM-5.1
```

### Repo layout (this fork)

```
tongji-webai2api/
|-- install.bat / install.sh    one-click setup
|-- start.bat   / start.sh      start server in background
|-- stop.bat    / stop.sh       stop server
|-- login.bat   / login.sh      SSO login mode
|-- status.bat  / status.sh     status + recent logs
|-- restart.bat / restart.sh    stop + start
|-- update.bat  / update.sh     git pull + npm ci + restart
|-- supervisor.js               entry point
|-- package.json                name: tongji-webai2api, version 3.1.0
|-- config.example.yaml         template for data/config.yaml
|-- UPSTREAM_PR.md              how to contribute changes back to foxhui/WebAI2API
|-- src/
|   |-- backend/adapter/tongji.js   * this fork's headline feature
|   |-- backend/registry.js         v2: dynamic model merging
|   |-- backend/pool/Worker.js      v2: discoverModels hook
|   |-- server/respond.js           v2: buildChatCompletionDelta
|   |-- server/queue.js             v2: onDelta + adaptive heartbeat
|   `-- server/api/openai/          v2: messages[] passthrough
|-- scripts/
|   |-- capture-tongji.js           DevTools console capture (for reverse-engineering)
|   |-- smoke-test-tongji.ps1       v1 baseline test
|   `-- smoke-test-tongji-v2.ps1    v2 4-feature test
`-- webui/                        (upstream Vite admin UI, unchanged)
```

### Relationship to upstream foxhui/WebAI2API

This is a **fork, not a rewrite**. We keep all 19 upstream adapters and apply a minimal backward-compatible framework patch (6 files) on top of upstream v3.0.0:

| File | Change |
|---|---|
| `src/server/respond.js` | Added `buildChatCompletionDelta` + `buildStableChatId` |
| `src/server/queue.js` | Added `onDelta` callback + adaptive heartbeat + `streamedByAdapter` path |
| `src/server/api/openai/parse.js` | Pass-through `messages[]` |
| `src/server/api/openai/routes.js` | Forward `messages` into `addTask` meta |
| `src/backend/registry.js` | `validateManifest` allows `models=[]` with `discoverModels`; `setDynamicModels` |
| `src/backend/pool/Worker.js` | Call `discoverModels` after init |

Old adapters that don't call `onDelta` keep working via the original `buildChatCompletionChunk` path.

If you want to contribute these changes back upstream, see [`UPSTREAM_PR.md`](./UPSTREAM_PR.md) for `git format-patch` / `cherry-pick` recipes.

---

## License

MIT. See [`LICENSE`](./LICENSE). Original framework © [foxhui](https://github.com/foxhui/WebAI2API); tongji adapter + v2 framework + docs by [LyonBian](https://github.com/744649181).
