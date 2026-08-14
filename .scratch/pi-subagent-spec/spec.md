# Pi Subagent 独立扩展规格

Status: development-ready
Upstream baseline: `a96fb984d8c8b065fc5d193309fc812a882adee0`
Minimum host: Pi `0.84.1`, Node `22.19.0`

当前实现里程碑：开发和原生验收只在 Windows 执行，使用最低宿主组合与验收时锁定的当前宿主组合各一个 job。macOS/Linux 适配代码可以在本里程碑交付并接受类型、纯逻辑和 fake 测试，但其原生 runner、进程树回收证据和支持结论明确延期到独立计划；未完成该计划前，不把 Unix 路径标记为已验证支持。

## 0. 文档约定

本文是 Pi Subagent 首版实现的唯一规范性入口。`map.md` 提供当前实现路线和工单导航；`issues/`、`research/` 和 `prototypes/` 保存决策依据、上游证据和抛弃式验证，不要求实现代理拼接这些文件才能理解行为。

本文中的“必须”“不得”“应”“可以”具有规范含义：

- **必须/不得**：实现和开发验收不可偏离；
- **应**：存在明确理由时才可偏离，并需在实现记录中说明；
- **可以**：不改变公开契约的实现选择。

每项规范要求使用稳定 `REQ-xxx` 标识，每个开发验收场景使用稳定 `AC-xxx` 标识。文末追踪表将要求映射到来源票据和验收场景。领域词汇以仓库根目录 `CONTEXT.md` 为准；本文与已解决票据或领域词汇出现矛盾时，必须先修正文档再实现。

包名、registry 所有者、签名凭据等属于未来发布输入，不影响本规格的功能行为。当前交付只定义开发阶段的本地 package 形态和验收，不执行 npm 发布、release tag 或安装到用户环境。

## 1. 目标、边界与核心不变量

### 1.1 产品目标

**REQ-001**：扩展必须让一个根 Pi 会话创建并长期复用临时子代理。每个子代理与一个 `pi --mode rpc --no-session` 进程一一对应，拥有独立上下文和身份，并可在根会话存活期间处理多次父子消息。

**REQ-002**：子代理必须组成有向树。每个节点只有一个直接父会话；父会话只能向直接子代理发送消息、等待、中断、终止或查询单节点状态。根会话可以只读查看整棵树，但不得越级控制后代。普通父会话可以只读查看自身子树，但不得访问祖先、兄弟或其他根。

**REQ-003**：代理树只在当前根会话内存在。根退出、切换到 `new`/`resume`/`fork` 或 runtime 真正关闭时必须清理整棵树；不得跨根会话恢复、跨设备持久化、共享节点或复用已分配的 `agent_id`。每个子代理的 `agent_id` 值必须是 UUID；控制器创建新节点时使用随机 UUID v4，并以 RFC 9562 canonical 小写文本格式传输；不使用 `agent_` 前缀。

### 1.2 明确排除

首版不包含：

- 兄弟代理、非直接祖先与后代之间的直接通信或广播；
- 远程主机、分布式调度、多用户共享代理树；
- 通用优先级队列、多个并行逻辑任务或自动调度系统；仅允许节点 mailbox 线性化同一任务消息与中断后的单一后继任务；
- 文件路径沙箱、逐路径读写授权或操作系统级安全隔离；
- 模型 token/费用预算、同时运行数限制、空闲自动回收、创建速率限制；
- 性能、吞吐、延迟、RSS 或句柄数量的产品 SLO；
- 修改 Pi 核心或把 Subagent 变成 Pi 内建功能。

## 2. 包、宿主兼容与平台

### 2.1 Pi package

**REQ-004**：扩展必须作为标准 Pi package 交付，不修改 Pi 核心。`package.json` 的标准 `pi` manifest 只显式声明一个扩展入口，不依赖约定目录扫描，也不注册 package skills、prompts 或 themes。

规范字段示意如下；具体包名和第三方依赖名称属于实现元数据：

```json
{
  "engines": {
    "node": ">=22.19.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./extensions/pi-subagents-wj.ts"]
  },
  "piSubagent": {
    "requiresPi": ">=0.84.1"
  }
}
```

第三方运行依赖必须放在 `dependencies`，不能只放在 `devDependencies`。扩展实际导入的宿主 Pi 包使用宽 `peerDependencies: "*"`，不得把宿主 Pi 实现打入分发包，也不得依赖 peer 解析充当兼容门禁。包内可以包含入口所需内部模块和静态资源，但只有显式扩展入口由 Pi 加载。

包不得创建、复制或修改代理模板、`subagent.json`、Pi 用户设置或项目设置。模板继续从第 4 节规定的目录发现。

### 2.2 安装来源边界

npm 是未来规范发布渠道，正式版本使用 SemVer；`v<version>` git tag 应指向同版本源码，完整 git commit 可用于固定和复现。可变 branch、未固定 git URL 和浮动 npm 标签不属于可复现安装承诺。本地路径只用于开发与验收。

未来 npm、git tag 和完整 commit 来源都应兼容 Pi 的临时 `-e/--extension` 与持久 `pi install`；持久安装默认是用户 scope，项目 scope 使用 Pi 原生 `-l` 并受 project trust 控制。当前开发交付只验收本地包路径或本地构建包，不要求 registry、正式 tag 或发布报告。

### 2.3 宿主兼容门禁

**REQ-005**：扩展激活必须是全有或全无事务。在注册八个管理工具、子代理专用 `reply_to_parent`、`/agent`、widget、监督器或业务生命周期处理器之前，必须确认：

1. Node 版本满足 `>=22.19.0`；
2. Pi 版本满足 `>=0.84.1`；
3. 当前平台存在可用的 `ProcessTreeAdapter`；
4. Pi 提供实现工具、命令、UI、生命周期和 RPC 监督所需的必需 API；
5. 必需模块和运行依赖可以加载。

任一探针失败时必须失败关闭：不注册任何公开面，不启动监督器或子进程，不做部分工具降级。由于 Pi factory 没有 UI 上下文，允许最多注册一次仅用于诊断的 `session_start` 桥；桥不执行扩展业务逻辑，只在 `ctx.hasUI` 且 `ctx.ui.notify` 可用时显示安全的 UI-only 诊断和稳定标识 `host_capability_unavailable`，随后忽略重复事件。诊断不得进入会话消息、系统提示或模型上下文；无 UI 模式不得增加 stderr、结构化事件或模型消息回退。宿主 Pi 会话仍可继续使用。

Node 版本低到宿主 Pi 本身无法启动时，由 Node/Pi 既有启动路径负责失败；上述 UI 语义只适用于扩展 factory 已能执行的情况。

### 2.4 支持平台

**REQ-006**：代码必须保留 Windows、macOS 和 Linux 的平台适配契约；当前 Windows 开发里程碑只验证 Windows：

- Windows 必须使用基于 Job Object 的进程树适配器；
- macOS/Linux 必须使用 process group 或 session；
- CPU 架构不另设限制，但必须能运行兼容 Node/Pi 和对应适配器；
- 本里程碑允许先交付 macOS/Linux 代码，并在 Windows 上执行类型、纯逻辑和 fake 测试，但不执行其原生 runner，也不据此宣称已验证支持；
- 浏览器、移动系统、远程宿主和未验证 Unix 变体不属于目标范围。

没有可靠整树适配器的平台必须被兼容门禁拒绝，不得退化为只终止直接子进程，也不得伪造 `terminated`。Unix 原生验证延期不改变代码契约，但在对应验证计划完成前不构成当前里程碑的支持证据。

## 3. 根基础、配置与诊断

### 3.1 固定工作基础

**REQ-007**：整棵代理树必须固定使用根会话的同一 `cwd`。模板、父会话和后代不得覆盖它；相对路径、project identity 和项目资源发现都以该目录为基点。

`cwd` 不是文件系统访问边界。只要模型可见工具和宿主权限允许，子代理可以使用绝对路径或 `..` 访问工作目录之外的文件。扩展不得额外实现 cwd 沙箱；隐藏一个工具也不代表仍可见的 `bash`、扩展或其他工具失去同等宿主权限。

**REQ-008**：根会话的 project trust 结果必须原样传给整棵树，只控制项目设置、扩展、技能、提示模板和系统提示等项目资源是否加载，不限制普通文件访问。模板不能提升、降低或重新确认该信任。

建立代理树时必须捕获一次根环境快照，所有后代从该快照启动，不继承中间父进程后续环境修改。控制器只可追加不可覆盖的节点身份、父标识、深度、`maxDepth`、根关联和协议版本等内部元数据。环境秘密不得进入状态、树、错误、UI、监督帧或日志。

### 3.2 配置位置与优先级

**REQ-009**：根启动时一次解析有效配置并固定传给整棵树。每个支持字段按以下优先级独立解析：

1. 显式根启动参数；
2. 已获信任项目的 `<cwd>/.pi/subagent.json`；
3. 用户级 `~/.pi/agent/subagent.json`；
4. 内置默认值。

项目未获 trust 时项目配置不参与。文件或字段缺失是正常情况，继续读取下一层。配置文件没有版本字段。

支持字段如下：

| 字段 | 默认值 | 合法值 | 作用 |
| --- | ---: | --- | --- |
| `maxDepth` | `2` | 整数 `1..8` | 根深度为 0 的最大子代理层级 |
| `maxChildrenPerAgent` | `4` | 整数 `1..16` | 每个父会话的直接子代理上限 |
| `maxAgentsPerTree` | `16` | 整数 `1..64` | 根之外尚未 `terminated` 的全树节点上限 |
| `waitTimeoutMs` | `60000` | 整数 `10000..600000` | `wait_agent` 未传 `timeout_ms` 时的默认观察窗口 |

`maxWaitTimeoutMs`、`idleTimeoutMs`、`maxConcurrentRuns`、`maxSpawnRate` 和模型预算字段均不受支持。

**REQ-010**：显式根参数只要提供就必须严格校验；非法类型、非整数或越界必须拒绝根会话启动。用户或项目配置文件不可读、JSON 无法解析，或被选中层的已知字段非法时，该受影响字段必须采用自身内置默认值，不得回退低优先级层。未知字段通过一次根 UI-only warning 提示后忽略。诊断必须说明逻辑来源、字段和采用的默认值，但不得包含绝对路径、秘密、异常堆栈或配置正文；不得进入模型上下文。无 UI 模式不提供其他输出回退。

## 4. 代理模板与上下文装配

### 4.1 发现、身份与信任

**REQ-011**：根控制器只从以下两个目录发现 UTF-8 Markdown 模板，并且只扫描直属 `*.md`，不递归：

