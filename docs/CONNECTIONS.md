# 连接与测试范围

Mac 版左下角进入“连接与模型设置”。先保存配置，再点击对应卡片的“测试连接”。浏览器 Demo 只展示流程，不调用外部服务。

“模型”页可选 OpenAI、Kimi、DeepSeek、兼容接口或本机服务。OpenAI、Kimi 和 DeepSeek 都有固定的官方平台入口；网页登录不会把 API 调用凭据自动交给共作。请在对应平台取得 API Key，回到 Mac 版保存并测试连接。Kimi 国内开放平台使用 `https://api.moonshot.cn/v1`，国际站使用 `https://api.moonshot.ai/v1`，两站的 Key 不通用。Kimi Code 的登录及密钥与 Kimi 开放平台 API 也不通用。模型 ID 和 Key 分提供方保存，切换提供方不会把旧 Key 发到新接口。

| 连接 | 测试行为 | 通过后仍未覆盖 |
| --- | --- | --- |
| OpenAI 模型 | 向配置的 `/responses` 发送短测试输入，检查是否返回文本 | 工具执行、文件处理、费用与所有模型能力 |
| Kimi 模型 | 向 Kimi 官方 `/chat/completions` 发送短测试输入；默认 `kimi-k2.6`，可手动改模型 ID | Kimi Code 会员权益、文件与工具能力 |
| DeepSeek 模型 | 向 DeepSeek 官方 `/chat/completions` 发送短测试输入；默认 `deepseek-flash` | 其他模型能力与工具调用 |
| 兼容或本机模型 | 向 `/chat/completions` 发送短测试输入 | 与不同服务商的全部参数兼容性 |
| 外部 Agent | 向填写的桥接地址发送短测试输入，检查 `output` 文本 | 上游服务的原生登录、会话和授权 |
| CodeBuddy | 调用本机已登录的 CodeBuddy Code CLI，检查文本响应 | 文件修改、工具调用、MCP、跨设备部署与会话续接 |
| Codex | 调用本机 Codex CLI，以只读沙盒处理当前工作并按任务续接会话 | 代码仓库委派、变更审阅和执行审批 |
| Kimi Code | 调用本机 Kimi Code CLI，以无工具 Agent 处理当前工作并按任务续接会话 | 代码仓库委派、变更审阅和执行审批 |
| WorkBuddy | 本机 MCP 已真实验证 WorkBuddy → 共作；Mac 版已按官方本地助理 API 实现共作 → WorkBuddy 的发送与查询，使用模拟响应验证 | 反向真实调用仍缺开放平台授权；多会话消息关联、自动令牌刷新和产物同步尚未验证 |
| 企业微信自建应用与智能机器人 | 自建应用定向通知和可见成员目录；机器人长连接接收明确指令并回复 | 真实企业账号端到端验证、跨设备项目访问、普通聊天记录读取 |

测试结果不会包含密钥或企业微信访问令牌。保存新配置会清除旧的测试状态。测试请求由 Electron 主进程发出；远程服务地址必须使用 HTTPS，本机服务允许 localhost HTTP，HTTP 重定向不会被跟随。

## 外部 Agent 桥接协议

外部 Agent 地址是一个 HTTPS 的 `POST` JSON 接口。共作发送：

```json
{
  "input": "用户最新消息",
  "context": {
    "workspace": "项目名称",
    "instructions": "当前工作指令和已确认记忆",
    "messages": [{ "role": "user", "content": "用户消息" }]
  }
}
```

桥接服务应返回 `{"output":"给员工看的结果"}`。配置访问令牌时，共作使用 `Authorization: Bearer ...`。此入口用于自建 HTTP Agent；填写其他产品的网页地址无法调用其 Agent。桥接服务必须自行处理上游鉴权、会话与权限，并只返回当前工作允许共享的结果。

## Codex、Kimi Code 与 CodeBuddy

