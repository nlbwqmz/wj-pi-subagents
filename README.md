# wj-pi-subagents

`wj-pi-subagents` 是面向 [Pi](https://github.com/earendil-works/pi-mono) 的递归子代理插件。它可以在当前会话中创建独立子代理，将分析、实现、测试或评审等任务分开处理，并由父代理统一协调结果。

## 使用前说明

本插件仅提供子代理的创建、协作与生命周期管理能力，不内置子代理模板，也不预设固定工作流。首次使用前，请根据实际任务自行创建模板，按需定义代理角色、可用工具、模型与递归权限。

## 插件特色

- **递归代理树**：根代理可以创建子代理，获得授权且未达到深度上限的子代理还可以继续创建下一层代理。
- **独立上下文**：每个子代理运行在独立的 Pi 会话中，不复制父会话历史，适合隔离大任务和减少上下文干扰。
- **模板化配置**：通过 Markdown 模板指定提示词、工具、扩展、模型、思考等级和递归权限。
- **并行协作**：无依赖、无资源冲突的任务可以交给多个子代理并行处理。
- **上下文复用**：同一个子代理可以连续接收任务，并保留自己的会话上下文。
- **受控管理**：父代理只能管理自己的直接子代理，支持等待、查询、中断、复用和终止。
- **状态可视化**：TUI 会显示直接子代理状态，`/agents` 可查看当前会话范围内的完整代理树。
- **原生上下文压缩**：依赖 Pi `>= 0.84.4` 的 post-tool 压缩流程，每个根会话和子代理由各自的 Pi 会话独立管理上下文。

## 运行要求

| 项目 | 要求 |
| --- | --- |
| Node.js | `>= 22.19.0` |
| Pi | `>= 0.84.4`，包名为 `@earendil-works/pi-coding-agent` |
| 模型 | 根会话需要已选择并配置可用模型 |
| Windows | 需要 Bash，推荐 Git for Windows；还需可从 `PATH` 调用 `powershell.exe` |

## 安装

### 用户级安装

为当前用户的所有 Pi 项目启用：

```bash
pi install npm:wj-pi-subagents
```

### 项目级安装

只为当前项目启用：

```bash
cd <PROJECT_DIR>
pi install npm:wj-pi-subagents -l
```

项目级安装会写入 `<PROJECT_DIR>/.pi/settings.json`，项目获得 Pi 授权后才会加载。

### 临时使用

只在本次 Pi 进程中加载：

```bash
cd <PROJECT_DIR>
pi -e npm:wj-pi-subagents
```

安装完成后可通过以下命令确认：

```bash
pi list
```

## 快速开始

### 1. 创建代理模板

用户级模板放在：

```text
<USER_HOME>/.pi/agent/agents/*.md
```

项目级模板放在：

```text
<PROJECT_DIR>/.pi/agents/*.md
```

例如创建 `researcher.md`：

```markdown
---
description: 只读分析代码、文档和测试
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

文件名去掉 `.md` 后就是模板 ID。本例的模板 ID 为 `researcher`。

### 2. 启动或重载 Pi

在目标项目中启动 Pi：

```bash
cd <PROJECT_DIR>
pi
```

新增或修改模板后执行：

```text
/reload
```

`/reload` 会刷新模板，已经创建的子代理仍保留原有配置。

### 3. 委派任务

直接用自然语言说明模板、任务和期望结果即可：

```text
创建 researcher 子代理，名称为“鉴权分析”，检查鉴权入口、权限判断和相关测试。
等待它完成后，汇总结论并列出涉及的文件。
```

需要并行处理时，应明确拆分互不依赖、不会修改同一资源的任务：

```text
分别创建两个 researcher 子代理：
一个检查服务端鉴权流程，另一个检查前端登录状态管理。
并行等待两者完成后汇总结论。
```

Pi 会自行调用插件工具完成模板查询、代理创建、任务发送和结果等待，无需手工填写工具参数。

## 查看代理状态

TUI 中的 `Agents` 区域会显示当前会话的直接子代理。输入以下命令可查看代理树：

```text
/agents
```

根会话可以查看整棵代理树；子代理只能查看自己的子树。父代理只能操作自己的直接子代理。

## 代理模板

### 模板来源

| 作用域 | 路径 | 说明 |
| --- | --- | --- |
| 用户级 | `<USER_HOME>/.pi/agent/agents/*.md` | 对所有项目可用 |
| 项目级 | `<PROJECT_DIR>/.pi/agents/*.md` | 仅在项目获得 Pi 授权后可用 |

模板目录只读取直属的、小写 `.md` 文件，不递归扫描子目录。项目模板与用户模板同名时，项目模板优先。模板 ID 区分大小写。

### 模板字段

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `description` | 是 | 无 | 模板用途说明 |
| `tools` | 否 | 使用 Pi 默认工具 | 子代理可用的业务工具列表 |
| `extensions` | 否 | 使用 Pi 默认扩展发现 | 子代理额外加载的扩展来源 |
| `allowSubagents` | 否 | `true` | 是否允许继续创建下一层子代理 |
| `contextFiles` | 否 | `true` | 是否加载 `AGENTS.md`、`CLAUDE.md` 等上下文文件 |
| `systemPromptMode` | 否 | `append` | `append` 追加模板正文，`replace` 替换基础提示词 |
| `model` | 否 | 继承父代理当前模型 | 格式为 `provider/model` |
| `thinking` | 否 | 继承父代理当前等级 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

模板使用严格 YAML frontmatter，只支持上表字段。正文是子代理的角色提示词。

`tools` 和 `extensions` 的省略与空数组含义不同：

| 写法 | 行为 |
| --- | --- |
| 省略 `tools` | 使用 Pi 正常的工具选择 |
| `tools: []` | 不提供业务工具，仅保留子代理运行所需工具 |
| 省略 `extensions` | 使用 Pi 正常的扩展发现规则 |
| `extensions: []` | 关闭普通扩展发现，仅加载本插件自身 |

完整示例：

```markdown
---
description: 实现指定模块并完成自检
tools:
  - read
  - edit
  - write
  - bash
allowSubagents: false
contextFiles: true
systemPromptMode: append
model: openai/gpt-5.4
thinking: high
---

先确认现有实现和约束，再完成修改。保持改动范围集中，并在提交结果前执行相关检查。
```

## 运行配置

运行配置可放在以下位置：

```text
<USER_HOME>/.pi/agent/wj-pi-subagents.json
<PROJECT_DIR>/.pi/wj-pi-subagents.json
```

已获授权的项目配置优先于用户配置。未提供配置时使用默认值：

```json
{
  "maxDepth": 2,
  "maxChildrenPerAgent": 4,
  "maxAgentsPerTree": 16,
  "waitTimeoutMs": 60000
}
```

| 字段 | 默认值 | 范围 | 说明 |
| --- | ---: | ---: | --- |
| `maxDepth` | `2` | `1..8` | 最大子代理层级，根会话为第 0 层 |
| `maxChildrenPerAgent` | `4` | `1..16` | 每个代理可保留的直接子代理数量 |
| `maxAgentsPerTree` | `16` | `1..64` | 整棵树中未终止的子代理数量 |
| `waitTimeoutMs` | `60000` | `10000..600000` | 默认等待时间，单位为毫秒 |

运行配置在根会话启动时读取。修改后需要退出并重新启动 Pi，`/reload` 不会重新读取这些配置。

## 上下文压缩

Pi `>= 0.84.4` 会在工具执行结束后通过原生 post-tool 流程判断并执行上下文压缩。根会话和每个子代理都是独立的 Pi 会话，各自根据实际上下文状态完成压缩和后续执行，无需额外安装插件或配置协调协议。

本插件观察 Pi 原生的压缩生命周期事件和 `get_state.isCompacting`，用于校准代理状态及 TUI 活动提示。父端发往子 Pi 的消息仍由 Pi 命令响应裁决；如果 Pi 正在压缩并拒绝消息，调用方会收到可重试的 `compaction_active`。Pi 0.84.4 没有 `abort_compaction` RPC，因此压缩期间的中断会根据当前原生压缩观察返回 `compaction_active`，不会调用无法取消压缩的普通 `abort`。子端回复使用 Pi 的 fire-and-forget 扩展消息 API，其成功结果只表示父扩展运行时已接受提交。

## 更新与卸载

更新插件：

```bash
pi update --extension npm:wj-pi-subagents
```

删除用户级安装：

```bash
pi remove npm:wj-pi-subagents
```

删除项目级安装：

```bash
cd <PROJECT_DIR>
pi remove npm:wj-pi-subagents -l
```

## 使用边界

- 子代理与当前 Pi 进程使用相同的操作系统用户权限。
- 工作目录用于项目资源发现和相对路径解析，不是文件系统沙箱。
- 模板中的 `tools` 只限制模型可调用的工具，不限制进程本身的系统权限。
- Pi 插件可以执行本机代码，只应安装可信且已审查的来源。
- 处理不可信代码时，应在容器、虚拟机或其他隔离环境中运行 Pi。

## 开发与调试

获取源码并安装依赖：

```bash
git clone https://github.com/nlbwqmz/wj-pi-subagents.git
cd wj-pi-subagents
npm ci --legacy-peer-deps
```

常用检查命令：

```bash
npm run typecheck
npm test
npm run check
```

本项目不需要开发服务器。在目标项目中临时加载源码：

```bash
cd <PROJECT_DIR>
pi --verbose -e "<REPOSITORY_PATH>"
```

修改源码或模板后执行 `/reload`。修改 `wj-pi-subagents.json` 后需要重新启动 Pi。

## 许可证

本项目采用 [MIT License](./LICENSE)。