- 用户级：`~/.pi/agent/agents/*.md`；
- 项目级：`<cwd>/.pi/agents/*.md`，仅在根 project trust 允许时参与。

接受直属普通文件和符号链接；失效或不可读链接是无效候选。缺失目录是正常空来源；目录存在但无法枚举时产生来源诊断，并继续使用另一来源。

**REQ-012**：`template_id` 是原始文件名去掉末尾 `.md` 的精确值。它区分大小写，不裁剪、不转写、不做 Unicode 归一化、别名或模糊匹配，也不增加扩展级字符限制。frontmatter 不提供 `name`。根 project trust 是项目模板唯一人工确认边界；信任后根和所有后代使用项目模板不再逐次确认。

### 4.2 Markdown 与 frontmatter schema

**REQ-013**：每个模板必须有可解析 YAML frontmatter；Markdown 正文允许为空，UTF-8 编码后不得超过 `64 KiB`。已知字段如下：

| 字段 | 类型与默认值 | 规范语义 |
| --- | --- | --- |
| `tools` | 必填 YAML 字符串 | `""` 是唯一合法空工具集；非空值按逗号拆分、裁剪、丢弃空项、按首次顺序去重；规范化后为空无效 |
| `description` | 可选字符串 | 裁剪后只作父代理展示元数据，可由 `get_agent_templates` 返回；空值等同无描述 |
| `subagents` | `inherit` 或 `disabled`，默认 `inherit` | `disabled` 对当前节点及所有后代关闭整组管理工具 |
| `contextFiles` | `enabled` 或 `disabled`，默认 `enabled` | 只控制固定 `cwd` 祖先链的 `AGENTS.md`/`CLAUDE.md` |
| `systemPromptMode` | `append` 或 `replace`，默认 `append` | 决定正文追加或替换项目与角色提示层 |
| `model` | 可选规范 `provider/model` 字符串 | 省略时捕获直接父会话当前精确模型；显式值必须精确匹配模型目录 |
| `thinking` | 可选枚举 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；省略时捕获父会话实际等级 |

未列出的字段一律静默忽略，不进入运行配置，也不产生诊断。因此 `name`、`env`、`skills`、`extensions`、`promptTemplates` 和 project trust 字段都不起作用。

frontmatter 缺失或解析失败、文件不可读、已知字段类型/枚举错误、未知业务工具名、显式模型格式错误或 thinking 格式错误都使候选模板无效。`tools: " , "` 无效；`tools: "read, , grep, read"` 规范化为 `read, grep`。

模板示例：

```markdown
---
description: 汇总并核对外部资料
tools: read, grep, find
subagents: inherit
contextFiles: enabled
systemPromptMode: append
model: openai/gpt-example
thinking: medium
---

优先给出可核对的来源和结论。
```

文件名为 `researcher.md` 时，公开标识只能是 `researcher`。

### 4.3 覆盖、诊断和发现快照

**REQ-014**：项目和用户候选具有相同 `template_id` 时，项目候选整体覆盖用户候选，不合并字段或正文。覆盖在有效性判断之前决定：无效项目候选仍遮蔽有效用户候选，显式创建返回 `template_invalid`；有效项目候选不因被遮蔽用户候选无效而失效。

根必须独立读取和校验所有可信来源候选，包括最终被遮蔽者。有效候选进入有效模板目录并成为 `get_agent_templates` 的唯一数据来源；无效候选进入只含逻辑来源、文件名和安全短原因的诊断索引；来源无法枚举形成无 `template_id` 的来源诊断。无效候选和来源诊断不得进入模型可见模板数组。

没有选中候选时 `spawn_agent` 返回 `template_not_found`；选中候选无效时返回 `template_invalid`；无法归类的控制器故障才返回 `internal_error`。诊断不得保存或展示正文、绝对路径、环境、OS 异常或堆栈。

根首次发现和每次根 `/reload` 后原子发布模板发现快照。存在诊断时只发送一次根 `ctx.ui.notify(..., "warning")` 汇总；没有诊断时不通知。子代理自身 reload 不重建根快照或重复通知。无 UI 模式仍建立同一快照，但不输出替代诊断。

### 4.4 创建预检与上下文继承

**REQ-015**：`spawn_agent` 在预留名额或启动进程前必须完成以下最小静态预检：

1. 精确解析当前模板发现快照；
2. 校验已知 schema 和工具名；
3. 将模板 `tools` 作为子代理初始业务工具请求，不与直接父会话当前活动工具做子集校验；
4. 精确解析显式或捕获的 provider/model，并校验当前模型目录、根策略和静态认证可用性；
5. 校验 thinking 枚举及当前已知模型支持范围；
6. 校验有效子代理管理能力、深度和名额。

结构、格式或未知工具名问题返回 `template_invalid`。模板合法但模型、认证、thinking 或父授权静态不可满足时返回不可重试的 `template_capability_unavailable`，不得静默削减工具、夹紧 thinking、构造 custom model、预留名额、登记节点或启动进程。

预检不得通过真实模型请求证明最终可用性，也不计算环境、提示、技能、扩展、上下文文件或工具注册表哈希。创建成功只要求监督通道和 Pi RPC 都可通信，不保证运行期资源永不变化。

**REQ-016**：模板和子进程上下文必须遵守：

- 子代理不复制父会话渲染后的系统提示或对话历史；
- `append` 将模板正文追加到项目与角色提示层；`replace` 只替换该层；两者都不能移除安全、所有权、直接父子通信、工具和树控制契约；
- 每个子代理始终保留只向直接父会话发送工作中回复的运行时契约；模板正文、模板 `tools` 和 `subagents: disabled` 均不能移除、替换或扩大其目标；
- `contextFiles` 只控制固定 `cwd` 祖先链的 `AGENTS.md`/`CLAUDE.md`，每个模板独立决定；父节点禁用不阻止子模板重新启用；
- skills、extensions 和 slash prompt templates 不由模板限制，按固定 `cwd`、统一 project trust、用户资源目录和 Pi 正常发现机制加载；
- prompt template 不自动展开为首条任务；模板也没有 `env` 覆盖。

### 4.5 Reload

**REQ-017**：成功的根 `/reload` 必须原子更新模板发现快照和 Pi 动态业务资源，只影响未来创建；既有节点的模板正文、初始工具请求、模型选择、提示、生命周期和上下文不得回溯改变。运行期业务工具或资源变化不重新执行模板能力预检，不降级、终止或重建节点。

树控制面是例外：reload 后必须按保存的身份、直接父关系、祖先 `subagents` 关闭状态和 `maxDepth` 重新施加八个管理工具的完整可见性，并为所有子运行时重新施加 `reply_to_parent`。成功 reload 通过控制器交接保留代理树与回复协调状态；根和后代的 `get_agent_templates` 必须通过根权威读取 reload 后的同一最新目录，不得继续使用子运行时的旧快照。旧实例只在没有新扩展 factory 接管时使用有界 watchdog；新 factory 开始宿主门禁后必须暂停该 watchdog，并在公开面和生命周期处理器完整注册后才认领旧控制器。已认领的控制器等待 Pi 发出 reload `session_start`，不得因固定 lease 期限误终止。交接窗口中已经通过监督传输接收、但旧 Pi API 未接纳的回复必须按 `reply_seq` 有界保留且不发送 reply ACK；新 API 绑定后重试注入，只有成功进入父会话才累计确认。若新扩展实例未通过宿主兼容门禁，旧控制器必须按终止语义清理全部子代理，不保留旧工具、widget、端点或孤儿进程，也不自动回退旧实例。

## 5. 能力、深度和资源配额

### 5.1 管理能力

**REQ-018**：根深度固定为 `0`，每经过一条父子边深度加一。有效 `maxDepth` 是可创建的最大子代理层级。默认 `maxDepth=2` 时，根可创建 A（深度 1），A 可创建 A-1（深度 2），A-1 是叶节点。

八个管理工具是不可拆分的“子代理管理能力”。一个节点只有同时满足以下条件才获得整组工具：

1. 直接父会话仍有该能力；
2. 所有祖先模板均未以 `subagents: disabled` 关闭它；
3. 当前节点 `depth < maxDepth`。

任一条件不满足时整组隐藏，后代不能重新开启。服务端仍必须重复校验直接父权限和深度；绕过工具发现的模板目录查询返回 `template_capability_unavailable`，创建请求返回 `max_depth_reached` 或相应授权错误。

`reply_to_parent` 不属于八个管理工具。每个子代理无论是否达到 `maxDepth`、是否继承管理能力、模板是否设置 `subagents: disabled`，都必须保留该工具；根会话不得注册它。

### 5.2 名额占用与释放

**REQ-019**：创建前必须在同一原子操作中预留父节点直接子代理名额和全树名额、分配不可复用的 UUID v4 `agent_id` 并登记 `starting`。`starting`、`idle`、`working`、`interrupting`、`suspended`、`failed`、`terminating` 都占名额；只有节点及其子树资源确认并进入 `terminated` 后释放。终止记录继续可见但不占名额。

达到深度、直接子代理或全树上限时必须立即拒绝，不自动等待、排队或回收：

- 深度：`max_depth_reached`，不可重试；
- 直接子代理：`max_children_reached`，名额释放后可重试；
- 全树：`max_tree_agents_reached`，任一节点完成回收后可重试。

并发创建不得超卖；启动失败或超时必须清理残留后释放预留，除非资源无法确认而保持 `terminating`。

### 5.3 不增加的资源控制

**REQ-020**：不同节点可以并行处理，同一节点由单一任务 mailbox/reducer 串行。首版不得新增同时运行数、token/费用、空闲时长或创建速率控制，也不得新增通用调度队列；`wait_agent` 超时只结束一次观察，不改变节点。

## 6. 生命周期与公开工具

### 6.1 八态生命周期

**REQ-021**：公开生命周期只能是以下八种：

| 状态 | 定义 | 接受父子消息 | 占名额 |
| --- | --- | --- | --- |
| `starting` | 已登记并预留名额，正在建立进程、监督通道和 RPC | 否 | 是 |
| `idle` | 双通道可通信，且没有当前任务、压缩、恢复、候选 final、未决命令或未确认 reply | 是，建立新任务 | 是 |
| `working` | 已有当前逻辑任务，可能正在投递、处理、压缩、对账或提交 final | 是，归入当前任务或 mailbox | 是 |
| `interrupting` | 中断栅栏已生效，等待当前任务形成 interrupted final | 是，但只能分配给后继任务 | 是 |
| `suspended` | 交付不可确认或维护失败，需要调用者裁决 | 是，由 mailbox 保守接纳但不自动投递 | 是 |
| `failed` | 终止屏障前发生不可自动恢复的运行或控制故障 | 否 | 是 |
| `terminating` | 终止屏障已生效，但子树资源未全部确认回收 | 否 | 是 |
| `terminated` | 本节点和全部后代的终止及资源回收已确认 | 否 | 否 |

