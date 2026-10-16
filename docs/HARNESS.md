# 共作 Harness 现状与「是否自研」评估（2026-10-15）

> 状态说明（2026-10-16）：项目暂停迭代。本文前半部分记录实现前的历史评估；现有实现见“四点六”，尚未验证的能力不视为已完成，不构成后续排期。

## 历史评估结论（实现前）

**不自研执行内核（agent loop + 通用工具 + 沙箱）；把共作已有的外层 harness 产品化，并补一个只开放共作工具的轻量循环。**

- 共作已经自研了 harness 的「外层」：上下文装配、会话与续接、执行时间线、成果回收、隐私与审批边界，约 2700 行，测试覆盖。
- 「内层」（模型 ↔ 工具循环、文件/命令工具、沙箱、上下文压缩）目前全部外包，且真正能执行的只有 CloudAgent 一条通道。
- 自研内层的成本主要在：多模型行为适配、沙箱隔离、Office 类产出能力，这些不是共作的差异点。
- 共作的差异点是「空间决定 Agent 能看什么、能做什么、结果流向哪里」，这正好是外层。

## 一、harness 分层与共作现状

| 层 | 内容 | 共作现状 | 归属 |
| --- | --- | --- | --- |
| L1 执行内核 | 模型调用、工具调用循环、流式解析、重试 | CloudAgent 托管；本机 Codex/Kimi/CodeBuddy 被刻意限制为纯文本 | 外包 |
| L2 工具与沙箱 | 文件、命令、网页、Office 产出；隔离环境 | CloudAgent 云端 Linux 沙箱（E2B） | 外包 |
| L3 上下文工程 | 记忆、资料、对话截取、隐私过滤 | `task-runner.prepare()`：个人/团队/继承记忆、同事视图隔离、资料引用、企微收件 | **自研** |
| L4 会话与运行 | 会话映射、断线重连、恢复、超时、进度 | `cloudagent.cjs`：一项工作一个 Runtime、消息标记找回本轮、5 分钟静默重连、2 小时上限 | **自研** |
| L5 观测与成果 | 工具时间线、耗时、文件回收、进展抽取 | `execution-log.cjs`、成果取回、`progress-service.cjs` | **自研** |
| L6 治理 | 谁能做什么、哪些动作需人确认 | `contracts/policy.cjs`（空间权限、高影响字段审批）；云端权限请求硬编码放行读/搜/改、拒绝其余 | **自研，但未闭环** |

### 各执行模式实际能力

| 模式 | 内核 | 能否用工具 | 依据 |
| --- | --- | --- | --- |
| cloudagent | CodeBuddy AgentOS | 能（沙箱内） | `cloudagent.cjs` |
| codebuddy | CodeBuddy CLI | 否：`--tools ''`、`--max-turns 1` | `codebuddy-service.cjs` |
| codex | Codex CLI | 否：`--sandbox read-only`，提示词禁止读文件/调工具 | `local-agent-service.cjs` |
| kimi | Kimi Code | 否：agent 文件 `tools: []` | `local-agent-service.cjs` |
| workbuddy | WorkBuddy | 能（由 WorkBuddy 执行） | `workbuddy-*.cjs` |
| model（自己的 API） | 无 | 否：单次 Chat/Responses 请求，最近 12 条、每条 4000 字 | `connection-service.cjs` |

## 二、现有问题（按影响排序）

