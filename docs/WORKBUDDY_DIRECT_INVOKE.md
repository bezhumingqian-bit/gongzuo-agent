# 在共作界面内直接调用 WorkBuddy 能力：调研结论

状态：调研稿（2026-10-13），同日已实现「值守」与「云端任务」两条通道，见文末「实现状态」。目标：员工只在共作里操作，发出工作后由 WorkBuddy 的能力（模型、技能、连接器、文档/表格/PPT 生成）实时执行，结果回到同一项工作；不需要切到 WorkBuddy。

## 结论

| 路径 | 实时 | 能力覆盖 | 现在能用吗 | 卡点 |
| --- | --- | --- | --- | --- |
| A. 开放平台 Open API（本地助理 / 云端任务 + ACP） | 本地助理：发送后轮询；云端任务：ACP 流式 | 完整 WorkBuddy | 否 | 必须创建开放平台应用并过审；只支持硬件接入、Buddy 应用、积分应用三类；`client_secret` 不能放客户端，需一个小服务端 |
| B. 本机 MCP 拉取（已实现） | 否（手动触发或每小时） | 完整 WorkBuddy | 是 | WorkBuddy 不能被共作唤起 |
| C. CodeBuddy Code CLI 作为执行器，加载 WorkBuddy 的技能与自定义 MCP | 是（流式） | 部分：模型、技能、自定义 MCP；不含 WorkBuddy 托管连接器 | 登录后可用 | CLI 登录已过期（401），需用户执行一次 `/login` |
| D. WorkBuddy 内置 CLI 单独运行 | — | — | 否 | 实测返回 “Authentication required”，凭据由 WorkBuddy 按会话注入，不共享 |
| E. WorkBuddy 内部守护进程 RPC | — | — | 不采用 | 未公开接口，依赖会话密钥，版本升级即失效 |

建议：**近期用 C 实现“在共作里直接执行”，B 保留给需要完整 WorkBuddy 能力的工作；同时申请 A，过审后切到官方通道。**

## 依据

### A. 开放平台（官方文档，open.workbuddy.cn）

- Open API 分为认证授权、个人资料、本地助理、云端任务、ACP 通道、会话产物、兑换码核销。
- 本地助理：`POST /openapi/v2/localassistant/message` 发送，`GET .../message` 查询历史，需 `user.localassistant.invokable/readable`。共作已按此实现（`electron/workbuddy-service.cjs`），缺令牌。
- 云端任务：`POST /openapi/v2/tasks` 返回 `task_id`、ACP `link` 与 `token`；随后按 ACP JSON-RPC `initialize → session/load → session/prompt` 交互，流式结果经 SSE 推回；“会话产物”接口可拉取计划、任务、媒体与总结。需 `user.task.invokable/readable`。注意云端任务运行在云端沙箱，不是用户本机。
- 应用类型：硬件接入（全部权限）、Buddy 应用（部分权限）、积分应用（积分类）。创建后进入审核；`client_secret` 仅展示一次，“不要在前端或客户端代码中暴露”；`access_token` 24 小时，`refresh_token` 60 天且需存服务端。
- 2026-09-24 记录：账号创建 Buddy 应用时提示“开发者信息待完善，提交审核通过后方可创建”。

### C/D. 本机实测（2026-10-13）

- WorkBuddy 内置 CLI（`/Applications/WorkBuddy.app/.../cli/bin/codebuddy`，2.161.0）：需设 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 才能加载产物；干净环境下 `-p` 返回 `Authentication required. Please use /login`。模型凭据由 WorkBuddy 宿主在每个会话注入，单独调用不可用。为避免与 WorkBuddy 客户端的登录状态冲突，不建议在其配置目录里另行登录。
- 独立 CodeBuddy Code CLI（`~/.nvm/.../bin/codebuddy`，2.139.0）：调用返回 `401 Authentication required ... target: https://copilot.tencent.com`，登录过期；登录后即可调用。共作已有 CodeBuddy 执行适配器（当前禁用工具与 MCP，只做文本）。
- CLI 支持：`--output-format stream-json`（流式步骤）、`--mcp-config`、`--plugin-dir`、`--add-dir`、`--allowedTools/--disallowedTools`、`--permission-mode`、`--resume`、ACP 模式。

## 方案 C 的实现要点（待确认后开发）

1. 执行器：在共作“执行 Agent”增加 “WorkBuddy 能力（本机）”，底层调用 CodeBuddy Code CLI，按工作保存会话 ID 续接；`stream-json` 把步骤实时显示在工作对话中。
2. 能力装配：技能目录读取 `~/.workbuddy/skills` 与 WorkBuddy 内置技能目录；MCP 读取 `~/.workbuddy/mcp.json`（排除 `gongzuo` 自身）。员工在共作的“工具与技能”里勾选本次可用的技能/MCP，只把勾选项传给 CLI。
3. 权限：默认只读工具；写文件、运行命令、调用会对外发送的 MCP 工具逐项需员工在共作里确认（沿用 `contracts/policy.cjs` 的审批边界）。工作目录为该工作的独立目录。
4. 成果：执行中生成的文件自动存入该工作所属空间的资料，并在回复中引用。
5. 不覆盖：WorkBuddy 托管的连接器（企业微信、乐享、CNB 等由 WorkBuddy 授权代理的连接）、资料库、专家。需要这些能力的工作继续走 B。

## 需要用户决定或配合

- 方案 C：在终端运行一次 `codebuddy` 并 `/login`（iOA 账号）。
- 方案 A：由账号主体在开放平台完善开发者资料并提交；确认共作应申请哪类应用（Buddy 应用的“部分权限”是否包含本地助理与云端任务 Scope 需向平台确认）。

## 实现状态（2026-10-13）

设置 → Agent → WorkBuddy 可选三种连接方式：

| 连接方式 | 实现 | 验证 | 能力 | 依赖 |
| --- | --- | --- | --- | --- |
| 云端任务（实时） | `electron/workbuddy-cloud.cjs`：`POST /tasks` 新建（一项工作对应一个云端任务，`task_id` 存为会话 ID 续接）→ ACP（SSE 接收 + POST JSON-RPC）`initialize / session/load / session/prompt`；流式文字与工具步骤实时显示在工作中；`_codebuddy.ai/artifact` 媒体产物下载并存入空间资料；工具授权请求一律拒绝并在回复中说明；ACP 凭据 401 时重新获取一次 | 模拟服务端测试 4 项通过；**未做真实调用**（无开放平台令牌） | 完整 WorkBuddy 云端能力；看不到这台 Mac 的文件 | 开放平台应用过审，填入 `access_token`（24 小时） |
| 本机连接 + 值守 | MCP 新增 `gongzuo_wait_for_work`（长轮询，最长 280 秒，新工作出现即返回）；`gongzuo_submit_reply` 支持 `files` 附带本机文件存入空间资料；自动化「共作值守」每个工作日每小时启动一次，每次持续约 50 分钟循环等待 | 真实 Electron 进程实测：新建工作后 3 秒唤醒，附件存入空间资料 | 完整本机 WorkBuddy（含托管连接器、本机文件） | WorkBuddy 与共作同时运行；连接器超时已调到 300 秒 |
| 本地助理接口 | 既有实现 | 模拟测试 | 完整本机 WorkBuddy | 开放平台令牌 |

待验证：云端任务创建时 `prompt` 是否会立即执行（若会，与随后的 `session/prompt` 重复）；自动化单次运行能否持续 50 分钟；ACP 推送的 `session/update` 实际字段与文档示例（`delta`）是否一致（已兼容两种写法）。
