# 共作接入 CodeBuddy CloudAgent（AgentOS）方案

状态：调研结论 + 接入设计（2026-10-14）。来源：iWiki「CloudAgent 接入文档」「CloudAgent 定义说明」、cnb `davidwguo/cloudagentdemos`。内部文档仅作阅读依据，此处只记录共作接入所需的要点。

## 为什么值得接

| 对比项 | WorkBuddy 开放平台（云端任务） | CloudAgent（AgentOS） |
| --- | --- | --- |
| 凭据 | OAuth 应用 + 用户授权，`access_token` 24 小时 | `x-api-key`（codebuddy.cn 个人/团队 API Key），自助创建 |
| 可定制 | 只能发 prompt | **Agent Manifest**：system prompt、rules、skills、MCP、子 Agent、工作区（git 仓库/模板/初始化命令）、secrets、记忆内容、知识库 |
| 运行环境 | 平台托管，不可见 | 独立 Linux 沙箱（Runtime），可快照/版本/回滚、可发布 Web |
| 内网 | 不明 | iOA 登录的 Key 创建在司内沙箱，可访问工蜂、cnb 等内网资源 |
| 多租户 | 每人授权 | 支持 `X-User-Id` / `X-Source-App` / `X-Source-Tenant-Id` 扩展头，适合后台统一代理 |
| 数据面 | ACP（SSE + POST JSON-RPC） | 同样是 ACP，共作已有的客户端可复用 |

结论：CloudAgent 与共作「空间决定 Agent 能看什么」的模型天然对齐——共作可以把空间的规则、技能、MCP、资料和记忆写进 Manifest，交给云端沙箱执行。

## 接口要点

- 控制面 Base：`https://www.codebuddy.cn/v2/agentos`，头 `x-api-key`、`X-Source-App: gongzuo`（不传则归入 default-app，列表查不到）。
- `POST /runtimes` 建沙箱，返回 `links.acpLink {url, token, tokenExpiresAt}` 与初始 session；轮询 `GET /runtimes/{id}` 至 `RUNNING`。token 过期后重新 `GET /runtimes/{id}` 取新的。
- Manifest 必填 `id`、`name`、`manifestVersion: "1.0"`；**必须在 `secrets` 里带 `CODEBUDDY_API_KEY`**（否则 14225），secrets 以环境变量注入，不落盘。
- ACP：`GET /acp`（SSE，响应头 `Acp-Connection-Id`）→ `POST /acp` 依次 `initialize`、`session/new {cwd:"/workspace", mcpServers:[]}` 或 `session/load`、`session/prompt`。`session/prompt` 的结果以 **POST 响应自身的 SSE 流** 返回，其他请求 202 后经 GET SSE 推送；`DELETE /acp` 关闭。POST 的 `Accept` 需同时含 `application/json` 与 `text/event-stream`。
- 同一 session 同时只能有一个 prompt（409）；`session/set_mode`：`default / acceptEdits / bypassPermissions / plan`；`session/set_model` 切模型。
- 生命周期：创建后最长运行 2 小时，之后 10 分钟无数据面访问即休眠，任何 ACP 访问自动唤醒，文件保留。
- Webhook（可选）：Manifest 配 URL + secret，`x-webhook-signature = sha256=HMAC(secret, timestamp + "." + body)`。

## 共作的映射设计

| 共作 | CloudAgent | 说明 |
| --- | --- | --- |
| 空间（团队/项目） | 1 个 Runtime（`metadata.gongzuo_space`） | 空间资料同步到 `/workspace/资料`，团队记忆写入 `memory.content`，空间规则写入 `rules`/`system_prompt` |
| 工作 | 该 Runtime 下 1 个 Session | `agentSessionId = runtimeId:sessionId`，`agentSessionOwner` 记录 Key 归属 |
| 工作的一次请求 | `session/prompt` | 流式文字/工具步骤显示为运行进度 |
| 成果文件 | 沙箱 `/workspace/artifacts` | 经 E2B 文件接口下载后存入空间资料（第二步） |
| 需人确认的操作 | 权限请求 / `default` 模式 | 首版拒绝并在回复中说明；后续做共作内审批 |

凭据：API Key 只放主进程，加密保存；分发给同事前改为后台持 Key，以 `X-User-Id` 区分成员（与 OAuth 方案的「凭据来源」抽象一致）。

## 实施步骤

1. 设置页新增执行 Agent「CodeBuddy 云端（CloudAgent）」：填写 API Key、连接测试（`GET /runtimes?pageSize=1`）。
2. `electron/cloudagent.cjs`：Runtime 创建/复用/唤醒、token 刷新、Manifest 组装；复用 `workbuddy-cloud.cjs` 的 `AcpConnection`（已兼容 POST SSE 响应与 `DELETE /acp`）。
3. 模拟服务端测试 + 用真实 Key 跑一项工作。
4. 资料同步与成果文件回传（E2B）。

阻塞项：需要一个 codebuddy.cn API Key（用 iOA 登录创建，得到司内沙箱）。
