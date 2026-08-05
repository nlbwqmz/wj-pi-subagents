# Pi 代理模板惯例研究

## 研究范围与版本

本报告只检查 Pi 上游官方仓库 `https://github.com/earendil-works/pi.git` 在提交 [`a96fb984d8c8b065fc5d193309fc812a882adee0`](https://github.com/earendil-works/pi/commit/a96fb984d8c8b065fc5d193309fc812a882adee0) 的源码、官方文档和 `packages/coding-agent/examples` 第一方示例。

本地工作副本确认该提交是 `main` 当前提交；该提交自身只修改 `.github/APPROVED_CONTRIBUTORS`，所以模板行为来自该提交所指向的整棵源码树，而不是该提交的变更内容。

源文件路径以下均相对于 `D:\\code\\open-source\\pi`。链接固定到上述提交，避免后续 `main` 变化导致证据漂移。

## 结论摘要

1. **Pi 核心没有原生的“代理模板”或子代理 API。** 核心 README 明确写着 “No sub-agents”，并把这类工作流交给扩展、包或外部进程；官方使用文档也明确说核心不包含内置 sub-agents。第一方代理模板实现是 `packages/coding-agent/examples/extensions/subagent` 下的扩展示例，不是核心公开契约。
2. **第一方示例的代理定义确实是 Markdown 文件。** 文件使用 YAML frontmatter，正文作为代理的追加系统提示词。示例 README 把该格式直接称为 “Agents are markdown files with YAML frontmatter”。
3. **示例字段只有四个来自文件的字段：** `name`、`description`、可选的逗号分隔 `tools`、可选的 `model`；frontmatter 结束后的 Markdown 正文映射为 `systemPrompt`。`source` 和 `filePath` 是加载器运行时派生字段，不是文件字段。
4. **示例加载器的校验很宽松。** `name` 和 `description` 缺失时跳过文件；读取失败时跳过文件；frontmatter 的 YAML 解析错误没有在代理加载器内捕获，会向上抛出；没有工具名、模型名、字段类型或未知字段的严格 schema 校验。
5. **示例把工具配置传给 Pi 的 `--tools` allowlist，但 Pi 核心对未知工具名采取“忽略”，不是“失败”。** 因此“模板声明的工具若不在创建者有效工具集中就拒绝创建子代理，不能削减后继续创建”是当前项目要新增的规范决策，不能声称是 Pi 上游既有行为。
6. **上游示例还允许调用时覆盖子进程 `cwd`。** `TaskItem`、`ChainItem` 和单次调用参数都带有 `cwd`，子进程使用 `cwd ?? defaultCwd`。这与本项目已经确认的“整棵代理树固定根工作目录”不同，应视为示例实现细节，而非必须继承的上游契约。

## 证据一：核心契约与第一方示例的边界

### 核心明确不内置子代理

核心 README 的 Philosophy 部分说 Pi 把工作流行为放到扩展、技能和包中，并明确列出 “No sub-agents”，建议通过启动多个 Pi、扩展或包实现：[README.md:492-500](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/README.md#L492-L500)。官方使用文档重复这一边界：核心不包含内置 sub-agents，应通过扩展、包或外部工具构建：[docs/usage.md:297-301](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L297-L301)。

源码中也没有核心导出的 `AgentConfig`、`discoverAgents` 或代理模板资源类型；核心 SDK 导出的相关文件资源类型是 `PromptTemplate`，而不是代理定义：[src/core/sdk.ts:97-126](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L97-L126)。这说明下文格式是**第一方扩展示例惯例**，不是 Pi 核心稳定 API。

### 官方示例的目录与职责

示例 README 的结构把 `index.ts` 标为扩展入口、`agents.ts` 标为代理发现逻辑、`agents/` 标为代理定义、`prompts/` 标为工作流提示模板：[examples/extensions/subagent/README.md:14-30](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/README.md#L14-L30)。扩展通过单独的 `pi` 子进程执行代理，并传入系统提示和工具/模型配置：[README.md:55-65](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/README.md#L55-L65)。

因此应区分两种 Markdown：

- `agents/*.md`：代理定义，带 `name`、`description` 等代理配置 frontmatter，正文是系统提示词。
- `prompts/*.md`：主会话可调用的工作流提示模板，只是 prompt template，不代表代理配置。示例中的 workflow prompt 只有 `description` frontmatter 和正文：[examples/extensions/subagent/prompts/implement.md:1-10](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/prompts/implement.md#L1-L10)。

## 证据二：代理 Markdown 文件格式

### README 明示的格式

官方第一方 README 给出完整样例：[examples/extensions/subagent/README.md:125-138](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/README.md#L125-L138)：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

示例代理文件与 README 完全一致。例如 `planner.md` 使用四个 frontmatter 字段并把行为要求放在正文：[agents/planner.md:1-10](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents/planner.md#L1-L10)；`worker.md` 省略 `tools`，正文仍是系统提示词：[agents/worker.md:1-9](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents/worker.md#L1-L9)。

### 文件字段与运行时字段

示例加载器定义的 `AgentConfig` 如下：[agents.ts:9-24](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L9-L24)。

| 字段 | 是否来自 frontmatter | 示例语义 |
| --- | --- | --- |
| `name` | 是，必需 | 代理调用名；不使用文件名作为名称 |
| `description` | 是，必需 | 代理列表中的说明 |
| `tools` | 是，可选 | 一个字符串，按逗号拆成工具名数组 |
| `model` | 是，可选 | 原样传给子 Pi 的 `--model` |
| 正文 | 否 | `systemPrompt`，作为追加系统提示词 |
| `source` | 否，运行时派生 | `user` 或 `project` |
| `filePath` | 否，运行时派生 | 代理文件路径 |

加载器在读取文件后调用共享 `parseFrontmatter<Record<string, string>>`，检查 `name` 和 `description`，再把 `tools` 以逗号切分、去空白、过滤空项，把正文放入 `systemPrompt`：[agents.ts:40-74](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L40-L74)。这里的 TypeScript 泛型只是编译期断言；运行时没有 JSON Schema、TypeBox 或其他字段类型校验。

### `tools` 的具体表现

README 和样例都使用逗号分隔的单一 frontmatter 标量，而不是 YAML 数组：[README.md:127-138](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/README.md#L127-L138)、[agents/scout.md:1-6](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents/scout.md#L1-L6)。省略 `tools`（如 `worker.md`）时，加载器留下 `undefined`；调用器因而不传 `--tools`，子 Pi 使用自己的默认工具策略：[index.ts:294-297](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/index.ts#L294-L297)。这与显式空列表的语义不能混为一谈：当前示例没有定义“显式无工具”的 frontmatter 表达。

### 未声明字段

示例只从 frontmatter 读取 `name`、`description`、`tools`、`model`；其他键不会进入 `AgentConfig`，也不会触发错误：[agents.ts:52-70](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L52-L70)。因此本项目若增加 `subagents: inherit | disabled`，它是本项目的新规范字段，不能说是 Pi 官方已有字段。

## 证据三：发现目录、作用域与覆盖

### 路径

示例 README 记录了两类目录：用户级 `~/.pi/agent/agents/*.md`，项目级 `.pi/agents/*.md`：[README.md:140-144](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/README.md#L140-L144)。安装步骤也明确把示例代理链接到 `~/.pi/agent/agents`：[README.md:42-46](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/README.md#L42-L46)。

代码没有把项目目录硬编码为 `.pi`，而是使用核心导出的 `CONFIG_DIR_NAME`，从当前 `cwd` 向父目录逐级查找最近的 `<dir>/{CONFIG_DIR_NAME}/agents`：[agents.ts:77-95](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L77-L95)。用户目录则是 `getAgentDir()/agents`：[agents.ts:97-102](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L97-L102)；核心默认 `getAgentDir()` 为 `~/{CONFIG_DIR_NAME}/agent`，可由环境变量覆盖：[src/config.ts:491-520](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/config.ts#L491-L520)。

### 作用域和同名覆盖

`AgentScope` 只有 `user`、`project`、`both` 三个值：[agents.ts:9-9](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L9-L9)。默认值在工具参数 schema 中是 `user`：[index.ts:443-446](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/index.ts#L443-L446)。`both` 模式先放入用户代理，再放入项目代理；同名项目代理覆盖用户代理：[agents.ts:104-115](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L104-L115)。

项目代理被视为仓库控制的提示词。交互模式默认在运行项目代理前确认，调用参数可用 `confirmProjectAgents: false` 关闭确认：[README.md:55-65](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/README.md#L55-L65)、[index.ts:505-528](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/index.ts#L505-L528)。这是扩展示例的输入信任流程，不是核心文件系统权限沙箱。

## 证据四：解析与校验行为

### 共享 frontmatter 解析器

Pi 核心共享解析器使用 `yaml` 包。只有内容以 `---` 开始并找到后续换行加 `---` 的结束标记时才提取 frontmatter；正文会做 `trim()`；没有 frontmatter 或没有结束标记时，原内容作为正文返回：[src/utils/frontmatter.ts:8-37](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/utils/frontmatter.ts#L8-L37)。核心测试确认非法 YAML 会抛出异常：[test/frontmatter.test.ts:20-23](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/test/frontmatter.test.ts#L20-L23)，也确认 CRLF 会规范化、缺失结束标记会保留原内容：[test/frontmatter.test.ts:14-18](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/test/frontmatter.test.ts#L14-L18)、[test/frontmatter.test.ts:32-41](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/test/frontmatter.test.ts#L32-L41)。

### 代理加载器的宽松规则

加载器的实际行为如下：

- 不存在的目录、目录读取失败、文件读取失败：返回当前已加载结果或跳过文件：[agents.ts:26-50](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L26-L50)。
- 只处理目录直接项中后缀为 `.md` 的普通文件或符号链接；不递归子目录：[agents.ts:40-44](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L40-L44)。
- `name` 或 `description` 缺失：静默跳过，不返回诊断：[agents.ts:52-56](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L52-L56)。
- 非法 YAML：`parseFrontmatter` 会抛出，但 `loadAgentsFromDir` 没有包住这段调用，因此该错误不会像文件读取错误那样被静默跳过：[agents.ts:45-53](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L45-L53)、[src/utils/frontmatter.ts:28-37](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/utils/frontmatter.ts#L28-L37)。
- `tools` 只做字符串 `split(",")`、`trim()` 和去空值：[agents.ts:58-67](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/agents.ts#L58-L67)。如果 YAML 写成数组或其他非字符串值，示例没有运行时类型保护。
- 不校验名称格式、工具是否注册、模型是否存在、正文是否非空，也不拒绝未知 frontmatter 键；模型和工具到真正启动子进程时才被使用。

## 证据五：子进程启动、工具可见性与硬失败差异

### 示例如何把配置传给子 Pi

`runSingleAgent` 找到代理后，把 `model` 作为 `--model`、非空 `tools` 作为 `--tools <逗号列表>` 传给子进程；正文写入临时 Markdown 文件，再用 `--append-system-prompt` 传入：[examples/extensions/subagent/index.ts:267-328](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/index.ts#L267-L328)。找不到代理时才在扩展层返回 `Unknown agent` 错误：[index.ts:278-291](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/index.ts#L278-L291)。

### 当前目录不是固定继承

示例 schema 给单次、并行任务和链式任务都提供 `cwd`（单次模式另有顶层 `cwd`），子进程实际使用 `cwd ?? defaultCwd`：[index.ts:431-458](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/index.ts#L431-L458)、[index.ts:330-339](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/examples/extensions/subagent/index.ts#L330-L339)。本项目已经确定的根 `cwd` 固定规则应覆盖这个示例便利项。

### Pi 核心 `--tools` 不是创建前硬校验

核心 CLI 把 `--tools` 解析成逗号分隔的名称数组，并把它描述为适用于内置、扩展和自定义工具的 allowlist：[src/cli/args.ts:118-131](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/cli/args.ts#L118-L131)、[src/cli/args.ts:272-277](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/cli/args.ts#L272-L277)。SDK 也把 `tools` 定义为“提供后只启用列出的名称”：[src/core/sdk.ts:54-73](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L54-L73)。

但实现是在工具注册表建立后按 allowlist 过滤，未知名称不会触发创建失败：[src/core/agent-session.ts:2458-2489](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L2458-L2489)。`setActiveToolsByName` 的核心注释更直接写明“Unknown tool names are ignored”，并只把注册表中找到的名称加入活动工具：[src/core/agent-session.ts:913-934](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L913-L934)。核心内置工具名集合虽然是固定的七个名称，但 `createAgentSession` 仍采用过滤而非模板验证：[src/core/tools/index.ts:81-113](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/tools/index.ts#L81-L113)、[src/core/sdk.ts:245-251](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L245-L251)。

所以当前上游行为是：模板声明 `read,missing_tool` 时，子 Pi 仍会启动，但 `missing_tool` 被忽略；它不是“模板无效”或“子代理创建失败”。这与本项目用户已经提出的要求相反。

## 证据六：核心 Prompt Template 格式的可借鉴范围

Pi 核心正式支持的 Prompt Template 本身也是 Markdown 文件，位置包括用户级 `~/.pi/agent/prompts/*.md`、项目级 `.pi/prompts/*.md`、包目录和显式路径：[docs/prompt-templates.md:3-17](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/prompt-templates.md#L3-L17)。其 frontmatter 示例只有可选的 `description`，正文是要展开的 prompt：[docs/prompt-templates.md:19-33](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/prompt-templates.md#L19-L33)。核心加载器同样使用 Markdown、共享 frontmatter parser、非递归扫描和读取失败跳过：[src/core/prompt-templates.ts:8-18](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/prompt-templates.ts#L8-L18)、[src/core/prompt-templates.ts:104-174](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/prompt-templates.ts#L104-L174)。

这能支持“模板采用 `.md` + YAML frontmatter + 正文”的整体方向，但不能把 Prompt Template 的 `description` 规则直接当成代理模板契约：代理示例额外要求 frontmatter 中必须有 `name` 和 `description`，并使用 `tools`、`model` 两个代理专属字段。

## 对本项目规范的直接建议

以下是基于上述证据、并结合当前会话已确认决策的落地建议；这些是本项目的规范选择，不声称是 Pi 上游已有契约：

1. **文件载体：** 采用 `.md` 文件，首段用 YAML frontmatter，结束标记后的正文作为系统提示词。这样与 Pi 第一方代理示例和核心 Prompt Template 的共同惯例一致。
2. **字段边界：** 可以保留 `name`、`description`、`model`、`tools`，并把已经确认的 `subagents: inherit | disabled` 明确记录为本项目新增字段。建议在规范中定义字段类型、未知字段处理和空正文行为，而不要照搬示例的隐式宽松处理。
3. **工具表示：** 上游示例使用逗号分隔标量（`tools: read, grep, find`），不是 YAML 数组。若追求上游迁移便利，可兼容该写法；无论采用标量还是数组，都应在本项目规范中固定一种规范化结果。
4. **严格创建前检查：** 解析出模板后，在创建子代理前计算模板请求工具集与创建者当前有效工具集的差集；差集非空时返回结构化模板无效/能力不足错误，整个子代理不创建，不把请求工具静默削减后继续执行。应同时拒绝模板中未知名称、祖先不可见名称和已被父会话移除的名称。
5. **原子性：** 并行任务和链式任务应在启动第一个子代理前预验证所有模板引用，避免先创建部分子代理后才发现后续模板工具不满足。上游示例只在运行到步骤时启动，未提供这种能力验证，因此这里属于新增安全语义。
6. **省略 `tools` 的语义要单独写清：** 上游示例省略时不传 `--tools`，子 Pi 使用默认工具；如果本项目要采用父会话工具集继承或“空集合”语义，必须显式定义，不能从上游的 `undefined` 推断。
7. **错误处理：** 建议把非法 YAML、缺失必填字段、类型错误、未知工具、模型不可用分别转换为可定位的 `template_invalid` / `capability_unavailable` 诊断。上游示例对缺字段静默跳过、对 YAML 异常直接上抛，适合示例但不适合树状代理协议。
8. **工作目录：** 忽略示例的 `cwd` 覆盖参数，遵循本项目已经确认的根会话固定 `cwd`；这不会改变 Pi 官方“工作目录不是沙箱”的事实。Pi 官方安全文档明确说项目信任不是沙箱、内置工具按启动用户权限运行：[docs/security.md:3-8](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/security.md#L3-L8)、[docs/security.md:31-37](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/security.md#L31-L37)。

## 正式程度判定

| 事项 | 上游证据 | 判定 |
| --- | --- | --- |
| Pi 核心不内置 sub-agent | 核心 README、usage 文档 | 正式产品边界 |
| Prompt Template 是 `.md` + frontmatter | 核心文档和 `src/core/prompt-templates.ts` | 核心公开能力 |
| 代理定义是 `.md` + YAML frontmatter | `examples/extensions/subagent/README.md`、`agents.ts` | 第一方示例惯例，不是核心 API |
| 代理字段 `name/description/tools/model` | `examples/extensions/subagent/agents.ts` | 第一方示例字段协议 |
| 用户级/项目级 `agents` 目录及同名覆盖 | 示例 README、`agents.ts` | 第一方扩展实现约定 |
| 未知工具名被忽略 | 核心 SDK/session 实现 | 当前 Pi 工具 allowlist 行为 |
| 工具不满足则拒绝创建子代理 | 未发现上游实现 | 本项目新增规范，不能引用为既有惯例 |
| `subagents: inherit | disabled` | 未发现上游实现 | 本项目新增规范字段 |
| 固定根 `cwd` | 上游示例反而允许调用时覆盖 | 本项目已确认的独立规范 |

