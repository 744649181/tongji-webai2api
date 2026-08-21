/**
 * @fileoverview 同济大学 agent.tongji.edu.cn 智能体平台文本适配器 — v2 (纯 HTTP + 真流式 + 动态模型)
 *
 * 平台:基于火山引擎 hiagent / Arco Design 构建的私有 MaaS
 * 入口:https://agent.tongji.edu.cn/product/maas/personal/personal-13048/experience
 *
 * v2 三大特性:
 *   1. 真流式输出:server → client 走 OpenAI SSE 增量推送 (token-by-token)
 *   2. 单 prompt 原生多轮:取 meta.messages 最后一条 user 内容,后端 SessionID 自带上下文
 *   3. 动态模型发现:discoverModels 调 Action=ListModelByWorkspaceGrant 自动列出该 workspace 所有可用模型
 *
 * 已逆向 API (2026-06-03 capture):
 *   POST /api/aigw?Action=ListModelByWorkspaceGrant  → 模型列表
 *   POST /api/aigw?Action=CreateConversation         → 新建对话
 *   POST /api/aigw?Action=UpdateConversation         → 切换模型 (Remove old session + Add new)
 *   POST /api/aigw?Action=BatchCreateMessages        → 上传 prompt → MessageID
 *   POST /api/bypass/aigw?Action=Chat                → 触发流式生成 (OpenAI SSE 兼容)
 *
 * 简化设计:page.evaluate 里一次性 fetch 拿到完整 SSE body,Node 端 parse 后顺序调 onDelta。
 *   server → client 之间是真流式 (queue.js 的 SSE pipeline);
 *   adapter ↔ page 之间是 buffered — 换取了代码极简 + 跨帧可暂停/可重试。
 *
 * 首次登录: npm start -- -login=tongji
 */

import {
    waitForInput,
    gotoWithCheck,
    normalizePageError
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// ============ 常量 ============
const TARGET_URL = 'https://agent.tongji.edu.cn/product/maas/personal/personal-13048/experience';
const WORKSPACE_ID = 'personal-13048';
const INPUT_SELECTOR = 'textarea.arco-textarea, textarea.message-input-jqw0LgZ, [contenteditable="true"]';
const API_QUERY = 'Version=2023-08-01&Region=cn-north-1';
const DEFAULT_MODEL = 'DeepSeek-V4-Pro';
const DEFAULT_MODEL_FALLBACK_ID = 'd7nld86ju5g84vm5njf0';
const FRAME_PAUSE_MS = 15; // Node-side 解析后帧间停顿,客户端可看到真流式效果

// ============ 状态 (per-page session + 全局模型字典) ============

const SESSION_MAP = new WeakMap();
function getSession(page) {
    let s = SESSION_MAP.get(page);
    if (!s) {
        s = { conversationId: null, sessionId: null, modelServiceId: null, modelName: null };
        SESSION_MAP.set(page, s);
    }
    return s;
}

const MODEL_DICT = new Map(); // ModelName → { serviceId, contextTokens }

// ============ helpers ============

/** page.evaluate 里发 /api/aigw 请求 (浏览器自动带 cookies + 同源) */
async function aigwCall(page, action, body, { timeoutMs = 60000 } = {}) {
    const url = `/api/aigw?Action=${action}&${API_QUERY}`;
    return await page.evaluate(async ({ url, body, timeoutMs }) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const m = document.cookie.match(/x-csrf-token=([^;]+)/);
            const csrf = m ? decodeURIComponent(m[1]) : '';
            const res = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrf,
                    'x-top-region': 'cn-north-1',
                    'accept-language': 'zh',
                },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch {}
            return { ok: res.ok, status: res.status, text: text.slice(0, 4000), json };
        } finally { clearTimeout(t); }
    }, { url, body, timeoutMs });
}

/** 从 messages[] 提取最后一条 user 消息的文本
 *  - hiagent 的 BatchCreateMessages 一次只处理一条 user 消息(尽管字段叫 MessageList,
 *    多消息上传会被静默丢弃第二条起的 user/assistant entry — 已用 3-消息 upload 验证)
 *  - 真正的多轮靠 SessionID 维持:同一 SessionID 第二次上传会 append 新 user message,
 *    Chat 拿新 MessageID 触发,后端自动 join 完整 history
 *  - 所以这里只取最后一条 user,prior history 由 hiagent SessionID 隐式提供
 *  - 跳过 system role (hiagent 当前不暴露 system prompt 入口)
 */
