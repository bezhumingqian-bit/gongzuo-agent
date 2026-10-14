# 共作接入 CodeBuddy CloudAgent（AgentOS）方案

状态：已实现并真实联调（2026-10-14），见文末「实现状态」。来源：iWiki「CloudAgent 接入文档」「CloudAgent 定义说明」、cnb `davidwguo/cloudagentdemos`。内部文档仅作阅读依据，此处只记录共作接入所需的要点。

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

## 实现状态（2026-10-14）

- `electron/cloudagent.cjs`：设置 → Agent → 「CodeBuddy 云端（CloudAgent）」。API Key 优先读共作加密存储，其次读本机钥匙串 `cn.gongzuo.codebuddy.api-key`。
- **映射修正：一项工作 = 一个 Runtime**。实测同一 Runtime 只有一个 ACP 会话（两次 `session/new` 返回同一 ID，且等于 Runtime ID），按空间共用会把不同工作的对话串在一起。Runtime 打 `metadata.gongzuo_work` 标签，丢失会话 ID 时可按工作找回；`agentSessionId = runtimeId:sessionId`。
- 雪花 ID（19 位）按字符串解析，避免 JSON 精度丢失。
- `session/load` 会先回放历史 `session/update`，只收集 `session/prompt` 之后的输出（同时修复了 WorkBuddy 云端任务的同类问题）。
- 新会话设 `acceptEdits`；权限请求中读/搜/改允许，执行、删除等拒绝并写进回复。**实测该沙箱执行只读终端命令（`ls`）未发起权限请求**，平台侧对命令的确认策略以实际为准，不能把「拒绝执行」当作强保证。
- 真实联调：建沙箱 → 对话 19.5 s；同会话追问 6.3 s 且记得上一问；经 TaskRunner 完整链路执行「建文件并读回」15.4 s，进度显示 Write/Read，团队记忆「结论先行」生效。测试 118/118。
- 未做：成果文件回传（E2B 文件接口）、空间资料同步进沙箱、共作内审批、沙箱回收策略（工作归档时删除 Runtime）。

## 多人接入（同事怎么用）

### 三个阶段

| 阶段 | 做法 | Key 在哪 | 用量算谁 | 适用 |
| --- | --- | --- | --- | --- |
| 1. 每人自带 Key（现在） | 同事装共作预览版 → 用自己的 iOA 在 codebuddy.cn「API 管理」建 Key → 填进设置 → 测试连接 | 各自 Mac（加密存储） | 各自的 Token 额度 | 小范围试用，零后台 |
| 2. 后台代建沙箱（后台上线后） | 同事用企微/iOA 登录共作后台；后台调用控制面建 Runtime，只把短期 ACP link/token 下发给桌面端，桌面端直连 ACP 流式对话 | 后台 | 取决于后台用谁的 Key（见下方风险） | 团队正式使用 |
| 3. 团队级 Key + 多租户头 | 后台用一个服务 Key，带 `X-User-Id` / `X-Source-Tenant-Id` 区分成员与团队 | 后台 | 服务 Key 所有者 | 需先和 CloudAgent 团队确认额度与合规口径 |

### 已经为多人做好的

- 沙箱归属：每项工作记录创建它的 Key ID（`ck_xxx`，不含密钥）。同事在同一项工作里追问时，会新建自己的沙箱并带上完整对话，不会去打开别人的沙箱。
- 凭据来源与 WorkBuddy 授权共用「本机 / 后台」两种来源的抽象，阶段 2 只换来源，执行器不改。
- 设置页给出建 Key 的链接和步骤；连接测试能直接判断 Key 是否有效。

### 进入阶段 2/3 前必须解决

1. **沙箱里的 Key 会暴露给 Agent**：AgentOS 要求在 Manifest `secrets` 里放 `CODEBUDDY_API_KEY`，它以环境变量注入沙箱，Agent（和诱导它的提示词）读得到。阶段 1 是每人自己的 Key，风险自担；阶段 2/3 如果放的是团队/服务 Key，任何同事都可能把它取出来。需向 CloudAgent 团队确认是否有沙箱专用的短期/受限 Key，否则不能把服务 Key 放进沙箱。
2. **用量归属**：用一个 Key 代所有人，所有消耗都记在 Key 所有者名下（token.woa.com 看板），需要团队预算或改为每人 Key。
3. **工作共享本身**：目前工作数据只在各自电脑上，同事看不到你的工作；多人共用一项工作要等协作服务端（模块化设计第 5 步）。
4. **沙箱回收**：一项工作一个沙箱，人一多数量会涨；需要在工作完成/归档时删除 Runtime，或定期清理长期闲置的沙箱。