`idle` 必须严格静止，不能仅凭 raw `agent_settled` 或 Pi 队列为零推断。`suspended` 不是完成或稳定终态；`wait_agent` 必须显式返回该 outcome，让调用者根据 `activity.phase` 查询和裁决。`failed` 与 `terminated` 是稳定终态，`terminating` 仍可能持有资源。不得新增公开 `queued`、`running`、`exited`、`cancelling` 或 `unknown`。

### 6.2 转换与线性化

**REQ-022**：每个节点必须由单一 mailbox/reducer 线性化父消息接纳、task assignment、Pi command、interrupt、生命周期、压缩、reply 与 ACK。关键转换如下：

| 当前状态 | 触发 | 下一状态/阶段 | 守卫 |
| --- | --- | --- | --- |
| 无节点 | 原子预留、分配身份并登记 | `starting` | 登记先于进程启动 |
| `starting` | 双握手、首个快照和无副作用 RPC 成功 | `idle` | 此时 `spawn_agent` 才成功 |
| `idle` | mailbox 接纳首条消息并分配 `task_id` | `working/reconciling` | 工具可立即返回 accepted |
| `working` | mailbox 接纳后续消息 | `working` | 中断栅栏前归入当前 task |
| `working` | 中断被接纳 | `interrupting/processing` | 栅栏后消息属于 successor task |
| `working`/`interrupting` | raw `agent_settled` | 保持非 idle，进入 `finalizing` | 只建立 provisional candidate |
| 非终态 | 匹配 final 已 prepare | `finalizing` 或 `waiting_parent_ack` | `reply_outbox_pending_count = 1` |
| 非终态 | settlement 与父会话接纳均满足，commit 成功 | `idle` 或 `working/reconciling` | 记录 `last_task`；仅全静止时 idle |
| `working`，已观察 `agent_end` | Pi 原生自动压缩开始/结束 | `working/compacting` 后进入 `working/reconciling` | 保持同一 `task_id`；threshold 可保留候选，overflow `willRetry` 撤销候选；等待真实 start 或 settled |
| `working`/`interrupting` | 会话本地入口和直接父边 prepared 后发生 manual 压缩 | `working/compacting` 后进入 `finalizing` 或等待真实 continuation | 保持同一 `task_id`；监督 complete 与 Pi start/end 可跨通道重排，不能据此误判未授权 |
| 活动节点 | Pi command rejection/EOF 后交付不可证明 | `suspended/delivery_uncertain` | 不倒写 mailbox accepted；屏障粘性 |
| 自动压缩活动 | 压缩失败或取消 | `suspended/maintenance_failed` | 不自动重跑；屏障粘性 |
| 非 `terminated` | 终止屏障被接纳 | `terminating` | 不可逆，固定已登记子树 |
| 非终态 | 进程、RPC 或协议不可可信恢复 | `failed` | 不自动重启 |
| `terminating` | 后代及本节点资源均确认 | `terminated` | 父节点后于后代 |
| `terminated` | 任意迟到事件或重复终止 | `terminated` | 身份不复用 |

进程退出和终止屏障并发时，以同一顺序域中先线性化者决定。终止屏障优先于普通命令、reply、快照和 ACK；迟到事件不得跨越屏障恢复节点。Pi `get_state` 只可用于启动同步、直接边压缩 prepare 的 `pendingMessageCount` 静止探测、事件缺口后的异常重同步和诊断；它不得裁决普通消息是否已读取、压缩 continuation 或 provisional settlement，也不得覆盖已提交任务结果或恢复公开 `failed`。

### 6.3 任务、队列、修订与时间

**REQ-023**：首条 mailbox 消息建立不可复用的 UUID v4 `task_id`；没有新的 task assignment 时，同一任务可以跨自动重试、steering、压缩和多个 Pi loop 保持身份。每次实际 loop 使用新的 UUID v4 `turn_id`；final 使用不可复用的 UUID v4 `commit_id`。中断栅栏后的消息必须获得后继 task，不能 steer 到正在取消的 run。

节点必须在一个原子快照中公开三类非负安全整数计数：

- `mailbox_pending_count`：插件已接纳、尚未完成 Pi command 接纳的正文数；
- `host_pending_count`：Pi 通过 queue/update 等安全事实报告的宿主待处理数；
- `reply_outbox_pending_count`：已经 prepare、仍等待可提交 settlement 或父会话 ACK 的 final 数，当前最大为 1。

`accepted: true` 只说明 mailbox 已分配 `message_id/task_id` 并接纳文本，不说明 Pi 或模型已读取。Pi command rejection 或 EOF 不能减少已经返回的接纳事实并伪造“未交付”；无法证明时进入 `suspended/delivery_uncertain`，也不得自动重发。`idle` 要求三类计数均为 0、没有 `activity` 和当前 task；`failed`/`terminated` 的计数必须归零。

快照可公开正交 `activity`，其中 `phase` 只取处理、工具执行、压缩、对账、finalizing、等待父 ACK、恢复或 suspension 原因等安全闭集，可选携带当前 `task_id` 与粗粒度工具类别/计数。成功 final commit 后可公开 `last_task { task_id, turn_id, commit_id, outcome, output_state }`，不得复制正文。

状态、三类计数、activity、last_task 或当前安全故障真实变化时，节点 `revision` 必须单调递增；这些字段必须由同一 mailbox 投影原子更新，不能出现 `idle` 与未确认 outbox/finalizing 并存。内部句柄和被忽略的 stale task/turn 事件不得增加修订；树原子变化使用独立 `tree_revision`。

### 6.4 共通工具契约

**REQ-024**：子代理管理工具固定为：

`get_agent_templates`、`spawn_agent`、`send_message`、`wait_agent`、`interrupt_agent`、`terminate_agent`、`get_agent_status`、`get_agent_tree`。

不提供多模式 `subagent` 工具。子运行时额外注册单一 `reply_to_parent`，但它不属于管理工具、不接受目标身份，也不能用于越级或任意目标消息。所有管理定向工具使用根会话内唯一、终止后不复用的 UUID `agent_id`；控制器新分配的值使用随机 UUID v4，所有传输文本必须符合 RFC 9562 canonical 小写格式（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`），不带 `agent_` 前缀。展示名称不能寻址，也不能从标识推断树结构。任何 `agent_id` 参数若不是 canonical UUID 文本，必须返回 `invalid_argument`；格式正确但不在当前根注册表中的值返回 `agent_not_found`。

除 `get_agent_templates` 的直接数组结果外，成功结果统一为：

```json
{ "ok": true, "data": {} }
```

预期失败必须让 Pi 标记工具结果 `isError: true`，正文为：

```json
{
  "ok": false,
  "error": {
    "code": "stable_snake_case",
    "message": "面向调用者的安全说明",
    "retryable": false,
    "details": {}
  }
}
```

调用方只依赖 `code` 和 `retryable`；`message` 和 `details` 结构不稳定，但不得泄露正文、绝对路径、环境、凭据、端点、进程句柄或堆栈。

### 6.4.1 `get_agent_templates`

输入只允许空对象 `{}`。成功正文直接是 JSON 数组，不套用 `{ "ok": true, "data": ... }` 外壳。没有格式有效模板时返回：

```json
[]
```

非空结果示例：

```json
[
  {
    "template_id": "Explore",
    "description": "Fast codebase exploration agent (read-only)",
    "tools": ["read", "bash", "grep", "find", "ls"]
  }
]
```

每项字段闭集为区分大小写的 `template_id`、可选 `description` 和始终存在的 `tools`。没有描述时省略 `description`；合法空工具模板返回 `tools: []`。`tools` 只包含模板声明并已规范化的业务工具，不得混入八个管理工具或 `reply_to_parent`。结果不得包含模板正文、来源、model、thinking、`subagents`、`contextFiles`、路径、诊断或其他运行配置；无效候选与来源诊断不得枚举。失败仍使用本节统一错误契约。

数组只表示根权威当前发现且格式有效的模板，不执行调用者当前模型、thinking 或管理权限的完整创建预检。`tools` 是子代理的初始业务工具请求，不要求是父会话当前活动工具的子集；非空项仍可能在 `spawn_agent` 返回 `template_capability_unavailable`。根 `/reload` 后，根和所有后代查询必须立即读取根权威发布的同一最新目录。

### 6.5 `spawn_agent`

**REQ-025**：输入只允许必填 `template_id` 和 `name`：

```json
{ "template_id": "researcher", "name": "资料代理" }
```

不得携带首条任务，也不得覆盖 cwd、环境、模型、thinking、工具、扩展、技能、提示、信任、深度或配额。首条任务必须另行调用 `send_message`。

模型调用前必须先调用 `get_agent_templates`，并原样复制当前返回项的 `template_id`。标识区分大小写，不得猜测、裁剪、改写、做 Unicode 归一化或使用 `description` 代替。模板 `tools` 不要求是父会话活动工具的子集；若目录返回 `[]`，不得调用 `spawn_agent`；非空目录不替代本次创建预检。

创建顺序为：静态模板/能力预检，原子预留与登记，进程树监督绑定，子进程启动，父子监督握手与首个快照，无副作用 Pi RPC 请求/响应，最后进入 `idle`。成功最小结果：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "资料代理",
    "template_id": "researcher",
    "depth": 1,
    "state": "idle"
  }
}
```

启动或协议失败返回 `spawn_failed`，启动期限内未就绪返回 `spawn_timeout`。返回前必须确认残余资源回收并释放名额；若无法确认，则顶层改为 `termination_incomplete`，节点保持 `terminating`，安全详情保留原始启动错误和诊断 `agent_id`。

### 6.6 `send_message`

