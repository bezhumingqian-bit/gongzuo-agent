# 共作模块化平台设计

状态：目标架构，2026-10-09。本文定义后续开发的边界，不代表所列能力已经实现。当前可用范围以 `README.md` 和 `CONNECTIONS.md` 为准。

## 产品模型

共作的核心是「人、空间、工作、来源、权限、审计」。主页、小应用、自动化规则、Agent 和外部系统接入都围绕这些对象扩展，不分别建立互不相通的任务与成员体系。

```text
个人对话 ──提出需求──> 定制服务 ──生成草案──> 校验/预览/确认 ──> 个人模块
                                                              │
                                              经空间负责人发布 ──> 团队模块

企微/飞书/邮件/数据库 ──> 接入适配器 ──> 标准来源事件/数据查询 ──> 工作与模块
模型/外部 Agent      ──> 执行适配器 ──> 任务结果或待确认操作 ──────> 工作
```

「模块」是带版本的声明式配置，不是模型临时生成并在用户机器上执行的脚本。首批模块类型为主页卡片、工作视图和自动化规则；团队小应用在相同权限和数据接口上提供表单、列表和详情页。一个模块必须声明它读取哪些数据、显示什么、允许什么动作、归属个人还是空间，以及所需能力。使用者可以通过自然语言创建或修改模块，AI 只生成草案；实际执行由固定的组件和受限服务完成。

## 稳定边界

| 边界 | 负责内容 | 不应承担的内容 |
| --- | --- | --- |
| 桌面壳与界面 | 导航、输入、预览和展示已获授权的数据 | 持有外部系统密钥、直接运行模型生成的代码或 SQL |
| 应用服务 | 工作、空间、成员、记忆、小应用与审批的业务规则 | 企微或某个数据库的专有字段 |
| 能力目录 | 注册模块、Agent、工具和连接器的能力、版本与可用状态 | 把「已配置」当成「已验证」 |
| 接入适配器 | 外部认证、拉取/接收、发送、字段映射、重试和游标 | 决定团队记忆或任务字段是否自动更新 |
| 数据仓储 | 按个人、组织和空间读写业务对象；迁移与事务 | 隐含地扩大数据可见范围 |
| 策略与审计 | 身份映射、授权、审批、来源和操作记录 | 由 Agent 自行声明或提升权限 |

`electron/main.cjs` 最终只负责窗口、安全边界和 IPC 组装。业务操作放在独立服务中，经明确的 IPC 方法调用；渲染进程不获得通用文件系统、数据库连接或任意网络代理。现有 `JsonStore` 可作为本机仓储适配器继续使用，但业务服务不得依赖其文件格式。多人协作需要独立服务端、组织身份、事务型数据库和空间级授权，不能把本机 JSON 当作共享数据库。

## 扩展契约

所有注册项都有稳定 ID、版本、能力声明和健康状态。升级保留旧版本配置并提供迁移或回滚；模块引用能力 ID，不引用某个文件路径或供应商实现。

### 数据来源适配器

```ts
interface SourceAdapter {
  id: string;
  capabilities: ('push' | 'sync' | 'query' | 'attachments' | 'send')[];
  connect(account: ConnectionRef): Promise<ConnectionStatus>;
  receive?(payload: AuthenticatedPayload): Promise<SourceEvent[]>;
  sync?(input: { cursor?: string; scope: AuthorizedScope }): Promise<{
    events: SourceEvent[]; nextCursor?: string;
  }>;
  query?(input: AuthorizedQuery): Promise<SourceRecord[]>;
  send?(input: AuthorizedAction): Promise<DeliveryReceipt>;
}
```

`SourceEvent` 至少包含 `source`、`connectionId`、`tenantId`、`sourceId`、`conversationId`、`actorId`、`occurredAt`、`receivedAt`、`contentType`、`contentRef`、`permissionScope` 和 `rawRef`。使用 `(source, connectionId, sourceId)` 去重。原文与提取出的工作进展分开存放；摘要和工作更新始终保留来源引用。连接器负责说明没有权限、数据缺失、限流和重试结果，不能伪造完整性。

企微机器人消息、未来的大圆定时投递、飞书消息、邮件和数据库增量都进入同一个来源入口。每个接入只实现自己的认证和映射。大圆发来的日报如果超过单条消息容量，应投递文件引用或分片清单；导入服务核对日期、分片数、校验值和最终收据后才标记当日完成。机器人收到消息不等于已完整导入。

对于企业业务数据库，优先使用系统官方 API、事件或受控数据视图；确需直连时，由服务端持有只读账号并暴露限定表/视图的查询适配器。每个系统单独配置字段映射、增量游标、分页、频率和权限。模块只能请求已登记的数据集和有限过滤条件，不能传入任意 SQL、连接串或凭据。跨系统写入使用独立动作能力，默认要求确认并记录回执。

### Agent 与工具

```ts
interface AgentAdapter {
  id: string;
  capabilities: ('text' | 'tools' | 'files' | 'resume')[];
  run(input: AuthorizedTaskContext): Promise<AgentResult>;
  testConnection(): Promise<ConnectionStatus>;
}
```

模型、Codex、Kimi Code、WorkBuddy 等通过执行适配器接入。MCP 与企业 API 是工具或数据能力，不能因为选中了 Agent 就自动获得。委派时按当前用户、空间和工作计算可见上下文，并逐动作授权；对外发送、改权限、删除、发布和跨系统写入走人工确认。

### 模块清单与 AI 定制

```ts
interface ModuleManifest {
  id: string;
  version: number;
  kind: 'home-card' | 'work-view' | 'workflow' | 'mini-app';
  owner: { type: 'user' | 'workspace'; id: string };
  title: string;
  dataBindings: { sourceId: string; dataset: string; fields: string[]; filters?: object }[];
  layout: object;     // 由受控组件目录校验，不允许任意 HTML/JS
  actions: { capabilityId: string; approval: 'none' | 'required' }[];
  status: 'draft' | 'published' | 'archived';
}
```