1. **执行能力单点**：只有 CloudAgent（及 WorkBuddy）能真正干活。Key、额度、接口变动都会让共作失去执行能力。
2. **自己的模型不能执行**：model 模式只会对话。CloudAgent 有 `session/set_model`，但是否支持自带模型/私有部署模型**待向 CloudAgent 团队确认**。
3. **治理没闭环**：云端权限请求只能自动允许或拒绝，共作内没有审批；实测只读命令 `ls` 未触发权限请求，平台侧策略不能当强保证。
4. **沙箱 Key 暴露**：Manifest `secrets` 要求放 `CODEBUDDY_API_KEY`，Agent 可读；团队 Key 阶段前必须解决（见 CLOUDAGENT.md）。
5. **上下文只能「推」不能「拉」**：记忆、资料一次性拼进提示词（资料 12000 字、继承记忆 团队 4 条/公共 3 条）。沙箱里 `mcpServers: []`，Agent 无法按需查共作的资料、记忆、进展，也无法通过工具提议变更。
6. **适配器没有统一契约**：`MODULAR_PLATFORM.md` 定义了 `AgentAdapter`，代码里仍是 `agent-service.answer()` 的大三元表达式；提示词拼装有 4 份（`conversationInput`、`buildCloudPrompt`、`buildPrompt`、CodeBuddy 拼接）。
7. **进展抽取依赖模型守格式**：靠 `<进展>` 文本块，换模型后稳定性未知。

## 三、自研内核要付出什么

| 需要做的 | 难点 | 对共作的价值 |
| --- | --- | --- |
| 多协议模型调用与工具调用解析 | 各家流式格式、工具调用格式、思考块、截断 | 低（通用能力） |
| 工具集（文件、命令、网页、Office/PDF 产出） | Office 产出质量靠大量技能积累 | 低 |
| 沙箱隔离 | 进程/网络/文件隔离、资源回收 | 低，且风险高 |
| 上下文压缩、长任务续接 | 压缩策略随模型调整 | 中 |
| 模型行为补丁 | 每接一个模型都要补边界情况（Claude Code 泄露代码中大量此类补丁即是例证） | 低，持续成本高 |

判断：以上没有一项是共作的差异点，且需要长期维护。泄露的 Claude Code 源码不可使用（版权保留、已发 DMCA），其提示词和补丁也是针对特定模型调的。

## 四、建议路线

### P0 外层产品化（共作自己的 Harness）

1. **统一 AgentAdapter**：把 `answer()` 拆成按模式注册的适配器，声明 `capabilities`（text / tools / files / resume / cloud）；提示词拼装收敛为一份「共作上下文协议」。
2. **审批闭环**：云端 `session/request_permission` 进入共作待确认队列（工作页内确认/拒绝，带超时），替代硬编码放行表；与 `policy.cjs` 的 `changeRisk` 共用一套规则。
3. **共作 MCP 进执行器**：把已有 `gongzuo-mcp.cjs` 的工作能力扩成「查资料 / 查记忆 / 查进展 / 提议变更」，所有调用按 actor + 空间走 `authorize()`；高影响动作只生成待确认项。上下文从「全推」改为「少推 + 按需拉」。

### P1 自己的 API 能执行

4. **轻量共作循环（唯一自研的循环）**：model 模式加一个工具调用循环，只开放第 3 条的共作工具，不开放文件/命令；步数、时长有上限，步骤写入执行时间线。规模估计数百行。
5. **第二执行内核，降低单点**：Codex CLI 自定义 provider 接自己的模型。注意：Codex 自 2026 年 2 月起只支持 Responses API（`wire_api = "responses"`），只有 Chat Completions 的接口需经 LiteLLM 等转换代理；共作当前用 `--ignore-user-config`，需改用 `-c` 注入 provider 配置并放开只读限制，**均待实测**。

### 何时重新考虑自研内核

满足任一条再评估：

- CloudAgent 不支持自带模型，而业务要求数据只进内部模型；
- 沙箱 Key 暴露问题无解，团队阶段无法上线；
- 需要私有化/离线部署；
- 外包内核的成本或限流成为主要瓶颈。

## 四点五、历史并行方案（其 K0 实现已确认，扩展级别暂停）

前提：外层只有一套，内核可插拔。先落地统一 AgentAdapter，再分两条线。

