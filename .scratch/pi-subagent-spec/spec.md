# Pi Subagent 独立扩展规格

Status: development-ready
Upstream baseline: `a96fb984d8c8b065fc5d193309fc812a882adee0`
Minimum host: Pi `0.83.0`, Node `22.19.0`

## 0. 文档约定

本文是 Pi Subagent 首版实现的唯一规范性入口。`map.md` 只提供导航；`issues/`、`research/` 和 `prototypes/` 保存决策依据、上游证据和抛弃式验证，不要求实现代理拼接这些文件才能理解行为。

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
- 自动排队并在当前处理结束后作为独立任务执行的后续任务；
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
    "extensions": ["./extensions/pi-subagent.ts"]
  },
  "piSubagent": {
    "requiresPi": ">=0.83.0"
  }
}
```

第三方运行依赖必须放在 `dependencies`，不能只放在 `devDependencies`。扩展实际导入的宿主 Pi 包使用宽 `peerDependencies: "*"`，不得把宿主 Pi 实现打入分发包，也不得依赖 peer 解析充当兼容门禁。包内可以包含入口所需内部模块和静态资源，但只有显式扩展入口由 Pi 加载。

包不得创建、复制或修改代理模板、`subagent.json`、Pi 用户设置或项目设置。模板继续从第 4 节规定的目录发现。

### 2.2 安装来源边界

npm 是未来规范发布渠道，正式版本使用 SemVer；`v<version>` git tag 应指向同版本源码，完整 git commit 可用于固定和复现。可变 branch、未固定 git URL 和浮动 npm 标签不属于可复现安装承诺。本地路径只用于开发与验收。

未来 npm、git tag 和完整 commit 来源都应兼容 Pi 的临时 `-e/--extension` 与持久 `pi install`；持久安装默认是用户 scope，项目 scope 使用 Pi 原生 `-l` 并受 project trust 控制。当前开发交付只验收本地包路径或本地构建包，不要求 registry、正式 tag 或发布报告。

### 2.3 宿主兼容门禁

**REQ-005**：扩展激活必须是全有或全无事务。在注册七个管理工具、`/agent`、widget、监督器或生命周期钩子之前，必须确认：

1. Node 版本满足 `>=22.19.0`；
2. Pi 版本满足 `>=0.83.0`；
3. 当前平台存在可用的 `ProcessTreeAdapter`；
4. Pi 提供实现工具、命令、UI、生命周期和 RPC 监督所需的必需 API；
5. 必需模块和运行依赖可以加载。

任一探针失败时必须失败关闭：不注册任何公开面，不启动监督器或子进程，不做部分工具降级。若 UI 可用，显示安全的 UI-only 诊断和稳定标识 `host_capability_unavailable`；该标识不是公开工具错误码。诊断不得进入会话消息、系统提示或模型上下文；无 UI 模式不得增加 stderr、结构化事件或模型消息回退。宿主 Pi 会话仍可继续使用。

Node 版本低到宿主 Pi 本身无法启动时，由 Node/Pi 既有启动路径负责失败；上述 UI 语义只适用于扩展 factory 已能执行的情况。

### 2.4 支持平台

**REQ-006**：首版支持 Windows、macOS 和 Linux：

- Windows 必须使用基于 Job Object 的进程树适配器；
- macOS/Linux 必须使用 process group 或 session；
- CPU 架构不另设限制，但必须能运行兼容 Node/Pi 和对应适配器；
- 浏览器、移动系统、远程宿主和未验证 Unix 变体不属于首版支持范围。

没有可靠整树适配器的平台必须被兼容门禁拒绝，不得退化为只终止直接子进程，也不得伪造 `terminated`。

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

**REQ-013**：每个模板必须有可解析 YAML frontmatter；Markdown 正文允许为空。已知字段如下：

| 字段 | 类型与默认值 | 规范语义 |
| --- | --- | --- |
| `tools` | 必填 YAML 字符串 | `""` 是唯一合法空工具集；非空值按逗号拆分、裁剪、丢弃空项、按首次顺序去重；规范化后为空无效 |
| `description` | 可选字符串 | 裁剪后只作父代理展示元数据；空值等同无描述 |
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

根必须独立读取和校验所有可信来源候选，包括最终被遮蔽者。有效候选进入有效模板目录；无效候选进入只含逻辑来源、文件名和安全短原因的诊断索引；来源无法枚举形成无 `template_id` 的来源诊断。

没有选中候选时 `spawn_agent` 返回 `template_not_found`；选中候选无效时返回 `template_invalid`；无法归类的控制器故障才返回 `internal_error`。诊断不得保存或展示正文、绝对路径、环境、OS 异常或堆栈。

根首次发现和每次根 `/reload` 后原子发布模板发现快照。存在诊断时只发送一次根 `ctx.ui.notify(..., "warning")` 汇总；没有诊断时不通知。子代理自身 reload 不重建根快照或重复通知。无 UI 模式仍建立同一快照，但不输出替代诊断。

### 4.4 创建预检与上下文继承

**REQ-015**：`spawn_agent` 在预留名额或启动进程前必须完成以下最小静态预检：

1. 精确解析当前模板发现快照；
2. 校验已知 schema 和工具名；
3. 确认直接父会话当前有效业务工具集完整包含模板 `tools`；
4. 精确解析显式或捕获的 provider/model，并校验当前模型目录、根策略和静态认证可用性；
5. 校验 thinking 枚举及当前已知模型支持范围；
6. 校验有效子代理管理能力、深度和名额。

结构或格式问题返回 `template_invalid`。模板合法但工具、模型、认证、thinking 或父授权静态不可满足时返回不可重试的 `template_capability_unavailable`，不得静默削减工具、夹紧 thinking、构造 custom model、预留名额、登记节点或启动进程。

预检不得通过真实模型请求证明最终可用性，也不计算环境、提示、技能、扩展、上下文文件或工具注册表哈希。创建成功只要求监督通道和 Pi RPC 都可通信，不保证运行期资源永不变化。

**REQ-016**：模板和子进程上下文必须遵守：

- 子代理不复制父会话渲染后的系统提示或对话历史；
- `append` 将模板正文追加到项目与角色提示层；`replace` 只替换该层；两者都不能移除安全、所有权、直接父子通信、工具和树控制契约；
- `contextFiles` 只控制固定 `cwd` 祖先链的 `AGENTS.md`/`CLAUDE.md`，每个模板独立决定；父节点禁用不阻止子模板重新启用；
- skills、extensions 和 slash prompt templates 不由模板限制，按固定 `cwd`、统一 project trust、用户资源目录和 Pi 正常发现机制加载；
- prompt template 不自动展开为首条任务；模板也没有 `env` 覆盖。

### 4.5 Reload

**REQ-017**：成功的根 `/reload` 必须原子更新模板发现快照和 Pi 动态业务资源，只影响未来创建；既有节点的模板正文、初始工具请求、模型选择、提示、生命周期和上下文不得回溯改变。运行期业务工具或资源变化不重新执行模板能力预检，不降级、终止或重建节点。

树控制面是例外：reload 后必须按保存的身份、直接父关系、祖先 `subagents` 关闭状态和 `maxDepth` 重新施加七个管理工具的完整可见性。成功 reload 通过控制器交接保留代理树；若新扩展实例未通过宿主兼容门禁，旧控制器必须按终止语义清理全部子代理，不保留旧工具、widget、端点或孤儿进程，也不自动回退旧实例。

## 5. 能力、深度和资源配额

### 5.1 管理能力

**REQ-018**：根深度固定为 `0`，每经过一条父子边深度加一。有效 `maxDepth` 是可创建的最大子代理层级。默认 `maxDepth=2` 时，根可创建 A（深度 1），A 可创建 A-1（深度 2），A-1 是叶节点。

七个管理工具是不可拆分的“子代理管理能力”。一个节点只有同时满足以下条件才获得整组工具：

1. 直接父会话仍有该能力；
2. 所有祖先模板均未以 `subagents: disabled` 关闭它；
3. 当前节点 `depth < maxDepth`。

任一条件不满足时整组隐藏，后代不能重新开启。服务端仍必须重复校验直接父权限和深度；绕过工具发现的创建请求返回 `max_depth_reached` 或相应授权错误。

### 5.2 名额占用与释放

**REQ-019**：创建前必须在同一原子操作中预留父节点直接子代理名额和全树名额、分配不可复用的 UUID v4 `agent_id` 并登记 `starting`。`starting`、`idle`、`working`、`interrupting`、`failed`、`terminating` 都占名额；只有节点及其子树资源确认并进入 `terminated` 后释放。终止记录继续可见但不占名额。

达到深度、直接子代理或全树上限时必须立即拒绝，不自动等待、排队或回收：

- 深度：`max_depth_reached`，不可重试；
- 直接子代理：`max_children_reached`，名额释放后可重试；
- 全树：`max_tree_agents_reached`，任一节点完成回收后可重试。

并发创建不得超卖；启动失败或超时必须清理残留后释放预留，除非资源无法确认而保持 `terminating`。

### 5.3 不增加的资源控制

**REQ-020**：不同节点可以并行处理，同一节点由单一命令通道串行。首版不得新增同时运行数、token/费用、空闲时长或创建速率控制，也不得新增对应错误码、自动回收或调度队列。`wait_agent` 超时只结束一次观察，不改变节点。

## 6. 生命周期与公开工具

### 6.1 七态生命周期

**REQ-021**：公开生命周期只能是以下七种：

| 状态 | 定义 | 接受父子消息 | 占名额 |
| --- | --- | --- | --- |
| `starting` | 已登记并预留名额，正在建立进程、监督通道和 RPC | 否 | 是 |
| `idle` | 双通道可通信且无活动处理 | 是 | 是 |
| `working` | prompt 已被 Pi 接受并正在一次活动处理内 | 是，作为 steering | 是 |
| `interrupting` | 中断意图已接纳，尚未收到 `agent_settled` | 是，排在中断之后 | 是 |
| `failed` | 终止屏障前发生不可自动恢复的运行或控制故障 | 否 | 是 |
| `terminating` | 终止屏障已生效，但子树资源未全部确认回收 | 否 | 是 |
| `terminated` | 本节点和全部后代的终止及资源回收已确认 | 否 | 否 |

`failed` 和 `terminated` 是 `wait_agent` 的稳定终态；`terminating` 仍可能持有资源，不是等待终态。不得新增公开 `queued`、`running`、`exited`、`cancelling` 或 `unknown`。意外退出归入 `failed`，终止流程中的预期退出归入 `terminated`，待处理工作只用计数表示。

### 6.2 转换与线性化

**REQ-022**：控制器必须以已接纳意图和已经确认的 Pi/监督事实驱动状态。关键转换如下：

| 当前状态 | 触发 | 下一状态 | 守卫 |
| --- | --- | --- | --- |
| 无节点 | 原子预留、分配身份并登记 | `starting` | 登记先于进程启动 |
| `starting` | 监督握手、首个快照和无副作用 RPC 均成功 | `idle` | 此时 `spawn_agent` 才成功 |
| `starting` | 启动、协议或期限失败 | `failed -> terminating -> terminated` | 自动清理；无法确认时停在 `terminating` |
| `idle` | prompt 获接受确认 | `working` | 接受前不得提前变更 |
| `working` | steering 获接受确认 | `working` | 不新增状态 |
| `working` | `agent_settled` | `idle` | 唯一正常 settle 边界 |
| `working` | 中断被接纳 | `interrupting` | 工具立即返回 |
| `interrupting` | abort 响应、`agent_end` 或局部取消 | `interrupting` | 均不能代替 settle |
| `interrupting` | `agent_settled` | `idle` | 中断正常完成 |
| 非 `terminated` | 终止屏障被接纳 | `terminating` | 不可逆，固定已登记子树 |
| `starting`/`idle`/`working`/`interrupting` | 进程、RPC 或协议不可可信恢复 | `failed` | 不自动重启 |
| `failed` | 迟到正常事件或 `get_state` | `failed` | 不允许恢复 |
| `terminating` | 仍有资源无法确认 | `terminating` | 携带 `termination_incomplete` |
| `terminating` | 后代及本节点资源均确认 | `terminated` | 父节点后于后代 |
| `terminated` | 任意迟到事件或重复终止 | `terminated` | 身份不复用 |

进程退出和终止屏障并发时，以同一顺序域中先线性化者决定：退出先发生则先进入 `failed`；屏障先发生则退出属于终止流程。终止屏障优先于 prompt、abort、settle、回复、快照和 ACK；迟到事件不得跨越屏障恢复节点，也不得增加无可见变化的 `revision`。

Pi `get_state` 只可用于启动同步、事件缺口后的异常重同步和诊断，不得在正常路径覆盖事件驱动状态，更不得恢复已经公开的 `failed`。

### 6.3 Pending、修订与时间

**REQ-023**：`pending_message_count` 必须统计已由控制器受理、但尚未开始实际处理的父子消息：

- 消息通过校验并进入节点命令通道时加一；
- 从控制器队列移入 Pi steering 队列不重复计数；
- 成为活动 prompt、Pi 确认取出、明确拒绝、交付失败或终止前尚未写入而被取消时减一；
- 当前活动 prompt 不计数，因此 `working` 可以为 0；
- `failed` 和 `terminated` 必须为 0；`terminating` 可暂时保留 Pi 已接受但未确认消费的项，资源回收后归零。

节点公开状态、pending 或当前安全故障真实变化时，节点 `revision` 必须单调递增。内部句柄、命令阶段和被忽略的迟到事件不得增加它。`observed_at` 使用控制器接受变化时的 UTC RFC 3339、固定毫秒和 `Z` 后缀，只表示新鲜度；状态顺序由 `revision` 决定。树原子变化使用独立 `tree_revision`。

### 6.4 共通工具契约

**REQ-024**：公开工具固定为：

`spawn_agent`、`send_message`、`wait_agent`、`interrupt_agent`、`terminate_agent`、`get_agent_status`、`get_agent_tree`。

不提供多模式 `subagent` 工具，也不提供 `report_progress` 或 `send_parent_message`。所有定向工具使用根会话内唯一、终止后不复用的 UUID `agent_id`；控制器新分配的值使用随机 UUID v4，所有传输文本必须符合 RFC 9562 canonical 小写格式（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`），不带 `agent_` 前缀。展示名称不能寻址，也不能从标识推断树结构。任何 `agent_id` 参数若不是 canonical UUID 文本，必须返回 `invalid_argument`；格式正确但不在当前根注册表中的值返回 `agent_not_found`。

