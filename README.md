# tongji-webai2api

> 同济大学 hiagent 智能体平台的 OpenAI 兼容 API 代理(基于 webai-2api v3 分支)

This fork of [foxhui/webai-2api](https://github.com/foxhui/WebAI2API) adds a complete adapter for the [agent.tongji.edu.cn](https://agent.tongji.edu.cn) hiagent MaaS platform, plus a v2 framework (true streaming, native multi-turn `messages[]`, dynamic model discovery).

---

## 快速开始

```bash
pnpm install                       # 安装依赖(触发 postinstall)
node scripts/init.js               # 初始化数据库、生成 API key
# 编辑 data/config.yaml 添加 tongji worker
pnpm start -- -login=tongji        # 首次登录(打开浏览器扫码/SSO)
pnpm start                         # 之后正常启动
```

> 配置文件必须是 `data/config.yaml`,不是根目录的 `config.yaml`(loader 会优先读 `data/` 下的)。

`data/config.yaml` tongji 段示例:

```yaml
browsers:
  - name: browser_tongji
    user_data_mark: tongji

workers:
  - name: tongji
    type: tongji
    browsers: [browser_tongji]
    api_key: sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## tongji adapter 特性

| 特性 | 说明 |
|------|------|
| **真流式输出** | server → client 是真 SSE 增量。`page.evaluate` 一次性 fetch 后 Node 端按 SSE 帧解析 + 顺序 `onDelta` 回调,15ms 帧间停顿让客户端能看见打字机效果 |
| **原生多轮** | 透传 OpenAI 的 `messages[]` 数组,后端 SessionID 自动 join 历史,客户端无需拼"=== 历史 ==="块 |
| **动态模型发现** | Worker 初始化时自动调 `Action=ListModelByWorkspaceGrant` 列出该 workspace 下所有已开通 LLM,包括 `DeepSeek-V4-Pro`、`GLM-5.1`、`Kimi-K2.6`、`MiMo-V2.5`、`Qwen3-235B`、`DeepSeek-R1` 等 25+ 个模型 |
| **模型切换** | 同一 conversation 内调用不同模型时,自动 `UpdateConversation` (Remove 旧 session + Add 新 model) |
| **Hiagent 后端** | `CreateConversation` → `BatchCreateMessages` → `Chat` 三段式,纯 HTTP,无 DOM 依赖,HttpOnly cookie 由 Camoufox 自动带 |

### 端到端验证

```bash
# 启动后,获取模型列表
curl http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $API_KEY"

# 流式对话
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4-Pro","messages":[{"role":"user","content":"Hello"}],"stream":true}'

# 多轮(同一个 conversation 跨两次 HTTP,第二次 messages[] 含前一轮)
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V4-Pro","messages":[{"role":"user","content":"My name is Alice"},{"role":"assistant","content":"OK"},{"role":"user","content":"What is my name?"}]}'
```

或者用打包好的 PowerShell 烟雾测试:

```powershell
powershell -File scripts/smoke-test-tongji-v2.ps1
```

烟雾测试覆盖:

1. `stream=true` → 11 个 SSE chunk,首尾 0.16s 间隔
2. 双 HTTP 调用多轮 → 第二轮 assistant 记住 "Alice"
3. `/v1/models` → 列出 25 个 tongji 模型
4. 模型切换 → `model: GLM-5.1` 触发 `UpdateConversation`,响应来自 GLM-5.1

---

## v2 框架改动 (framework changes)

为了支撑 tongji 的真流式 + 原生多轮 + 动态模型,框架做了以下向后兼容的扩展:

| 文件 | 改动 |
|------|------|
| `src/server/respond.js` | 新增 `buildChatCompletionDelta` / `buildStableChatId` |
| `src/server/queue.js` | 新增 `onDelta` 回调 + adaptive heartbeat + `streamedByAdapter` 路径 |
| `src/server/api/openai/parse.js` | 透传 `messages` 原始数组 |
| `src/server/api/openai/routes.js` | 把 `messages` 写入 `addTask` meta |
| `src/backend/registry.js` | `validateManifest` 允许 `models=[]` 若有 `discoverModels`;新增 `setDynamicModels` + 静态 ∪ 动态合并 |
| `src/backend/pool/Worker.js` | init 后调 `discoverModels` 并注册到 registry |

这些改动对其他 adapter 透明(旧的 `text` 类型 adapter 走老路径,v2 streaming 路径只对调用 `onDelta` 的 adapter 生效)。

---

## 仓库目录

```
tongji-webai2api/
|-- supervisor.js
|-- package.json
|-- config.example.yaml
|-- src/
|   |-- backend/adapter/tongji.js     # * 本 fork 的核心新增
|   |-- backend/registry.js           # v2 改动
|   |-- backend/pool/Worker.js        # v2 改动
|   |-- server/respond.js             # v2 改动
|   |-- server/queue.js               # v2 改动
|   `-- server/api/openai/            # v2 改动 (parse.js + routes.js)
|-- scripts/
|   |-- capture-tongji.js             # 浏览器 Console 抓取脚本(逆向用)
|   |-- smoke-test-tongji.ps1         # v1 baseline 测试
|   `-- smoke-test-tongji-v2.ps1      # v2 全特性测试
|-- webui/                            # 独立 Vite 子项目
`-- README.md
```

---

## 与上游 foxhui/WebAI2API 的关系

这是 fork,不是重写。保留所有 19 个内置 adapter,框架基线 = upstream v3.0.0(2026-06-02),叠加:

- `src/backend/adapter/tongji.js`(全新)
- v2 framework 微改动(向后兼容)

如果你只想用 tongji,只需要这一份代码;如果你想 contribute 回上游,tongji adapter 和 v2 framework 改动是干净独立的 commit 单元,可以直接 cherry-pick 或开 PR。

---

## License

MIT(沿用上游 foxhui/WebAI2API)。
