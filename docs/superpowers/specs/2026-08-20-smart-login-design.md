# Smart Login Lifecycle Design

- **Date**: 2026-08-20
- **Status**: Approved (brainstorming complete, awaiting user sign-off)
- **Owner**: LyonBian
- **Upstream**: foxhui/WebAI2API v3.0.0 (frozen)
- **This fork**: tongji-webai2api v3.1.0
- **Depends on**: existing `-login=tongji` mode in `server.js`, `data/camoufoxUserData_tongji/cookies.sqlite` flow

## 1. Goal

Eliminate the user's need to run multiple scripts and re-do manual SSO every
7-30 days. Introduce a **single-command smart start** (`npm run up`) that:

1. Detects whether the Tongji hiagent SSO cookies are still valid.
2. If valid, starts the server immediately -- zero clicks.
3. If invalid, walks the user through SSO **once**, encrypts the captured
   session state, and starts the server.
4. During operation, a **watchdog** silently re-injects fresh cookies on 401
   responses so subsequent server lifetimes are click-free.
5. No boot auto-start; manual start/stop only (per user decision).

Information captured from the SSO flow must be **encrypted at rest**; never
plaintext on disk.

## 2. Scope (v1)

**In scope:**

- New CLI commands: `npm run up`, `npm run down`, `npm run status`,
  `npm run login`. Each is a thin wrapper around a `scripts/cli/*.mjs`
  entry point.
- New module `src/backend/auth/` containing:
  - `keychain.mjs` -- cross-platform OS keychain abstraction with file
    fallback (Linux libsecret absent).
  - `sso.mjs` -- encrypt / decrypt / capture / inject.
  - `probe.mjs` -- SSO health probe (cheap mtime check + active API ping).
  - `watchdog.js` -- 401 detection and re-auth orchestration.
- Encryption: AES-256-GCM with 12-byte IV and 16-byte auth tag; master key
  in OS keychain (Windows Credential Manager / macOS Keychain / Linux
  libsecret) via `@napi-rs/keyring`.
- Watchdog triggers on 401s surfaced from the existing adapter error
  channel in `src/server/queue.js`.
- Cookie injection via `context.addCookies()` (Playwright API) -- the
  adapter itself (`src/backend/adapter/tongji.js`) is unchanged.
- Backward compatibility: existing `install.bat/sh`, `login.bat/sh`,
  `start.bat/sh`, `stop.bat/sh`, `status.bat/sh`, `restart.bat/sh`
  remain functional but are marked deprecated; they now shell out to the
  new npm scripts.

**Out of scope (v1):**

- WebUI enhancements (cookie age panel, manual re-login button, watchdog
  notification UI). The WebUI continues to serve as dashboard + settings
  + logs + VNC viewer. Future spec may cover.
- POSIX system-tray equivalents (`npm run up` + status check via CLI is
  the POSIX UX).
- Boot auto-start (LaunchAgent / systemd user unit). Manual start only.
- Native tool calling or any upstream hiagent capability change.
- Visual companion for the smart-start flow.

## 3. Architecture

```
                +--------------------------+
                | scripts/cli/up.mjs       |
                |   probe -> maybe login   |
                |   -> spawn supervisor.js |
                +-----------+--------------+
                            |
                            v
                +--------------------------+
                | supervisor.js (existing) |
                |   spawns server.js, IPC  |
                +-----------+--------------+
                            |
                            v
                +--------------------------+
                | server.js -> queue.js    |
                |   watchdog hook (new)    |
                +----+---------------+-----+
                     |               |
                     v               v
       +-------------------+   +---------------------+
       | src/backend/auth/ |   | src/backend/adapter |
       |  watchdog.js      |   |  tongji.js (NO CHG) |
       |  sso.mjs          |<--+  reads cookies via  |
       |  keychain.mjs     |   |  document.cookie    |
       |  probe.js         |   +---------------------+
       +---------+---------+
                 |
                 v
       +-----------------+        +---------------------+
       | OS Keychain     |        | data/.sso.enc       |
       | (DPAPI/Keychain/|        | (AES-256-GCM blob)  |
       |  libsecret)     |        +---------------------+
       +-----------------+
```

## 4. New files

