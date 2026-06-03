/**
 * Tongji Agent Capture Tool — v2
 * ─────────────────────────────────────────────────────────────────────────────
 * v2 升级:为 tongji adapter v2(真流式 + messages[] + 动态模型列表)收集
 * 完整的 HiAgent / Volcengine MaaS API 行为。比 v1 多记录 LIST_BOTS / CREATE_SESSION /
 * CREATE_MESSAGE / 多轮对话 / 模型切换等场景,并对敏感 header 做 hash 脱敏。
 *
 * 用法(浏览器 Console,不是 Node):
 *   1. 浏览器打开:
 *        https://agent.tongji.edu.cn/product/maas/personal/personal-13048/experience
 *      登录(若有效 cookie 直接进 chat 页)。
 *   2. 按 F12 → Console 标签。
 *   3. 把本文件全部内容粘贴到 Console,回车。
 *   4. 按照 Console 输出的指引,依次完成 7 个阶段(不要急,每步等几秒):
 *        Phase 1 - boot      : 等页面加载完成
 *        Phase 2 - send-1    : 在 chat 输入框打 "Hello" 发送
 *        Phase 3 - send-2    : 同一对话再发 "What's 2+2?"  ← 测多轮 session
 *        Phase 4 - send-3    : 同一对话再发 "回忆我上一个问题"  ← 测后端记忆
 *        Phase 5 - new-chat  : 点 "新建对话" 按钮(若有)
 *        Phase 6 - reload    : 按 F5 刷新页面(脚本会保留状态)— 跳过此步若不方便
 *        Phase 7 - model-switch: 切换模型(若 UI 有下拉) — 跳过此步若没有此功能
 *   5. 全部完成后按 F9 立刻保存,或者闲置 60 秒自动保存。
 *   6. 自动下载 tongji-capture-v2-<时间戳>.json,把这个文件发给我。
 *
 * 隐私:敏感 header(cookie, x-csrf-token, x-tt-token, authorization)被
 *      hash 脱敏为 "sha256:<前12位>";header NAME 保留(我需要知道哪些 header 存在);
 *      body 保留(API shape 需要)。如有 PII 可手动编辑 JSON 后再发。
 *
 * 安全:只 hook 自己页面的 fetch/XHR/EventSource。不外发任何数据。
 * ─────────────────────────────────────────────────────────────────────────────
 */