function extractLastUserContent(messages, fallbackPrompt) {
    if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.role === 'user') {
                if (typeof m.content === 'string' && m.content) return m.content;
                if (Array.isArray(m.content)) {
                    const text = m.content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
                    if (text) return text;
                }
            }
        }
    }
    // 兜底:framework 的 prompt 字段(虚拟上下文串)— 只取"=== 当前输入 ==="之后的部分
    const fp = String(fallbackPrompt || '');
    const m = fp.match(/===\s*当前输入\s*===\s*([\s\S]*?)$/i);
    return (m ? m[1] : fp).trim();
}

// ============ discoverModels lifecycle hook ============

async function discoverModels(ctx) {
    const { page, workerName } = ctx || {};
    const meta = { workerName };
    try {
        if (!page) return [];
        if (!page.url().includes('agent.tongji.edu.cn')) {
            await gotoWithCheck(page, TARGET_URL, { timeout: 30000 });
        }
        await waitForInput(page, INPUT_SELECTOR, { click: false, timeout: 30000 }).catch(() => {});

        const r = await aigwCall(page, 'ListModelByWorkspaceGrant', {
            WorkspaceID: WORKSPACE_ID,
            Filter: { IsPublished: true, IsGranted: true, ExcludeWorkspaceID: WORKSPACE_ID, Type: 'text-generation' },
            ListOpt: { Sort: [{ SortField: 'created_at', SortOrder: 'desc' }] },
            PageSize: 50,
            PageNumber: 1,
        }, { timeoutMs: 15000 });

        if (!r.ok || !r.json?.Result?.Items) {
            logger.warn('适配器', `[tongji] discoverModels: 响应异常 status=${r.status}`, meta);
            return [];
        }

        const items = r.json.Result.Items;
        const models = [];
        for (const it of items) {
            const name = it.ModelName || it.Name;
            const sid = it.ID;
            if (!name || !sid) continue;
            const ctxTokens = it?.TokenConfig?.ContextTokens || it?.Property?.LLM?.Token?.ContextTokens || 0;
            MODEL_DICT.set(name, { serviceId: sid, contextTokens: ctxTokens });
            models.push({ id: name, imagePolicy: 'forbidden', type: 'text' });
        }
        logger.info('适配器', `[tongji] discoverModels 完成: ${models.map(m => m.id).join(', ')}`, meta);
        return models;
    } catch (e) {
        logger.warn('适配器', `[tongji] discoverModels 失败: ${e.message}`, meta);
        return [];
    }
}

// ============ session 管理 (CreateConversation / UpdateConversation) ============

async function ensureSession(page, requestedModelName, meta = {}) {
    const s = getSession(page);
    let serviceId = MODEL_DICT.get(requestedModelName)?.serviceId;
    // 兜底:discoverModels 还没跑且请求的是默认模型 → 用硬编码 ID
    if (!serviceId && requestedModelName === DEFAULT_MODEL) {
        serviceId = DEFAULT_MODEL_FALLBACK_ID;
    }
    if (!serviceId) {
        throw new Error(`未知模型 ${requestedModelName} - 请等 discoverModels 完成或确认模型名称`);
    }

    // 首次:CreateConversation
    if (!s.conversationId) {
        logger.info('适配器', `[tongji] 创建 conversation (${requestedModelName})`, meta);
        const r = await aigwCall(page, 'CreateConversation', {
            ConversationName: 'API 代理对话',
            WorkspaceID: WORKSPACE_ID,
            Models: [{ ModelServiceID: serviceId, ModelName: requestedModelName, PublishSourceType: 'external' }],
        });
        if (!r.ok || !r.json?.Result?.ConversationInfo) {
            throw new Error(`CreateConversation 失败: status=${r.status} body=${r.text}`);
        }
        const info = r.json.Result.ConversationInfo;
        s.conversationId = info.ConversationID;
        s.sessionId = info.ProjectList?.[0]?.SessionID;
        s.modelServiceId = serviceId;
        s.modelName = requestedModelName;
        return s;
    }

    // 模型未变:复用
    if (s.modelName === requestedModelName) return s;

    // 切换模型:UpdateConversation
    logger.info('适配器', `[tongji] 切换模型 ${s.modelName} → ${requestedModelName}`, meta);
    const r = await aigwCall(page, 'UpdateConversation', {
        WorkspaceID: WORKSPACE_ID,
        ConversationID: s.conversationId,
        Remove: [s.sessionId],
        Add: [{ ModelServiceID: serviceId, ModelName: requestedModelName, PublishSourceType: 'external' }],
    });
    if (!r.ok || !r.json?.Result?.ConversationInfo) {
        throw new Error(`UpdateConversation 失败: status=${r.status} body=${r.text}`);
    }
    const info = r.json.Result.ConversationInfo;
    s.sessionId = info.ProjectList?.[0]?.SessionID;
    s.modelServiceId = serviceId;
    s.modelName = requestedModelName;
    return s;
}