| File | Purpose | Est. lines |
|------|---------|-----------:|
| `scripts/cli/up.mjs` | smart start: probe, maybe login, spawn supervisor | 180 |
| `scripts/cli/down.mjs` | graceful stop via supervisor IPC + port check | 80 |
| `scripts/cli/status.mjs` | unified status: PID, port, login age, queue, last log | 120 |
| `scripts/cli/login.mjs` | explicit one-shot login (used by `up` and standalone) | 150 |
| `src/backend/auth/keychain.mjs` | `@napi-rs/keyring` wrapper; file fallback when keychain unavailable | 140 |
| `src/backend/auth/sso.mjs` | encryptSSO / decryptSSO / captureFromBrowser / injectIntoContext | 220 |
| `src/backend/auth/probe.mjs` | SSO health probe (mtime + cheap API call) | 90 |
| `src/backend/auth/watchdog.js` | 401 detection + retry orchestration + notification | 260 |
| `tests/auth/test-keychain.mjs` | unit: keychain mock, fallback paths | 110 |
| `tests/auth/test-sso.mjs` | unit: encrypt/decrypt round-trip, inject cookie payload shape | 130 |
| `tests/auth/test-watchdog.mjs` | unit: 401 -> reauth tries (1, 2, 3) -> success / notify | 180 |
| `tests/auth/test-probe.mjs` | unit: mtime + active probe decision tree | 80 |

**Total new code: ~1740 lines.**

## 5. Untouched boundaries

- `src/backend/adapter/tongji.js` -- zero changes (cookie injection happens
  via Playwright `context.addCookies()` in the pool layer, not in the
  adapter itself).
- All other `src/backend/adapter/*.js` upstream adapters.
- `src/server/respond.js`, `patches/`, `webui/`.

## 5b. Modified files (existing)

| File | Change | Approx. lines |
|------|--------|--------------:|
| `package.json` | add `@napi-rs/keyring` to dependencies; add `up`/`down`/`status`/`login` scripts | +10 |
| `src/server/queue.js` | catch 401 errors from adapter; call `watchdog.handle401({worker, originalRequest, logger, notify})`; preserve per-worker mutex | +30 |
| `src/backend/pool/Worker.js` | expose `worker.context` (Playwright BrowserContext) and `worker.page` properties so watchdog can call `context.addCookies()` | +15 |
| `install.bat`, `install.sh`, `login.bat`, `login.sh`, `start.bat`, `start.sh`, `stop.bat`, `stop.sh`, `status.bat`, `status.sh`, `restart.bat`, `restart.sh` | become thin shims around `npm run up/down/status/login`; marked deprecated in file header comment | +5 each (replaces existing content) |
| `config.example.yaml` | document `auth.keychainFallback` and `auth.encryptAlgo` defaults (informational only; values hardcoded in code) | +15 |
| `README.md` | "Smart login lifecycle" section covering `npm run up/down/status/login`, encryption model, watchdog behavior | +120 |
| `AGENTS.md` | new section 12 (mirroring section 11 anthropic-protocol format) with smart-login hard rules | +60 |

## 6. CLI entry points (mount point for `npm run`)

In `package.json` add:

```json
"scripts": {
  "up": "node scripts/cli/up.mjs",
  "down": "node scripts/cli/down.mjs",
  "status": "node scripts/cli/status.mjs",
  "login": "node scripts/cli/login.mjs"
}
```

`install.bat/sh`, `start.bat/sh`, etc. become thin shims:

```bat
@echo off
:: install.bat -- thin shim around npm run up
npm run up %*
```

Marked deprecated in the file header; removed in v4.

## 7. Data flow

### 7.1 First-time start (`npm run up`)

```
1. scripts/cli/up.mjs:
   a. probe.mjs#probe():
      - data/.sso.enc missing  -> INVALID
      - mtime > 30d            -> STALE
      - cheap GET /api/aigw?Action=ListModelByWorkspaceGrant -> 200 valid, 401 invalid
   b. INVALID -> call scripts/cli/login.mjs:
      - read master key from keychain.mjs#getMasterKey() (or generate + store)
      - spawn `node server.js -login=tongji` (existing flow, opens browser)
      - poll data/camoufoxUserData_tongji/cookies.sqlite mtime every 500ms
        up to 5 minutes; abort on timeout (exit 2 "login timed out")
      - sso.mjs#captureFromBrowser(cookies.sqlite):
          extract session cookies (especially x-csrf-token) + user identifier
      - sso.mjs#encryptSSO(blob, masterKey):
          AES-256-GCM(iv=random12B, plaintext=JSON(cookies+meta))
          write data/.sso.enc with JSON header {iv, ct, tag, createdAt, userHash}
   c. spawn supervisor.js as before; supervisor spawns server.js.
2. Exit code 0 if running, non-zero on login failure.
```