成功结果统一为：

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

### 6.5 `spawn_agent`

**REQ-025**：输入只允许必填 `template_id` 和 `name`：

```json
{ "template_id": "researcher", "name": "资料代理" }
```

不得携带首条任务，也不得覆盖 cwd、环境、模型、thinking、工具、扩展、技能、提示、信任、深度或配额。首条任务必须另行调用 `send_message`。

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

**REQ-026**：输入包含直接子代理 `agent_id`、非空 `message`，以及可选 Pi `ImageContent` 集合：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "请核对实现",
  "images": [
    { "data": "raw-base64-without-data-url-prefix", "mimeType": "image/png" }
  ]
}
```

实现必须校验文本、数量、长度、Base64 和 MIME。任务通道始终发送 Pi RPC `prompt` 并固定 `streamingBehavior: "steer"`：空闲节点启动处理，活动节点原子接受 steering。消息被 RPC 接受或进入 Pi steering 队列后立即成功：

```json
{ "ok": true, "data": { "message_id": "msg_...", "accepted": true } }
```

`message_id` 由控制器生成，在根会话内唯一且不复用。工具结果不区分 started/steered，也不等待回复或 settle。`interrupting` 仍可接收消息，但消息排在中断之后。`failed`、`terminating`、`terminated` 返回 `agent_unavailable`。

能证明未接受时返回 `message_delivery_failed` 并减 pending；接受状态未知时也返回该码，但不得自动重发，内部未决交付由后续队列/settle/故障事实消解。已返回 accepted 的调用不得因后续模型、工具或进程失败而被改写。

普通 assistant 回复经直接父子上行协议注入直接父会话；不允许越级。父会话模型自行决定是否继续交互。

### 6.7 `wait_agent`

**REQ-027**：输入为直接子代理 `agent_id` 和可选 `timeout_ms`。单次值必须在 `10000..600000` 毫秒；省略时使用根解析的 `waitTimeoutMs`。等待只观察一个节点，不改变节点或工作。

实现必须采用“原子检查、登记等待、再次检查”，允许多个等待者由同一事件完成。`agent_settled` 是正常完成边界，`agent_end` 不是。返回：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "outcome": "settled",
    "state": "idle",
    "revision": 12,
    "observed_at": "2026-08-04T04:34:57.123Z"
  }
}
```