// ============ 流式 Chat (简化:page 单次 fetch + Node 端 parse) ============

/**
 * 拉取流式生成结果。adapter ↔ page 之间是 buffered(整段 body),
 * Node 端按 SSE 帧拆分后顺序回调 onDelta,server → client 仍是真流式。
 *
 * @param {object} page - Playwright page
 * @param {object} session - ensureSession 返回的会话状态
 * @param {string} messageId - BatchCreateMessages 返回的 MessageID
 * @param {Function|undefined} onDelta - (delta: {content?, reasoning_content?}) => void
 * @param {object} [opts]
 * @returns {Promise<{fullText: string, reasoningText: string}>}
 */
async function streamChat(page, session, messageId, onDelta, { timeoutMs = 300000 } = {}) {
    const url = `/api/bypass/aigw?Action=Chat&${API_QUERY}`;
    const body = { SessionID: session.sessionId, MessageID: messageId, WorkspaceID: WORKSPACE_ID };

    // page 端:单次 fetch 拉完整 body(简化:不暴露 ReadableStream reader)
    // 注意:page.evaluate 默认 30s 超时,长生成会被 Playwright 提前 kill。
    //      这里临时把 defaultTimeout 调到 timeoutMs,跑完恢复(避免影响 adapter 其他路径)。
    const prevDefaultTimeout = page._defaultTimeout || 30000;
    page.setDefaultTimeout(timeoutMs);
    let result;
    try {
        result = await page.evaluate(async ({ url, body, timeoutMs }) => {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                const m = document.cookie.match(/x-csrf-token=([^;]+)/);
                const csrf = m ? decodeURIComponent(m[1]) : '';
                const res = await fetch(url, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Accept': 'text/event-stream',
                        'Content-Type': 'application/json',
                        'x-csrf-token': csrf,
                        'x-top-region': 'cn-north-1',
                        'accept-language': 'zh',
                    },
                    body: JSON.stringify(body),
                    signal: ctrl.signal,
                });
                if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, body: null };
                return { ok: true, status: res.status, body: await res.text() };
            } catch (e) {
                return { ok: false, status: 0, error: e.message || String(e), body: null };
            } finally { clearTimeout(t); }
        }, { url, body, timeoutMs });
    } finally {
        page.setDefaultTimeout(prevDefaultTimeout);
    }

    if (!result.ok) {
        throw new Error(`streamChat HTTP 失败: status=${result.status} error=${result.error}`);
    }

    // Node 端:按 \n\n 切 SSE 帧,逐帧解析 → 顺序 onDelta
    let fullText = '';
    let reasoningText = '';
    const frames = (result.body || '').split(/\r?\n\r?\n/);
    for (const frame of frames) {
        if (!frame.trim()) continue;
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        // 一帧可能含多行 data: (少见),逐个 parse
        for (const dataStr of dataLines) {
            if (!dataStr || dataStr === '[DONE]') continue;
            let data;
            try { data = JSON.parse(dataStr); } catch { continue; }
            // hiagent Chat 兼容 OpenAI: choices[0].delta.{content, reasoning_content}
            const choice = data?.choices?.[0];
            const delta = choice?.delta;
            if (!delta) continue;
            if (typeof delta.content === 'string' && delta.content.length > 0) {
                fullText += delta.content;
                if (onDelta) onDelta({ content: delta.content });
            } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                reasoningText += delta.reasoning_content;
                if (onDelta) onDelta({ reasoning_content: delta.reasoning_content });
            }
        }
        if (onDelta) await new Promise(r => setTimeout(r, FRAME_PAUSE_MS));
    }
    return { fullText, reasoningText };
}

