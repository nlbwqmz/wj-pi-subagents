# Pi Subagent

面向 [Pi](https://github.com/earendil-works/pi) 的递归子代理扩展。它让当前 Pi 会话可以创建、复用、引导、等待、中断和终止独立子代理，并通过只读代理树观察整个协作过程。

> [!IMPORTANT]
> 本仓库当前是开发阶段的本地 package，尚未发布到 npm registry。代码适配 Windows、macOS 和 Linux，其他平台不会激活扩展。Windows 是当前开发验收目标，但真实 Pi 端到端验收仍待人工完成；macOS/Linux 已实现进程组适配，原生 runner 与完整跨平台验证尚未完成。请勿将当前版本视为已经完成三平台生产验收。

## 目录

- [它能做什么](#它能做什么)
- [运行要求](#运行要求)
- [安装](#安装)
- [更新与卸载](#更新与卸载)
- [五分钟上手](#五分钟上手)
- [代理模板](#代理模板)
- [日常使用](#日常使用)
- [查看代理树](#查看代理树)
- [运行配置](#运行配置)
- [工具参考](#工具参考)
- [生命周期](#生命周期)
- [安全与资源边界](#安全与资源边界)
- [故障排查](#故障排查)
- [本地开发](#本地开发)

## 它能做什么

安装扩展后，Pi 会获得八个代理管理工具和一个 `/agent` 命令。你仍然可以像平常一样用自然语言给 Pi 下达任务；根代理会在适合时调用这些工具。

- 每个子代理运行在独立的临时 Pi RPC 进程中，有自己的上下文和身份。
- 同一个子代理可以连续接收多轮任务，适合需要保留上下文的长期分工。
- 不同节点可以并行工作；同一个节点上的控制命令按顺序处理。
- 子代理可以继续创建自己的子代理，形成受深度和名额限制的树。
- 父代理只能控制自己的直接子代理，不能越级操纵更深层后代。
- 子代理回复只交付给直接父代理，并触发父代理继续处理。
- 会话关闭时，扩展会递归清理受监督的子进程树。

子代理不会复制父会话的对话历史。整棵树共享根会话启动时确定的工作目录、项目信任结果、环境快照和配额配置；具体工具、模型、thinking 和系统提示由代理模板决定。

## 运行要求

| 项目 | 要求 |
| --- | --- |
| Node.js | `>= 22.19.0` |
| Pi | `>= 0.83.0`，包名为 `@earendil-works/pi-coding-agent` |
| 平台 | 代码门禁仅接受 Windows、macOS 和 Linux |
| Windows | Pi 需要可用的 Bash（推荐随 Git for Windows 安装的 Git Bash）；扩展使用 Job Object 管理子进程树，并默认调用 `powershell.exe` |
| macOS / Linux | 已实现 process group/session 适配器，但尚未完成独立原生验收 |
| 模型 | Pi 当前会话必须已选定可用模型；模板指定的模型和 thinking 必须处于当前可用范围 |

扩展启动时会先检查 Node、Pi、平台适配器、Pi API 和运行依赖。任一条件不满足时，扩展会整体保持未激活：八个工具、`/agent` 和代理 widget 都不会注册；交互界面会尽量显示一次 `host_capability_unavailable` 警告，普通 Pi 会话仍可继续使用。

## 安装

以下本地路径命令以 Windows PowerShell 为例。macOS/Linux 用户可将 `Set-Location` 换成 `cd`，并使用对应平台的绝对路径；这两个平台当前仍受前述验收状态限制。

### 1. 安装 Pi

如果尚未安装 Pi：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
node --version
pi --version
```

然后启动 Pi：可以在交互界面中使用 `/login` 完成订阅登录，也可以按 Pi 自身说明配置 API Key。确认 Pi 已经能够选择模型并正常调用后，再继续安装扩展。

### 2. 准备本地扩展

取得本仓库源码后，在扩展目录安装生产依赖。Pi 是宿主提供的 peer dependency，不需要再安装一份到扩展目录：

```powershell
Set-Location D:\path\to\pi-subagent
npm ci --omit=dev --legacy-peer-deps
```

仓库包含 `package-lock.json`，因此这里使用 `npm ci` 按锁文件装配依赖。本地路径安装不会替你运行 `npm install` 或 `npm ci`，所以这一步不能省略。

### 3. 临时试用

切换到真正要处理的项目目录，再通过扩展的绝对路径启动 Pi：

```powershell
Set-Location D:\path\to\your-project
pi -e "D:\path\to\pi-subagent"
```

`-e` 只对当前 Pi 进程生效，不会修改 Pi 的持久设置。工作目录来自启动 Pi 时所在的项目目录，而不是扩展目录。

### 4. 持久启用

用户级安装会在所有项目中启用这个本地 package：

```powershell
pi install "D:\path\to\pi-subagent"
pi list
```

也可以只在当前项目启用：

```powershell
Set-Location D:\path\to\your-project
pi install "D:\path\to\pi-subagent" -l
```

项目级安装受 Pi 的 project trust 保护。如果项目尚未获信任，请在 Pi 的提示中确认；只有你明确希望信任该项目时，才使用 `--approve` 完成非交互安装：

```powershell
pi install "D:\path\to\pi-subagent" -l --approve
```

本地 package 只是登记并直接引用源目录，不会复制源码。请保留该目录及其中的 `node_modules`；移动、重命名或删除目录都会使已登记的来源失效。项目设置中登记的本机绝对路径通常也不能直接供其他团队成员使用。

当前没有可用的 `npm:pi-subagent` 安装来源，也没有可在本文中提供的公开 Git 安装地址。

## 更新与卸载

### 更新本地安装

Pi 不管理本地路径中的源码副本。请先通过你实际取得源码的方式更新该目录，然后重新按锁文件装配生产依赖：

```powershell
Set-Location D:\path\to\pi-subagent
npm ci --omit=dev --legacy-peer-deps
```

随后在正在运行的 Pi 中输入：

```text
/reload
```

也可以退出并重新启动 Pi。如果扩展的绝对路径没有改变，不需要再次执行 `pi install`。

裸 `pi update` 只更新 Pi 本体；`pi update --extensions` 只更新由 Pi 管理的 npm/git package，也会跳过当前这种本地路径来源。Pi 不会替本地来源拉取源码或更新依赖。

### 卸载

使用安装时的同一绝对路径移除来源。用户级安装：

```powershell
pi remove "D:\path\to\pi-subagent"
```

项目级安装：

```powershell
pi remove "D:\path\to\pi-subagent" -l
```

`pi uninstall` 是 `pi remove` 的别名。对于本地路径，这些命令只会移除 Pi 设置中的来源引用，不会删除源码目录或其中的 `node_modules`；如需删除文件，请在移除引用后自行处理。

## 五分钟上手

### 第一步：创建一个模板

模板决定子代理可用的业务工具、模型和工作方式。先创建用户级模板目录：

```powershell
New-Item -ItemType Directory -Force (Join-Path $HOME '.pi\agent\agents') | Out-Null
```

在该目录新建 `researcher.md`，以 UTF-8 保存：

```markdown
---
description: 阅读代码并给出有依据的结论
tools: read
subagents: disabled
contextFiles: enabled
systemPromptMode: append
---

你是一名只读研究代理。先检查相关文件，再给出带文件位置的结论；不要修改代码。
```

这里没有填写 `model` 和 `thinking`，所以创建时会继承直接父会话当时的精确模型与 thinking 等级。

> [!NOTE]
> `read` 必须是当前 Pi 实际注册的工具。模板业务工具不要求在父会话当前处于活动状态，子 Pi 会按模板声明的初始工具集启动。

### 第二步：启动或重载

模板在根会话启动和根 `/reload` 时重新发现。新建或修改模板后，启动 Pi；如果 Pi 已在运行，则输入：

```text
/reload
```

### 第三步：让 Pi 委派任务

直接用自然语言提出需要分工的任务，例如：

```text
创建一个 researcher 子代理，名为“鉴权调查”，让它只读检查鉴权入口和相关测试；
等它完成后，汇总结论和涉及的文件。
```

典型流程是：

1. 根代理调用 `get_agent_templates` 查看当前有效模板，并原样复制返回的 `template_id`。
2. 根代理调用 `spawn_agent`，创建后得到唯一 `agent_id`。
3. 根代理调用 `send_message` 发送第一项任务。
4. 子代理的回复自动回到直接父代理。
5. 根代理可调用 `wait_agent` 等待节点空闲或进入终态。
6. 后续仍可向同一 `agent_id` 发送任务，以复用其上下文。
7. 不再需要时调用 `terminate_agent`，递归回收该节点和所有后代。

`spawn_agent` 只负责创建节点，不接受首条任务。若模型只创建了代理却没有开始工作，可以明确提醒它“继续向刚创建的代理调用 `send_message`”。

## 代理模板

### 模板目录与覆盖规则

| 级别 | 目录 | 何时读取 |
| --- | --- | --- |
| 用户级 | `~/.pi/agent/agents/*.md` | 始终参与发现 |
| 项目级 | `<项目 cwd>/.pi/agents/*.md` | 仅在当前项目已获 Pi 信任时参与 |

只扫描目录直属、扩展名严格为小写 `.md` 的 UTF-8 文件，不递归扫描子目录。模板标识 `template_id` 就是原始文件名去掉末尾 `.md`，精确区分大小写。例如 `researcher.md` 的标识是 `researcher`。

同名时，项目模板整体覆盖用户模板，不合并字段或正文。覆盖先于有效性校验：一个无效的项目模板仍会遮蔽同名的有效用户模板，并让创建返回 `template_invalid`。

### 完整模板格式

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

| 字段 | 是否必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `tools` | 是 | 无 | 必须是逗号分隔的 YAML 字符串。裁剪空项并按首次出现去重；唯一合法的空工具集写法是 `tools: ""`。 |
| `description` | 否 | 无 | 裁剪后的展示元数据；不定义模板标识。 |
| `subagents` | 否 | `inherit` | `inherit` 保留递归管理能力；`disabled` 对该节点及其所有后代关闭八个管理工具。 |
| `contextFiles` | 否 | `enabled` | `disabled` 会让该子代理不加载固定 cwd 祖先链上的 `AGENTS.md` / `CLAUDE.md`。 |
| `systemPromptMode` | 否 | `append` | `append` 将正文追加到项目与角色提示；`replace` 替换这一提示层。 |
| `model` | 否 | 父会话当前模型 | 必须是精确的 `provider/model`；模型 ID 本身可以继续包含 `/`。 |
| `thinking` | 否 | 父会话当前等级 | 可选 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。 |

Markdown 正文可以为空。未列出的 frontmatter 字段会被静默忽略；尤其是 `name`、`env`、`skills`、`extensions` 和 `promptTemplates` 不会产生模板级覆盖。

`description` 只是模板展示元数据，不会自动注入提示词。`get_agent_templates` 会列出当前发现且格式有效的模板，并返回 `template_id`、可选 `description` 和模板声明的业务 `tools`。八个代理管理工具不能手动写进模板 `tools`，也不会出现在返回项的 `tools` 中；扩展会根据深度和祖先权限自动追加或移除完整管理工具集合。

模板出现在目录中不表示当前父会话一定能创建它：模型、thinking 和管理能力仍会在 `spawn_agent` 时预检；模板 `tools` 是子代理的初始业务工具请求，不要求是父会话当前活动工具的子集。目录为空时 `get_agent_templates` 直接返回 `[]`，此时不能调用 `spawn_agent`。

创建时还会做能力预检：

- 模板中的每个业务工具必须已经由 Pi 注册；它不要求当前在直接父会话中启用，子 Pi 会按模板请求自己的初始工具集。
- 显式模型必须存在于 Pi 模型目录并处于当前模型范围内。
- 模板或继承到的 thinking 必须受所选模型支持。
- 模板不能扩张父会话的信任或子代理管理权限；业务工具不执行父会话活动工具子集校验。

模板格式错误或列出未注册工具会得到 `template_invalid`；模板合法但当前模型、thinking 或管理能力无法满足时会得到 `template_capability_unavailable`。

当前子 Pi 会显式加载 Pi Subagent 自身，并沿用根会话的 Pi 扩展发现配置，因此根会话注册的动态 provider（例如自定义 provider）也能在子 Pi 中解析。模板仍应优先使用 Pi 内置业务工具；依赖其他扩展注册的业务工具时，必须确认这些扩展在子 Pi 的同一 cwd/settings 下可发现。

### 模板与父会话的继承关系

- 子代理固定使用根会话启动时的 cwd；模板不能改 cwd。
- 子代理不会获得父会话对话历史，也不会复制父会话最终渲染出的完整系统提示。
- `model` 或 `thinking` 省略时，在创建时捕获直接父会话的当前值。
- 项目信任结果沿整棵树保持一致；模板不能重新确认或提升信任。
- 根 `/reload` 只更新未来创建所使用的模板快照，不回溯改变已运行节点；根和后代后续调用 `get_agent_templates` 都读取根权威发布的同一最新目录。

## 日常使用

### 创建后复用同一个代理

一个子代理可以处理多轮任务。例如先让它阅读某个模块，收到回复后再让它核对测试，不必每次重新创建。只要继续使用同一个 `agent_id`，子代理就会保留自身会话上下文。

这份上下文只存在于受监督的临时进程中；子 Pi 使用 `--no-session`，不会保存为可单独恢复的 Pi 会话。分支终止或根会话关闭后，不能再次恢复该节点。

### 工作中发送补充要求

`send_message` 会根据节点状态自动选择交付方式：

- 节点为 `idle` 时，消息作为新 prompt 开始一次处理；
- 节点为 `working` 或 `interrupting` 时，消息作为 steering 加入当前处理；
- 节点为 `failed`、`terminating` 或 `terminated` 时，消息会被拒绝。

工具成功只表示消息已被子 Pi 接受，不表示任务已经完成。子代理的普通 assistant 回复会自动显示在直接父会话，并触发父代理继续处理；`wait_agent` 只负责观察状态，不会重复取回回复。

### 等待、打断与终止

- `wait_agent`：等待节点 settled、进入稳定终态或超时。超时只结束这次等待，不打断节点。
- `interrupt_agent`：协作式中断当前处理，保留节点、上下文和后代。它不会自动升级为终止。
- `terminate_agent`：永久递归终止目标和全部后代，并同步等待资源回收确认。目标必须是调用者的直接子代理。

需要“暂停当前回答，稍后继续”时使用中断；确定不再使用该分支，或中断长期没有 settled 时使用终止。

### 递归委派与控制范围

默认 `maxDepth=2`：根会话深度为 0，可以创建深度 1 的 A；A 可以创建深度 2 的 A-1；A-1 是叶节点。只有 `depth < maxDepth` 且祖先没有设置 `subagents: disabled` 的节点才会看到完整的八工具集合。

每个父代理只能向自己的直接子代理发送消息、等待、中断、终止或查询状态。根代理可以只读查看整棵树；普通子代理只能只读查看自己的子树。展示名称只是给人看的标签，寻址始终使用 UUID 格式的 `agent_id`。

### 结束会话

显式调用 `terminate_agent` 最便于确认某个分支已回收。根会话关闭或切换时，扩展也会递归关闭现有代理树。已经 `terminated` 的记录仍可能在当前树面板中作为历史可见，但不再占用名额。

## 查看代理树

在交互式 TUI 中，编辑器上方的 `Agents` widget 会显示当前会话的直接、尚未终止的子代理，包括模板、名称、状态、活动类别、运行时长和 pending 数量。

输入以下命令打开当前可见作用域的完整只读树：

```text
/agent
```

面板操作：

| 按键 | 动作 |
| --- | --- |
| `↑` / `k` | 上移 |
| `↓` / `j` | 下移 |
| `→` / `l` | 展开选中分支或 `finished` |
| `←` / `h` | 折叠分支；已折叠时跳到父节点 |
| `Esc` | 关闭面板 |

折叠分支会显示后代数、工作中数量、故障数和 pending 汇总。`finished` 分组统计 `completed`、`failed` 和 `incomplete`。节点新进入 `failed`，或资源清理出现 `termination_incomplete` 时，TUI 还会显示聚合且脱敏的通知。

`/agent` 面板只在交互式 TUI 中打开。RPC 模式可以接收 widget 的 UI 数据；print/JSON 等无 UI 模式没有文本回退，可让模型调用 `get_agent_tree` 获取结构化快照。

## 运行配置

配置在根会话启动时读取一次，并固定给整棵代理树。普通用户可用的每个字段独立按以下优先级解析：

1. 已获信任项目的 `<cwd>/.pi/subagent.json`；
2. 用户级 `~/.pi/agent/subagent.json`；
3. 内置默认值。

例如：

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
| `maxDepth` | `2` | `1..8` | 根深度为 0 时允许创建的最大代理层级 |
| `maxChildrenPerAgent` | `4` | `1..16` | 每个父会话尚未终止的直接子代理上限 |
| `maxAgentsPerTree` | `16` | `1..64` | 根之外、尚未终止的全树节点上限 |
| `waitTimeoutMs` | `60000` | `10000..600000` | `wait_agent` 未显式传入超时时间时的默认毫秒数 |

项目未获信任时，项目配置完全不参与解析。缺失文件或字段会继续读取下一层；但某一已选中的配置层不可读、JSON 无效或字段值越界时，受影响字段直接采用内置默认值，不会再回退到更低优先级。未知字段会被忽略，并在可用的 TUI 中显示脱敏 warning。

修改配置后需开始新的根会话；`/reload` 会刷新模板和扩展资源，但不会重新解析并改变现有代理树的根配置。

达到限制时不会自动排队或回收：

- `max_depth_reached`：已达到深度上限；
- `max_children_reached`：当前父节点的直接子代理名额已满；
- `max_tree_agents_reached`：整棵树名额已满。

后两者在相关节点确认 `terminated` 并释放名额后可以重试。

## 工具参考

这些工具主要供模型调用。通常你只需用自然语言说明期望；当需要精确约束代理行为或排查问题时，可以参考下面的契约。

### `get_agent_templates`

列出根权威当前发现且格式有效的模板，不接受参数。没有有效模板时，成功正文直接是数组：

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

这个工具是其他管理工具成功外壳的明确例外：模型可见正文就是数组，不套 `{ "ok": true, "data": ... }`。每项只包含区分大小写的 `template_id`、可选 `description` 和始终存在的业务 `tools`；没有描述时省略该字段，合法空工具模板返回 `tools: []`。`tools` 不包含八个子代理管理工具，结果也不会公开模板正文、来源、模型、thinking、路径或无效模板诊断。

数组只说明模板格式有效，不代表当前父会话的模型、thinking 和管理能力预检一定通过。模板 `tools` 不执行父会话活动工具子集校验。返回 `[]` 时不能调用 `spawn_agent`；返回非空数组后，也应以 `spawn_agent` 的实际结果为准。

### `spawn_agent`

创建一个直接子代理，并等待它完成进程、监督通道和 Pi RPC 的启动握手。调用前必须先调用 `get_agent_templates`，再从当前返回项中原样复制 `template_id`。标识区分大小写，不得猜测、改写或使用 `description` 代替；模板 `tools` 是子代理的初始业务工具请求，不要求是父会话活动工具的子集。若目录返回 `[]`，不能调用本工具。

输入只包含模板标识和展示名称：

```json
{
  "template_id": "researcher",
  "name": "资料代理"
}
```

成功时节点已处于 `idle`，结果包含新分配的 `agent_id`、名称、模板、深度和状态。名称与模板标识的 UTF-8 长度都不能超过 256 字节。它不能同时携带任务、模型、工具、cwd 或配额；第一项任务必须另行调用 `send_message`。即使模板出现在查询结果中，本次创建仍可能因模型、thinking 或管理能力预检失败而返回 `template_capability_unavailable`。

### `send_message`

向一个直接子代理发送任务或 steering：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "检查鉴权入口，并列出相关测试。"
}
```

`message` 必须非空且不超过 16 KiB UTF-8。成功结果中的 `accepted: true` 只表示对应 Pi RPC 已接受消息。可选的 `images` 最多 8 张，每张使用原始 Base64 数据（不要带 `data:` URL 前缀）、`image/*` MIME，解码后不超过 24 KiB：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "分析这张截图。",
  "images": [
    {
      "type": "image",
      "data": "iVBORw0KGgoAAA...",
      "mimeType": "image/png"
    }
  ]
}
```

若返回 `message_delivery_failed`，交付状态可能无法确认。不要盲目自动重发；先查询节点状态并结合任务是否已有回复判断，以免重复执行。

### `wait_agent`

等待一个直接子代理：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000",
  "timeout_ms": 120000
}
```

`timeout_ms` 可省略，合法范围为 10,000 到 600,000 毫秒。返回的 `outcome` 为：

- `settled`：观察到了正常 settled 边界，或调用时节点已经空闲；
- `terminal`：节点已经或随后进入 `failed` / `terminated`；
- `timeout`：本次观察到期，节点继续保持原有工作。

### `interrupt_agent`

协作式打断直接子代理当前处理：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

对工作中的节点，成功接纳后通常进入 `interrupting`；工具不等待最终 settled。对已经空闲、正在中断或已进入终态的节点是幂等操作，可能返回 `changed: false`。

### `terminate_agent`

永久终止一个直接子代理及其全部已登记后代：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

该工具同步等待递归资源回收；成功结果包含是否进入过强制阶段的 `forced`，以及本次新终止的 `terminated_count`。重复终止已经回收的节点会幂等成功。若返回可重试的 `termination_incomplete`，表示仍有资源无法确认释放，应稍后再次对同一直接子代理调用终止。

### `get_agent_status`

立即读取一个直接子代理最近确认的安全快照，不发起模型或 RPC 请求：

```json
{
  "agent_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

快照包含模板、名称、深度、状态、pending、修订和观察时间。故障节点仍返回成功外壳，并在 `data.error` 中携带稳定错误码。

### `get_agent_tree`

读取调用者当前可见的完整代理树，不接受参数：

```json
{}
```

根会话看到整棵树；子代理只看到自身作用域根和后代。结果是按父节点优先排列的扁平快照，包含 `scope`、`tree_revision`、`observed_at` 和 `nodes`，但不包含消息正文、图片、路径、环境、进程标识或内部连接信息。

### 通用寻址和错误

所有定向工具都只允许操作调用者的直接子代理。`agent_id` 是规范小写 UUID，不能用展示名称替代。常见稳定错误码：

| 错误码 | 含义 | 建议 |
| --- | --- | --- |
| `invalid_argument` | 参数类型、范围、UUID 或多余字段不合法 | 按工具 schema 修正参数 |
| `agent_not_found` | UUID 格式正确，但当前代理树没有该标识 | 重新读取状态或树 |
| `not_direct_child` | 目标存在，但不是调用者的直接子代理 | 让它的直接父代理执行控制 |
| `template_not_found` | 没有选中对应模板 | 检查目录、文件名、trust 并 `/reload` |
| `template_invalid` | 选中的模板候选格式无效 | 修复 UTF-8、frontmatter 或字段 |
| `template_capability_unavailable` | 模板要求的模型、thinking 或管理能力不可用 | 调整模板或父会话能力 |
| `max_depth_reached` | 达到最大深度 | 提高新会话配置，或从更浅节点创建 |
| `max_children_reached` | 直接子代理名额已满 | 终止不用的直接子代理后重试 |
| `max_tree_agents_reached` | 全树名额已满 | 回收任一不用的分支后重试 |
| `spawn_failed` / `spawn_timeout` | 子 Pi 启动失败或未在期限内就绪 | 检查 Pi、模型、平台和资源 |
| `agent_unavailable` | 节点当前状态不接受该操作 | 查询状态，必要时终止 |
| `message_delivery_failed` | 无法确认消息交付 | 先观察，不要无条件重发 |
| `termination_incomplete` | 资源尚未完全确认回收 | 稍后重试终止 |
| `internal_error` | 控制器遇到已脱敏的内部故障 | 查看 UI 状态，保存可复现步骤 |

错误结果只公开稳定 `code`、安全说明、`retryable` 和空详情；不会把底层路径、凭据、句柄或堆栈交给模型。

如果刚更新了本地 package 或重新生成了 smoke tarball，请退出并重新启动根 Pi 会话。已经运行的会话不会自动替换扩展代码；安装包中的受管 bridge 会使用随包编译的入口，并从宿主 Pi CLI 解析 `RpcClient`，因此不需要在子 Pi 中关闭扩展发现。

## 生命周期

代理状态只有以下七种：

| 状态 | 含义 | 是否占用名额 |
| --- | --- | --- |
| `starting` | 已预留身份和名额，正在建立进程、监督通道和 RPC | 是 |
| `idle` | 已就绪且当前没有活动处理，可以接收新 prompt | 是 |
| `working` | 正在处理任务；新消息会作为 steering | 是 |
| `interrupting` | 已接受协作式中断，等待真正 settled；仍可排入 steering | 是 |
| `failed` | 发生不可自动恢复的运行或控制故障 | 是 |
| `terminating` | 终止屏障已建立，但资源尚未全部确认回收 | 是 |
| `terminated` | 本节点和后代均已确认回收 | 否 |

`failed` 不会自动恢复或重启，但仍需显式终止才能释放名额。`terminating` 也不是“已经结束”；它可能携带 `termination_incomplete`，并继续占用名额。只有 `terminated` 会真正释放直接子代理和全树配额。

`pending_message_count` 表示已经受理、但尚未开始实际处理的父消息数量，不包含当前活动 prompt。因此 `working` 节点的 pending 可以是 0。

## 安全与资源边界

### 扩展拥有宿主用户权限

Pi package 是在本机进程内执行的代码，这个扩展及其子 Pi 进程拥有启动 Pi 的操作系统用户权限。安装前应审查源码，并只在可信项目中启用项目级资源。

每个子代理都有独立模型上下文和模型调用，多个节点并行工作会相应增加 token、费用与本地资源占用。当前扩展没有 token/费用预算、空闲超时、创建速率或自动回收策略；不再需要的代理应显式终止。

### cwd 不是沙箱

整棵树固定使用根会话 cwd，但这只是路径解析和项目资源发现的基点，不是文件系统安全边界。只要模板暴露的工具与宿主权限允许，子代理仍可能通过绝对路径或 `..` 访问 cwd 外部内容。`contextFiles: disabled` 只禁止加载上下文说明文件，也不会撤销普通工具权限。

如需真正隔离不可信代码、仓库内容或模型操作，请在容器、虚拟机或其他操作系统级沙箱中运行整个 Pi 会话。

### 模板不能扩权

项目模板只有在 Pi 已信任该项目时才会读取。模板可以声明已注册的业务工具，不要求从直接父会话当前活动工具中取子集；它不能改变 project trust、环境、cwd 或配额，也不能突破祖先的 `subagents: disabled` 和 `maxDepth`。

### 进程树回收

Windows 适配器在目标进程运行前将它放入专用 Job Object；macOS/Linux 代码使用独立 process group/session。终止会先尝试优雅关闭，再在需要时强制处理整棵受监督子树，并且只有确认资源释放后才公开 `terminated`。

Windows 是当前开发验收的目标平台，但真实宿主组合下的本地 package 与进程资源验收由人工完成，仓库当前未提供已完成的生产验收报告。macOS/Linux 的原生 runner 与真实回收证据仍待独立验证。

### 状态与 UI 脱敏

公开状态、代理树、错误和 UI 活动只携带控制器确认的安全事实，不包含 prompt、回复正文、图片、文件路径、环境、凭据、进程号、管道/socket、句柄或堆栈。活动只显示 `editing`、`reading`、`running`、`researching`、`delegating` 或 `other` 等粗粒度类别和计数。

## 故障排查

### 没有出现工具、Agents widget 或 `/agent`

先检查：

```powershell
node --version
pi --version
pi list
```

- Node 必须至少是 `22.19.0`，Pi 必须至少是 `0.83.0`。
- 确认本地 package 路径仍存在，并且该目录已经安装 `semver`、`yaml` 等生产依赖。
- Windows 需要能从 `PATH` 调用 `powershell.exe`。
- 如果启动时出现 `host_capability_unavailable`，括号中的稳定原因可帮助区分版本、平台、运行依赖、进程树适配器或 Pi API 问题。
- 如果通过 `-e` 试用，确认本次启动确实带了扩展路径；如果持久安装，确认没有在 `pi config` 中禁用该扩展。

兼容门禁失败不会留下半套工具；修复环境后重启 Pi。

### `template_not_found`

- 先调用 `get_agent_templates`，只使用当前返回数组中的 `template_id`；不要根据描述或旧结果猜测标识。
- 用户模板应放在 `~/.pi/agent/agents`，不是 `~/.pi/agents`。
- 项目模板应放在启动 Pi 的 cwd 下的 `.pi/agents`，并要求该项目已获信任。
- 文件必须直属于目录、使用小写 `.md` 后缀，并以 UTF-8 保存。
- `template_id` 精确区分大小写，来自文件名而不是 frontmatter。
- 新增、删除或改名后执行根 `/reload`。

### `template_invalid` 或模板 warning

检查文件开头是否立即是 `---`，YAML 是否可解析且键不重复。尤其注意：

- `tools` 必须是字符串，例如 `tools: read, grep`，不能写成 YAML 数组；
- 空工具集只能写成双引号 `tools: ""`；
- 不要把 `get_agent_templates`、`spawn_agent` 等八个管理工具放进 `tools`；
- `model` 必须含 provider 和 model，例如 `openai/gpt-example`；
- thinking、`subagents`、`contextFiles` 和 `systemPromptMode` 必须使用文档列出的精确值；
- 无效的同名项目模板会遮蔽有效用户模板，不能靠用户模板自动回退。

TUI warning 只显示逻辑来源、直属文件名和固定原因，不显示绝对路径或 YAML 正文。

### `template_capability_unavailable`

模板本身合法，但当前父会话无法满足它：

- 确认显式模型仍存在，并处于 Pi 当前 scoped models 范围；
- 确认模型支持指定或继承到的 thinking；
- 如果问题来自递归创建，检查深度和祖先是否关闭了子代理能力。

业务工具不要求向父会话活动工具向下缩减；若模板列出未注册的工具名，则会在模板发现阶段得到 `template_invalid`。已有节点不会随模板变化重建。

### 配置看起来没有生效

- 配置文件必须是 UTF-8 JSON 对象，而不是带注释的 JSON 或 YAML。
- 项目文件仅在项目已信任时读取。
- 较高优先级层的无效值会直接采用内置默认值，不会回退到用户配置。
- 配额在根会话启动时冻结；修改 `subagent.json` 后应结束并新建根会话，单独执行 `/reload` 不会重读。

### `wait_agent` 超时

`outcome: "timeout"` 不是错误，也不会停止子代理。可以查询 `get_agent_status` 或 `get_agent_tree`，然后继续等待、发送 steering、调用 `interrupt_agent`，或在确定不再需要时调用 `terminate_agent`。

### 节点停在 `interrupting`、`failed` 或 `terminating`

- `interrupting`：子 Pi 尚未报告 settled；若长期不返回，显式终止。
- `failed`：节点不会自动恢复；查询错误码后终止以释放名额。
- `terminating`：清理尚未确认；如果错误为 `termination_incomplete`，稍后重试同一 `terminate_agent`。

## 本地开发

开发依赖已经锁定在 `package-lock.json` 中：

```powershell
npm ci --legacy-peer-deps
npm run check
```

`npm run check` 会先执行 TypeScript `--noEmit` 类型检查，再运行 Node 测试。测试不需要启动开发服务。

### 打包后安装到 Pi 测试

以下命令以扩展仓库 `D:\code\pi-subagent-wj` 和测试项目 `D:\code\your-project` 为例。请把测试项目路径替换成你的实际路径。Smoke 打包命令会读取当前包名和版本，生成 tarball，并将其安装到 `.scratch\package-smoke`；版本变化后不需要修改命令。

1. 进入扩展源码目录：

   ```powershell
   Set-Location "D:\code\pi-subagent-wj"
   ```

2. 安装开发依赖：

   ```powershell
   npm ci --legacy-peer-deps
   ```

3. 执行完整检查：

   ```powershell
   npm run check
   ```

4. 生成 tarball 并安装到隔离测试目录：

   ```powershell
   npm run pack:smoke
   ```

5. 进入需要测试的项目：

   ```powershell
   Set-Location "D:\code\your-project"
   ```

6. 把隔离目录中的 package 安装到当前 Pi 项目：

   ```powershell
   pi install "D:\code\pi-subagent-wj\.scratch\package-smoke\node_modules\pi-subagent" -l
   ```

   如果 Pi 提示项目未信任，并且你明确同意信任当前项目，则改用：

   ```powershell
   pi install "D:\code\pi-subagent-wj\.scratch\package-smoke\node_modules\pi-subagent" -l --approve
   ```

7. 确认 package 已登记：

   ```powershell
   pi list
   ```

8. 启动 Pi：

   ```powershell
   pi
   ```

9. 进入 Pi 后打开代理树，确认扩展已经加载：

    ```text
    /agent
    ```

#### 测试完成后清理

1. 退出 Pi，回到 PowerShell 后移除项目级 package：

   ```powershell
   pi remove "D:\code\pi-subagent-wj\.scratch\package-smoke\node_modules\pi-subagent" -l
   ```

2. 返回扩展源码目录：

   ```powershell
   Set-Location "D:\code\pi-subagent-wj"
   ```

3. 核对即将删除的测试目录：

   ```powershell
   Resolve-Path -LiteralPath "D:\code\pi-subagent-wj\.scratch\package-smoke"
   ```

4. 仅在上一步输出完全符合预期时，删除隔离测试目录：

   ```powershell
   Remove-Item -LiteralPath "D:\code\pi-subagent-wj\.scratch\package-smoke" -Recurse -Force
   ```

项目的实现规格与决策背景位于：

- [领域上下文](./CONTEXT.md)
- [代理模板与完整产品规格](./.scratch/pi-subagent-spec/spec.md)
- [架构决策记录](./docs/adr/)