对话定制流程：用户描述目标 → AI 从已授权的数据集和组件目录生成 `ModuleManifest` 草案 → 确定性校验字段、权限、成本与循环触发风险 → 用样例或真实的最小授权数据预览 → 用户确认保存。个人模块只对创建者可见；分享到空间需空间负责人确认。每次修改生成新版本，能查看差异和恢复旧版。AI 不能通过提示词绕过校验，也不能直接生成可运行代码、数据库查询或外发动作。

例如「每天把大圆送来的客户讨论整理成待办，在首页显示」应生成一个来源绑定、一条提炼规则和一张主页卡片。提炼结果先成为待确认工作；确认后才更新任务或团队知识。缺少大圆投递、微盘读取或 Agent 授权时，草案显示缺失的能力，不假装已经运行。

## 存储与部署

先建立 `TaskRepository`、`WorkspaceRepository`、`SourceRepository`、`ModuleRepository`、`ConnectionRepository` 的接口，再迁移本机实现。连接凭据与业务数据分开保管；渲染进程和模块清单只见凭据引用及状态。来源记录、模块版本、执行记录和审批记录应有独立存储与保留策略。未来服务端按 `tenantId + actorId + workspaceId` 授权，所有查询在服务端裁剪范围。

Mac 版可继续本机运行交互与个人配置。要求全天接收消息、定时同步或多人共用的数据接入应移到常驻服务端；Mac 休眠或应用关闭时，本机长连接不能保证接收。服务端需支持游标续传、幂等导入、失败重试、积压监控和人工补录。

## 与现有代码的迁移顺序

1. **固定数据和权限契约。**（2026-10-13 已完成首版：`electron/contracts/` 下 `source-event.cjs`、`policy.cjs`、`work-operations.cjs`；见下方「当前契约」。） 从 `main.cjs`、`task-runner.cjs` 和 `wecom-bot-service.cjs` 中抽出来源事件、工作操作与审批边界；保留现有 IPC 行为。为已有企微消息补适配器，但不要改变已存数据的含义。
2. **实现模块目录。** 把 `demo/app.js` 中写死的 `homeModuleCatalog`、固定应用预览和一条 `workflow` 规则逐步改为受控清单；先支持个人主页卡片和规则版本，再开放团队发布。
3. **实现对话定制。** AI 输出草案，校验器生成可预览配置；先只用现有工作、空间资料和企微收件数据。预览、保存和实际运行状态分别显示。
4. **建立接入适配器。** 先验证「大圆 → 企微机器人 → 来源记录 → 待确认工作」；随后接微盘文件、飞书和邮件。每项接入单独做权限、断线和重复投递测试。
5. **迁往协作服务。** 在组织身份、空间授权和审计就位后，再开放跨设备共享模块、团队记忆与企业数据库数据集。

验收标准：新增一个数据来源、一个 Agent 或一个主页模块，不修改其他供应商的实现；用户能用一句话生成可预览的个人模块，确认后才生效；未授权字段不能被查询，失效连接不会被显示成可用；重复事件不会重复创建工作，所有自动更新可追溯并可撤销。

## 当前契约（第 1 步落地）

| 文件 | 内容 | 使用方 |
| --- | --- | --- |
| `contracts/source-event.cjs` | `SourceEvent` 标准字段与去重键 `source:connectionId:sourceId`；企微机器人帧与 `channel:ingest` 的适配；按旧集合（`wecomEvents`、`inboundMessages`、`channelEvents`）原样落库 | 企微机器人、IPC 渠道接入 |
| `contracts/policy.cjs` | 操作者（本机用户、企微成员、WorkBuddy、摘要规则）、空间角色与 `work.view/create/append` 授权；企微发起的工作不带个人记忆；字段风险（需确认 / 可撤销）与渠道消息判定 | 全部入口、TaskRunner |
| `contracts/work-operations.cjs` | 唯一的新建、追加、查看入口：解析空间 → 授权 → 交给 TaskRunner；错误码 `workspace-not-found / task-not-found / no-access / read-only` 由各入口映射为自己的文案 | 本机 IPC、企微机器人、WorkBuddy 桥接 |

已存数据的结构和含义未改；企微回复文案逐字保持（有回归测试）。单机语义：本机用户拥有全部本机空间，WorkBuddy 作为本机用户的代理，企微成员只能操作显式关联的空间，摘要规则只能在配置的空间建工作。迁往服务端时，替换 `workspaceRole` 的身份来源即可，入口代码不变。

## 工作关联多个空间（2026-10-14，张祥春评审建议）

一项工作 = **1 个归属空间 + 最多 5 个关联空间**，而不是对等多选：

| 维度 | 归属空间 | 关联空间 |
| --- | --- | --- |
| 数量 / 可改 | 1 个，创建后不可改 | 0–5 个，可随时增删 |
| 可见 | 出现在该空间 | 同样出现在该空间的工作列表 |
| 查看 / 追加权限 | 按成员角色 | 同样按成员角色（任一空间有权限即可） |
| 修改关联 | 需归属空间的编辑权限；新增某个关联还需在该空间有创建权限 | — |
| Agent 上下文 | 团队记忆 + 可引用资料 | 同样提供，提示词中注明「同时关联到」 |
| 成果文件写回、负责人、企微通知 | 归属空间 | 不写入 |

为什么不做对等多选：权限、成果归档、负责人都需要一个确定的「主」；对等多选会让「这项工作算谁的」没有答案。数据上只新增可选字段 `relatedWorkspaces`，未关联的工作结构不变。