| | 线 A：托管内核 | 线 B：共作内核（自研） |
| --- | --- | --- |
| 内核 | CloudAgent（及 WorkBuddy） | 共作自己的工具调用循环，接自有模型 API |
| 沙箱 | AgentOS | 先不需要；到需要命令执行时租用沙箱（E2B 或 AgentOS），只自研循环与策略 |
| 共用 | 上下文协议、共作 MCP 工具、审批队列、执行时间线、进展抽取、评测集 | 同左 |

线 B 分级长大，每级通过评测再进下一级：

| 级 | 开放能力 | 进入下一级的条件 |
| --- | --- | --- |
| K0 | 只用共作工具（查资料/记忆/进展、提议变更） | 评测集完成率不低于线 A 同类任务 |
| K1 | + 空间资料只读检索 | 无越权读取 |
| K2 | + 写文件到工作产出目录（md/html/csv） | 产出可用率达标 |
| K3 | + 命令执行（必须在租用沙箱内） | 安全审核通过 |

评测集：20–30 条真实工作任务，两条内核跑同一批，比完成率、步数、耗时、成本、被拒/越权动作数；结果决定默认内核。
线 B 的工具白名单、中间件拦截可直接作为 Harness 五层防护（L3/L4）的落地载体。

## 四点六、实现状态（2026-10-15，已确认并行）

参考：pi（`@earendil-works/pi-agent-core`，MIT）与 DeepSeek Harness（`deepseek-ai/deepseek-harness`，MIT）的公开设计；**未使用泄露的 Claude Code 源码**，也未拷贝上述项目代码。

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 适配器注册表 | `electron/harness/adapters.cjs` | 每种模式一个适配器，声明 capabilities；`AgentService.answer/isConfigured` 改为查表 |
| 共作内核循环 | `electron/harness/kernel.cjs` | turn/step、before/afterToolCall、截断整批不执行、超限补合成结果、步数上限后无工具收尾；轨迹只记动作名/状态/耗时 |
| 模型适配 | `electron/harness/providers.cjs` | Chat Completions（DeepSeek/Kimi/兼容/本机）与 OpenAI Responses 的工具调用；回传 `reasoning_content`；识别“接口不支持工具” |
| 共作工具 K0 | `electron/harness/gongzuo-tools.cjs` | 查资料、读资料、查记忆、查已确认进展、提议变更；范围由 `TaskRunner.prepare()` 计算（团队工作不主动列个人资料）；白名单 + 次数预算 |
| 内核接入 | `electron/harness/kernel-adapter.cjs` | `built-in` 模式即共作内核；步骤进执行时间线；接口不支持工具时退回纯对话并在回复中说明 |
| 审批闭环（线 A） | `electron/harness/approvals.cjs`、`cloudagent.cjs`、`task-runner.cjs`、`main.cjs`、`demo/app.js` | CloudAgent 的命令/删除等权限请求进工作页「允许一次 / 拒绝」，10 分钟未确认自动拒绝；等待期间暂停空闲重连；回复记录本轮确认 |
| 评测 | `scripts/harness-eval.cjs` | 6 条用例；配置 `GONGZUO_EVAL_*` 跑真实模型，否则只验证链路 |

测试：新增 `test/harness.test.cjs`（17）、`test/harness-ui.test.cjs`（2），全量 362/362。

未做 / 待实测：真实模型评测（需 API Key）；OpenAI Responses 推理模型在 `store:false` 下回传 function_call 的兼容性；Agent 提议的变更目前只展示、不提供一键应用；线 A 同批评测；K1 起的能力。

## 五、待确认

| 问题 | 找谁 |
| --- | --- |
| AgentOS 是否支持自带模型地址（`set_model` 的可选范围） | CloudAgent 团队 |
| 是否有沙箱专用的短期/受限 Key | CloudAgent 团队 |
| 平台对命令类工具的权限请求策略 | CloudAgent 团队 |
| 目标自有模型接口是否提供 Responses API | 模型服务方 |
