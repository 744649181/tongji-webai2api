# Contributing

Thanks for your interest in improving `tongji-webai2api`! This document covers the practical workflow.

## Quick links

- [README](./README.md) — what this is, how to use it
- [UPSTREAM_PR.md](./UPSTREAM_PR.md) — how to send the v2 framework changes back to [foxhui/WebAI2API](https://github.com/foxhui/WebAI2API) as a PR
- [CHANGELOG.md](./CHANGELOG.md) — release history
- [Open issues](https://github.com/744649181/tongji-webai2api/issues) — bug reports & feature requests
- [GitHub Actions](../../actions) — CI runs on every push to `main`

## Local development

```bash
# Clone
git clone https://github.com/744649181/tongji-webai2api.git
cd tongji-webai2api

# Install + login + start
./install.sh   # or install.bat on Windows
./login.sh     # or login.bat — opens browser, complete SSO
./start.sh     # or start.bat — server in background

# Make changes, then verify:
./status.sh    # or status.bat — see PID + recent logs

# Smoke test the 4 v2 features:
powershell -File scripts/smoke-test-tongji-v2.ps1     # Windows
# (POSIX port pending — open a PR if you write one)
```

Expected: all 4 tests pass (streaming / multi-turn / dynamic models / model switch).

## Coding conventions

- **ES modules only** — `package.json` has `"type": "module"`. Use `import`/`export`, not `require`. Use `.js` extension in relative imports.
- **Path aliases** — use the `#` aliases (`#utils/foo`, `#backend/foo`, `#server/foo`) when crossing module boundaries, not deep relative paths.
- **Adapter placement** — new adapters go in `src/backend/adapter/<id>.js`. Drop the file, add a worker in `data/config.yaml`, no framework changes needed.
- **Forward compatibility** — anything that adds a new field to the manifest / API surface must keep the existing field working.
- **Match existing style** — see `lmarena_text.js` (simplest), `deepseek_text.js` (medium complexity), or `tongji.js` (this fork's headline) for canonical templates.

## Before opening a PR

1. **Run the smoke test** — `scripts/smoke-test-tongji-v2.ps1` should report all 4 features PASS.
2. **One-line summary in the PR description** — what changed, why, and how you tested.
3. **Update CHANGELOG.md** — add a bullet under the next `[Unreleased]` section (or create the section if missing) describing your change in user-facing terms.
4. **Don't include secrets** — `data/`, `camoufox/`, `config.yaml`, and `startup.{log,err}` are all gitignored. Don't paste cookies, API keys, or hiagent tokens in code or screenshots.

## Reporting bugs

Use the [bug report](../../issues/new?template=bug_report.yml) template. Required info:

- OS + Node.js version
- tongji-webai2api version (`git rev-parse --short HEAD`)
- The model ID you were calling
- The relevant slice of `data/logs/system.log` (use a `\`\`\`shell` code block — it has syntax highlighting)
- Output of `status.bat` / `./status.sh`

## Adding a new adapter (for a different web-chat provider)

See the comments at the top of `src/backend/adapter/tongji.js` for the canonical adapter skeleton. The other 19 upstream adapters (`src/backend/adapter/*.js`) are real-world examples ranging from simple to complex — pick the simplest one that matches your needs and start from there.

Required manifest fields:

```js
export const manifest = {
  id: '<unique-id>',          // must match worker.type in config.yaml
  displayName: '...',
  description: '...',
  getTargetUrl(config, workerConfig) { return '...'; },
  models: [
    { id: 'model-name', imagePolicy: 'forbidden' }   // or 'optional' / 'required'
  ],
  // Optional: dynamic discovery (called once after Worker init)
  async discoverModels(ctx) { return []; },
  // Optional: navigation handlers (called after page.goto)
  navigationHandlers: [],
  // Core: text/image generation function
  async generate(context, prompt, imagePaths, modelId, meta) {
    // context: { page, config }
    // meta: { id, reasoning, onDelta?, messages? }
    return { text: '...', reasoning: '...', image: '...' };
    // or { error: '...' }
  },
};
```

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](./LICENSE)).