// ============ generate 入口 ============

async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page } = context;
    const { onDelta, messages, id: requestId } = meta;
    const requestedModelName = modelId || DEFAULT_MODEL;
    const logMeta = { id: requestId };

    try {
        // 1. 确保 session (首次创建 / 切换模型)
        const session = await ensureSession(page, requestedModelName, logMeta);

        // 2. 取最后一条 user 内容 (hiagent BatchCreateMessages 一次只处理一条 user 消息;
        //    真正的多轮靠 SessionID 维持 — 同 SessionID 第二次 upload 时,后端自动 join 历史)
        const userContent = extractLastUserContent(messages, prompt);
        if (!userContent) {
            return { error: '未提供 user 消息内容' };
        }
        logger.info('适配器', `[tongji] 上传 prompt (${userContent.length} 字符) → ${requestedModelName}`, logMeta);

        // 3. 上传 → MessageID
        const r = await aigwCall(page, 'BatchCreateMessages', {
            WorkspaceID: WORKSPACE_ID,
            ConversationID: session.conversationId,
            MessageList: [{
                SessionID: session.sessionId,
                Content: userContent,
                ContentType: 'text',
            }],
        });
        if (!r.ok || !r.json?.Result?.MessageList) {
            throw new Error(`BatchCreateMessages 失败: status=${r.status} body=${r.text}`);
        }
        // 找最后一条 user 消息(AuthorRole=2)的 MessageID,作为 Chat 的 query 锚点
        const userMsgs = r.json.Result.MessageList.filter(x => x.AuthorRole === 2);
        const messageId = (userMsgs.length ? userMsgs[userMsgs.length - 1] : r.json.Result.MessageList[r.json.Result.MessageList.length - 1]).MessageID;

        // 4. 拉取流式结果
        if (onDelta) {
            // streaming 模式:onDelta 实时推 SSE,但 generate() 仍需 return 完整 text
            // 给 queue.js 写入 history.response_text(WebUI Tools/Request 页显示)。
            // timeoutMs 与 main 的 16ed8d6 对齐(300s,避免长响应被 Playwright 30s 默认超时截断)
            const r2 = await streamChat(page, session, messageId, onDelta, { timeoutMs: 300000 });
            logger.info('适配器', `[tongji] 流式完成 (${r2.fullText.length} 字符)`, logMeta);
            return {
                text: r2.fullText,
                reasoning: r2.reasoningText || undefined,
            };
        } else {
            // non-streaming 模式:一次性返回完整 text
            const r2 = await streamChat(page, session, messageId, null, { timeoutMs: 120000 });
            logger.info('适配器', `[tongji] 一次性返回 (${r2.fullText.length} 字符)`, logMeta);
            return {
                text: r2.fullText,
                reasoning: r2.reasoningText || undefined,
            };
        }
    } catch (err) {
        const pageError = normalizePageError(err, logMeta);
        if (pageError) return pageError;
        logger.error('适配器', '[tongji] generate 失败', { ...logMeta, error: err.message });
        return { error: `生成任务失败: ${err.message}`, retryable: true };
    }
}

// ============ manifest ============

export const manifest = {
    id: 'tongji',
    displayName: '同济 hiagent 文本生成',
    description: '通过同济大学 agent.tongji.edu.cn 智能体平台代理文本生成,支持该 workspace 下所有已开通的 LLM 模型。需要已登录浏览器会话(首次运行 npm start -- -login=tongji)。',

    getTargetUrl() { return TARGET_URL; },

    // 默认模型作为 manifest 兜底(若 discoverModels 还没跑,manifest 至少能让 manifest 校验通过 + /v1/models 立刻有数据)
    models: [
        { id: DEFAULT_MODEL, imagePolicy: 'forbidden', type: 'text' },
    ],

    // 动态发现钩子 — Worker 初始化时由 registry 调用,结果合并到 /v1/models
    discoverModels,

    navigationHandlers: [],

    generate,
};