### 7.2 Subsequent start (`npm run up` when SSO is valid)

```
1. probe.mjs#probe() returns VALID (mtime < 30d AND active ping 200).
2. skip login entirely.
3. spawn supervisor.js; exit 0.
```

### 7.3 Watchdog (during operation, 401 detected)

```
src/server/queue.js catches adapter error with status=401:
  -> watchdog.handle401({worker, originalRequest, logger, notify}):
     The watchdog extracts context/page from worker (worker.context, worker.page
     -- exposed by src/backend/pool/Worker.js per section 13 modified files).

     1. Try 1: silent re-inject
        - decrypt data/.sso.enc with masterKey
        - worker.context.addCookies(cookies) on the browser context
        - retry the original request
        - if 200, log + return.
     2. Try 2: session refresh endpoint (best-effort; opportunistic)
        - POST /api/aigw?Action=RefreshSession (no public contract; if 404 or
          405 returned, skip Try 2 entirely)
        - on 200, capture new cookies, re-encrypt to .sso.enc, retry.
     3. Try 3: notify user + interactive re-login
        - notification via:
          * Windows: tray balloon if Windows tray is up, else BurntToast PowerShell module if available
          * macOS: `osascript -e 'display notification'`
          * Linux: `notify-send` (libnotify); if missing, log warning
        - if user is at the keyboard: prompt in CLI log
        - if not: launch scripts/cli/login.mjs in background (browser popup)
        - when new cookies land in data/.sso.enc: re-inject + retry
     4. All failed -> 503 returned to upstream + `data/logs/system.log` alert
```

**Per-worker mutex**: concurrent 401s for the same worker await the in-flight
recovery before triggering a new one. Implemented as a per-worker
`Map<workerName, Promise>`; second 401 attaches to the in-flight promise.

### 7.2 Subsequent start (`npm run up` when SSO is valid)

```
1. probe.mjs#probe() returns VALID (mtime < 30d AND active ping 200).
2. skip login entirely.
3. spawn supervisor.js; exit 0.
```

### 7.3 Watchdog (during operation, 401 detected)

```
src/server/queue.js catches adapter error with status=401:
  -> watchdog.handle401({worker, originalRequest, logger, notify}):
     The watchdog extracts context/page from worker (worker.context, worker.page
     -- exposed by src/backend/pool/Worker.js per section 13 modified files).

     1. Try 1: silent re-inject
        - decrypt data/.sso.enc with masterKey
        - worker.context.addCookies(cookies) on the browser context
        - retry the original request
        - if 200, log + return.
     2. Try 2: session refresh endpoint (best-effort; opportunistic)
        - POST /api/aigw?Action=RefreshSession (no public contract; if 404 or
          405 returned, skip Try 2 entirely)
        - on 200, capture new cookies, re-encrypt to .sso.enc, retry.
     3. Try 3: notify user + interactive re-login
        - notification via:
          * Windows: tray balloon if Windows tray is up, else BurntToast PowerShell module if available
          * macOS: `osascript -e 'display notification'`
          * Linux: `notify-send` (libnotify); if missing, log warning
        - if user is at the keyboard: prompt in CLI log
        - if not: launch scripts/cli/login.mjs in background (browser popup)
        - when new cookies land in data/.sso.enc: re-inject + retry
     4. All failed -> 503 returned to upstream + `data/logs/system.log` alert
```

**Per-worker mutex**: concurrent 401s for the same worker await the in-flight
recovery before triggering a new one. Implemented as a per-worker
`Map<workerName, Promise>`; second 401 attaches to the in-flight promise.

## 8. Encryption details

- **Algorithm**: AES-256-GCM
- **Key**: 32 random bytes (`crypto.randomBytes(32)`); never logged.
- **Storage**: OS keychain under service `tongji-webai2api`, account
  `sso-master-key`.
  - Windows: Credential Manager via DPAPI (via `@napi-rs/keyring`).
  - macOS: Keychain login keychain.
  - Linux: libsecret (GNOME Keyring / KWallet via Secret Service API).
- **Fallback**: if `@napi-rs/keyring` reports `PlatformFailure` on Linux
  (e.g., no dbus), write the master key to `data/.master.key` with a
  prominent warning + `chmod 600`. Decryption still works, but at-rest
  security is reduced. Surface this in `npm run status` output.
- **Blob format** (`data/.sso.enc`):
  ```json
  {
    "version": 1,
    "createdAt": "2026-08-20T11:00:00Z",
    "lastRefreshAt": "2026-08-20T11:00:00Z",
    "userHash": "sha256:first8bytes",
    "iv": "<base64 12 bytes>",
    "ct": "<base64 ciphertext>",
    "tag": "<base64 16 bytes>"
  }
  ```