**REQ-026**：输入字段闭集只包含直接子代理 `agent_id` 和非空 `message`：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "请核对实现"
}
```

实现必须校验文本和字段闭集；`images` 或其他额外载荷返回 `invalid_argument`。节点在单写者 mailbox 中立即分配不可复用的 `message_id` 和稳定 UUID v4 `task_id` 并接纳正文：没有当前任务时建立新 task；中断栅栏前的后续消息归入当前 task；栅栏后的消息归入唯一后继 task。该接纳点不等待 Pi、模型、task assignment ACK 或任务完成。

监督器随后按序取出 mailbox 项：先通过父子监督通道发布 `{ message_id, task_id, mode }` assignment 并等待 transport ACK，再依据该任务是否已经 host-started 选择纯文本 Pi `prompt` 或 `steer`。状态观察、assignment、Pi command、生命周期和 reply 必须在同一 reducer 顺序域线性化，不得在顺序域外旁路写入 RPC transport。

```json
{
  "ok": true,
  "data": {
    "message_id": "650e8400-e29b-41d4-a716-446655440010",
    "task_id": "450e8400-e29b-41d4-a716-446655440011",
    "accepted": true
  }
}
```

`accepted: true` 只证明插件 mailbox 接纳，不表示 Pi 或模型已经读取。assignment 或 Pi command 随后 rejection/EOF 时不得倒写工具结果、不得自动重发，而应将节点投影为粘性的 `suspended/delivery_uncertain`；后续 lifecycle 不得静默清除该屏障，调用者需结合状态和 reply 人工裁决。`failed`、`terminating`、`terminated` 返回 `agent_unavailable`；`suspended` 可继续保守接纳到 mailbox，但不自动投递或恢复。

父会话向下发送的任务消息与子代理向上 reply 是两条独立语义；mailbox accepted、三类队列变化、raw settlement 或 timeout 都不得被误当成已经收到业务结果。

### 6.6.1 `reply_to_parent`

**REQ-055**：每个子运行时必须注册 `reply_to_parent`，根运行时不得注册。输入字段闭集只允许非空 `message`：

```json
{ "message": "需要父代理裁决：现有接口契约与任务要求冲突。" }
```

正文不得超过监督通道字符串上限。工具不接受 `agent_id`、目标路径、唤醒开关、图片、回复类别、序号或完成标记；目标由已认证的直接父子监督关系唯一绑定。每条成功接纳的 message 固定以 `deliverAs: "steer"` 和 `triggerTurn: true` 进入直接父会话，并可解除一次包含该节点的 wait。成功表示直接父会话已经接纳并 ACK：

```json
{ "ok": true, "data": { "accepted": true } }
```

成功不会停止、settle、中断或另起当前子代理处理；模型必须继续原任务。仅当任务在最终答复前遇到必须由直接父代理处理或裁决的阻塞问题，或者直接父代理已明确要求过程回报时才能调用；不得用于常规进度、心跳、阶段性总结、完成通知或替代最终答复。最终答复由运行时自动提交。监督通道或父会话无法确认接纳时返回 `message_delivery_failed`，不得泄露正文或底层传输错误。

### 6.7 `wait_agent`

**REQ-027**：输入字段闭集为非空 `agent_ids` 数组和可选 `timeout_ms`。`agent_ids` 包含 `1..64` 个 canonical UUID，重复项按首次出现顺序忽略；所有目标都必须是调用者的直接子代理。`timeout_ms` 必须在 `10000..600000` 毫秒；省略时使用根解析的 `waitTimeoutMs`。一次调用为所有目标建立一个观察窗口，不改变节点或工作。

控制器必须采用“检查全部目标、登记一个 waiter 到全部目标反向索引、再次检查”的原子流程。工作中回复、final commit、suspension 或 terminal 的第一个已提交事件结算 waiter，并从其余目标索引同步移除；多个等待者仍可由同一事件完成。完成边界不是 raw `agent_settled`。有获胜目标时返回示例：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "outcome": "task_completed",
    "state": "idle",
    "revision": 12,
    "last_task": {
      "task_id": "450e8400-e29b-41d4-a716-446655440011",
      "turn_id": "550e8400-e29b-41d4-a716-446655440012",
      "commit_id": "750e8400-e29b-41d4-a716-446655440013",
      "outcome": "completed",
      "output_state": "present"
    }
  }
}
```

`outcome` 的节点事件值只有：

- `reply`：直接子代理工作中回复已被父会话接纳；只结束本次等待，子代理通常仍继续处理；
- `task_completed`：节点为 `idle`，最近任务以 completed final 提交；新建后尚无任务的严格 idle 也使用该 outcome，但省略 `last_task`；
- `task_failed`：最近任务以 failed final 提交；节点可以仍为健康 `idle`；
- `task_interrupted`：最近任务以 interrupted final 提交；节点可以继续复用；
- `suspended`：节点交付或维护恢复不可确认；返回 activity 供调用者裁决；
- `terminal`：调用时已经或等待中进入 `failed`/`terminated`；`failed` 必须附 `data.error`。

观察期限先到时没有获胜节点，返回完整去重目标集合，不附加 `state` 或 `revision`：

```json
{
  "ok": true,
  "data": {
    "agent_ids": [
      "550e8400-e29b-41d4-a716-446655440000",
      "650e8400-e29b-41d4-a716-446655440000"
    ],
    "outcome": "timeout"
  }
}
```

工具固定使用 `executionMode: "parallel"`。Pi provider adapter 已将供应商调用归一化为最终 assistant message 中的 `{ type: "toolCall", id, name, arguments }`；插件不得解析供应商原始协议。同一最终 assistant session entry 是一个工具批次，其 entry ID 为批次键，`toolCallId` 为调用键。同批次存在多个 schema 合法的 `wait_agent` 时，插件必须：

1. 分别校验每个调用的直接子代理权限；语义非法调用独立失败，不污染合法 sibling；
2. 合并合法目标并只启动一个控制器 waiter；共享期限取各合法调用解析后期限的最小值；
3. 任一目标产生节点事件后，让包含获胜 `agent_id` 的调用返回真实节点结果；其他调用返回：

```json
{
  "ok": true,
  "data": {
    "agent_ids": ["650e8400-e29b-41d4-a716-446655440000"],
    "outcome": "batch_released",
    "released_by_agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "released_by_outcome": "reply"
  }
}
```

4. 共享期限先到时让所有合法 sibling 返回同一联合 `timeout`，不得继续累计后续调用的期限；
5. 在后续 sibling 被 Pi 顺序执行时读取已缓存结果立即返回，并在 `turn_end`、abort、reload 或 shutdown 后清理批次状态。

`batch_released` 只表示同一工具批次已由其他目标事件解除，不伪造调用目标的生命周期变化。无法从当前 session branch 唯一确认 assistant entry、批次内出现重复 `toolCallId`，或持久化参数与实际执行参数不一致时，只能退化为当前调用的独立多目标等待；不得使用时间窗口或全局任意回复唤醒。

结束原因与返回快照分开线性化，因此可以出现 `reply + working`，任务级 outcome 则必须对应已提交 `last_task` 和严格 idle。工作中回复通知、任务 commit、suspension、terminal 与 timeout 由先提交者决定唯一结果；回复/final 正文已作为独立父会话消息注入，wait 结果不得复制正文。

### 6.8 `interrupt_agent`

**REQ-028**：中断是保留节点和上下文的协作式操作。对有当前任务的 `working` 节点，接纳时必须先在 mailbox 建立不可逆 interrupt 栅栏，丢弃尚未完成宿主接纳的当前任务投递，再异步发送 RPC `abort`、转为 `interrupting` 并返回：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "accepted": true,
    "changed": true,
    "state": "interrupting"
  }
}
```

不得等待 abort 响应或 raw settlement，不追溯撤回 Pi 已接受的 steering，不终止后代或释放名额。栅栏后的新消息分配给后继 `task_id`，只有当前 interrupted final 提交后才能作为新 prompt 交付；当前任务的 raw settlement 也不能直接回到 `idle`。长期不形成 final 时保持 `interrupting`，调用者需显式终止。

对 `idle`、`interrupting`、`suspended`、`failed`、`terminating`、`terminated` 幂等成功，`changed:false` 并返回准确状态；`starting` 返回 `agent_unavailable`。abort 交付使 RPC/监督状态不可可信时节点进入 `failed`，不能伪造 interrupted commit。

### 6.9 `terminate_agent`

**REQ-029**：终止必须永久、不可逆并始终递归覆盖目标及全部已登记后代；不接受 `cascade` 开关或单节点模式。调用者只能终止直接子代理，根关闭流程只能从根的直接子树开始。

接纳时必须在一个树线性化点固定目标子树、原子建立所有节点终止屏障并置为 `terminating`，取消尚未写入 RPC 的普通命令，拒绝新消息、创建和普通控制；屏障前已登记后代纳入级联，屏障后创建被拒绝。已经被 Pi 接受的消息不追溯撤回。

工具是同步的：只有目标及整个子树资源确认后才成功：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "state": "terminated",
    "changed": true,
    "forced": true,
    "terminated_count": 4
  }
}
```

`forced` 表示共享流程是否使用强制阶段；`terminated_count` 是本次共享流程实际新进入 `terminated` 的节点数，纯幂等调用为 0。优雅失败但强制回收成功仍是成功。无法确认全部资源时返回可重试 `termination_incomplete`；已确认节点先终止并释放名额，未确认节点继续 `terminating`，父节点必须等待全部后代。同一目标并发或重复终止合并到同一流程，只推进未完成部分。

### 6.10 状态与树查询

**REQ-030**：`get_agent_status` 只接受一个直接子代理 `agent_id`，必须立即返回最近确认的安全快照，不触发 RPC、不等待、不改变状态。字段至少包含 `agent_id`、`name`、`template_id`、`depth`、`state`、`mailbox_pending_count`、`host_pending_count`、`reply_outbox_pending_count`、`revision` 和适用的生命周期时间；活动节点可包含 `activity`，已提交任务可包含 `last_task`。故障节点查询仍为 `ok:true`，在 `data.error` 提供当前稳定故障；健康或已成功终止节点省略错误。

**REQ-031**：`get_agent_tree` 不接受目标参数，必须按调用者自动裁剪并返回一个 `tree_revision` 的完整扁平快照：

- 根作用域为 `{ "kind": "root" }`，可见整棵树；根不伪装成节点，根直接子代理的 `parent_agent_id` 为 `null`；
- 普通父作用域为 `{ "kind": "subtree", "agent_id": "550e8400-e29b-41d4-a716-446655440000" }`，包含该父会话作为隐式作用域根及其后代，隐藏真实祖先；
- 节点按父先、稳定创建顺序排列，深度仍是全局深度；
- 查询不扩大控制权限，不暴露增量、游标、协议序号、消息/回复正文、图片、路径、环境、句柄或端点。

最小外壳：

```json
{
  "ok": true,
  "data": {
    "scope": { "kind": "root" },
    "tree_revision": 42,
    "nodes": []
  }
}
```

### 6.11 稳定错误码

**REQ-032**：公开工具错误码是以下闭合集合：