(() => {
  if (window.__tongjiCaptureV2Installed) {
    console.warn('[CAPTURE v2] 已安装。刷新页面后再粘贴一次。');
    return;
  }
  window.__tongjiCaptureV2Installed = true;

  const PATTERN_PRIMARY = /\/api\/bypass\/aigw/;
  const PATTERN_SECONDARY = /(?:agent\.tongji\.edu\.cn)?\/api\//;
  const SENSITIVE_HEADERS = /^(cookie|set-cookie|x-csrf-token|x-tt-token|authorization|x-access-token|x-session-token|api-key)$/i;

  const log = (...a) => console.log('%c[CAPTURE v2]', 'color:#0a0;font-weight:700', ...a);
  const warn = (...a) => console.warn('%c[CAPTURE v2]', 'color:#a60;font-weight:700', ...a);
  const milestone = (...a) => console.log('%c[CAPTURE v2 ★]', 'color:#06c;font-weight:700;font-size:13px', ...a);

  const dump = {
    captureVersion: 2,
    capturedAt: new Date().toISOString(),
    pageUrl: location.href,
    userAgent: navigator.userAgent,
    cookieKeys: parseCookieKeys(document.cookie),
    metaTokens: [...document.querySelectorAll('meta')]
      .filter(m => /csrf|token/i.test(m.getAttribute('name') || ''))
      .map(m => ({ name: m.getAttribute('name'), content: hashShort(m.getAttribute('content') || '') })),
    primaryRequests: [],     // /api/bypass/aigw 完整(body + SSE 全帧)
    relatedApiCalls: [],     // 其他 /api/ POST/PUT/PATCH(精简:URL + body + 状态)
    selectors: { inputCandidates: [], submitCandidates: [], modelSwitchCandidates: [] },
    timing: { startedAt: Date.now() },
    notes: [],
  };

  // ============================================================
  // selector heuristic
  // ============================================================
  function cssEscape(s) { return CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'); }
  function buildSelector(el) {
    if (el.id) return '#' + cssEscape(el.id);
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map(c => '.' + cssEscape(c)).join('');
      if (cls) return el.tagName.toLowerCase() + cls;
    }
    return el.tagName.toLowerCase();
  }
  function scanSelectors() {
    const inputs = [];
    document.querySelectorAll('textarea,[contenteditable=""],[contenteditable="true"],input[type="text"],input[type="search"]')
      .forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 80 && r.height > 20 && el.offsetParent) {
          inputs.push({
            kind: el.tagName.toLowerCase() + (el.getAttribute('contenteditable') !== null ? '[contenteditable]' : ''),
            id: el.id || null, name: el.name || null,
            placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || null,
            selector: buildSelector(el),
            outerHTMLSnippet: (el.outerHTML || '').slice(0, 400),
          });
        }
      });
    const buttons = [];
    document.querySelectorAll('button,[role="button"],[type="submit"]').forEach(el => {
      const txt = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      const isSend = /^(send|submit|发送|提交|发出|确认)$/i.test(txt)
        || /(send|submit|发送)/i.test(aria) || /(send|submit)/i.test(el.className || '');
      if (el.offsetParent && (isSend || (el.querySelector('svg') && txt.length < 5))) {
        buttons.push({ text: txt.slice(0, 30), ariaLabel: aria, selector: buildSelector(el), outerHTMLSnippet: (el.outerHTML || '').slice(0, 400) });
      }
    });
    const modelSwitches = [];
    // 模型选择候选:Arco Select 组件 / 含 "模型" / "Model" 文字的按钮
    document.querySelectorAll('button,[role="button"],[role="combobox"],.arco-select,.arco-dropdown-trigger').forEach(el => {
      const txt = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      if (el.offsetParent && (/模型|model|deepseek|gpt|claude|gemini|qwen|chatglm/i.test(txt + aria) && txt.length < 60)) {
        modelSwitches.push({ text: txt.slice(0, 60), ariaLabel: aria, selector: buildSelector(el), outerHTMLSnippet: (el.outerHTML || '').slice(0, 400) });
      }
    });
    return {
      inputCandidates: inputs.slice(0, 5),
      submitCandidates: buttons.slice(0, 6),
      modelSwitchCandidates: modelSwitches.slice(0, 5),
    };
  }
  dump.selectors = scanSelectors();

  // ============================================================
  // helpers
  // ============================================================
  function tryParseJson(x) {
    if (typeof x !== 'string') return x;
    try { return JSON.parse(x); } catch { return x; }
  }
  function parseRawHeaders(s) {
    const o = {};
    (s || '').trim().split(/\r?\n/).forEach(line => {
      const i = line.indexOf(':');
      if (i > 0) o[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return o;
  }
  function parseCookieKeys(cookieStr) {
    return (cookieStr || '').split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
  }
  function hashShort(s) {
    // 简单非加密 hash,只为去重 / 比对,不暴露完整 token
    if (!s) return '';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return 'hash:' + ((h >>> 0).toString(16).padStart(8, '0')) + ':len' + s.length;
  }
  function redactHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      out[k] = SENSITIVE_HEADERS.test(k) ? hashShort(String(v)) : v;
    }
    return out;
  }
  function extractActionFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return u.searchParams.get('Action') || u.searchParams.get('action') || null;
    } catch { return null; }
  }

  // ============================================================
  // finalize + download
  // ============================================================
  let finalized = false;
  function finalize(reason = 'auto') {
    if (finalized) return;
    finalized = true;
    dump.selectors = scanSelectors(); // rescan after user has interacted
    dump.timing.endedAt = Date.now();
    dump.timing.durationMs = dump.timing.endedAt - dump.timing.startedAt;
    dump.notes.push(`finalize-reason: ${reason}`);

    // acceptance check
    const actions = [...new Set(dump.primaryRequests.map(r => r.queryAction).filter(Boolean))];
    const streamFmts = [...new Set(dump.primaryRequests.map(r => {
      const ct = (r.responseHeaders?.['content-type'] || '').toLowerCase();
      if (ct.includes('event-stream')) return 'SSE';
      if (ct.includes('ndjson')) return 'NDJSON';
      if (ct.includes('json')) return 'JSON';
      return ct || 'unknown';
    }))];
    dump.acceptance = {
      primaryRequestCount: dump.primaryRequests.length,
      relatedApiCount: dump.relatedApiCalls.length,
      actionsObserved: actions,
      streamingFormatsObserved: streamFmts,
      hasChatAction: actions.some(a => /chat|sendmessage|sendchat/i.test(a)),
      hasListBots: actions.some(a => /list.*bot|list.*agent/i.test(a)),
      hasListModels: actions.some(a => /list.*model/i.test(a)),
      hasCreateSession: actions.some(a => /createsession|newsession/i.test(a)),
      hasCreateMessage: actions.some(a => /createmessage|sendmessage/i.test(a)),
      csrfHeaderReplayed: dump.primaryRequests.some(r => r.requestHeaders && Object.keys(r.requestHeaders).some(k => /csrf/i.test(k))),
    };

    const json = JSON.stringify(dump, null, 2);
    milestone('====== CAPTURE COMPLETE ======');
    milestone(`Primary aigw calls: ${dump.primaryRequests.length}`);
    milestone(`Related /api/ calls: ${dump.relatedApiCalls.length}`);
    milestone(`Actions observed: [${actions.join(', ') || '(none!)'}]`);
    milestone(`Streaming formats: [${streamFmts.join(', ')}]`);
    milestone(`Acceptance:`, dump.acceptance);

    try {
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tongji-capture-v2-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      milestone(`Auto-downloaded → ${a.download}`);
    } catch (e) {
      warn('自动下载失败:', e.message);
      console.log(json); // fallback to console output
    }
    milestone('把下载到的 JSON 发给 assistant。');
  }

  // ============================================================
  // fetch hook
  // ============================================================
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    init = init || {};
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isPrimary = PATTERN_PRIMARY.test(url);
    const isRelated = !isPrimary && PATTERN_SECONDARY.test(url) && /^(POST|PUT|PATCH|DELETE)$/i.test(init.method || (input && input.method) || 'GET');
    if (!isPrimary && !isRelated) return origFetch.apply(this, arguments);

    const t0 = Date.now();
    let bodyText = init.body;
    if (bodyText instanceof Blob) try { bodyText = await bodyText.text(); } catch {}
    if (bodyText instanceof ArrayBuffer) try { bodyText = new TextDecoder().decode(bodyText); } catch {}

    const req = {
      transport: 'fetch',
      method: init.method || (input && input.method) || 'POST',
      fullUrl: url,
      queryAction: extractActionFromUrl(url),
      queryVersion: (() => { try { return new URL(url, location.origin).searchParams.get('Version'); } catch { return null; } })(),
      queryRegion: (() => { try { return new URL(url, location.origin).searchParams.get('Region'); } catch { return null; } })(),
      requestHeaders: redactHeaders(Object.fromEntries(new Headers(init.headers || (input && input.headers) || {}).entries())),
      requestBody: tryParseJson(bodyText),
      requestBodyRaw: typeof bodyText === 'string' ? bodyText.slice(0, 4000) : null,
      capturedAt: new Date().toISOString(),
    };

    if (isPrimary) {
      log(`#${dump.primaryRequests.length + 1} aigw Action=${req.queryAction || '?'} → recording...`);
    } else {
      log(`related ${req.method} ${url.replace(location.origin, '')}`);
    }

    const res = await origFetch.apply(this, arguments);
    req.responseStatus = res.status;
    req.responseHeaders = Object.fromEntries(res.headers.entries());

    if (isRelated) {
      // 精简版:只读 response 前 2KB 文本,不 tee
      try {
        const text = (await res.clone().text()).slice(0, 2000);
        req.responseBodySample = text;
      } catch (e) { req.notes = `clone-error: ${e.message}`; }
      req.timingMs = Date.now() - t0;
      dump.relatedApiCalls.push(req);
      return res;
    }

    // Primary: tee 流,完整捕获 SSE 帧
    req.sseFrames = [];
    req.rawBodySample = null;

    if (res.body && typeof res.body.tee === 'function') {
      const [a, b] = res.body.tee();
      (async () => {
        const reader = a.getReader();
        const decoder = new TextDecoder();
        let buffer = '', raw = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          raw += chunk; buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            req.sseFrames.push(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 2);
          }
          // 限制内存:超过 50 帧只记前 50(避免长对话爆内存)
          if (req.sseFrames.length > 50 && req.sseFrames.length % 20 === 0) {
            req.sseFrames = req.sseFrames.slice(0, 50);
            req._sseTruncatedAt = 50;
          }
        }
        if (buffer.trim()) req.sseFrames.push(buffer);
        req.rawBodySample = raw.slice(0, 6000);
        req.timingMs = Date.now() - t0;
        dump.primaryRequests.push(req);
        log(`#${dump.primaryRequests.length} aigw Action=${req.queryAction} done — ${req.sseFrames.length} frames, ${req.timingMs}ms`);
        resetSilentTimer();
      })().catch(e => { req.notes = 'stream-read-error: ' + e.message; dump.primaryRequests.push(req); });
      return new Response(b, { status: res.status, statusText: res.statusText, headers: res.headers });
    } else {
      try { req.rawBodySample = (await res.clone().text()).slice(0, 6000); } catch (e) { req.notes = 'clone-read-error: ' + e.message; }
      req.timingMs = Date.now() - t0;
      dump.primaryRequests.push(req);
      resetSilentTimer();
      return res;
    }
  };

  // ============================================================
  // XHR hook (axios fallback)
  // ============================================================
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._cap = { method, url, headers: {} };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    if (this._cap) this._cap.headers[k] = v;
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const url = this._cap?.url || '';
    const isPrimary = PATTERN_PRIMARY.test(url);
    const isRelated = !isPrimary && PATTERN_SECONDARY.test(url) && /^(POST|PUT|PATCH|DELETE)$/i.test(this._cap?.method || '');
    if (this._cap && (isPrimary || isRelated)) {
      const t0 = Date.now();
      const req = {
        transport: 'xhr',
        method: this._cap.method,
        fullUrl: url,
        queryAction: extractActionFromUrl(url),
        requestHeaders: redactHeaders(this._cap.headers),
        requestBody: tryParseJson(body),
        requestBodyRaw: typeof body === 'string' ? body.slice(0, 4000) : null,
        capturedAt: new Date().toISOString(),
      };
      log(`XHR ${this._cap.method} ${url.replace(location.origin, '')}`);
      this.addEventListener('loadend', () => {
        req.responseStatus = this.status;
        req.responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
        const ct = (req.responseHeaders['content-type'] || '').toLowerCase();
        req.rawBodySample = (this.responseText || '').slice(0, 6000);
        if (ct.includes('event-stream') || ct.includes('ndjson')) {
          req.sseFrames = (this.responseText || '').split('\n\n').filter(Boolean).slice(0, 50);
        }
        req.timingMs = Date.now() - t0;
        if (isPrimary) dump.primaryRequests.push(req); else dump.relatedApiCalls.push(req);
        resetSilentTimer();
      });
    }
    return origSend.apply(this, arguments);
  };

  // ============================================================
  // EventSource hook (HiAgent some build uses EventSource)
  // ============================================================
  if (window.EventSource) {
    const OrigES = window.EventSource;
    window.EventSource = function(url, init) {
      const es = new OrigES(url, init);
      if (PATTERN_PRIMARY.test(url)) {
        const req = { transport: 'eventsource', fullUrl: url, queryAction: extractActionFromUrl(url), init: init || null, sseFrames: [], capturedAt: new Date().toISOString() };
        log(`EventSource → ${url}`);
        es.addEventListener('message', e => { req.sseFrames.push('event: message\ndata: ' + e.data); if (req.sseFrames.length > 50) req.sseFrames = req.sseFrames.slice(0, 50); });
        es.addEventListener('error', () => { dump.primaryRequests.push(req); setTimeout(() => resetSilentTimer(), 200); });
      }
      return es;
    };
    window.EventSource.prototype = OrigES.prototype;
  }

  // ============================================================
  // 60s 静默自动 finalize + F9 手动 finalize
  // ============================================================
  let silentTimer = null;
  function resetSilentTimer() {
    if (silentTimer) clearTimeout(silentTimer);
    silentTimer = setTimeout(() => {
      log('60 秒静默,自动保存...');
      finalize('silent-timeout');
    }, 60000);
  }
  resetSilentTimer();

  window.addEventListener('keydown', e => {
    if (e.key === 'F9' && !finalized) {
      e.preventDefault();
      milestone('F9 pressed → finalize NOW');
      finalize('manual-F9');
    }
  });

  // ============================================================
  // 引导提示
  // ============================================================
  milestone('Installed v2.');
  milestone(`Pre-scan selectors: ${dump.selectors.inputCandidates.length} inputs, ${dump.selectors.submitCandidates.length} buttons, ${dump.selectors.modelSwitchCandidates.length} model-switch candidates`);
  console.log('%c─── 接下来请按顺序操作 ───', 'color:#06c;font-weight:700;font-size:14px');
  console.log('%c1. 在 chat 框输入 "Hello" 发送', 'color:#333;font-size:13px');
  console.log('%c2. 同一对话再发 "What\'s 2+2?"(测多轮 session)', 'color:#333;font-size:13px');
  console.log('%c3. 同一对话再发 "回忆我上一个问题"(测后端记忆)', 'color:#333;font-size:13px');
  console.log('%c4. 点 "新建对话" 按钮(如有)', 'color:#333;font-size:13px');
  console.log('%c5. 切换模型(如有下拉)', 'color:#333;font-size:13px');
  console.log('%c6. 全部做完后按 F9 立即保存,或闲置 60 秒自动保存', 'color:#06c;font-size:13px');
  console.log('%c提示:每发完一句话等几秒看上面 [CAPTURE v2] 日志确认抓到了再继续', 'color:#888;font-size:12px');
})();