- Plaintext shape (decrypted at runtime only, never written):
  ```json
  {
    "sessionCookies": [{ "name": "x-csrf-token", "value": "...", "domain": ".tongji.edu.cn", "path": "/" }, ...],
    "userIdentifier": "sha256:16hexchars of any stable per-user cookie value (e.g., a user-id cookie if present, otherwise first 16 hex chars of sha256 of x-csrf-token). Used only to detect 'different user logged in' if cookies change identity. Never written to disk; never logged.",
    "capturedAt": "2026-08-20T11:00:00Z"
  }
  ```

  **Decryption availability**: if `masterKey` cannot be retrieved (keychain
  failure AND no file fallback), `decryptSSO()` throws `MasterKeyUnavailable`
  and the watchdog / probe functions fall back to requiring fresh login.

## 9. Watchdog logic (detail)

`src/backend/auth/watchdog.js` exports a single function:

```js
export async function handle401({ worker, originalRequest, logger, notify });
```

The watchdog reads `worker.context` and `worker.page` from the Worker
object (exposed by `src/backend/pool/Worker.js` per section 13 modified
files). This avoids the queue.js layer needing to know Playwright types.

State machine:

| Step | Action | On success | On failure |
|------|--------|------------|------------|
| 1 | decrypt .sso.enc + `worker.context.addCookies()` + retry | return result | step 2 |
| 2 | POST `/api/aigw?Action=RefreshSession` (best-effort, no contract; skip if 404/405) + retry | return result | step 3 |
| 3 | notify user (platform-specific) + spawn `login.mjs` + wait for new .sso.enc + re-inject + retry | return result | step 4 |
| 4 | log critical + return 503 to upstream | n/a | n/a |

Concurrency: only one watchdog flow per worker at a time. Implemented as
a per-worker `Map<workerName, Promise>`; a second 401 arriving mid-recovery
for the same worker awaits the in-flight promise. Different workers run
their watchdog flows independently.

## 10. Error handling and degradation matrix

| Failure | Behavior |
|---------|----------|
| cookies expired server-side | watchdog Try 3 -- interactive popup |
| server-side session not refreshable | same as above |
| Keychain unavailable (headless Linux, no dbus) | file fallback + startup warning + status shows "ENCRYPTION: file-fallback" |
| Master key corrupted / lost | auto re-login once; if it fails, clear `.sso.enc` and require fresh login |
| `context.addCookies()` rejected (cookie schema invalid) | watchdog Try 3 |
| notify-send / osascript missing | log warning; rely on user reading the CLI |
| Login popup timed out (user walked away) | server stays up but `discoverModels` returns 401; watchdog keeps nagging; `npm run status` shows STALE |
| Adapter returns a non-401 auth-shaped error (e.g., 403) | logged but not auto-handled (different cause) |
| Probe fails (hiagent network down at startup) | treat as STALE; warn user; offer `--force-start` flag to start anyway |

## 11. CLI command surface

### `npm run up [--force-start]`

```
Tongji WebAI2API -- smart start

[probe] data/.sso.enc missing -> login required
[login] opening browser; complete SSO to continue...
[login] SSO captured; encrypted to data/.sso.enc
[start] supervisor PID 12345
[start] tail: data/logs/system.log  (Ctrl+C to detach)
```

Exit codes:
- 0 -- server running (TTY mode: blocks tailing logs; CI mode: exits immediately).
- 2 -- login failed.
- 3 -- supervisor failed to bind port.
- 4 -- already running (use `npm run status`).

### `npm run down`

Sends SIGTERM to supervisor (via IPC if available, else by PID file). Waits
up to 5s for graceful shutdown. Exit 0.

### `npm run status`

```
Tongji WebAI2API status

  server:    UP (PID 12345, port 3000)
  login:     OK -- captured 2026-08-15, age 5d
  keychain:  OK (Windows Credential Manager)
  workers:   tongji (busy=0, queued=0)
  last log:  data/logs/system.log:tail-12
```

Exit codes:
- 0 -- server running and healthy (or not running, but sso/keychain OK).
- 1 -- degraded state (server not running but recoverable via `npm run up`).
- 5 -- unrecoverable (keychain failed AND no file fallback; fresh login required).

### `npm run login [--encrypt-only]`

Force a fresh login. With `--encrypt-only`, skip the server start.

## 12. Testing

### Unit