`outcome` 只有：

- `settled`：调用时已 `idle`，`starting` 后进入 `idle`，或 `working`/`interrupting` 收到 `agent_settled`；
- `terminal`：调用时已经或等待中进入 `failed`/`terminated`；`failed` 必须附 `data.error`；
- `timeout`：观察期限先到；`terminating` 在资源未确认时只能继续等或超时。

结束原因与返回快照分开线性化，因此可以出现 `settled + working` 或 `terminal + terminating`。超时与事件先提交者决定唯一 outcome；超时绝不中断、终止或升级节点，也不重复返回 assistant 回复。

### 6.8 `interrupt_agent`

**REQ-028**：中断是保留节点和上下文的协作式操作。对 `working` 接纳后立即发送 RPC `abort`、转为 `interrupting` 并返回：

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

不得等待 abort 响应或 settle，不清除 Pi 已接受 steering，不终止后代，不释放名额，也不自动升级为终止。只有 `agent_settled` 能回到 `idle`。长期不响应时保持 `interrupting`，调用者需显式终止。

对 `idle`、`interrupting`、`failed`、`terminating`、`terminated` 幂等成功，`changed:false` 并返回准确状态；`failed` 附当前错误。`starting` 返回 `agent_unavailable`。交付中断时若确认 RPC/监督状态已不可可信使用，节点进入 `failed`。

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

