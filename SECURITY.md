# Security Policy

## Reporting a vulnerability

If you discover a security issue in this repository, **please do not open a public GitHub issue.** Instead, email the maintainer directly (see your GitHub profile settings for the contact email on [@744649181](https://github.com/744649181)) or open a [private security advisory](../../security/advisories/new).

We aim to acknowledge within 3 business days and provide a fix or mitigation within 30 days for critical issues.

## Scope

This repository is a **personal fork** of [foxhui/WebAI2API](https://github.com/foxhui/WebAI2API). It adds a single adapter for the Tongji University hiagent platform plus a small, backward-compatible framework patch (see [README.md](./README.md#relationship-to-upstream-foxhuiwebai2api)).

- **In scope:** the tongji adapter (`src/backend/adapter/tongji.js`), the v2 framework changes (6 files, all in `src/`), the one-click scripts in the repo root, and the smoke test in `scripts/`.
- **Out of scope:** the other 19 upstream adapters and the rest of the framework — please report those to [foxhui/WebAI2API](https://github.com/foxhui/WebAI2API/security/policy) instead.

## Secrets

**No secrets are required to build or test this project.** The `.gitignore` excludes:

- `data/` (cookies, history DB, log files, generated API key)
- `camoufox/` (browser binary + your SSO profile)
- `config.yaml` (contains the API key)
- `startup.log` / `startup.err`
- `tongji-capture-*.json` (network traces from the DevTools capture script)

If you accidentally commit a secret, rotate it immediately and contact the maintainer — git history is permanent.

## Camoufox + Playwright

This project uses [Camoufox](https://github.com/daijro/camoufox) (anti-detect Firefox) + [Playwright](https://playwright.dev/) to drive a real browser session. We pin a known-good combination of versions in `package.json`. Running the bundled browser **on a different network than the one you use day-to-day** is recommended — the campus SSO flow trusts device + IP heuristics.

The supervisor's `server.js` includes a feature-filtered `process.on('uncaughtException')` handler that swallows a known Playwright/Camoufox compat bug (`FFBrowserContext` pageError TypeError). All other exceptions still surface. See `src/server/server.js` for the exact filter and `memory/self_improve.md` (in the upstream repo) for the full diagnosis.