| 错误码 | 含义 | 重试语义 |
| --- | --- | --- |
| `invalid_argument` | 参数缺失、类型、范围、长度或额外字段无效 | 修正参数前不可重试 |
| `agent_not_found` | 标识不在当前根注册表或属于其他根 | 不可重试 |
| `not_direct_child` | 节点存在但不是调用者直接子代理 | 不可重试 |
| `template_not_found` | 当前可信来源没有选中候选 | 不可重试 |
| `template_invalid` | 选中模板存在但格式或已知字段无效 | 修正模板后再调用 |
| `template_capability_unavailable` | 模板合法但父授权、模型或 thinking 静态不满足 | 更换模板或父配置后再调用 |
| `max_depth_reached` | 调用者达到深度上限 | 不可重试 |
| `max_children_reached` | 直接子代理名额已满 | 完成直接子代理回收后可重试 |
| `max_tree_agents_reached` | 全树名额已满 | 任一节点完成回收后可重试 |
| `spawn_failed` | 启动、提前退出、握手、RPC 或协议失败 | 按安全详情判断 |
| `spawn_timeout` | 启动期限内未进入可通信 `idle` | 可重试 |
| `agent_unavailable` | 节点当前状态不接受操作 | 不可对当前状态重试 |
| `message_delivery_failed` | 工作中回复或 final 的监督/父会话接纳无法确认 | 不得盲目重发；先查询任务状态 |
| `termination_incomplete` | 强制阶段后仍无法确认全部资源退出 | 可幂等重试终止 |
| `internal_error` | 无法归类的控制器内部异常 | 由实例决定 |

不得新增 `template_not_allowed`、配置文件错误、协议阶段、kill 阶段或 cleanup 阶段专用公开码。`host_capability_unavailable` 仅是扩展激活 UI 诊断。

## 7. 父子任务与监督协议

### 7.1 两条逻辑平面

**REQ-033**：每条直接父子关系必须有两个相互隔离的平面：

1. **Pi 任务通道**：监督器独占子进程 RPC stdin/stdout；承载 prompt/steer、abort、Pi 状态事件和原始 assistant 生命周期输出。
2. **父子监督通道**：独立本地双向可靠字节流；承载握手、生命周期、完整子树快照、task assignment/start、结构化 reply、逐跳控制、child 发起的直接边压缩请求、parent 业务响应、累计 ACK、重同步和关闭通知。

Unix 使用本地 Unix socket，Windows 使用命名管道。上层必须用带长度边界的 UTF-8 JSON 帧，不能依赖换行、模型文本、Pi 日志或 `entry_appended` 分帧。控制帧不得成为模型工具、prompt、会话条目或模型上下文。

规范帧外壳：

```json
{
  "protocol": "pi-subagent/10",
  "kind": "hello|hello_ack|event|snapshot_request|snapshot|reply|task_assignment|task_started|control_request|control_response|compaction_prepare|compaction_prepared|compaction_complete|compaction_completed|ack|close",
  "stream_id": "stream_...",
  "sender_agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "target_agent_id": "550e8400-e29b-41d4-a716-446655440001",
  "seq": 17,
  "request_id": "req_...",
  "payload": {}
}
```

协议主版本不匹配、未知 kind 或必填字段类型错误是协议故障；同主版本未知可选字段忽略。根发送者使用保留空 `sender_agent_id`，不伪装成代理。接收方必须核对根关联、直接父子身份、目标、深度和当前流。

### 7.2 握手与子树快照

**REQ-034**：每次通道建立生成随机 `stream_id`；单向 `seq` 从 1 单调递增且不复用；`request_id` 在当前根会话内不复用。握手必须验证协议版本、一次性本地连接凭据、根关联、子 `agent_id`、直接父标识、深度和初始完整快照。

每个子控制器只报告以自身为作用域根的完整子树，并维护单调 `subtree_revision`。快照节点复用安全树字段，不能包含 prompt、回复正文、工具参数/结果、路径、环境、端点、句柄或堆栈。父控制器必须完整校验作用域、父关系、深度和重复身份；失败时不得部分应用。

只有 `subtree_revision` 大于父侧已接受值时才替换该直接子树缓存；相等或更小视为重复/迟到但仍确认传输序号。替换与公开 `tree_revision` 分配必须在同一临界区，观察者不得看到混合新旧子树。`spawn_agent` 只有在监督握手、首个快照和 Pi RPC 就绪都成功后进入 `idle`。

### 7.3 顺序、ACK 与重同步

**REQ-035**：接收方按当前 `stream_id` 维护最高连续 `last_seq`：

| 收到 seq | 行为 |
| --- | --- |
| `last_seq + 1` | 校验并应用，更新水位，ACK 已应用最高连续序号 |
| `<= last_seq` | 重复或迟到，不重复应用，回当前 ACK |
| `> last_seq + 1` | 不应用，发一次 `snapshot_request`，等待最新完整快照 |

断序不等待无界历史补齐。当前流可用时，发送方对挂起 request 返回带相同 `request_id` 和 `reset:true` 的完整快照，接收方用该帧建立新连续水位；通道断开或请求无法确认时，只在启动或尚未判定故障的有限重同步窗口内使用新 `stream_id` 从 seq 1 重新握手。运行期协议/通道故障一旦被裁决为 `failed`，不得重连恢复生命周期。终止屏障后拒绝新流，旧流帧全部丢弃。

重同步期间可保留最后安全快照供只读 UI，但不得把它当成最新健康事实。请求超期、身份不符、快照非法或 EOF 时，节点按终止屏障进入 `failed` 或继续 `terminating`；缓存后代不能静默消失，必须进入防孤儿清理。

一次 receive transaction 内，协议状态机生成的 ACK、重同步或握手 outbound 必须先进入唯一写队列，之后才能释放 listener 同步重入发布的应用帧。不得出现低 `seq` 协议 ACK 尚未入队、较高 `seq` control/reply 已先写出的序列缺口；Stream 和 Managed RPC 适配器必须实现相同排序语义。

### 7.4 分类回复与最终提交屏障

**REQ-036**：直接父子监督 `reply` 必须携带独立单调 `reply_seq` 和经过统一 codec 校验的第 4 版结构化 envelope。所有 reply 都要求 `agent_id`、`task_id` 和 `turn_id`；message 另要求有界非空 `text`，final 另要求唯一 `commit_id`、`run_state` 和 `output_state`。message 不接受唤醒开关并固定触发直接父代理；`present` 必须有文本，`absent` 不得伪造说明性正文，`images` 显式拒绝。

父端必须在每条正文 Pi command 前发布并等待 transport ACK 的 `task_assignment { message_id, task_id, mode }`。child 消费 assignment 后，每次实际 `agent_start` 生成新 `turn_id`，发布 `task_started { task_id, turn_id }` 并等待累计 ACK；该 turn 的 message/final 不得越过这一身份事实。

子运行时只有两条 reply 入口：

1. `reply_to_parent` 显式发布 message，与当前 task/turn 绑定；它不会结束处理；
2. raw `agent_settled` 只在 mailbox 建立 provisional settlement，并让 handler 立即返回；协调器在 callback 外经过短隔离窗口创建 final、分配 `commit_id` 并等待 ACK。`message_end` 只更新最近安全文本候选，图片块、工具调用、空消息和原始错误不进入正文。

final 到达父端后先 prepare。仅当 task/turn 匹配、provisional settlement 可提交、压缩未活动、当前任务 mailbox 已排空且父会话成功接纳 final 时，`commit_id` 才从 prepared 单调推进到 accepted；随后记录 `last_task`、发送 reply ACK 并在真正静止时进入 `idle`。final 先到时监督通道保留并在 settlement 或 `task_started` 后重试；settlement 先到时保持 `working/finalizing`。任一单独事实都不得制造完成。

Pi 原生自动压缩发生在 `agent_end` 与最终的单次 `agent_settled` 之间。threshold 压缩可以保留已完成的 assistant candidate；overflow 且 `willRetry:true` 必须撤销旧 candidate，并等待下一次真实 `agent_start` 建立新 turn。压缩结束后只以真实 `agent_start` 或 `agent_settled` 决定 mailbox 使用公开 `steer()` 或 `prompt()`，在两者出现前保持 `working/reconciling`。不得为原生 threshold/overflow 发布监督 continuation 恢复帧、使用固定延迟、读取状态后再命令或依赖私有 Pi RPC。自动压缩失败进入粘性的 `suspended/maintenance_failed`。

用户人工 `/compact` 仍只属于根会话宿主生命周期。可选自动压缩扩展通过 `wj-pi-auto-compact/coordination/v1` 触发 managed child 的 manual 压缩时，child 只有在当前会话本地 reply/final 入口、自身上行 reply/final outbox 和唯一直接父边全部 prepared 后才接纳 `manual`；未经协调的 child manual 是协议故障。协调层不拥有压缩实现或 continuation；只有发起压缩的本机会话可以在物理压缩成功且全部 complete 业务确认后发送一次 continuation。协作式中断产生的 interrupted final 与压缩结果保持分层，桥接层仍须严格规范化 Pi 公共压缩原因闭集。

### 7.5 会话本地直接边压缩协调

本节定义的可选协调边界只覆盖当前会话和唯一直接父子消息边，不递归冻结 descendant，也不固定整棵子树成员。根、父、child、孙节点与 sibling 会话可以并行压缩，压缩期间创建的新 child 不加入既有事务。

child 只能向直接 parent 发送 `compaction_prepare` 和 `compaction_complete`，parent 只能返回 `compaction_prepared` 和 `compaction_completed`。parent 收到 prepare 后必须先同步为目标 child 安装下行 mailbox 令牌和上行 reply/final 令牌，再等待线性化点前工作静止。prepared 至少要求 mailbox 没有 in-flight 交付、`host_pending_count === 0`、没有等待中的 prompt start，并且不存在 `delivery_uncertain` 或 `maintenance_failed`；Pi `queue_update.pendingMessageCount` 和 `get_state` 中的同一计数是内部队列事实，`prompt()`/`steer()` RPC 成功本身不是排空证明。屏障后的普通消息可继续被 mailbox 接纳，但必须可靠延迟到全部事务令牌释放；压缩控制帧、业务响应、transport ACK 和 close 不受消息闸门阻塞。

事务标识必须非空且不超过 256 字符；同一直接边允许不同事务令牌叠加，释放一个事务不能释放其他事务。transport ACK 只证明帧送达，只有 prepared/completed 业务响应可以结算 waiter。业务 `false` 是已处理的拒绝，首次超时或异常是送达不确定；complete 不确定时，child 必须在首次 waiter 清理后以独立有限期限补发同事务 `not_started`，补偿获得 `true` 或 `false` 都证明事务闭合，补偿仍无业务响应才废止直接上游通道。通道故障、关闭和 reload 必须释放活动令牌；reload 不转移参与者或活动事务。manual `compaction_start` 一旦消费 prepared 授权，该授权保留到真实 `compaction_end`，即使业务 complete 或补偿通过独立监督流更早到达。

