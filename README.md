# wj-pi-subagents

`wj-pi-subagents` 为 [Pi](https://github.com/earendil-works/pi) 提供递归子代理能力。它在一个根 Pi 会话内创建受监督的临时代理树：每个子代理运行在独立的 Pi RPC 进程中，拥有自己的上下文，并且只能由直接父会话管理。

> [!IMPORTANT]
> macOS 和 Linux 平台未测试。

## 目录

- [路径占位符](#路径占位符)
- [功能概览](#功能概览)
- [运行要求](#运行要求)
- [安装](#安装)
- [快速上手](#快速上手)
- [使用方法](#使用方法)
- [代理模板配置](#代理模板配置)
- [运行配置](#运行配置)
- [项目授权与安全边界](#项目授权与安全边界)
- [重载、更新与卸载](#重载更新与卸载)
- [故障排查](#故障排查)
- [开发与调试](#开发与调试)
- [许可证](#许可证)
- [项目文档](#项目文档)

## 路径占位符

| 占位符 | 含义 |
| --- | --- |
| `<REPOSITORY_PATH>` | 本仓库在本机的检出目录 |
| `<PROJECT_DIR>` | 希望 Pi 和子代理处理的目标项目目录 |
| `<USER_HOME>` | 当前操作系统用户的主目录 |
| `<PI_AGENT_DIR>` | 本扩展的用户级配置目录，即 `<USER_HOME>/.pi/agent` |
| `<TEMPLATE_DIR>` | 当前代理模板所在目录 |

在命令中使用占位符时，请将整个占位符替换为实际路径；路径含空格时保留引号。

## 功能概览

### 递归代理树

- 根会话可以创建直接子代理；有管理能力且未达到深度上限的子代理可以继续创建下一层子代理。
- 每个子代理对应一个独立的 `pi --mode rpc --no-session` 进程，不复制父会话的对话历史。
- 整棵树固定使用根会话启动时的工作目录、环境快照、项目授权结论和配额配置。
- 子代理可以在根会话存活期间重复使用；向同一 `agent_id` 发送新任务会保留该节点自己的上下文。
- 根会话结束、切换会话或显式终止节点时，扩展会按代理子树回收相关进程。

### 受控的父子协作

- 父会话只能控制自己的直接子代理，不能越级向孙代理发送消息、中断或终止。
- 根会话可以只读查看整棵树；普通子代理只能查看自己的子树。
- 不同子代理可以并行工作；同一子代理的消息、任务、中断和终止由单一 mailbox 串行协调。
- 父子消息只支持纯文本，不支持图片或其他二进制载荷。
- 子代理可通过 `reply_to_parent` 向直接父会话发送必要的工作中回复，最终答复由运行时自动提交。

### 模板与能力核验

- 从用户级和已授权项目级目录发现 Markdown 代理模板。
- 模板可以配置业务工具、额外扩展、模型、thinking 等级、上下文文件和递归权限。
- 模板使用严格 YAML frontmatter；无效模板不会进入可用模板目录。
- 子代理完成实际资源加载后会上报能力清单。工具、模型、thinking 或扩展入口与模板不匹配时，创建会以 `capability_mismatch` 失败，不会静默降级。

### 状态与界面

- TUI 中的 `Agents` widget 持续显示当前会话的直接子代理。
- `/agent` 打开只读代理树面板，支持滚动、展开、折叠和查看已终止节点。
- `get_agent_status` 返回直接子代理的安全状态快照。
- `get_agent_tree` 返回当前调用者可见范围内的完整树快照。
- 状态、错误和 UI 不公开消息正文、模板正文、环境变量、凭据、绝对路径、进程句柄或堆栈。

### 管理工具

拥有子代理管理能力的会话会获得以下八个工具：

| 工具 | 用途 |
| --- | --- |
| `get_agent_templates` | 列出当前格式有效的代理模板 |
| `spawn_agent` | 使用模板创建一个直接子代理 |
| `send_message` | 向直接子代理发送任务或 steering |
| `wait_agent` | 等待一个或多个直接子代理的首个有效事件 |
| `interrupt_agent` | 协作式中断当前任务，保留节点上下文 |
| `terminate_agent` | 永久终止节点及其已登记子树 |
| `get_agent_status` | 查询直接子代理的最近安全状态 |
| `get_agent_tree` | 查询当前作用域内的只读代理树 |

每个非根子代理还会获得 `reply_to_parent`。它不属于管理工具，也不能指定任意目标。

### 当前边界

本扩展当前不提供：

- 跨根会话持久化或恢复子代理；
- 兄弟代理、跨层代理之间的直接通信或广播；
- token、费用、并发运行数、创建速率或空闲时间预算；
- 文件系统沙箱、逐路径权限或操作系统级隔离；
- 远程主机、分布式调度或多用户共享代理树。

## 运行要求

| 项目 | 要求或状态 |
| --- | --- |
| Node.js | `>= 22.19.0` |
| Pi | `>= 0.84.1`，当前兼容性 smoke 基线为 `0.84.2`，包名为 `@earendil-works/pi-coding-agent` |
| 目标平台 | Windows、macOS、Linux；当前只完成 Windows 原生验收 |
| Windows Shell | Pi 需要可用的 Bash，推荐 Git for Windows 提供的 Git Bash |
| Windows 进程管理 | 需要可从 `PATH` 调用的 `powershell.exe`，扩展使用 Job Object 回收进程树 |
| 模型 | 根会话必须已选择可用模型；模板也可以指定精确的 `provider/model` |

扩展启动时会检查 Node、Pi、必需 API、运行依赖和平台进程树适配器。任一门禁失败时，扩展不会注册半套工具或启动子进程；普通 Pi 会话仍可继续运行，TUI 中会显示 `host_capability_unavailable` 诊断。

## 安装
### 1. 从 npm 安装正式版本

首个 npm 版本发布后，可以直接安装用户级 package：

```bash
pi install npm:wj-pi-subagents
```

只在当前项目中安装：

```bash
cd <PROJECT_DIR>
pi install npm:wj-pi-subagents -l
```

只为当前进程临时加载，不写入设置：

```bash
cd <PROJECT_DIR>
pi -e npm:wj-pi-subagents
```

指定 `npm:wj-pi-subagents@X.X.X` 可以固定版本；不带版本时由 Pi 按 npm package 更新规则管理。

### 2. 获取源码并安装运行依赖

```bash
git clone https://github.com/nlbwqmz/wj-pi-subagents.git
cd wj-pi-subagents
npm ci --omit=dev --legacy-peer-deps
```

Pi 是本 package 的宿主 peer dependency。本地路径 package 不会由 Pi 自动执行依赖安装，因此必须保留仓库目录及其中的 `node_modules`。

### 3. 一次性加载本地源码

在目标项目目录启动 Pi：

```bash
cd <PROJECT_DIR>
pi -e "<REPOSITORY_PATH>"
```

`-e` / `--extension` 只影响当前 Pi 进程，不写入持久设置。子代理的工作目录是启动 Pi 时的 `<PROJECT_DIR>`，不是扩展仓库目录。

### 4. 持久安装本地源码

用户级安装会在所有项目中启用本 package：

```bash
pi install "<REPOSITORY_PATH>"
```

只在当前项目中启用：

```bash
cd <PROJECT_DIR>
pi install "<REPOSITORY_PATH>" -l
```

项目级安装会修改 `<PROJECT_DIR>/.pi/settings.json`，并受 Pi 的项目授权机制保护。只有在已审查该项目的 `.pi` 资源后，才为非交互命令显式授权：

```bash
pi install "<REPOSITORY_PATH>" -l --approve
```

使用 `pi list` 可以确认 package 来源是否已经写入设置。

## 快速上手

### 1. 创建代理模板

创建 `<PI_AGENT_DIR>/agents/researcher.md`，使用 UTF-8 编码保存：

```markdown
---
description: 只读检查代码、文档和测试
tools:
  - read
  - grep
  - find
  - ls
allowSubagents: false
contextFiles: true
systemPromptMode: append
---

先阅读相关实现和测试，再给出带文件位置的结论。不要修改文件。
```

项目专用模板可以放在 `<PROJECT_DIR>/.pi/agents/researcher.md`，但只有根项目已获 Pi 授权时才会被发现。

### 2. 启动或重载 Pi

新会话直接在目标项目中启动：

```bash
cd <PROJECT_DIR>
pi -e "<REPOSITORY_PATH>"
```

如果 Pi 已经运行，新增或修改模板后执行：

```text
/reload
```

### 3. 委派任务

直接向根会话描述目标即可，无需手工组织工具 JSON：

```text
创建 researcher 子代理，名称为“鉴权调查”，只读检查鉴权入口和相关测试。
等待它完成后，汇总结论并列出涉及的文件。
```

模型通常会按以下顺序调用扩展工具：

1. `get_agent_templates` 获取当前模板目录。
2. `spawn_agent` 原样使用目录中的 `template_id` 创建节点。
3. `send_message` 发送首项任务。
4. `wait_agent` 等待工作中回复、任务提交、挂起或终态。
5. 继续复用该 `agent_id`，或用 `terminate_agent` 回收不再需要的分支。

## 使用方法

### 创建与发送任务

`spawn_agent` 只负责创建节点，不接受首项任务。创建成功后必须再调用 `send_message`。

`send_message` 返回 `accepted: true` 时，只表示扩展 mailbox 已接纳消息并分配 `message_id` / `task_id`，不表示 Pi 或模型已经读取，更不表示任务完成。消息交付不确定时，应先查询状态，不能盲目重发。

向同一 `agent_id` 再次发送消息时：

- 节点空闲：建立新逻辑任务，并复用现有上下文；
- 节点工作中：消息通常作为当前任务的 steering；
- 节点正在中断：消息进入后继任务，等待当前任务完成中断提交后再处理。

一旦任务由 `send_message` 接纳，父会话不应同时重复执行或再次委派同一工作。需要接管时，应先 `interrupt_agent`，再用 `wait_agent` 确认当前处理已经结束。

### 等待多个子代理

`wait_agent` 一次可以观察 `1..64` 个直接子代理：

```json
{
  "agent_ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "650e8400-e29b-41d4-a716-446655440000"
  ],
  "timeout_ms": 120000
}
```

所有目标共享一个观察窗口，任一目标出现有效事件时返回。常见 outcome：

| outcome | 含义 |
| --- | --- |
| `reply` | 收到工作中回复；子代理通常仍在处理 |
| `task_completed` | 最近任务已正常提交 |
| `task_failed` | 最近任务以失败结果提交，节点仍可能可复用 |
| `task_interrupted` | 最近任务已完成中断提交 |
| `suspended` | 交付或维护状态无法确认，需要查询状态并裁决 |
| `terminal` | 节点已进入 `failed` 或 `terminated` |
| `timeout` | 本次观察窗口结束，节点状态没有因此改变 |
| `batch_released` | 同一工具批次已被另一个等待目标解除 |

`timeout` 不会中断或终止子代理。耗时任务仍处于 `working` 时，应继续等待；不要仅因一次 timeout 就创建替代代理或重复工作。

### 中断、复用与终止

- `interrupt_agent`：协作式结束当前处理，保留节点及其上下文；调用成功后仍需 `wait_agent` 确认任务已提交中断结果。
- `terminate_agent`：永久终止目标及其全部已登记后代，并等待资源回收；终止后不可复用。
- `failed` 节点不会自动重启，仍需显式终止才能释放名额。
- `termination_incomplete` 表示资源尚未全部确认回收，应稍后对同一直接子代理重试终止。

### 生命周期状态

| 状态 | 含义 | 是否占用名额 |
| --- | --- | --- |
| `starting` | 正在建立进程、RPC 和监督通道 | 是 |
| `idle` | 已就绪且当前严格静止 | 是 |
| `working` | 正在投递、处理、压缩、对账或提交任务 | 是 |
| `interrupting` | 中断栅栏已生效，等待当前任务结束 | 是 |
| `suspended` | 交付或维护状态无法确认，需要外部裁决 | 是 |
| `failed` | 出现不可自动恢复的运行故障 | 是 |
| `terminating` | 终止已开始，资源尚未全部确认回收 | 是 |
| `terminated` | 节点及其子树资源已确认回收 | 否 |

### 查看代理树

- 常驻 `Agents` widget 只显示当前会话的直接、未终止子代理。
- 输入 `/agent` 打开完整只读树面板。
- 根会话看到整棵树；普通父会话只看到自己的子树。
- 面板只提供观察能力，不扩大跨层控制权限。

## 代理模板配置

### 模板发现位置

| 作用域 | 路径 | 生效条件 |
| --- | --- | --- |
| 用户级 | `<PI_AGENT_DIR>/agents/*.md` | 始终参与发现 |
| 项目级 | `<PROJECT_DIR>/.pi/agents/*.md` | 根项目已获 Pi 授权 |

本扩展当前固定从 `<USER_HOME>/.pi/agent` 读取用户级模板和运行配置。只扫描目录直属的小写 `.md` 文件或符号链接，不递归扫描子目录。

`template_id` 是文件名移除末尾 `.md` 后的原始值，区分大小写，不裁剪、不转换大小写，也不做模糊匹配。项目模板与用户模板同名时，项目模板整体覆盖用户模板；两者不会合并。无效的同名项目模板仍会遮蔽用户模板。

### 完整模板示例

```markdown
---
description: 审核代码并核对相关测试
extensions:
  - ./extensions/audit-tools.ts
tools:
  - read
  - grep
  - find
allowSubagents: false
contextFiles: true
systemPromptMode: append
model: openai/gpt-example
thinking: medium
---

优先说明判断依据、涉及的文件和未能确认的部分。
```

模板正文是子代理的角色提示。正文允许为空，UTF-8 编码后最大为 `64 KiB`。

### Frontmatter 字段

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `description` | 是 | 无 | 非空字符串，最多 512 个 Unicode code point，用于模板目录展示 |
| `extensions` | 否 | 省略 | Pi extension source 字符串数组 |
| `tools` | 否 | 省略 | 子代理业务工具字符串数组 |
| `allowSubagents` | 否 | `true` | 是否允许该节点继续管理子代理 |
| `contextFiles` | 否 | `true` | 是否加载 Pi 的 `AGENTS.md` / `CLAUDE.md` 上下文文件 |
| `systemPromptMode` | 否 | `append` | `append` 或 `replace` |
| `model` | 否 | 创建时直接父会话的当前模型 | 精确的 `provider/model` |
| `thinking` | 否 | 创建时直接父会话的当前等级 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

只允许以上八个字段。未知字段、重复键、YAML merge 键、错误类型、空数组项、重复数组项和保留工具名都会使模板无效。`allowSubagents` 与 `contextFiles` 必须使用 YAML 布尔值，不能写成字符串。

### `tools` 的三种状态

| 写法 | 行为 |
| --- | --- |
| 省略 `tools` | 不传 `--tools`，保留 Pi 正常的业务工具选择 |
| `tools: []` | 使用严格的零业务工具 allowlist，但仍保留运行时必需的协议工具 |
| 非空数组 | 使用声明的精确业务工具 allowlist，并附加获授权的协议工具 |

`tools` 只能声明业务工具，不能包含八个管理工具或 `reply_to_parent`。如果模板扩展注册了某个业务工具，并且模板显式声明了 `tools`，该工具还必须同时出现在 `tools` 中。

### `extensions` 的三种状态

| 写法 | 行为 |
| --- | --- |
| 省略 `extensions` | 保留 Pi 的普通扩展发现规则 |
| `extensions: []` | 传递 `--no-extensions`，关闭普通扩展发现，仅显式加载本扩展自身 |
| 非空数组 | 关闭普通扩展发现，再显式加载本扩展和数组中的每个 source |

相对本地 source 以模板文件所在目录 `<TEMPLATE_DIR>` 为基准解析，而不是以 `<PROJECT_DIR>` 为基准。`npm:`、`git:`、完整协议 URL 和 `git@host:...` 形式交由 Pi 解析。远程 source 可能触发下载、依赖安装和任意扩展代码执行。

### 模板重载

根会话执行 `/reload` 后，会原子刷新供未来 `spawn_agent` 使用的模板快照。它不会修改已存在子代理的工具、扩展、模型、提示、上下文或递归能力。

## 运行配置

运行配置在根会话启动时读取一次，并冻结给整棵代理树。

### 配置位置与优先级

每个字段独立按以下顺序解析：

1. 已授权项目的 `<PROJECT_DIR>/.pi/wj-pi-subagents.json`
2. 用户级 `<PI_AGENT_DIR>/wj-pi-subagents.json`
3. 内置默认值

项目未获授权时，项目配置不参与解析。

`WJ_PI_SUBAGENTS_*` 是扩展向受管子进程注入的内部环境变量前缀，用于传递节点身份、配额、协议版本和本地监督凭据。不要手工设置或覆盖这些变量；用户运行配置只通过上述 `wj-pi-subagents.json` 文件提供。

### 配置示例

```json
{
  "maxDepth": 3,
  "maxChildrenPerAgent": 4,
  "maxAgentsPerTree": 12,
  "waitTimeoutMs": 120000
}
```

### 配置字段

| 字段 | 默认值 | 合法范围 | 作用 |
| --- | ---: | ---: | --- |
| `maxDepth` | `2` | `1..8` | 最大子代理层级，根会话深度为 0 |
| `maxChildrenPerAgent` | `4` | `1..16` | 每个父会话尚未终止的直接子代理上限 |
| `maxAgentsPerTree` | `16` | `1..64` | 根之外、尚未终止的全树节点上限 |
| `waitTimeoutMs` | `60000` | `10000..600000` | `wait_agent` 省略 `timeout_ms` 时的默认毫秒数 |

达到深度上限会立即拒绝创建。达到直接子代理或全树名额上限后，需要先终止并完成资源回收，再重新创建。

如果某层文件不可读、不是有效 JSON、不是对象，或被选中的已知字段非法，受影响字段直接使用内置默认值，不会继续回退到更低优先级。未知字段会被忽略，并在有 UI 时显示脱敏警告。

修改 `wj-pi-subagents.json` 后必须结束并重新启动根 Pi 会话；`/reload` 不会重新读取运行配置。

## 项目授权与安全边界

### 项目授权

Pi 的 project trust 决定项目级 `.pi/settings.json`、package、扩展和本扩展的项目模板、项目运行配置是否参与加载。根会话会将启动时的授权结论固定传给所有后代，子代理不能重新提示、提升或降低该结论。

`contextFiles` 是独立开关。即使项目未获授权，`contextFiles: true` 仍允许 Pi 按自身规则读取 `AGENTS.md` / `CLAUDE.md`；`contextFiles: false` 会为该子代理传递 `--no-context-files`。

### `cwd` 不是沙箱

根工作目录只是相对路径和项目资源发现的基点，不是文件访问边界。只要宿主权限和可见工具允许，子代理仍可能访问 `<PROJECT_DIR>` 之外的路径。

模板 `tools` 只限制模型可调用的工具集合，不改变进程的操作系统权限。`extensions: []` 也不是安全沙箱，它只关闭 Pi 的普通扩展发现。

需要处理不可信代码、扩展或模型操作时，应在容器、虚拟机或其他操作系统级隔离环境中运行整个 Pi 会话。

### 扩展来源安全

Pi package 和模板 `extensions` 都以当前操作系统用户权限执行代码。只使用已审查、可信且版本可追溯的来源。不要在 npm、git 或 URL source 中嵌入 token、用户名密码或私有查询参数，因为规范化后的 source 可能出现在模板目录展示中。

## 重载、更新与卸载

### `/reload` 的作用

`/reload` 会刷新 Pi 资源和代理模板，并让新模板快照用于之后创建的子代理。现有代理树、活动任务、mailbox、模型和上下文保持不变。

以下变更建议完全退出并重新启动 Pi：

- 修改 `<PI_AGENT_DIR>/wj-pi-subagents.json` 或项目 `wj-pi-subagents.json`；
- 更新本扩展源码或运行依赖；
- 更新监督协议主版本；
- 更换本地 package 目录。

### 更新本地源码

```bash
cd <REPOSITORY_PATH>
git pull --ff-only
npm ci --omit=dev --legacy-peer-deps
```

本地路径 package 直接引用磁盘内容，`pi update --extensions` 不会拉取本仓库或重新安装其依赖。更新后应重新启动 Pi。

### 卸载

用户级来源：

```bash
pi remove "<REPOSITORY_PATH>"
```

项目级来源：

```bash
cd <PROJECT_DIR>
pi remove "<REPOSITORY_PATH>" -l
```

移除命令只删除 Pi 设置中的来源引用，不会删除仓库或 `node_modules`。

## 故障排查

### 公开错误码与消息

公开控制结果以 `code` 作为错误身份；`message` 和 `retryable` 必须使用该错误码对应的规范值。跨进程快照和控制响应不会兼容旧中文消息或不匹配的 `retryable` 值，收到这类数据会拒绝该载荷。

| `code` | Canonical `message` | `retryable` |
| --- | --- | ---: |
| `invalid_argument` | `Invalid argument` | `false` |
| `agent_not_found` | `Subagent ID is not registered` | `false` |
| `not_direct_child` | `Target is not a direct child` | `false` |
| `template_not_found` | `Agent template not found` | `false` |
| `template_invalid` | `Invalid agent template` | `false` |
| `template_capability_unavailable` | `Required template capabilities unavailable` | `false` |
| `capability_mismatch` | `Subagent capability mismatch` | `false` |
| `max_depth_reached` | `Maximum subagent depth reached` | `false` |
| `max_children_reached` | `Direct child limit reached` | `true` |
| `max_tree_agents_reached` | `Agent tree limit reached` | `true` |
| `spawn_failed` | `Subagent startup failed` | `false` |
| `spawn_timeout` | `Subagent startup timed out` | `true` |
| `agent_unavailable` | `Subagent currently unavailable` | `false` |
| `message_delivery_failed` | `Message delivery status is uncertain` | `false` |
| `termination_incomplete` | `Subagent resources not fully reclaimed` | `true` |
| `internal_error` | `Internal controller error` | `false` |

### 没有管理工具、`Agents` widget 或 `/agent`

依次检查：

```bash
node --version
pi --version
pi list
```

- Node 必须至少为 `22.19.0`，Pi 必须至少为 `0.84.1`。
- 确认 `<REPOSITORY_PATH>` 存在，且已安装生产依赖。
- 确认本次启动包含 `-e "<REPOSITORY_PATH>"`，或 package 已持久安装。
- Windows 上确认 Bash 和 `powershell.exe` 可用。
- 查看 TUI 是否出现 `host_capability_unavailable`。

修复门禁问题后重新启动 Pi。

### 模板没有出现或返回 `template_invalid`

检查以下项目：

- 文件位于 `<PI_AGENT_DIR>/agents` 或已授权项目的 `.pi/agents` 直属目录；
- 后缀是严格小写 `.md`，文件编码是 UTF-8；
- 文件第一行就是 `---`，frontmatter 是 YAML mapping；
- `description` 存在且非空；
- `tools` 与 `extensions` 是 YAML 字符串数组；
- `allowSubagents` 和 `contextFiles` 是原生布尔值；
- 没有未知字段、重复键、YAML merge 或保留工具名；
- 没有同名无效项目模板遮蔽用户模板。

修复后执行 `/reload`，再重新调用 `get_agent_templates`。

### `template_capability_unavailable` 或 `capability_mismatch`

- `template_capability_unavailable`：当前调用者没有递归管理能力，或已到达允许的创建层级。
- `capability_mismatch`：子代理已经启动并上报实际能力，但工具、模型、thinking 或本扩展入口与请求不一致。
- 显式 `extensions: []` 会关闭普通扩展发现；依赖其他扩展或 provider 时应省略该字段，或显式列出所需 source。
- 显式 `tools` 必须包含模板扩展所注册且任务需要调用的业务工具。
- 模板指定的模型和 thinking 必须在子代理实际启动环境中可用。

### `spawn_failed` 或 `spawn_timeout`

- 检查 Pi、模型认证、模板 extension source、网络和运行依赖。
- 检查相对 extension source 是否确实相对 `<TEMPLATE_DIR>` 可解析。
- `spawn_timeout` 表示启动期限内没有形成完整就绪事实，可以在确认环境后重试。
- `spawn_failed` 不应原样反复重试，应先修复来源、模型、平台或依赖问题。

### `message_delivery_failed` 或 `suspended`

这表示消息交付或维护状态无法确认，不等于“消息未处理”。先调用 `get_agent_status` 检查 `state`、`activity.phase`、三类队列计数和 `last_task`，再决定继续等待、发送恢复指令或人工处理。不要盲目重发可能产生副作用的任务。

### `termination_incomplete`

目标仍处于 `terminating`，表示部分进程或子树资源尚未确认回收。稍后对同一直接子代理再次调用 `terminate_agent`；不要把它当作已经终止。

### reload 或更新后行为没有变化

- `/reload` 只改变未来创建的子代理，不会重建现有节点。
- `wj-pi-subagents.json` 只在根会话启动时读取。
- 本地源码和依赖更新后需要退出并重新启动 Pi。
- 本地路径 package 不受 `pi update --extensions` 管理。

## 开发与调试

### 安装开发依赖

```bash
git clone https://github.com/nlbwqmz/wj-pi-subagents.git
cd wj-pi-subagents
npm ci --legacy-peer-deps
```

本项目不需要启动开发服务器。

### 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 使用 TypeScript 执行 `--noEmit` 类型检查 |
| `npm test` | 使用 Node test runner 运行 `test/*.test.ts` |
| `npm run check` | 依次执行类型检查和全部测试 |
| `npm run build:bridge` | 将 RPC bridge 编译到 `dist/` |
| `npm run pack:smoke` | 打包 tarball，并在 `package-smoke/` 中执行隔离生产安装 |
| `npm run compat:pi` | 使用本机 Pi RPC 验证扩展入口、TUI widget 和 `get_state` |

源码开发时，若 `dist/` 中没有编译 bridge，运行时会回退到 `src/rpc-bridge-process.ts`。打包时 `prepack` 会自动执行 `build:bridge`。

`npm run pack:smoke` 会生成 `dist/` 和 `package-smoke/`。验证完成、且没有 Pi 设置继续引用 smoke package 后，应删除这些生成目录。

### 运行单个测试

```bash
node --experimental-strip-types --test test/agent-controller.test.ts
```

按测试名称过滤：

```bash
node --experimental-strip-types --test --test-name-pattern="中断" test/agent-controller.test.ts
```

### 使用 Node Inspector 调试测试

单进程运行目标测试并在第一行暂停：

```bash
node --inspect-brk --experimental-strip-types --test --experimental-test-isolation=none test/agent-controller.test.ts
```

随后使用浏览器 DevTools 或 IDE 附加到 Node 默认 inspector 端口。只调试一个测试文件，避免多个 test worker 竞争调试端口。

### 在真实 Pi 宿主中调试

1. 先运行仓库检查：

```bash
cd <REPOSITORY_PATH>
npm run check
```

2. 在 `<PI_AGENT_DIR>/agents` 或 `<PROJECT_DIR>/.pi/agents` 准备一个最小模板。
3. 从目标项目一次性加载源码 package：

```bash
cd <PROJECT_DIR>
pi --verbose -e "<REPOSITORY_PATH>"
```

4. 验证以下旅程：创建子代理、发送任务、等待 final、复用节点、中断节点、打开 `/agent`、终止节点。
5. 使用 Pi 隐藏命令 `/debug` 生成 `pi-debug.log`，检查 TUI 渲染和最近发送给模型的消息。日志可能包含项目上下文，分享前必须脱敏。
6. 退出根 Pi 会话后确认没有遗留由本次测试创建的子进程、临时 pipe/socket 或 smoke 目录。

### 提交前检查

```bash
npm run check
git status --short
git diff -- README.md
```

涉及发布装配或 bridge 的改动还应执行：

```bash
npm run pack:smoke
```

## 许可证

本项目采用 [MIT License](./LICENSE)。

## 项目文档

- [领域上下文](./CONTEXT.md)
- [完整规格](./.scratch/wj-pi-subagents-spec/spec.md)
- [架构决策记录](./docs/adr/)
- [Issue 跟踪说明](./docs/agents/issue-tracker.md)