**REQ-030**：`get_agent_status` 只接受一个直接子代理 `agent_id`，必须立即返回最近确认的安全快照，不触发 RPC、不等待、不改变状态。字段至少包含 `agent_id`、`name`、`template_id`、`depth`、`state`、`pending_message_count`、`revision`、`observed_at`。故障节点查询仍为 `ok:true`，在 `data.error` 提供当前 `code`、安全 `message`、`retryable` 和故障时间；健康或已成功终止节点省略当前错误。

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
    "observed_at": "2026-08-04T04:36:12.004Z",
    "nodes": []
  }
}
```

### 6.11 稳定错误码

**REQ-032**：公开工具错误码是以下闭合集合：

| 错误码 | 含义 | 重试语义 |
| --- | --- | --- |
| `invalid_argument` | 参数缺失、类型、范围、长度、Base64 或 MIME 无效 | 修正参数前不可重试 |
| `agent_not_found` | 标识不在当前根注册表或属于其他根 | 不可重试 |
| `not_direct_child` | 节点存在但不是调用者直接子代理 | 不可重试 |
| `template_not_found` | 当前可信来源没有选中候选 | 不可重试 |
| `template_invalid` | 选中模板存在但格式或已知字段无效 | 修正模板后再调用 |
| `template_capability_unavailable` | 模板合法但父授权、工具、模型或 thinking 静态不满足 | 更换模板或父配置后再调用 |
| `max_depth_reached` | 调用者达到深度上限 | 不可重试 |
| `max_children_reached` | 直接子代理名额已满 | 完成直接子代理回收后可重试 |
| `max_tree_agents_reached` | 全树名额已满 | 任一节点完成回收后可重试 |
| `spawn_failed` | 启动、提前退出、握手、RPC 或协议失败 | 按安全详情判断 |
| `spawn_timeout` | 启动期限内未进入可通信 `idle` | 可重试 |
| `agent_unavailable` | 节点当前状态不接受操作 | 不可对当前状态重试 |
| `message_delivery_failed` | 消息未获明确接受确认 | 仅明确未接受且节点健康时可重试 |
| `termination_incomplete` | 强制阶段后仍无法确认全部资源退出 | 可幂等重试终止 |
| `internal_error` | 无法归类的控制器内部异常 | 由实例决定 |

不得新增 `template_not_allowed`、配置文件错误、协议阶段、kill 阶段或 cleanup 阶段专用公开码。`host_capability_unavailable` 仅是扩展激活 UI 诊断。

## 7. 父子任务与监督协议

### 7.1 两条逻辑平面

**REQ-033**：每条直接父子关系必须有两个相互隔离的平面：

1. **Pi 任务通道**：监督器独占子进程 RPC stdin/stdout；承载 prompt/steer、abort、Pi 状态事件和普通 assistant 输出。
2. **父子监督通道**：独立本地双向可靠字节流；只承载握手、生命周期、完整子树快照、回复确认、重同步和关闭通知。

Unix 使用本地 Unix socket，Windows 使用命名管道。上层必须用带长度边界的 UTF-8 JSON 帧，不能依赖换行、模型文本、Pi 日志或 `entry_appended` 分帧。控制帧不得成为模型工具、prompt、会话条目或模型上下文。

规范帧外壳：

```json
{
  "protocol": "pi-subagent/1",
  "kind": "hello|hello_ack|event|snapshot_request|snapshot|reply|ack|close",
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

### 7.4 普通回复

**REQ-036**：监督器必须把普通 assistant 输出组装成只向直接父控制器上行的 `reply`，携带独立单调 `reply_seq` 和 Pi `ImageContent`。逐 token、工具参数和工具结果不得作为树事件转发。

父控制器按 `reply_seq` 顺序注入普通会话输入，注入成功后累计 ACK；重复回复不得再次注入。未连续确认回复只保留有界窗口。同一活动根会话内有限重同步先恢复握手和快照，再从最近未确认回复继续；不承诺跨根崩溃恢复或去重。消息 ID、reply seq、帧 seq 和 tree revision 属于不同命名空间，不得复用或互相推断。

### 7.5 有界状态与安全

**REQ-037**：控制器只能保留每个直接子代理的最新完整快照、每个流的序号水位、一个有界待确认快照/回复窗口和当前快照请求；不得保存无限事件日志。状态快照可合并，普通回复不得静默合并。窗口满时可以暂停非必要快照并请求重同步，但不得改变公开配额或等待语义。

监督端点只绑定本机 IPC，并使用不可猜测一次性凭据。帧长度、字符串、节点列表和回复载荷必须有代码级固定上限；越界关闭通道并按协议故障处理。凭据、端点、流 ID、序号水位和原始错误不得出现在工具、UI 或模型上下文。

## 8. 控制器、监督器与资源清理

### 8.1 模块责任

**REQ-038**：实现必须采用“封装 Pi `RpcClient`，由扩展补充监督器”的结构，不复制 Pi RPC。至少保留下列深模块边界：

| 模块 | 责任 | 禁止承担 |
| --- | --- | --- |
| `AgentController` | 单节点身份、直接父授权、生命周期、工具裁决和状态代际 | 直接递归 PID、渲染模型正文 |
| `RpcSupervisor` | 独占 Pi RPC、命令串行、事件归一化、启动/关闭和资源观察 | 裁决整树所有权、自动重启 |
| `ProcessTreeAdapter` | 平台树句柄、优雅请求、强制整树回收、退出观察、释放 | 修改生命周期或配额 |
| `SupervisorChannel` | 直接父子帧、握手、ACK、快照、回复和关闭 | 注入模型或越级通信 |
| `TreeController` | 所有权、配额、树合并、`tree_revision` 和安全 UI 快照 | 直接访问 RPC、PID、socket 或管道 |

模型工具不得直接调用平台适配器；树视图不得发送 RPC；子控制器不得直接访问祖先控制器。

### 8.2 启动事务

**REQ-039**：单节点启动必须按可回滚阶段执行：

1. 原子预留直接和全树名额，分配身份，登记 `starting`；
2. 创建本地监督端点和一次性凭据，准备固定 cwd、根环境快照、模板结果及内部元数据；
3. 先创建 Job Object 或 process group/session 归属，再启动子进程；
4. 完成监督协议身份、版本和初始快照校验；
5. 启动 Pi `RpcClient` 并完成无副作用请求/响应；
6. 双通道就绪后记录创建成功的单调时间，进入 `idle` 并返回。

任一步失败必须先记录安全故障，再执行终止清理。失败身份不复用。

### 8.3 单节点命令顺序

**REQ-040**：每个 `RpcSupervisor` 必须是其 RPC stdin/stdout 的唯一读写者，并提供一个状态变更顺序域，协调 prompt、steering、abort、优雅关闭和强制清理。只读查询、事件观察和多个等待者可以并行；不同节点可以并行。

终止屏障优先级最高：取消尚未写入的普通命令，抢占未完成中断清理，拒绝新 prompt/创建/普通控制，并用状态代际丢弃迟到响应。并发终止合并到同一流程。

监督器必须将 Pi 原始事件归一化：prompt 接受、`agent_settled`、安全工具活动、reply、EOF/协议故障。`agent_end`、abort 响应和局部完成只作诊断，不得错误 settle 或确认资源。

### 8.4 终止与资源确认

**REQ-041**：终止流程使用独立内部清理期限，不复用 `wait_agent.timeout_ms`，不允许调用者扩大为无限等待。阶段固定为：

1. 先在控制器建立目标子树终止屏障；
2. 子控制器向下为后代建立屏障并停止接单；
3. 对活动 Pi 会话发送 abort，但不把响应当成 settle 或回收；
4. 取消尚未写入命令，发送 stdin EOF 或等价优雅关闭；
5. 等待后代、进程和监督端点在内部优雅期限内退出；
6. 期限到达后调用平台适配器强制回收整树；
7. 重新观察进程、IPC、本节点和全部后代；只有全部确认退出才发布 `terminated`。

`ProcessTreeAdapter` 必须提供等价职责：

```ts
interface ProcessTreeAdapter {
  attach(processHandle): Promise<ProcessTreeHandle>;
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
- 运行期进程退出、RPC EOF、非法事件、身份篡改、序号/快照无法重同步在屏障前进入稳定 `failed`，不自动重启或恢复；
- 中间父节点故障时先保留 `failed`，立即对其已登记后代建立防孤儿屏障；故障父节点继续占名额，直到直接父显式终止并确认子树回收；
- 部分级联失败时已确认节点先 `terminated`，兄弟继续清理，未确认节点和父节点保持 `terminating`；
- 根退出、`new`、`resume`、`fork` 或 runtime 真正关闭时自动清理全部直接子树；内部期限超期只产生 UI-only 错误并允许根流程退出，不无限阻塞、不提前释放未确认名额；
- 成功 reload 保留树，reload 激活失败按 REQ-017 清理。

实现必须注入 `FakeRpcClient`、`FakeProcessTreeAdapter` 和 `FakeSupervisorChannel`，用于确定性复现 prompt/steering/settle、迟到事件、孙进程残留、部分回收、重复帧、断序、新流、回复 ACK、EOF 和协议损坏。

## 9. 可观测性与 UI

### 9.1 常驻 `Agents` widget

**REQ-044**：Pi TUI 必须提供只读常驻 `Agents` widget，并且只显示当前会话的直接子代理：根显示根直接子代理，普通父会话显示自身直接子代理。不得显示祖先、兄弟或越级后代，不提供发送、中断、终止或重载按钮。

活动行按稳定顺序显示并按行宽安全截断：

1. `template_id`，不是泛化 `Agent` 标签；
2. `spawn_agent.name`；
3. 生命周期状态；
4. 可选安全活动摘要；
5. 创建成功后的生命周期总时长；
6. 非零 pending 计数；
7. `failed` 或带 `termination_incomplete` 的 `terminating` 的稳定故障码。

不得显示 token/费用、完整 prompt、assistant 正文、工具参数/结果、路径、环境、句柄、堆栈或模型推理。

### 9.2 `/agent` 遮罩面板

**REQ-045**：唯一正式树查看命令是单数 `/agent`。它打开只读 TUI 遮罩，不把命令或面板内容提交给模型：

- 根查看整棵树；普通父会话查看自身子树；
- 初始读取一致 `tree_revision`，随后实时跟随新修订；
- 默认展开作用域直接子代理、折叠后代；
- 支持上下滚动、左右展开/折叠和 `Esc` 关闭；
- 折叠分支显示后代总数、working、failed 和 pending 汇总；
- 活动/故障分支优先可见，纯 idle 分支可折叠但不能静默消失；
- `terminated` 记录进入默认折叠 `finished` 区域，显示完成、失败终止和未完成清理数量；
- 面板保持用户展开集合和滚动位置；新修订不能强制回顶。

渲染内部错误时必须显示 UI 错误状态，不得伪造完整树。作用域根失效时关闭面板。

### 9.3 生命周期时间和状态反馈

**REQ-046**：生命周期计时从 `spawn_agent` 完成监督/RPC 双握手、节点进入 `idle` 并成功返回的线性化点开始，使用单调时钟。`starting` 不显示正常时长；`idle`、`working`、`interrupting`、`terminating` 累计；`failed`/`terminated` 冻结。它不是创建请求、当前 prompt 或工具耗时。

UI 只消费控制器确认事实，不按逐 token 刷新：消息受理增加 pending；Pi 确认开始后显示 working 并消解对应 pending；工具边界只更新安全摘要；中断接纳显示 interrupting；终止屏障使目标子树原子显示 terminating；资源确认后移入 finished；故障显示稳定码。一次级联变化必须按单一 `tree_revision` 原子刷新。

### 9.4 UI-only 与脱敏

**REQ-047**：正常状态变化只更新 widget/面板。节点进入 `failed` 或出现 `termination_incomplete` 时，当前可见作用域控制器按同批变化聚合一次 `ctx.ui.notify`：运行故障用 warning，清理不完整用 error；只含模板标识、数量和稳定错误码。

模板诊断、配置诊断、宿主兼容诊断、故障通知、widget、`/agent`、树修订和协议诊断都必须是 UI-only/控制器数据，不创建 user/assistant 消息、会话条目或系统提示，不进入模型上下文。不得使用 `sendMessage`、`sendUserMessage` 或 prompt 替代 UI API。RPC 宿主可消费独立 UI request；print/JSON 等无 UI 模式保持无可见回退。

安全活动摘要只能由已确认工具边界映射成短类别和计数，例如 `editing 2 files`；不得从原始正文、路径、参数、结果或堆栈摘要生成可能泄密的文本。

## 10. 开发阶段验收

### 10.1 判定范围

**REQ-048**：开发交付必须在 Windows、macOS、Linux 原生 runner 上通过。缺少任一 runner 或任一平台必测场景失败，都表示开发验收未完成；mock 不能替代原生进程树回收。CPU 架构不单列矩阵，以 runner 可运行兼容 Node/Pi 的架构为准。

每个平台执行两个锁定宿主组合：

1. 最低组合：Node `22.19.0` + Pi `0.83.0`；
2. 当前组合：验收执行时最新稳定 Pi + 该 Pi 支持的当前 Node Active LTS。

当前组合在 CI 开始时解析后必须立即锁定，并在验收证据中记录精确版本。不做最低/当前全排列。低于最低或不可解析 Pi、缺失必需 API和不支持平台可以集中做负向契约测试，不要求三平台重复。nightly、未发布 Pi commit 和 Node Current 不属于首版开发门槛。

### 10.2 测试层级

**REQ-049**：实现必须提供以下五层自动化测试，且不依赖外部模型网络、API key 或人工交互：

1. **纯逻辑测试**：状态机、配额、配置、模板、树合并、seq/ACK/重同步、脱敏；使用 fake 和可控单调时钟覆盖竞态。
2. **Pi 契约测试**：加载真实扩展入口和 Pi `RpcClient`，验证七工具 schema、错误外壳、事件映射、reload 与 UI-only 边界。
3. **原生进程集成测试**：启动真实 `pi --mode rpc --no-session`，使用确定性本地假模型/提供者，验证创建、steering、中断、故障和整树回收。
4. **TUI 交互测试**：验证直接子代理 widget、`/agent` 遮罩、滚动/展开/关闭、稳定尺寸和 UI-only 通知。
5. **本地 package 测试**：验证本地包目录或本地构建包的 manifest、生产依赖、临时加载和隔离的本地持久安装形态。

现有 throwaway 原型只能作为设计证据，关键断言必须迁入正式测试。人工探索可以补充，但不能替代自动化验收。

### 10.3 核心端到端旅程

**REQ-050**：以下旅程必须在三平台乘两个宿主组合的六个 job 中全部执行：

1. 加载扩展并发现合法模板，根创建 A；只有双握手后才以 `idle` 成功。
2. 向空闲 A 发送任务，接收直接回复并等待 settled；再次发送可观察同一节点上下文延续。
3. A 工作时再次发送，验证 steering 被接受而不是独立后续任务。
4. A 创建 A-1 到默认深度 2；A-1 不可见管理工具，绕过发现创建仍返回 `max_depth_reached`。
5. 根能只读看整树但不能越级控制 A-1；A 只能看自身子树并直接控制 A-1；revision、pending 和父关系一致。
6. 创建兄弟节点并行处理，验证不同节点并行、同节点命令串行。
7. 中断工作节点，等 `agent_settled` 回 idle 后再次复用。
8. 终止 A，验证 A-1 后代优先、整树资源确认、幂等终止和两类名额释放。
9. 成功根 `/reload` 后，新模板快照只影响未来创建，既有节点和 UI 状态保持一致。

### 10.4 负向、安全与资源正确性

**REQ-051**：负向矩阵至少必须覆盖：

- 公开闭集中每个工具错误码至少一个场景，核对 `retryable`、安全 details 和无副作用；
- 参数错误（包括非 canonical UUID 的 `agent_id`）、格式正确但未注册的 UUID、非直接子代理、模板不存在/无效/能力不足、深度/直接/全树配额耗尽；
- 配置不可读、坏 JSON、非法值、未知字段 UI-only 默认回退，以及非法显式根参数拒绝启动；
- 启动超时/提前退出、RPC 断开、消息接受状态未知、中断-settle 竞态、屏障后迟到事件、部分级联失败、中间父故障和根关闭；
- 重复帧、断序、旧 revision、旧/非法 stream、损坏快照、ACK 丢失、reset 快照和回复去重；
- 未信任项目资源不加载、模板不能扩权、叶节点不能绕过深度、根不能越级控制；
- cwd 外路径仍按 Pi 正常工具能力处理，证明扩展没有误实现 cwd 沙箱；
- 以秘密 canary 注入 prompt、路径、环境、工具参数/结果、连接凭据和堆栈，证明 widget、`/agent`、状态/树、错误、UI 通知、监督帧和 UI-only 诊断不泄露，也不进入模型上下文；
- 三个平台真实验证显式终止、根关闭和 reload 激活失败后没有存活的被监督后代；其余平台无关用例不重复完整六组合。

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

**REQ-054**：开发验收记录至少包含源码 commit、精确 OS/Node/Pi 版本、执行的 `AC-xxx`、通过/失败结果、资源清理结论和脱敏日志/UI 快照。所有映射到要求的 AC 必须通过；不得用 skip、quarantine 或自动重试掩盖失败。失败修复后必须重跑受影响场景。证据不包含 registry、正式发行 hash 或 release tag 证明。

## 11. 验收场景目录

| AC | 场景 | 核心断言 |
| --- | --- | --- |
| `AC-001` | 根树生命周期与所有权 | UUID `agent_id`、临时树、唯一直接父、根只读整树、切换/关闭不持久化 |
| `AC-002` | cwd、环境和 project trust | 固定 cwd；外部路径可按工具访问；环境快照不扩张；trust 只管项目资源 |
| `AC-003` | 原子宿主兼容门禁 | 版本/API/平台缺失时零公开面、UI-only 诊断、宿主继续运行 |
| `AC-004` | 配置优先级 | 根参数、可信项目、用户、默认按字段解析且根值固定 |
| `AC-005` | 配置错误诊断 | 文件/JSON/值错误用默认且不下退；未知字段忽略；非法根参数拒绝 |
| `AC-006` | 模板发现与身份 | 双来源直属 Markdown、project trust、文件名 ID、符号链接和来源故障 |
| `AC-007` | 模板 schema | 空正文、逗号 tools 规范化、枚举、model/thinking、未知字段静默忽略 |
| `AC-008` | 覆盖、诊断和模板 reload | 无效项目遮蔽用户；诊断 UI-only；新快照只影响未来创建 |
| `AC-009` | 创建能力与上下文继承 | 工具缺一即拒绝；精确模型/thinking；prompt mode、contextFiles、资源继承 |
| `AC-010` | 深度、管理工具和配额 | 默认两级；祖先 disabled 衰减；直接/全树原子预留和回收释放 |
| `AC-011` | 七态、pending、revision | 所有合法/非法转换、迟到事件守卫、计数与修订单调 |
| `AC-012` | 创建成功与失败回滚 | 创建生成 canonical UUID v4；双握手后 idle；启动错误/超时；清理完整与不完整两条返回路径 |
| `AC-013` | 任务、steering 与回复 | 空闲 prompt、工作 steer、交付未知不重发、直接回复顺序和 ACK |
| `AC-014` | 等待竞态 | 原子登记、多等待者、settled/terminal/timeout 及并发返回组合 |
| `AC-015` | 协作式中断 | abort 不等于 settle、不清 steering、不释放名额、中断后可复用 |
| `AC-016` | 终止与部分级联 | 屏障、后代优先、强制回收、幂等合并、partial failure |
| `AC-017` | 状态和树查询 | 直接状态权限、根/子树裁剪、原子 tree revision、安全字段 |
| `AC-018` | 公开错误码闭集 | 非法 UUID 与未注册 UUID 分流；每个错误码、retryable 和无副作用；无额外阶段错误码 |
| `AC-019` | 监督握手和快照 | 身份/版本/凭据、初始快照、subtree replacement、原子根修订 |
| `AC-020` | seq、ACK、重同步和有界状态 | duplicate/gap/reset/new stream/reply dedupe/窗口边界 |
| `AC-021` | 监督器启动和命令顺序 | 先挂接 OS 树、双通道就绪、单写者、终止优先、迟到丢弃 |
| `AC-022` | 原生平台进程树回收 | Windows Job Object、macOS/Linux process group/session、资源确认 |
| `AC-023` | 父故障、根关闭与 reload 失败 | 防孤儿、内部期限、无自动重启、失败 reload 清树 |
| `AC-024` | 常驻 widget | 只显示直接子代理、稳定行字段、计时、pending 和故障码 |
| `AC-025` | `/agent` 遮罩 | 作用域、折叠/滚动/展开/Esc、finished、修订保持交互状态 |
| `AC-026` | UI-only 与秘密 canary | 诊断/通知不进上下文，所有公开面不泄露正文和秘密 |
| `AC-027` | 本地 package 形态 | 唯一入口、生产依赖、本地临时/持久 scope、无隐式写入、清理临时资源 |
| `AC-028` | 六组合核心旅程 | 三平台乘最低/当前组合完整执行 REQ-050 |
| `AC-029` | 兼容负向组合 | 低版本、不可解析版本、API 缺失、不支持平台统一失活 |
| `AC-030` | 无性能门槛 | 测试计划和 CI 不含性能/压力/SLO/coverage 百分比阻断项 |
| `AC-031` | 追踪与开发证据 | 每个 REQ 有 AC；环境、commit、结果和清理证据完整，无 skip 隐藏 |

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

本文没有性能测试或发布执行要求，registry 凭据等发布运营信息属于外部输入，所有运行期产品决策均已冻结。实现代理应按 REQ 和 AC 直接拆分生产代码与测试；对不改变公开行为的类名、文件布局、内部期限数值、帧/字符串安全上限和日志后端，可以在实现中选择并用测试固定。