- `test-keychain.mjs`: mock `@napi-rs/keyring` for Windows / macOS / Linux.
  Test fallback to file mode on `PlatformFailure`. Test encryption key
  generation and round-trip storage.
- `test-sso.mjs`: encrypt / decrypt round-trip; capture payload shape;
  inject payload schema for Playwright `context.addCookies()`.
- `test-watchdog.mjs`: state-machine coverage:
  - 401 -> Try 1 success -> returns result.
  - 401 -> Try 1 fail -> Try 2 success -> returns result.
  - 401 -> Try 1+2 fail -> Try 3 success -> returns result.
  - 401 -> all fail -> 503 returned.
  - concurrent 401 -> queued, not double-fired.
- `test-probe.mjs`: VALID / INVALID / STALE decision tree.

### Integration

- `tests/auth/test-watchdog-integration.mjs`: spawns a mock hiagent
  server returning 401 once then 200. Verifies watchdog retries succeed.

### Manual smoke

- `npm run up` (fresh install) -> browser pops up -> complete SSO ->
  server starts. Verify `data/.sso.enc` is JSON, not SQLite.
- `npm run up` (subsequent) -> server starts without browser.
- `npm run status` -> all fields populated correctly.
- Simulate 401 by revoking cookie via WebUI admin tools -> next request
  triggers watchdog. Verify Try 1 re-injects and recovers.
- Verify Windows / macOS / Linux by running `npm run status` on each
  and confirming keychain entry exists.

### CI

- Add a step to `.github/workflows/ci.yml`: `node --test tests/auth/*.mjs`.
- Keep the existing structural check (no native browser needed for unit
  tests; keychain is mocked).

## 13. Completion criteria

The implementation is complete when **all** of the following are satisfied:

1. `node --test tests/auth/*.mjs` passes all cases.
2. `npm run up` on a fresh checkout walks the user through one browser SSO
   and starts the server. `data/.sso.enc` exists and is JSON-parseable
   + AES-256-GCM-decryptable.
3. `npm run up` on a machine with valid `.sso.enc` starts the server
   without any browser popup.
4. `npm run down` stops the server within 5 seconds.
5. `npm run status` reports login age, keychain status, server status,
   queue, and recent log lines.
6. Manual 401 simulation (overwrite `data/.sso.enc` with a deliberately
   empty or garbage `sessionCookies` array, then issue a request via curl)
   triggers watchdog recovery: Try 1 fails (addCookies no-op), Try 2
   skipped (no RefreshSession contract), Try 3 prompts for re-login or
   auto-spawns browser. Recovery logged within 30 seconds.
7. Cross-platform verification: `npm run status` shows keychain working
   on Windows / macOS / Linux. File-fallback warning appears when Linux
   libsecret is absent.
8. Existing `login.bat/sh`, `start.bat/sh`, etc. continue to work as
   deprecated shims (no behavior regression for users on the old flow).
9. README documents the new commands + the encryption model.
10. AGENTS.md `section 12` (next free number) lists smart-login hard
    rules mirroring the Anthropic protocol section.

## 14. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| `@napi-rs/keyring` native build fails on Windows (no MSVC) | Use the prebuild-only release channel; if build fails entirely, fall back to Node `crypto` + encrypted-file-only mode. Document in README. |
| hiagent does not expose `Action=RefreshSession` | Watchdog Try 2 best-effort; Treat 404/405 as "skip to Try 3". |
| Cookies genuinely revoked (user logged out from another browser) | Watchdog Try 3 popup. Cannot avoid user click in this case. |
| Master key in OS keychain but encrypted file `.sso.enc` from old machine | Decryption fails (auth tag mismatch). Auto-clear `.sso.enc` and prompt for fresh login. |
| Watchdog race condition during cookie injection | `context.addCookies()` is async; await it; add 100ms grace before retry. Use per-worker serialization to avoid double-injection. |
| Linux without libsecret | File fallback with `chmod 600` + warning in `npm run status`; no silent failure. |
| `npm run up` invoked twice concurrently | First instance writes PID file at startup; second instance sees it, exits 4 with "already running". |

## 15. Open questions deferred to implementation

None. All design decisions resolved during brainstorming:

- Scope: smart start + watchdog + encrypted storage (full Approach A).
- Encryption: OS keychain via `@napi-rs/keyring` with file fallback.
- Watchdog: hybrid silent-when-possible, popup-otherwise (three tries).
- POSIX scope: CLI only; no tray, no boot auto-start (per user).
- WebUI: out of scope (future spec).