### 7.6 有界状态与安全

父控制器按 `reply_seq` 接纳并累计 ACK；同 seq 同 envelope 重放幂等，同 seq 不同语义是协议故障。每个 turn 的首个已接纳 final 单调生效，同 turn 后续 final 只推进 ACK，不得再次注入或覆盖结果。过期或已作废 task/turn reply 可确认后隔离，不能再次注入；匹配 final 未满足双条件时不能 ACK。message 以 `triggerTurn: true` 注入并通知所有包含该节点的 waiter，final 注入触发父会话处理；wait/status 不复制正文。

**REQ-037**：控制器只能保留每个直接子代理的最新完整快照、当前 task mailbox、最近安全 `last_task`、每个流的序号水位、一个有界待确认快照/reply 窗口、当前快照请求和有界待消费工作中回复通知；不得保存无限事件日志。状态快照可合并，reply 不得静默合并。工作中 message 最多占用 `maxReplyWindow - 1` 个未确认槽位，始终为 final 预留一个槽位；窗口满时暂停非必要快照或请求重同步，不改变公开配额、任务或等待语义。

监督端点只绑定本机 IPC，并使用不可猜测一次性凭据。帧长度、字符串、节点列表和回复载荷必须有代码级固定上限；越界关闭通道并按协议故障处理。凭据、端点、流 ID、序号水位和原始错误不得出现在工具、UI 或模型上下文。

## 8. 控制器、监督器与资源清理

### 8.1 模块责任

**REQ-038**：实现必须采用“由受管 RPC 节点承载 Pi 公共 `RpcClient`，由扩展补充监督器”的结构，不修改 Pi 核心，也不复制 Pi RPC 协议。受管 RPC 节点必须把平台进程树句柄、桥接进程、Pi `RpcClient` 命令面和退出观察绑定在同一启动事务中；桥接进程不生成 `agent_id`，不是独立子代理。监督器不得分别接收可独立组合的 RPC 客户端和树句柄。至少保留下列深模块边界：

| 模块 | 责任 | 禁止承担 |
| --- | --- | --- |
| `AgentController` | 直接父授权、工具裁决、等待通知和公开结果装配 | 直接递归 PID、推断 Pi 是否读取消息 |
| `AgentTaskMailbox` | 单节点 task/message 身份、三类队列、interrupt 栅栏、压缩、直接边事务令牌、provisional settlement、final commit 与原子安全投影 | 父会话注入、平台资源清理、全树授权 |
| `ManagedRpcNode` | 在平台树内启动受管桥接进程，桥接进程独占公共 `RpcClient`，提供高层命令、事件、故障和资源操作 | 复制 Pi JSONL、裁决整树所有权 |
| `RpcSupervisor` | 驱动 mailbox、assignment/Pi command 顺序、事件归一化、目标 child 直接边 prepare/complete、启动/关闭和节点级资源协调 | 拼接独立进程与客户端、递归冻结 descendant、自动重试不确定交付 |
| `ProcessTreeAdapter` | 为 `ManagedRpcNode` 在目标进程运行前建立平台树归属，并提供不透明句柄的优雅请求、强制整树回收、退出观察和释放 | 修改生命周期或配额、暴露 PID |
| `SupervisorChannel` | 直接父子帧、握手、累计 ACK、assignment/start、快照、reply、单向角色压缩请求/响应、控制路由和关闭；协议 outbound 优先于 listener 重入发送 | 注入模型、parent 发起压缩请求或越级通信 |
| `TreeController` | 所有权、配额、任务投影应用、树合并、`tree_revision` 和安全 UI 快照 | 直接访问 RPC、PID、socket 或管道 |

模型工具不得直接调用平台适配器；树视图不得发送 RPC；子控制器不得直接访问祖先控制器；`RpcSupervisor` 之外不得直接调用 `ManagedRpcNode` 的状态变更接口。

### 8.2 启动事务

**REQ-039**：单节点启动必须按可回滚阶段执行：

1. 原子预留直接和全树名额，分配身份，登记 `starting`；
2. 创建本地监督端点和一次性凭据，准备固定 cwd、根环境快照、模板结果及内部元数据；
3. 由 `ProcessTreeAdapter` 在目标进程运行前启动受管桥接进程并建立 Job Object 或 process group/session 归属；
4. 桥接进程内部创建公共 Pi `RpcClient`，其 RPC 子进程继承同一平台树；受管节点只通过高层桥接协议转发命令、事件和故障，不复制 Pi JSONL；
5. 完成监督协议身份、版本和初始快照校验，并通过受管节点发出无副作用状态请求；
6. 双通道就绪后记录创建成功的单调时间，进入 `idle` 并返回。

bridge 启动响应可以等待 child `session_start` 和无副作用状态屏障，而 child `session_start` 又需要完成监督 hello/ACK；因此 `ManagedRpcNode` 一旦已经绑定 bridge，在 `starting` 与 `ready` 阶段都必须允许监督帧双向通过。普通 prompt、steering、abort 和状态查询仍只能在 `ready` 后通过公开命令面调用，不能借此扩大启动期业务 RPC 能力。

任一步失败必须先记录安全故障，再执行终止清理。失败身份不复用。

### 8.3 单节点命令顺序

**REQ-040**：每个 `ManagedRpcNode` 必须是桥接协议和 Pi RPC transport 的唯一拥有者；每个 `RpcSupervisor` 通过一个 `AgentTaskMailbox` 形成单写者顺序域，协调 submit、task assignment、prompt/steer、abort、Pi 生命周期、压缩、reply/ACK、优雅关闭和强制清理。mailbox 接纳可先于异步 Pi command；只读查询、事件观察和多个等待者可并行，不同节点可并行。

终止屏障优先级最高：取消尚未 host-accepted 的普通投递，拒绝新 submit/创建/控制，并用状态代际丢弃迟到响应；并发终止合并。interrupt 是次级栅栏：当前 task 不再取得新投递，栅栏后消息进入 successor task。

监督器必须归一化 `agent_start`、raw `agent_settled`、`compaction_start/end`、queue update、安全工具活动和 EOF/协议故障。assistant `message_end` 只更新 child 最近安全候选；`agent_end` 只关联迟到 settled 与当前 turn；abort 响应、raw settlement 和局部完成都不得单独提交 final、进入 idle 或确认资源。直接边 prepare 必须同步安装令牌后异步等待既有下行工作与 Pi 队列静止；等待操作主动与状态变化/取消竞速，不能假设下层遵守 `AbortSignal`。通道 fault、关闭或依赖注销必须释放该边全部事务令牌。

### 8.4 终止与资源确认

**REQ-041**：终止流程使用独立内部清理期限，不复用 `wait_agent.timeout_ms`，不允许调用者扩大为无限等待。阶段固定为：

1. 先在控制器建立目标子树终止屏障；
2. 子控制器向下为后代建立屏障并停止接单；
3. 对活动 Pi 会话发送 abort，但不把响应当成 settle 或回收；
4. 取消尚未写入命令，发送 stdin EOF 或等价优雅关闭；
5. 等待后代、进程和监督端点在内部优雅期限内退出；
6. 期限到达后调用平台适配器强制回收整树；
7. 重新观察进程、IPC、本节点和全部后代；只有全部确认退出才发布 `terminated`。

`ProcessTreeAdapter` 必须提供启动和回收职责；生产路径不得用 `attach` 把一个已经由其他模块启动的进程事后拼入树。等价接口如下：

```ts
interface ManagedProcessTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

interface ProcessTreeAdapter {
  launch(processSpec): Promise<{ tree: ProcessTreeHandle; transport: ManagedProcessTransport }>;
  requestGracefulClose(tree, signal): Promise<void>;
  forceTerminate(tree): Promise<void>;
  waitForExit(tree, deadline): Promise<ExitObservation>;
  inspect(tree): Promise<ResourceObservation>;
  release(tree): Promise<void>;
}
```

观察结果必须区分“确认退出”“仍存在”“无法确认”。成功发送信号、收到 EOF 或直接进程退出都不能单独构成资源确认。

### 8.5 平台回收与故障

**REQ-042**：Windows 子进程必须在启动时纳入节点专用 Job Object；Unix 子进程必须在专用 process group/session 中。强制阶段针对整棵 OS 进程树，不能只调用直接子进程 `kill`，不能由领域控制器读取 PID 并自行递归枚举。PID 递归只能作内部诊断或补救，不能据此伪造安全回收。

**REQ-043**：故障语义必须满足：

- 启动失败走 `starting -> failed -> terminating -> terminated`；清理不完整时停在 `terminating` 并返回 `termination_incomplete`；
- 运行期进程退出、一般 RPC EOF、非法事件、身份篡改、序号/快照无法重同步在屏障前进入稳定 `failed`，不自动重启或恢复；
- 已 mailbox-accepted 消息的 Pi command rejection/EOF 若只影响该次交付证明，进入粘性的 `suspended/delivery_uncertain`；原生自动压缩失败进入粘性的 `suspended/maintenance_failed`；child 侧未经协调的 `manual` 压缩事件属于协议故障；
- final 构造或 ACK 永久失败使 child reply 协调器进入 terminal failure，并通过监督故障让祖先节点失败关闭，不能伪造 `last_task`；
- 中间父节点故障时先保留 `failed`，立即对其已登记后代建立防孤儿屏障；故障父节点继续占名额，直到直接父显式终止并确认子树回收；
- 部分级联失败时已确认节点先 `terminated`，兄弟继续清理，未确认节点和父节点保持 `terminating`；
- 根退出、`new`、`resume`、`fork` 或 runtime 真正关闭时自动清理全部直接子树；内部期限超期只产生 UI-only 错误并允许根流程退出，不无限阻塞、不提前释放未确认名额；
- 成功 reload 保留树，reload 激活失败按 REQ-017 清理。

实现必须注入 `FakeRpcClient`、`FakeProcessTreeAdapter` 和 `FakeSupervisorChannel`，用于确定性复现 mailbox submit、assignment/start ACK、公开 prompt/steering、prompt-start 屏障、interrupt 栅栏、raw settlement/final commit、threshold 候选保留、overflow 重试候选撤销、未协调 child manual 拒绝、协调 manual 的 complete/start/end 跨流重排、直接边叠加令牌与排空、重入出站顺序、孙进程残留、部分回收、重复/断序帧、reload、EOF 和协议损坏。

