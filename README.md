# Pi Subagent

面向 [Pi](https://github.com/earendil-works/pi) 的递归子代理扩展。它为一个 Pi 根会话建立受监督的临时代理树：父会话只能直接控制自己创建的节点，子代理使用独立的 Pi RPC 进程和上下文，并通过直接父子监督通道汇聚状态与回复。

> [!IMPORTANT]
> 本仓库是开发阶段的本地 Pi package，尚未发布到 npm registry。Windows 是当前开发验收目标；macOS/Linux 已有进程树适配代码，但尚未完成原生 runner、真实 Pi 宿主和完整回收场景的独立验收。本文描述当前实现契约，不代表三平台生产认证。

## 目录

- [能力与边界](#能力与边界)
- [运行要求与验证状态](#运行要求与验证状态)
- [安装、来源与项目授权](#安装来源与项目授权)
- [五分钟上手](#五分钟上手)
- [代理模板](#代理模板)
- [子进程启动与能力证明](#子进程启动与能力证明)
- [日常使用](#日常使用)
- [运行配置](#运行配置)
- [重载与更新](#重载与更新)
- [安全与脱敏](#安全与脱敏)
- [故障排查](#故障排查)
- [本地开发](#本地开发)

## 能力与边界

根会话和拥有递归管理能力的子代理可使用以下八项管理工具：

- `get_agent_templates`
- `spawn_agent`
- `send_message`
- `wait_agent`
- `interrupt_agent`
- `terminate_agent`
- `get_agent_status`
- `get_agent_tree`

每个非根子代理还拥有 `reply_to_parent`，它只能向自己的直接父会话发送必要的工作中协作消息。根会话没有该工具。运行时会在处理结束边界向直接父会话自动提交一次最终答复。

关键约束如下：

- 每个子代理是独立的临时 Pi RPC 进程，使用 `--no-session`，不会复制父会话的对话历史，也不会成为可单独恢复的 Pi 会话。
- 整棵树固定使用根会话启动时捕获的 `cwd`、环境快照、项目信任结论和配额配置；模板不能改写这些值。
- 一个父会话只能发送消息、等待、打断、终止或查询自己的直接子代理。根会话可以只读查看整棵树；普通子代理只读查看自己的子树。
- 节点可复用：向同一 `agent_id` 再次发送消息会保留该节点自身的会话上下文。
- 代理树受深度、每父节点数量和全树数量约束，但当前没有 token、费用、创建速率或空闲超时预算。
- 终止会递归清理目标节点及其已登记后代。`interrupt_agent` 仅协作式打断当前处理，保留节点与上下文。

## 运行要求与验证状态

| 项目 | 当前要求或状态 |
| --- | --- |
| Node.js | `>= 22.19.0` |
| Pi | `>= 0.84.1`，包名 `@earendil-works/pi-coding-agent` |
| 平台门禁 | 仅 Windows、macOS、Linux 可激活扩展 |
| Windows | 当前开发验收目标；需要可用的 Bash，推荐 Git for Windows 的 Git Bash；进程树由 Job Object 管理，并需要 `powershell.exe` |
| macOS / Linux | 已实现 process group/session 适配；原生 runner 和端到端回收证据仍未完成 |
| 模型 | 根会话必须能解析一个可用模型；模板可显式指定 `provider/model` 和 thinking 等级 |

扩展启动会检查 Node、Pi、平台进程树适配器、Pi API 与运行依赖。门禁失败时扩展整体不激活，不注册管理工具、`/agent` 或代理树 widget；普通 Pi 会话仍可继续使用。

当前仓库的自动化检查覆盖大量纯逻辑、协议和 fake 旅程，但本文档更新没有执行真实 Pi 端到端验证，也不能替代 Windows、macOS 或 Linux 的原生验收。

## 安装、来源与项目授权

### 先理解 Pi package 的安全模型

Pi package、扩展和模板 `extensions` source 都以启动 Pi 的操作系统用户权限执行代码。扩展可注册工具、provider、命令和事件处理器；技能也可引导模型执行外部程序。只使用已审查、可信且版本可追溯的来源。

Pi 支持以下 package source 形式：

| 来源 | 示例 | 行为 |
| --- | --- | --- |
| 本地路径 | `D:\path\to\pi-subagents-wj`、`./local-package` | 直接引用磁盘上的文件或目录，不复制源码 |
| npm | `npm:@scope/package@1.2.3` | 由 Pi 管理安装；精确版本是固定来源 |
| git / 远程 URL | `git:github.com/org/repo@v1`、`https://github.com/org/repo` | 由 Pi 克隆或解析；固定 tag/commit 不会被常规更新移动 |

`pi -e` / `--extension` 是一次性加载入口；`pi install` 把来源写入持久设置。对于 npm 或 git source，`-e` 在本次运行的临时目录解析，不持久化到 settings。对于本地路径，它仍直接加载当前磁盘内容。

### 1. 安装 Pi

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
node --version
pi --version
```

先确认 Pi 已能完成登录或 API Key 配置、选择模型并正常运行，再安装本扩展。

### 2. 准备本地 package

本仓库的 Pi 依赖是宿主 peer dependency。取得源码后，在 package 目录安装运行依赖：

```powershell
Set-Location D:\path\to\pi-subagents-wj
npm ci --omit=dev --legacy-peer-deps
```

本地路径安装不会替 package 执行 `npm install`。因此必须保留源码目录和其中的 `node_modules`；移动、删除或更名后，Pi settings 中的本地来源会失效。

### 3. 一次性试用

在真正要处理的项目目录运行：

```powershell
Set-Location D:\path\to\your-project
pi -e "D:\path\to\pi-subagents-wj"
```

这只影响本次 Pi 进程，不写入持久 settings。工作目录来自启动 Pi 的项目目录，而不是扩展目录。

### 4. 持久安装

用户级安装会在全部项目中启用该 package：

```powershell
pi install "D:\path\to\pi-subagents-wj"
```

仅在当前项目启用时使用 `-l`：

```powershell
Set-Location D:\path\to\your-project
pi install "D:\path\to\pi-subagents-wj" -l
```

项目级 package 会写入 `<cwd>/.pi/settings.json`，并受 Pi 的项目授权机制保护。仅在你已审查且明确希望执行项目 `.pi` 资源时，才在非交互命令中传入 `--approve`：

```powershell
pi install "D:\path\to\pi-subagents-wj" -l --approve
```

当前没有可用的 `npm:pi-subagents-wj` 公共安装来源，也没有本文可提供的公共 git 安装地址。

### 项目授权如何影响子代理

Pi 在交互式根会话中会对未决项目授权作出提示。授权前，Pi 可以加载用户级资源和命令行 `-e` 来源；项目 `.pi/settings.json`、项目扩展、项目 package 与其他受授权控制的项目 `.pi` 资源只有在项目获信任后才加载。非交互模式不会弹出提示：保存的决定或全局 `defaultProjectTrust` 决定默认行为，`--approve` 与 `--no-approve` 只覆盖本次运行。

本扩展在根会话启动时捕获该结论，并在所有 child Pi 启动参数中传递相同的 `--approve` 或 `--no-approve`。子代理不能重新询问、提升或降低根会话的项目授权。上下文文件是独立开关：`contextFiles` 决定 child 是否允许 Pi 按其规则读取 context files，不由 project trust 代替。

这有两个容易混淆的后果：

1. `<cwd>/.pi/agents` 中的项目模板只在根项目已获信任时参与发现。
2. 模板中的 `extensions` 会成为 child 的显式 `-e` source。`--no-approve` 只关闭普通项目资源发现，不能把已经由可信模板显式要求加载的 source 变成安全沙箱。因此，模板 extension source 本身也是代码执行授权的一部分。

不要在 extension URL 中嵌入 token、用户名密码或私有查询参数。模板目录会向模型公开规范化后的 extension source 字符串。

## 五分钟上手

### 1. 创建用户级模板

创建用户模板目录：

```powershell
New-Item -ItemType Directory -Force (Join-Path $HOME '.pi\agent\agents') | Out-Null
```

创建 `researcher.md`，使用 UTF-8 保存：

```markdown
---
description: 只读核对代码和测试
tools:
  - read
  - grep
  - find
  - ls
allowSubagents: false
contextFiles: true
systemPromptMode: append
---

先阅读相关代码和测试，再给出带文件位置的结论。不要修改代码。
```

此例故意省略 `extensions`，因此 child 遵循 Pi 的正常扩展发现规则。`tools` 是 YAML 字符串数组，不是逗号分隔标量。

### 2. 启动或重载根会话

新建模板后可重新启动 Pi；若根会话正在运行，输入：

```text
/reload
```

根 reload 会重新发现供未来 child 创建使用的模板。详见 [重载与更新](#重载与更新)。

### 3. 委派任务

可以直接提出自然语言任务，例如：

```text
创建 researcher 子代理，名为“鉴权调查”，让它只读检查鉴权入口和相关测试；
等待它完成后汇总结论和涉及的文件。
```

典型工具流程是：

1. 调用 `get_agent_templates`，只从当前返回项复制精确的 `template_id`。
2. 调用 `spawn_agent` 创建节点，得到 `agent_id`。
3. 调用 `send_message` 发送第一项任务。创建本身不接受首条任务。
4. 使用 `wait_agent` 等待必要工作中回复、任务提交、挂起或终态。
5. 继续向同一 `agent_id` 发送任务以复用上下文，或通过 `terminate_agent` 回收不再需要的分支。

`send_message` 返回的 `accepted: true` 只表示插件 mailbox 已接纳文本，不表示模型已读取或任务已经完成。

## 代理模板

### 发现目录与覆盖

| 来源 | 目录 | 何时参与发现 |
| --- | --- | --- |
| 用户级 | `~/.pi/agent/agents/*.md` | 始终 |
| 项目级 | `<root cwd>/.pi/agents/*.md` | 仅根项目已获 Pi 信任 |

只扫描目录直属的 UTF-8、严格小写 `.md` 文件及符号链接，不递归扫描子目录。`template_id` 是文件名去掉末尾 `.md` 后的原始值，精确区分大小写，不裁剪、不转小写，也不做 Unicode 归一化。

同名项目候选会整体遮蔽用户候选，不合并字段或正文。遮蔽在有效性校验之前发生：无效的项目模板仍会让同名用户模板不可用，并使该标识返回 `template_invalid`。

### 完整 schema

模板必须以 YAML frontmatter 开始，随后是可为空的 Markdown 正文：

```markdown
---
description: 审核远程资料并给出可核对结论
tools:
  - read
  - grep
extensions:
  - ./extensions/audit.ts
  - npm:@example/pi-audit@1.2.0
allowSubagents: false
contextFiles: false
systemPromptMode: replace
model: openai/gpt-example
thinking: medium
---

优先给出来源、判断依据和未能确认的部分。
```

允许且只允许以下八个 frontmatter 字段：

| 字段 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `description` | 是 | 无 | 非空字符串，裁剪后最多 512 个 Unicode code point；仅用于模板目录展示 |
| `extensions` | 否 | 省略 | YAML 字符串数组；控制 child 的额外 extension source 与自动发现策略 |
| `tools` | 否 | 省略 | YAML 字符串数组；控制 child 的业务工具 allowlist 策略 |
| `allowSubagents` | 否 | `true` | 原生 YAML boolean；是否允许该节点具备完整管理工具集合 |
| `contextFiles` | 否 | `true` | 原生 YAML boolean；`false` 时为 child 传递 `--no-context-files` |
| `systemPromptMode` | 否 | `append` | `append` 或 `replace` |
| `model` | 否 | 创建时的直接父会话当前模型 | 精确 `provider/model` 字符串 |
| `thinking` | 否 | 创建时的直接父会话当前等级 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

正文以 UTF-8 计最多 `64 KiB`。`description` 不会自动注入系统提示；正文才是模板角色提示。`replace` 只替换模板可控制的项目与角色提示层，不能移除运行时的所有权、通信、最终答复或安全约束。

### 严格解析规则

- `description` 必须存在且为非空字符串。
- `tools` 与 `extensions` 只能是原生 YAML 字符串数组；标量、空值、对象、数字、布尔值、空字符串条目和裁剪后重复项都会使候选无效。
- `tools` 不得包含系统保留名称：八项管理工具以及 `reply_to_parent`。这些工具由角色、祖先授权和深度自动决定，不能由模板直接索取。
- 未知字段会被拒绝，不会静默忽略。`name`、`env`、`skills`、`promptTemplates` 等都不是本扩展的模板字段。
- YAML merge 键、非字符串顶层键、重复键、无效 UTF-8、无法读取的文件和无效 frontmatter 都会使候选无效。
- 无效模板不会进入 `get_agent_templates`。有 UI 时，根会话只显示脱敏汇总诊断，包含逻辑来源、直属文件名和固定原因，不包含正文、绝对路径、异常文本或堆栈。

### `tools` 的三态语义

`tools` 的省略、空数组和非空数组不等价：

| 写法 | child 启动行为 |
| --- | --- |
| 省略 `tools` | 不传 `--tools`，保留 Pi 正常的业务工具选择；模板没有建立业务工具 allowlist |
| `tools: []` | 传递严格 allowlist；没有模板业务工具，但运行时仍保留角色必需的协议工具，例如 child 的 `reply_to_parent` |
| 非空数组 | 严格 allowlist 由声明的业务工具与角色必需的协议工具组成 |

显式 `tools` 是对 child 的启动时工具集约束。若某个模板 extension 注册了业务工具，并且该工具应在显式 allowlist 下可调用，就必须同时把它写入 `tools`。只加载 extension source 不会自动把它注册的工具加入显式业务 allowlist。

### `extensions` 的三态语义与 source 解析

`extensions` 同样拥有三态，且由 child 的 Pi CLI 参数实现：

| 写法 | child 扩展行为 |
| --- | --- |
| 省略 `extensions` | 遵循 Pi 的普通扩展发现：用户资源始终按 Pi 规则参与，项目资源取决于继承到的 project trust |
| `extensions: []` | 传递 `--no-extensions`，关闭普通扩展发现；child 仍显式加载本扩展自身以维持监督与回复协议 |
| 非空数组 | 同样传递 `--no-extensions`，再显式加载本扩展和数组内的每个 source，形成受模板控制的显式集合 |

Pi 的 `--no-extensions` 关闭的是普通发现路径，不会把 child 变成无代码或无权限进程，也不能移除 Pi 固定的内建 inline extension。它不是沙箱。

模板 extension source 的解释规则如下：

- `./...`、`../...`、绝对路径等本地 source 相对模板文件所在目录解析，而不是相对 child 的工作目录解析。
- `npm:...`、`git:...`、完整 `https://` / `http://` / `ssh://` / `git://` URL 与 `git@host:...` 形式按 Pi package source 规则原样交给 Pi 解析。
- 每个 source 最终按 YAML 声明顺序作为 child 的显式 `-e` 参数加载；远程 source 可能引发临时下载、安装或 git 操作。
- source 字符串会以裁剪后的显示值出现在模板目录中。不要写入认证信息，也不要依赖前后空白。
- `extensions` 只控制 extension source；它不提供技能、提示模板、环境变量、cwd 或文件系统权限的模板级白名单。

### 模板目录的公开内容

`get_agent_templates` 返回当前根权威的安全目录。每项仅包含：

```json
{
  "template_id": "researcher",
  "description": "只读核对代码和测试",
  "tools": ["read", "grep"],
  "extensions": ["./extensions/audit.ts"]
}
```

`tools` 或 `extensions` 省略时，返回项中对应字段也省略；显式空数组会返回 `[]`。目录不会公开模板正文、真实模板目录、来源层级、模型、thinking、上下文文件策略或递归授权开关。

目录有效只表示 frontmatter 合法，不代表 child 已实际完成加载。模板业务工具、模型、thinking 与 provider 可以由模板 extension 提供，因此父端不会以自身当前可见的工具或 provider 做最终可用性裁决。

## 子进程启动与能力证明

创建 child 的事务按以下边界进行：

1. 根权威解析当前模板快照并签发模板修订与节点预留事实。
2. 父端启动受管 Pi RPC child，固定根 `cwd`、根环境快照、根 project trust 与节点身份；child 使用 `--no-session`。
3. child 总是通过当前实际加载的扩展入口显式 `-e` 加载本扩展。它不会按 package 名重新解析另一份安装；入口由根运行时传入，以避免加载到不同副本。
4. 直接父子监督通道完成身份、凭据、协议版本和初始快照握手，普通 ready 后 child 才能报告运行能力。
5. child 最多一次发布内部 capability manifest，父端缓存并据此裁决模板请求与实际激活能力是否匹配；通过后节点才作为可用 child 进入 `idle`。

manifest 是内部控制信息，不属于 `get_agent_status`、`get_agent_tree`、widget 或模型可见模板目录。它只包含受限、可校验的运行时事实：实际业务工具、系统工具及其来源、provider、model、thinking 和当前自扩展入口标识。它不携带模板正文、环境、凭据、进程句柄或原始异常。

这解决了两个旧假设的问题：

- 父会话当前未知的工具和 provider 可能由模板列出的 source 注册，最终判断必须等待 child 实际完成加载。
- Pi 对未知 CLI allowlist 工具可能采取静默处理；只有 child 实际加载完成后的能力事实才能说明模板请求是否真正生效。

若 child 已启动并绑定监督通道，但上报的能力无法满足模板，节点以稳定的 `capability_mismatch` 失败并清理。进程、RPC、监督握手或准备阶段无法完成时使用 `spawn_failed`；超过启动期限时使用 `spawn_timeout`。这些公开错误不会暴露 source 路径、manifest 内容、凭据或堆栈。

## 日常使用

### 发送、回复与等待

`spawn_agent` 只创建节点。首项工作必须由 `send_message` 另行发送：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "检查鉴权入口，并列出相关测试。"
}
```

父端将文本线性化进入 child mailbox。节点空闲时会以 Pi `prompt()` 启动逻辑任务；已有活动任务时，后续文本可作为 `steer()` 进入当前处理。Pi 自动压缩、交付不确定或终止屏障期间，运行时保守地保持消息与节点状态，不把 RPC 返回成功误写为模型已读取。

`reply_to_parent` 仅用于 child 在最终答复前遇到必须由直接父代理裁决的阻塞问题，或父代理明确要求过程回报时：

```json
{
  "message": "需要父代理裁决：任务要求与当前接口契约冲突。"
}
```

它不用于心跳、常规进度、阶段性总结、完成通知或替代最终答复。成功的工作中回复会唤醒直接父会话，但不会结束 child 当前任务。

child 到达本轮结束边界时，运行时在独立 outbox 中准备并向直接父会话提交一次最终答复。普通 assistant 过程输出、思考块、工具参数、工具结果和原始错误不会自动上行。最终答复被父会话接纳并完成相应确认后，任务才提交为完成、失败或中断。

`wait_agent` 可在一次调用中观察多个直接 child：

```json
{
  "agent_ids": [
    "550e8400-e29b-41d4-a716-446655440000",
    "650e8400-e29b-41d4-a716-446655440000"
  ],
  "timeout_ms": 120000
}
```

任一目标产生必要工作中回复、最终任务结果、挂起或稳定终态时，等待返回。`timeout` 只结束观察，不中断、不终止，也不表示任务失败。

### 管理范围与递归

`allowSubagents: false` 会关闭该节点完整的八项管理工具；它不会移除 child 的 `reply_to_parent`。即使模板允许递归，父节点已经没有管理能力或深度达到 `maxDepth` 时，也无法把能力重新授予后代。

默认 `maxDepth` 为 `2`：根深度是 `0`，根可创建深度 `1`，深度 `1` 可创建深度 `2`，最后一层是叶节点。展示名称仅供 UI 使用，所有工具寻址均使用规范小写 UUID `agent_id`。

### 状态与终止

| 状态 | 含义 | 是否占用名额 |
| --- | --- | --- |
| `starting` | 身份与名额已预留，正在建立进程、监督通道和 RPC | 是 |
| `idle` | 已就绪且没有当前任务、未决回复或待交付消息 | 是 |
| `working` | 正在处理、对账或提交任务 | 是 |
| `interrupting` | 已接受协作式中断，等待当前任务结束 | 是 |
| `suspended` | 交付或维护状态无法确认，需要外部裁决 | 是 |
| `failed` | 发生不可自动恢复的运行或控制故障 | 是 |
| `terminating` | 终止屏障已建立，资源尚未全部确认 | 是 |
| `terminated` | 本节点和其已登记后代已确认回收 | 否 |

`failed` 不会自动重启，仍需显式终止才能释放名额。`termination_incomplete` 表示资源尚未确认回收，应稍后对同一直接子代理重试终止，而不是假设进程已经消失。

在交互式 TUI 中，`Agents` widget 显示当前会话的直接、未终止 child。输入 `/agent` 可打开当前可见作用域的完整只读树；根看到整棵树，普通 child 看到自己的子树。树视图不会提供越级控制权限。

## 运行配置

根会话只在启动时解析一次配置，并将结果冻结给整个代理树。优先级为：

1. 已获信任项目的 `<cwd>/.pi/subagent.json`
2. 用户级 `~/.pi/agent/subagent.json`
3. 内置默认值

```json
{
  "maxDepth": 3,
  "maxChildrenPerAgent": 4,
  "maxAgentsPerTree": 12,
  "waitTimeoutMs": 120000
}
```

| 字段 | 默认值 | 合法范围 | 作用 |
| --- | ---: | ---: | --- |
| `maxDepth` | `2` | `1..8` | 根深度为 0 时允许创建的最大 child 层级 |
| `maxChildrenPerAgent` | `4` | `1..16` | 每个父节点尚未终止的直接 child 上限 |
| `maxAgentsPerTree` | `16` | `1..64` | 根之外、尚未终止的全树节点上限 |
| `waitTimeoutMs` | `60000` | `10000..600000` | `wait_agent` 未传超时时间时的默认毫秒数 |

项目未获信任时，项目配置完全不参与解析。缺失字段继续向下一层取值；已选层的文件不可读、JSON 无效或字段越界时，受影响字段使用内置默认值，而不是回退到更低优先级层。配置变更需要新建根会话；`/reload` 只刷新未来 child 创建时使用的模板与资源。

## 重载与更新

### `/reload` 的准确边界

Pi `/reload` 会重新发现模板和 Pi 资源，并原子替换供后续 `spawn_agent` 创建 child 使用的模板快照。解析和创建之间若发生 reload，应重新查询模板并重新发起创建。

`/reload` 只影响未来 child 的模板与资源，不影响任何已存在 child。

升级监督协议主版本或本地 package 代码时，退出并重新启动 Pi。

### 更新本地来源

Pi 不管理本地路径中的源码副本。按你取得源码的方式更新后，重新安装依赖：

```powershell
Set-Location D:\path\to\pi-subagents-wj
npm ci --omit=dev --legacy-peer-deps
```

随后退出并重新启动 Pi。若只需让新增模板或资源用于未来 child，可在根会话执行 `/reload`。`pi update --extensions` 只更新由 Pi 管理的 npm/git package，不会拉取或重装当前这种本地路径来源。

移除持久引用时使用与安装时相同的 source：

```powershell
pi remove "D:\path\to\pi-subagents-wj"
pi remove "D:\path\to\pi-subagents-wj" -l
```

这些命令只删除 settings 中的引用，不删除本地源码或 `node_modules`。

## 安全与脱敏

### `cwd` 不是沙箱

根 `cwd` 是相对路径、项目资源发现和模板项目目录的基点，不是文件访问边界。只要 Pi 工具与宿主用户权限允许，`read`、`write`、`edit` 与 Bash 仍可能访问绝对路径或 `cwd` 外的路径。`contextFiles: false` 只关闭 Pi 的上下文文件发现，不会撤销普通工具权限。

要隔离不可信仓库、模型操作或 extension 代码，应在容器、虚拟机或其他操作系统级沙箱中运行整个 Pi 会话。

### 工具与 extension 不是权限边界

模板 `tools` 控制 child 的模型可调用工具集，不改变进程的操作系统权限。模板 `extensions` 也不是安全过滤器：它明确选择哪些 source 在 child 中执行。应把可写工具、远程 package、项目模板与 extension source 都当作需审查的可执行输入。

### 公开面只保留安全事实

控制工具、代理树、UI 与模型可见错误只公开稳定的状态、枚举、计数和错误码。它们不会携带：

- 模板正文、消息正文、final 正文、图片或工具参数
- 模板目录绝对路径、环境变量、凭据、认证 URL
- 进程 ID、Job Object、process group、管道/socket、句柄
- 原始异常、远程安装输出或堆栈
- capability manifest 的内部内容和自扩展实际路径

常见稳定错误码包括：

| 错误码 | 含义 | 处理方向 |
| --- | --- | --- |
| `template_not_found` | 当前快照没有该模板标识 | 检查文件名、目录、trust 与 reload |
| `template_invalid` | 候选文件不满足严格 schema | 修复 UTF-8、frontmatter 或字段类型 |
| `template_capability_unavailable` | 当前节点没有递归管理能力 | 检查深度、祖先授权和 `allowSubagents` |
| `capability_mismatch` | child 实际能力未满足模板请求 | 检查模板 `tools`、`extensions`、模型和 child 启动环境 |
| `spawn_failed` / `spawn_timeout` | child 未能启动或未及时就绪 | 检查 Pi、来源、平台、模型与资源 |
| `message_delivery_failed` | 无法确认消息交付 | 先查询状态，不要盲目重发 |
| `termination_incomplete` | 资源尚未确认回收 | 稍后重试终止 |
| `internal_error` | 已脱敏的控制器故障 | 保存可复现步骤并查看 UI 状态 |

## 故障排查

### 没有管理工具、Agents widget 或 `/agent`

先检查：

```powershell
node --version
pi --version
pi list
```

- Node 必须至少为 `22.19.0`，Pi 必须至少为 `0.84.1`。
- 确认本地 package 路径存在，且已执行 `npm ci --omit=dev --legacy-peer-deps`。
- Windows 需要从 `PATH` 调用 `powershell.exe`，并需要 Pi 可用的 Bash。
- 项目级 `-l` 安装和项目模板都要求根项目获信任；检查是否误用了 `--no-approve`，或尚未在交互式 Pi 中作出授权决定。
- 若通过 `-e` 试用，确认本次 Pi 启动命令包含正确的 source。

门禁失败不会留下半套工具。修复环境后重启 Pi。

### `template_invalid` 或模板未出现

检查：

- 文件必须在 `~/.pi/agent/agents` 或已信任项目的 `.pi/agents` 直属目录，且后缀是小写 `.md`。
- 文件开头必须立即是 `---`，frontmatter 必须是 YAML 对象。
- `description` 必填；`tools` 与 `extensions` 必须写成 YAML 数组，例如 `tools: [read, grep]` 或多行数组。
- `allowSubagents` 和 `contextFiles` 必须是 `true` / `false`，不是字符串或旧枚举。
- 不要使用未知字段，也不要使用 YAML merge。
- 同名无效项目模板会遮蔽有效用户模板。
- 新增、删除或改名后在根会话执行 `/reload`，使变更用于未来 child 创建。

TUI 诊断只显示安全原因；它不会显示正文或绝对路径。

### extension source、工具或模型无法满足模板

- `extensions: []` 会关闭普通发现。若 child 依赖用户级、项目级或已安装 provider extension，请省略 `extensions`，或将所需 source 显式列入数组。
- 使用显式 `tools` 时，extension 注册的业务工具还必须显式写入 `tools`；否则它虽可加载，但不会成为可调用业务工具。
- 相对本地 source 相对模板目录，而不是相对项目 cwd。检查 `./` / `../` 路径是否以该目录为基点。
- 远程 source 应使用 Pi 支持的 `npm:`、`git:` 或完整 URL 格式；确认网络、git 认证和 source 版本可用。
- `capability_mismatch` 表示 child 实际启动后的能力与模板不一致。不要把它理解为父会话当前工具列表的简单子集错误。

### reload 或本地更新后行为与预期不同

- `/reload` 重新发现模板和资源，只用于之后创建的 child；它不影响任何已存在 child。
- `subagent.json` 在根启动时冻结；修改它需要结束并新建根会话。
- 本地路径 source 不会被 `pi update --extensions` 更新。更新源码和依赖后应退出并重新启动 Pi；新增模板或资源需要用于未来 child 时，可在根会话执行 `/reload`。
- 若改变了监督协议主版本或自扩展入口无法再被解析，请退出并重新启动 Pi。

### 节点停在 `interrupting`、`suspended`、`failed` 或 `terminating`

- `interrupting`：当前任务仍在形成 interrupted final；长期无结果时显式终止。
- `suspended`：交付或维护状态不可确认。先查询状态，不要把它当作完成或无条件重发任务。
- `failed`：节点不会自动恢复；根据稳定错误码排查后终止以释放名额。
- `terminating`：资源清理尚未确认。若错误为 `termination_incomplete`，稍后对同一直接 child 重试终止。

## 本地开发

安装开发依赖并运行仓库检查：

```powershell
Set-Location D:\path\to\pi-subagents-wj
npm ci --legacy-peer-deps
npm run check
```

`npm run check` 依次执行 TypeScript `--noEmit` 类型检查和 Node 测试，不会启动开发服务。

如需构建隔离 smoke package：

```powershell
npm run pack:smoke
```

该命令在仓库根目录创建 `package-smoke` 安装目录。完成验证后，先移除测试项目中登记的 package source，再确认目标路径无误后删除该临时目录。

更多项目背景和架构依据见：

- [领域上下文](./CONTEXT.md)
- [完整规格](./.scratch/pi-subagent-spec/spec.md)
- [架构决策记录](./docs/adr/)