共作可在“执行 Agent”选择 Codex 或 Kimi Code，并在对话中把当前工作和适用的已确认记忆发送给本机 CLI，接收最终文本。Codex 使用官方的 [`codex exec --json` 与 `codex exec resume`](https://learn.chatgpt.com/docs/developer-commands) 非交互入口，按任务保存会话 ID，并保持只读沙盒；Kimi Code 使用官方的 [`kimi -p --output-format stream-json` 与 `--continue`](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)，按任务保留独立目录，并用[自定义 Agent 文件](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents)禁用所有工具与子 Agent。两者当前只做文本委派，未让外部 Agent 访问实际仓库。工作先保存，CLI 在后台执行，失败或应用重启导致的中断可从工作内重试。每项工作可单独切换执行 Agent；切换时清除该任务的旧会话引用。

员工可在发起工作或继续对话时明确选择当前空间资料。共作只读取选中的 PDF、Word、TXT、Markdown 或 CSV 的文字，每条消息最多 3 份、每份最多前 12000 字，并将文字随当前消息发送给选定 Agent；原始文件不传入本机 Codex 或 Kimi Code 的工作目录。扫描版 PDF 暂无 OCR；本机未安装 `pdftotext` 时无法提取 PDF 文字。资料只归属于当前空间，切换空间会清空尚未发送的选择。Excel 和 PowerPoint 可在空间中管理，目前无法作为 Agent 正文引用。

2026-09-24 使用本机已登录账号，分别通过共作进行两轮无敏感短句测试：第一轮记住“木星17”，第二轮询问上一轮代号；Codex 与 Kimi Code 均正确返回“木星17”。本地单元测试另验证参数、输出解析、任务先落盘、同一工作消息顺序和重试。测试不等于完成实际仓库执行或审批。

长期要在共作中展示执行步骤、审批和持续会话，可分别使用 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 与 [Kimi ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)；当前 CLI 桥接不代表这些能力已完成。

## WorkBuddy 本机连接（默认）

没有开放平台令牌时，选择 WorkBuddy 的工作不会在共作内执行，而是进入「等待 WorkBuddy 领取」：

1. 共作启动时在 `userData/workbuddy-bridge.sock` 开启仅本机用户可访问的 Unix 套接字（不开 TCP 端口），随机令牌写入同目录 `workbuddy-bridge.json`（权限 0600），退出时删除。
2. WorkBuddy 的「gongzuo」stdio 连接器（`integrations/workbuddy/gongzuo-mcp.cjs`）读取该文件并调用共作。默认依次查找 `gongzuo-agent`、`gongzuo-agent-dev` 数据目录，取正在运行的最新实例；可用环境变量 `GONGZUO_BRIDGE_FILE` 指定。
3. 连接器工具：`gongzuo_connection_test`、`gongzuo_list_pending_work`、`gongzuo_claim_work`、`gongzuo_submit_reply`、`gongzuo_list_works`、`gongzuo_get_work`、`gongzuo_create_work`。领取时共作按与其他 Agent 相同的边界准备上下文：工作对话、适用的已确认记忆、主动引用的资料正文；企微触发的工作不附带个人记忆。
4. 回复必须带领取时的 `triggerId`；员工期间追加了新消息，旧 `triggerId` 会被拒绝，避免答非所问。回复后行为与其他 Agent 一致：摘要规则进入待确认，企微发起的工作私聊回发起者。
5. 切换执行 Agent 会撤回等待中的交接，并标为可重试。

触发方式是 WorkBuddy 主动拉取：在 WorkBuddy 里说「处理共作待办」，或为它配置定时任务。共作必须保持运行；它不会唤起 WorkBuddy。

## CodeBuddy 和 WorkBuddy

CodeBuddy Code 的 [CLI 参考](https://www.codebuddy.cn/docs/cli/cli-reference)提供 `--print`、纯文本输出和工具限制参数；[官方工作流说明](https://www.codebuddy.cn/docs/cli/common-workflows)建议只需回答的集成使用纯文本输出。[Agent SDK](https://www.codebuddy.cn/docs/cli/sdk)也支持程序化调用及已有登录凭据。Mac 版现在可以在“执行 Agent”选择 CodeBuddy。共作从主进程启动本机 CLI，使用临时目录、禁用内置工具和 MCP、不保存 CLI 会话，只读取纯文本回答。它会发送当前工作对话和适用的已确认记忆，因此只应在允许共享这些内容时启用。此前 JSON 输出的真实联调未通过；现已改用纯文本并通过本地模拟测试，**还需再做一次真实请求才能确认修复**。当前没有接入 CodeBuddy 编辑文件、运行命令或恢复会话的能力。

WorkBuddy 的[自定义连接器](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector)支持本机 stdio MCP。因此可运行 `npm run workbuddy:mcp-config`，把生成的配置加入 WorkBuddy 的“自定义连接器”。当前连接器只有 `gongzuo_connection_test`：返回固定状态，不读取共作工作、资料、记忆或密钥。2026-09-24 在 WorkBuddy 5.5.6 的已登录 Mac 客户端安装并信任后，实际发起一次独立任务调用该工具，客户端返回“共作本机连接成功（版本 0.1.0）”；因此 **WorkBuddy → 共作** 的本机 MCP 连接测试已通过。安装前应核对配置中启动的 Node 与脚本路径；本机 Node 路径变动后需重新生成配置。这个工具仍不提供共作项目数据或任务操作。

反方向的 **共作 → WorkBuddy** 需要 WorkBuddy 的[开放平台](https://open.workbuddy.cn/docs/third-party-app)和 [Open API](https://open.workbuddy.cn/docs/openapi)，通过第三方应用 OAuth 获取本地助理权限。需申请 `user.localassistant.invokable` 和 `user.localassistant.readable`。Mac 版现可在“执行 Agent”选择 WorkBuddy，并临时填入经授权取得的短期 `access_token` 做开发联调；令牌经 macOS 安全存储加密，不会返回给界面。实际发送只传当前输入，以及该条消息中主动引用的资料文字，不自动附带记忆；使用官方 `POST /localassistant/message`，保存消息 ID 后用 `GET /localassistant/message?message_id=...` 查询回复，超时可在工作对话里手动刷新。连接测试只检查助理在线，不会发送消息，也不能证明发送权限。接口协议与失败情形已用模拟响应测试，**尚未完成真实反向发送**。WorkBuddy API 每条消息限 4000 字，因此引用资料后可能超限并在当前工作显示错误。

正式产品的授权码交换与令牌刷新需要受控服务端；`client_secret` 和刷新令牌不能内置于开源 Mac 客户端。2026-09-24 登录的开放平台账号已进入后台，但创建 Buddy 应用时平台提示“开发者信息待完善，提交审核通过后方可创建”。开发者信息页要求头像、简介和至少一种对外联系方式，需由账号主体提供真实资料。硬件接入表单要求真实硬件名称、类型、产品图片等，不适合将共作 Mac 软件填成硬件。Buddy 应用属于 WorkBuddy 内的行业工作台；其可申请权限只写为“部分权限”，仍须确认该应用类型能否申请 `user.localassistant.*`。因此当前没有可用于真实 API 联调的应用凭据或访问令牌。安装 WorkBuddy 桌面版或连接企业微信助理，都不等于取得 Open API 授权。官方增量消息接口按消息 ID 返回之后的消息，尚未验证并发助理对话时的严格一一关联；生产版需处理这一点，不能把其他会话的回复误记入当前工作。

### 开放平台下一步

1. 由账号主体完善并提交开发者公开资料，等待平台审核。
2. 核实 Buddy 应用是否允许申请 `user.localassistant.invokable` 与 `user.localassistant.readable`；若不允许，应向平台确认适合独立软件产品的应用类型。不要用虚构硬件信息申请硬件接入。
3. 创建应用时只申请上述两个本地助理 Scope，并登记实际可用的 OAuth 回调地址。应用 `client_secret` 仅显示一次，应保存于受控服务端。
4. 应用审核通过后完成用户授权，以无敏感测试短句验证“共作发送 → WorkBuddy 执行 → 共作取回回复”。

## 企业微信与项目权限

当前版本针对**企业自建应用**校验凭据，并实现[发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)中的单人文本发送。管理员需提供企业 ID、数字 AgentID 和该应用的 Secret，并把收件成员放入应用可见范围。员工可在输入框选择“发企微”，填写收件人的企微通讯录 UserID 后直接发送；共作记录该消息和投递状态，不会调用 Agent。也可在已有工作消息上点“转发到企微”；该工作消息此前若已交给 Agent，原回复仍会保留，转发本身不会再次调用 Agent。默认 UserID 可在设置里保存；禁止 `@all` 和多人列表。主进程临时获取 access_token 并调用 `POST /cgi-bin/message/send`；Secret 和 token 不返回界面。只发送该条文字，限 2048 UTF-8 字节，不包含任务其他内容、资料或记忆。接口接受仅代表服务端受理，仍需在企微客户端确认实际收到。请求结果未知时不会自动重发，以免重复通知。

设置里的“测试连接”只验证自建应用凭据，不发送消息。管理员授予通讯录读取权限后，“同步可见成员”调用 `user/simplelist`，本地只保存 UserID、显示名与同步时间。用户从目录选择成员关联到团队或项目空间，赋予其**企微机器人内**的只读或协作权限。工作中 @ 已关联成员时，自建应用向其 UserID 定向发送当前消息和 `gongzuo://task/<id>` 链接；任务信息中指派负责人也会发送定向通知。每位收件人的接口结果独立记录。已受理不等于成员实际收到；网络结果未知时应在企微核实。

管理员另行创建企业微信智能机器人并提供 BotID、Secret 后，Mac 端通过[官方 Node SDK](https://github.com/WecomTeam/aibot-node-sdk)建立长连接。机器人只处理发给它的文本：`新建 空间名：目标`、`更新 工作ID：进展`、`查看 工作ID`。每条消息按 `msgid` 去重，按 `from.userid` 核对当前空间显式关联的成员角色；只读成员不能新建或更新。Agent 回复与群聊中的工作详情只私聊发给发起者，避免向群内其他成员公开空间内容。企微触发的 Agent 不会读取本机用户的个人长期记忆。应用需保持运行以接收机器人消息。

共作窗口右上角“消息收件”可直接阅读发给机器人的单聊正文。新消息进入本机统一收件结构（渠道、事件 ID、发送者、会话、时间、正文、关联工作），最多保留最近 50 条；企微群聊只保留去重元数据，不存入收件正文。用户在本机工作对话中明确要求查看、列出或总结企微来信时，主进程临时把最近至多 10 条单聊正文及时间、发送者交给当前 Agent，受输入长度限制；这个动作不会把消息正文写入工作。普通工作不附带收件正文，企微同事从机器人发起的请求也不能读取本机收件箱。若要把指定来信长期作为工作材料，用户可选择“作为工作材料引用”，检查输入框后再发送。明确工作指令会进入对应工作。旧版接收事件只有时间和发送者，正文无法补回。飞书、Telegram 和 Instagram 可由各自适配器写入同一收件结构，目前尚未接入。

这条链路**不能读取个人全部企微聊天记录**，也没有配置会话内容存档。目录同步、自动提醒和机器人回流已经用模拟接口验证，仍需真实企业账号、应用可见范围、通讯录授权和机器人配置做端到端测试。空间资料仍只保存在这台 Mac；企微项目角色不等于跨设备登录共作。邮箱待邀请名单仍不会自动授权访问。

真实联调顺序：管理员创建或授权自建应用，提供 CorpID、AgentID、应用 Secret，并授予目标成员可见范围与通讯录读取权限；另建长连接智能机器人，提供 BotID 与机器人 Secret。在共作“设置 → 企业微信”保存后，先测试应用凭据，再检查机器人状态为“已连接”，同步可见成员，并在团队或项目空间关联目标 UserID。随后从任务信息指派一位同事，确认其企微收到提醒；请该同事私聊机器人发送 `查看 工作ID`，再用 `更新 工作ID：已确认` 验证回流。配置密钥只在 Mac 应用中填写，不要放入聊天或仓库。

模型请求使用 [OpenAI Responses API](https://platform.openai.com/docs/quickstart/make-your-first-api-request)；企业微信凭据验证基于[腾讯云企业微信连接说明](https://cloud.tencent.com/document/product/1270/73958)中描述的企业 ID、应用密钥与访问令牌流程。