## 9. 可观测性与 UI

### 9.1 常驻 `Agents` widget

**REQ-044**：Pi TUI 必须提供只读常驻 `Agents` widget，并且只显示当前会话的直接子代理：根显示根直接子代理，普通父会话显示自身直接子代理。不得显示祖先、兄弟或越级后代，不提供发送、中断、终止或重载按钮。

活动行按稳定顺序显示并按行宽安全截断：

1. `template_id`，不是泛化 `Agent` 标签；
2. `spawn_agent.name`；
3. 生命周期状态；
4. 可选安全 `activity.phase`、当前任务和粗粒度工具摘要；
5. 创建成功后的生命周期总时长；
6. 非零的 mailbox/host/reply outbox 三类队列计数；
7. `suspended` 的稳定 phase，或 `failed`/`termination_incomplete` 的稳定故障码。

不得显示 token/费用、完整 prompt、assistant 正文、工具参数/结果、路径、环境、句柄、堆栈或模型推理。

### 9.2 `/agent` 遮罩面板

**REQ-045**：唯一正式树查看命令是单数 `/agent`。它打开只读 TUI 遮罩，不把命令或面板内容提交给模型：

- 根查看整棵树；普通父会话查看自身子树；
- 初始读取一致 `tree_revision`，随后实时跟随新修订；
- 默认展开作用域直接子代理、折叠后代；
- 支持上下滚动、左右展开/折叠和 `Esc` 关闭；
- 折叠分支显示后代总数、working、suspended、failed 和三类队列汇总；
- 活动/故障分支优先可见，纯 idle 分支可折叠但不能静默消失；
- `terminated` 记录进入默认折叠 `finished` 区域，显示完成、失败终止和未完成清理数量；
- 面板保持用户展开集合和滚动位置；新修订不能强制回顶。

渲染内部错误时必须显示 UI 错误状态，不得伪造完整树。作用域根失效时关闭面板。

### 9.3 生命周期时间和状态反馈

**REQ-046**：生命周期计时从 `spawn_agent` 完成监督/RPC 双握手、节点进入 `idle` 并成功返回的线性化点开始，使用单调时钟。`starting` 不显示正常时长；`idle`、`working`、`interrupting`、`suspended`、`terminating` 累计；`failed`/`terminated` 冻结。它不是单个 task、prompt 或工具耗时。

UI 只消费控制器原子任务投影，不按逐 token 刷新：mailbox 接纳显示 working 和 mailbox 计数；assignment/Pi command 接纳移动到 host 计数；工具与压缩事件更新安全 phase；raw settlement 显示 finalizing；final prepare 显示 reply outbox；commit 后更新 last_task 并仅在全静止时 idle；中断、suspension、终止和故障使用各自稳定状态。一次级联变化必须按单一 `tree_revision` 原子刷新。

### 9.4 UI-only 与脱敏

**REQ-047**：正常状态变化只更新 widget/面板。节点进入 `failed` 或出现 `termination_incomplete` 时，当前可见作用域控制器按同批变化聚合一次 `ctx.ui.notify`：运行故障用 warning，清理不完整用 error；只含模板标识、数量和稳定错误码。

模板诊断、配置诊断、宿主兼容诊断、故障通知、widget、`/agent`、树修订和协议诊断都必须是 UI-only/控制器数据，不创建 user/assistant 消息、会话条目或系统提示，不进入模型上下文。不得使用 `sendMessage`、`sendUserMessage` 或 prompt 替代 UI API。RPC 宿主可消费独立 UI request；print/JSON 等无 UI 模式保持无可见回退。

安全活动摘要只能由已确认工具边界映射成短类别和计数，例如 `editing 2 files`；不得从原始正文、路径、参数、结果或堆栈摘要生成可能泄密的文本。

## 10. 开发阶段验收

### 10.1 判定范围

**REQ-048**：当前开发交付只要求 Windows 原生 runner 通过；macOS/Linux 原生 runner、真实进程树回收证据和跨平台支持结论延期到独立计划。Windows runner 缺失或任一 Windows 必测场景失败，都表示本里程碑未完成；mock 不能替代 Windows Job Object 的原生回收。CPU 架构不单列矩阵，以 runner 可运行兼容 Node/Pi 的架构为准。

Windows 执行两个锁定宿主组合：

1. 最低组合：Node `22.19.0` + Pi `0.84.1`；
2. 当前组合：验收执行时最新稳定 Pi + 该 Pi 支持的当前 Node Active LTS。

当前组合在 CI 开始时解析后必须立即锁定，并在验收证据中记录精确版本。不做最低/当前全排列。低于最低或不可解析 Pi、缺失必需 API和不支持平台可以集中做负向契约测试，不要求三平台重复。nightly、未发布 Pi commit 和 Node Current 不属于首版开发门槛。

### 10.2 测试层级

**REQ-049**：实现必须提供以下五层自动化测试，且不依赖外部模型网络、API key 或人工交互：

1. **纯逻辑测试**：mailbox reducer、任务身份、八态、三类队列、final commit、配额、配置、模板、树合并、seq/ACK/重同步与脱敏；使用显式 gate/barrier 和可控时钟覆盖确定性并发交错，不以 sleep 概率复现竞态。
2. **Pi 契约测试**：加载真实扩展入口和 Pi `RpcClient`，验证八个管理工具与子运行时 `reply_to_parent` 的角色可见性/schema、`get_agent_templates` 直接数组例外、其余成功外壳、错误外壳、事件映射、reload 与 UI-only 边界。
3. **原生进程集成测试**：启动真实 `pi --mode rpc --no-session`，使用确定性本地假模型/提供者，验证创建、steering、中断、故障和整树回收。
4. **TUI 交互测试**：验证直接子代理 widget、`/agent` 遮罩、滚动/展开/关闭、稳定尺寸和 UI-only 通知。
5. **本地 package 测试**：验证本地包目录或本地构建包的 manifest、生产依赖、临时加载和隔离的本地持久安装形态。

五层自动化当前都在 Windows runner 执行。平台无关逻辑和 Unix 适配代码可以通过 fake、类型检查和条件分支契约测试覆盖；需要 macOS/Linux 内核原语的测试不属于本里程碑通过项，必须留给独立原生验证计划。

现有 throwaway 原型只能作为设计证据，关键断言必须迁入正式测试。人工探索可以补充，但不能替代自动化验收。

### 10.3 核心端到端旅程

**REQ-050**：以下旅程必须在 Windows 乘两个宿主组合的两个 job 中全部执行；macOS/Linux 只保留代码、类型、纯逻辑和 fake 测试，不在本里程碑执行原生旅程：

1. 加载扩展并发现合法模板，根先通过 `get_agent_templates` 获得安全目录、精确复制 `template_id` 再创建 A；只有双握手后才以 `idle` 成功。
2. 向空闲 A 发送任务；工具立即返回 mailbox 分配的 `message_id/task_id`。A 发布 `task_started` 后发送工作中回复，父端 wait 以 `reply + working` 返回；raw settlement 不结束任务，final 经父会话接纳和 commit 后 wait 返回 `task_completed + idle`。
3. A 工作时再次发送，验证同一 task steering；中断后立即发送第三条，验证它获得 successor task，必须在 interrupted final 提交后作为新 prompt。
4. A 查询到与根权威一致的模板目录并创建 A-1 到默认深度 2；A-1 不可见八个管理工具但仍可见 `reply_to_parent`，绕过发现查询返回 `template_capability_unavailable`，绕过发现创建仍返回 `max_depth_reached`。
5. 根能只读看整树但不能越级控制 A-1；A 只能看自身子树并直接控制 A-1；revision、三类队列、activity、last_task 和父关系一致。
6. 创建兄弟节点并行处理，验证不同节点并行、同节点 mailbox 串行。
7. 中断工作节点，验证 raw settlement 后仍非 idle，匹配 interrupted final commit 后返回 `task_interrupted` 并可复用。
8. 覆盖 Pi 原生自动压缩：按 `agent_end -> compaction -> retry start 或单次 settled` 建模；threshold 保留安全候选，overflow `willRetry` 撤销旧候选；只由后续真实 start/settled 选择 steer/prompt，不生成恢复帧；自动压缩失败投影 maintenance_failed，未经协调的 child manual 固定为协议故障。
9. 覆盖可选协调 manual：根与 child、祖先与孙节点、sibling 会话可并行准备；parent 等待在途 prompt/steer 与 Pi pending 队列静止，屏障后消息延迟投递；同边叠加令牌、提前 `not_started`、ACK 不确定补偿、关闭释放，以及业务 complete 先于 Pi manual start/end 到达都必须收敛。
10. 终止 A，验证 A-1 后代优先、整树资源确认、幂等终止和两类名额释放。
11. 成功根 `/reload` 后，根和 A 的模板查询立即看到同一新目录；活动 task/mailbox、未确认 reply、直接边控制响应和 UI 状态保持，`pi-subagent/9` 及更早活动树明确拒绝由 `/10` 热接管。

### 10.4 负向、安全与资源正确性

**REQ-051**：负向矩阵至少必须覆盖：

- 公开闭集中每个工具错误码至少一个场景，核对 `retryable`、安全 details 和无副作用；
- 参数错误（包括 `get_agent_templates` 多余参数和非 canonical UUID 的 `agent_id`）、格式正确但未注册的 UUID、非直接子代理、模板不存在/无效/能力不足、深度/直接/全树配额耗尽；
- 配置不可读、坏 JSON、非法值、未知字段 UI-only 默认回退，以及非法显式根参数拒绝启动；
- 启动超时/提前退出、一般 RPC 断开、mailbox accepted 后 Pi command rejection、delivery uncertainty、中断-final 竞态、suspension、屏障后迟到事件、部分级联失败、中间父故障和根关闭；
- 重复帧、断序、旧 revision、旧/非法 stream、损坏快照、ACK 丢失、reset 快照和回复去重；reply 缺 task/turn/commit、旧 turn final、final 先于 settlement、settlement 先于 final、message/final 混排和 final 槽位预留；
- receive listener 同步发送 control/reply 的确定性交错，证明协议生成低 seq ACK 先入写队列；同一交错覆盖 Stream 与 Managed RPC；
- `agent_end` 后的 threshold/overflow 自动压缩、start/settled 尚未出现、threshold 候选保留、overflow `willRetry` 候选撤销、自动压缩失败、未协调 child manual 拒绝、协调 manual 的本地入口/直接父边、并行会话、Pi 队列排空、叠加令牌、complete 补偿和跨流结束重排、同 turn 重复 final 的 ACK 与跨实例 reload；证明不阻塞 handler、不猜测原生 continuation 所有权、不误提交或覆盖旧 final；
- assistant 思考、工具前说明、工具调用、参数、结果、错误和中止内容不能泄漏到父会话；重复/stale settlement 不得重复 final commit；
- 模板目录为空时直接返回 `[]`，无效候选和来源诊断不枚举，非空项字段闭合且不泄露运行配置，模板业务 `tools` 不混入八个管理工具或 `reply_to_parent`；
- 未信任项目资源不加载、模板不能扩权、叶节点不能绕过管理能力和深度、根不能越级控制；
- cwd 外路径仍按 Pi 正常工具能力处理，证明扩展没有误实现 cwd 沙箱；
- 以秘密 canary 注入 prompt、路径、环境、工具参数/结果、连接凭据和堆栈，证明 widget、`/agent`、状态/树、错误、UI 通知、监督帧和 UI-only 诊断不泄露，也不进入模型上下文；
- Windows 真实验证显式终止、根关闭和 reload 激活失败后没有存活的被监督后代；macOS/Linux 对应原生场景记为延期，不得以 skip 或 mock 标记为已通过。

配额边界、协议状态有界、资源确认、名额释放和无孤儿是功能/安全正确性，不是性能指标。

### 10.5 本地 package 验收

**REQ-052**：当前开发阶段只验证隔离临时目录中的本地 package：

- Pi manifest 只发现唯一扩展入口；
- `npm install --omit=dev` 或等价生产装配后运行依赖完整；
- Pi `-e` 临时加载、本地用户 scope 持久安装和已信任项目 scope 形态可用；
- 未信任项目不能绕过 project trust；
- 安装/加载不会写入模板目录、`subagent.json` 或非预期设置；
- 测试结束清理所有临时目录、进程、管道/socket 和平台句柄。

当前不要求 npm registry、正式 tarball、release tag/commit 对应、签名或发布报告。

### 10.6 明确不做性能验收

**REQ-053**：首版开发验收不得设置压力规模、吞吐量、延迟、绝对 RSS/句柄阈值、性能基线或 benchmark 工件；也不要求 10,000 步随机压力、16 个真实节点并发、反复 churn 或 64 个 helper 进程。代码覆盖率可以作为诊断信息，但不设 line coverage 百分比门槛。

### 10.7 开发验收证据

**REQ-054**：开发验收记录至少包含源码 commit、精确 Windows/Node/Pi 版本、执行的 `AC-xxx`、通过/失败结果、资源清理结论和脱敏日志/UI 快照；本里程碑映射到 Windows 的 AC 必须通过。延期的 macOS/Linux 原生场景必须单独列为未执行，不得用 skip、quarantine、mock 或自动重试伪装成通过。失败修复后必须重跑受影响场景。证据不包含 registry、正式发行 hash 或 release tag 证明。

## 11. 验收场景目录

| AC | 场景 | 核心断言 |
| --- | --- | --- |
| `AC-001` | 根树生命周期与所有权 | UUID `agent_id`、临时树、唯一直接父、根只读整树、切换/关闭不持久化 |
| `AC-002` | cwd、环境和 project trust | 固定 cwd；外部路径可按工具访问；环境快照不扩张；trust 只管项目资源 |
| `AC-003` | 原子宿主兼容门禁 | 版本/API/平台缺失时零公开面、UI-only 诊断、宿主继续运行 |
| `AC-004` | 配置优先级 | 根参数、可信项目、用户、默认按字段解析且根值固定 |
| `AC-005` | 配置错误诊断 | 文件/JSON/值错误用默认且不下退；未知字段忽略；非法根参数拒绝 |
| `AC-006` | 模板发现与身份 | 双来源直属 Markdown、project trust、文件名 ID、符号链接、来源故障和安全模板目录数组 |
| `AC-007` | 模板 schema | 空正文、UTF-8 `64 KiB` 正文边界、逗号 tools 规范化、枚举、model/thinking、未知字段静默忽略 |
| `AC-008` | 覆盖、诊断和模板 reload | 无效项目遮蔽用户；诊断 UI-only；根与后代查询 reload 后同一新目录；新快照只影响未来创建 |
| `AC-009` | 创建能力与上下文继承 | 工具缺一即拒绝；精确模型/thinking；prompt mode、contextFiles、资源继承 |
| `AC-010` | 深度、管理工具和配额 | 默认两级；八工具整体隐藏但 child 回复工具保留；祖先 disabled 衰减；查询/创建服务端复核；直接/全树原子预留和回收释放 |
| `AC-011` | 八态、任务投影与 revision | 合法/非法转换、三类队列、activity、last_task、stale task/turn 与修订单调 |
| `AC-012` | 创建成功与失败回滚 | 创建生成 canonical UUID v4；双握手后严格 idle；启动错误/超时；清理完整与不完整两条返回路径 |
| `AC-013` | mailbox、任务、steering 与回复 | accepted 身份、assignment/start、同 task steer、交付不确定、工作中 reply、双条件 final commit |
| `AC-014` | 等待竞态 | 原子登记、多等待者、reply/三类 task/suspended/terminal/timeout 七种 outcome |
| `AC-015` | 协作式中断 | interrupt 栅栏、未交付当前项取消、successor task、interrupted final 后复用 |
| `AC-016` | 终止与部分级联 | 屏障、后代优先、强制回收、幂等合并、partial failure |
| `AC-017` | 状态和树查询 | 直接状态权限、根/子树裁剪、原子 tree revision、安全字段 |
| `AC-018` | 公开错误码闭集 | 非法 UUID 与未注册 UUID 分流；每个错误码、retryable 和无副作用；无额外阶段错误码 |
| `AC-019` | 监督握手和快照 | 身份/版本/凭据、初始快照、subtree replacement、原子根修订 |
| `AC-020` | v10 seq、ACK、重同步与出站屏障 | assignment/start、reply_seq 去重、同 turn 首 final 单调提交、单向角色压缩帧、final 槽位、ACK 失败、listener 重入时协议 outbound 优先 |
| `AC-021` | mailbox 与监督器命令顺序 | 先挂接 OS 树、双通道就绪、接纳/宿主交付分离、终止和中断栅栏、迟到丢弃 |
| `AC-022` | Windows 原生进程树回收 | Windows Job Object、资源确认和孙进程整树回收；Unix 原生部分延期 |
| `AC-023` | 父故障、原生/协调压缩、根关闭与 reload | 防孤儿、真实 lifecycle、threshold/overflow 候选规则、未协调 manual 拒绝、会话本地直接边并行与补偿、粘性 suspension、跨实例保留、失败 reload 清树 |
| `AC-024` | 常驻 widget | 只显示直接子代理、稳定行字段、activity、三类队列、计时、suspension 和故障码 |
| `AC-025` | `/agent` 遮罩 | 作用域、折叠/滚动/展开/Esc、finished、修订保持交互状态 |
| `AC-026` | UI-only 与秘密 canary | 诊断/通知不进上下文，所有公开面不泄露正文和秘密 |
| `AC-027` | 本地 package 形态 | 唯一入口、生产依赖、本地临时/持久 scope、无隐式写入、清理临时资源 |
| `AC-028` | Windows 双组合核心旅程 | Windows 乘最低/当前组合完整执行 REQ-050 |
| `AC-029` | 兼容负向组合 | 低版本、不可解析版本、API 缺失、不支持平台统一失活 |
| `AC-030` | 无性能门槛 | 测试计划和 CI 不含性能/压力/SLO/coverage 百分比阻断项 |
| `AC-031` | 追踪与 Windows 开发证据 | Windows 环境、commit、结果和清理证据完整；延期 Unix 场景单独列出，不以 skip 隐藏 |

## 12. 需求追踪

| 要求 | 来源票据 | 验收场景 |
| --- | --- | --- |
| `REQ-001..003` | 01、02、03、08 | `AC-001`、`AC-023` |
| `REQ-004` | 09 | `AC-027` |
| `REQ-005` | 09 | `AC-003`、`AC-029` |
| `REQ-006` | 08、09、12 | `AC-022`、`AC-028` |
| `REQ-007..008` | 04、13、15 | `AC-002`、`AC-009`、`AC-026` |
| `REQ-009..010` | 02、06 | `AC-004`、`AC-005` |
| `REQ-011..014` | 05、14 | `AC-006`、`AC-007`、`AC-008` |
| `REQ-015..017` | 04、05、09、15 | `AC-008`、`AC-009`、`AC-023` |
| `REQ-018..020` | 02、04、06 | `AC-010`、`AC-012`、`AC-018` |
| `REQ-021..023` | 03 | `AC-011`、`AC-014` |
| `REQ-024` | 02 | `AC-018` |
| `REQ-025` | 02、03、04、12 | `AC-012`、`AC-021` |
| `REQ-026` | 01、02、03、11、12 | `AC-013`、`AC-020` |
| `REQ-027` | 02、03 | `AC-014` |
| `REQ-028` | 02、03、08 | `AC-015` |
| `REQ-029` | 02、03、08、12 | `AC-016`、`AC-022` |
| `REQ-030..031` | 02、03、07、11 | `AC-017`、`AC-026` |
| `REQ-032` | 02、04、06、08 | `AC-018` |
| `REQ-033..037` | 11 | `AC-013`、`AC-019`、`AC-020`、`AC-026` |
| `REQ-038..040` | 12 | `AC-021` |
| `REQ-041..043` | 03、08、12 | `AC-016`、`AC-022`、`AC-023` |
| `REQ-044..047` | 05、07、09、11 | `AC-024`、`AC-025`、`AC-026` |
| `REQ-048..050` | 10 | `AC-028`、`AC-031` |
| `REQ-051` | 10 | `AC-005`、`AC-011..023`、`AC-026`、`AC-029` |
| `REQ-052` | 09、10 | `AC-027` |
| `REQ-053` | 06、10 | `AC-030` |
| `REQ-054` | 10 | `AC-031` |
| `REQ-055` | 11、21 | `AC-013`、`AC-014`、`AC-020`、`AC-026` |

本文没有性能测试或发布执行要求，registry 凭据等发布运营信息属于外部输入。当前运行期产品决策已冻结，平台验收范围则明确分为 Windows 开发里程碑和后续独立的 macOS/Linux 原生验证计划。实现代理应按 REQ 和 AC 直接拆分生产代码与测试；对不改变公开行为的类名、文件布局、内部期限数值、帧/字符串安全上限和日志后端，可以在实现中选择并用测试固定。
