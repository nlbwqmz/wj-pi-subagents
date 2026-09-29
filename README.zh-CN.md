<div align="center">

# 🌳 wj-pi-subagents

[English](README.md) | [简体中文](README.zh-CN.md)

**[Pi](https://github.com/earendil-works/pi-mono) 的多级子代理编排插件**

无内置模板 · 无预设工作流 · 一切由你塑造

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2022.19.0-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D%200.85.1-2563EB)](https://github.com/earendil-works/pi-mono)

</div>

## 📖 简介

`wj-pi-subagents` 在当前 Pi 会话内创建相互独立的子代理，将分析、实现、测试或评审等任务分离开来，由父代理统筹结果。获得授权的子代理还可以继续创建下一级代理，形成多级代理树。

> 💡 **本插件不内置任何子代理模板，也不预设任何工作流。**
> 首次使用前，请先创建你自己的模板，自由定义每个代理的角色、可用工具、模型以及多级权限。
> 插件只负责组织代理树 —— 代理之间如何协作，完全由你决定。

## ✨ 亮点特性

| | 特性 | 说明 |
| --- | :---: | --- |
| 🌳 | **多级代理树** | 根代理创建子代理；未达到深度限制且获得授权的子代理可依次创建下一级代理 |
| 🧩 | **完全可定制** | 无内置模板、无预设工作流 —— 通过 Markdown 模板自由定义提示词、工具、扩展、模型、思考等级与多级权限 |
| 📦 | **独立上下文** | 每个子代理都运行在各自的 Pi 会话中，不复制父级历史，适合隔离大型任务、减少上下文噪音 |
| ⚡ | **并行协作** | 没有依赖或资源冲突的任务，可以委派给多个子代理并行执行 |
| ♻️ | **上下文复用** | 同一个子代理可以连续承接任务，并保留自己的会话上下文 |
| 🎛️ | **受控管理** | 父代理只能管理其直接子级，支持等待、状态查询、中断、复用与终止 |
| 👁️ | **状态可见** | TUI 展示直接子代理的状态；`/agents` 展示当前会话范围内的完整代理树 |
| 🔭 | **实时动态查看器** | 在树中的任意代理上按 `Enter`，即可实时观看它的工作过程 |
| 🗜️ | **原生上下文压缩** | 依赖 Pi `>= 0.85.1` 的工具执行后压缩流程；每个根会话和子代理都通过自己独立的 Pi 会话管理上下文 |

## 📦 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | `>= 22.19.0` |
| Pi | `>= 0.85.1` |

## 🚀 安装

### 用户级安装

为当前用户的所有 Pi 项目启用：

```bash
pi install npm:wj-pi-subagents
```

### 项目级安装

仅为当前项目启用：

```bash
cd <PROJECT_DIR>
pi install npm:wj-pi-subagents -l
```

> 项目级安装会写入 `<PROJECT_DIR>/.pi/settings.json`；只有在项目获得 Pi 授权后才会加载。

### 临时使用

仅为本次 Pi 进程加载：

```bash
cd <PROJECT_DIR>
pi -e npm:wj-pi-subagents
```

使用以下命令验证安装：

```bash
pi list
```

## 🏁 快速开始

### 1️⃣ 创建代理模板

用户级模板存放于：

```text
<PI_AGENT_DIR>/agents/*.md
```

`<PI_AGENT_DIR>` 是 Pi 的用户级代理目录：跟随 `PI_CODING_AGENT_DIR` 环境变量；该变量未设置或为空串时回退 `<USER_HOME>/.pi/agent`。

项目级模板存放于：

```text
<PROJECT_DIR>/.pi/agents/*.md
```

例如，创建 `researcher.md`：

```markdown
---
description: Read-only analysis of code, docs, and tests
tools:
  - read
  - grep
  - find
  - ls
allowSubagents: false
contextFiles: true
systemPromptMode: append
---

Read the relevant implementation and tests first, then give conclusions with file locations. Do not modify files.
```

模板 ID 即去掉 `.md` 扩展名后的文件名。本例中的模板 ID 为 `researcher`。

### 2️⃣ 启动或重载 Pi

在目标项目中启动 Pi：

```bash
cd <PROJECT_DIR>
pi
```

新增或修改模板后，执行：

```text
/reload
```

`/reload` 会刷新模板；已创建的子代理保持原有配置不变。

## 👀 查看代理状态

只要当前会话中存在子代理，输入框上方就会常驻一个 `Agents` 区域。每个尚未终止的直接子代理在此占一行：先是实时状态图标（工作时为动态旋转指示），其后依次为模板、名称、状态、活动阶段、上下文用量与耗时。当子代理全部消失时，该区域随之隐藏：

```text
● Agents
├─ ⠋ researcher · explore-auth · working · processing · 12.3%/200k · 2m 14s
└─ ○ worker · fix-tests · idle · 0s
```

执行以下命令打开代理树面板：

```text
/agents
```

根会话可以查看整棵代理树；子代理只能查看自己的子树。父代理只能操作其直接子级。

代理树面板内部：

```text
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ AGENT TREE                                 REV 7 ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ › ▾ worker · fix-tests · working · processing    ┃
┃     · reviewer · review-pr · idle                ┃
┃   ▸ researcher · explore-auth · idle             ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ ↑↓ scroll · ←→ fold · Home/End jump · Esc close  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

| 按键 | 操作 |
| --- | --- |
| `↑` / `↓` | 移动选中项 |
| `←` / `→` | 折叠 / 展开分支 |
| `Home` / `End` | 跳转到首行 / 末行 |
| `Enter` | 打开所选代理的实时动态查看器 |
| `Esc` | 关闭面板 |

在 Pi 的全屏 TUI 模式（启动时加 `--tui-mode fullscreen`，或在 `/settings` 中切换 TUI 模式）下支持鼠标操作：滚轮滚动，点击选中一行，再次点击已选中的行则折叠或展开其子级。在普通模式下，鼠标由终端接管，请使用键盘。

## 🔭 实时动态查看器

想了解子代理在 `working` 状态背后究竟在做什么？在树中选中任意代理 —— 直接子级、孙级或任意更深层的后代均可 —— 按 `Enter` 打开其实时动态查看器：一个只读的全屏视图，展示该代理的工作过程，呈现方式与你的主会话十分相似。

打开查看器后，会先回放该代理最近的动态，然后在其工作期间持续追加新事件。你可以看到：

- **助手回复**以 Markdown 渲染，书写过程中实时流式输出
- **思考**折叠为一行 `Thinking` —— 仍在生成时标记为 `streaming`，可展开以实时跟随推理过程
- **工具活动**以按类型着色的单行摘要展示：读取或写入了哪些文件、搜索了什么、创建或联系了哪些代理 —— shell 命令完整显示
- **父级消息**与提交的回复/报告，可展开查看完整 Markdown 正文

整个视图如下所示：

```text
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ AGENT ACTIVITY · worker · fix-tests · working                              ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ ▸ Parent message                                                           ┃
┃ ▸ Thinking                                                                 ┃
┃ The failing test expects unclosed brackets to be rejected — checking       ┃
┃ the parser implementation first.                                           ┃
┃ ↻ read · test/parser.test.ts                                               ┃
┃ ▸ ✓ bash · timeout 120s                                                    ┃
┃ ✓ edit · src/parser.ts                                                     ┃
┃ ▸ ✓ final_report                                                           ┃
┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫
┃ ↑↓ scroll · Tab/Shift+Tab select · Enter expand · Home/End jump · Esc back ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

| 按键 | 操作 |
| --- | --- |
| `↑` / `↓` | 滚动 |
| `Home` / `End` | 跳转到顶部 / 底部 |
| `Tab` / `Shift+Tab` | 选中下一个 / 上一个可展开条目 |
| `Enter` 或 `Space` | 展开 / 折叠所选条目 |
| `→` / `←` | 仅展开 / 仅折叠 |
| `Esc` | 返回代理树面板 |

这里同样支持鼠标：滚轮滚动，点击可展开的行即可将其展开或折叠。

查看器会自动跟随最新动态。向上滚动会暂停跟随；滚回底部（或按 `End`）即可恢复。

几点值得了解：

- 查看器是**只读**的：浏览不会向代理发送任何内容。
- 动态仅用于展示：不会进入你的主会话，也不会消耗父代理的上下文或 token。
- 每个代理会在内存中为当前会话保留最近 100 条动态；更早的条目将被丢弃，并显示 `Older activity omitted` 提示。
- 动态仅存于内存：退出 Pi 或执行 `/reload` 都会将其清空。
- 已终止的代理在当前会话内仍可回放，你可以在它们消失之后回顾其做过的事情。
- 查看器仅在 TUI 模式下可用。

## 🧩 代理模板

### 模板存放位置

| 范围 | 路径 | 说明 |
| --- | --- | --- |
| 用户级 | `<PI_AGENT_DIR>/agents/*.md` | 对所有项目可用 |
| 项目级 | `<PROJECT_DIR>/.pi/agents/*.md` | 仅在项目获得 Pi 授权后可用 |

`<PI_AGENT_DIR>` 是 Pi 的用户级代理目录：跟随 `PI_CODING_AGENT_DIR` 环境变量；该变量未设置或为空串时回退 `<USER_HOME>/.pi/agent`。

模板目录只读取直接的、小写的 `.md` 文件，不会递归扫描子目录。当项目模板与用户模板同名时，项目模板优先。模板 ID 区分大小写。

### 模板字段

| 字段 | 必填 | 默认值 | 说明 |
| --- | :-: | :-: | --- |
| `description` | 是 | 无 | 模板的用途 |
| `tools` | 否 | Pi 默认工具 | 子代理可用的业务工具 |
| `extensions` | 否 | Pi 默认扩展发现机制 | 子代理可用的额外扩展来源 |
| `allowSubagents` | 否 | `true` | 子代理是否可以创建下一级子代理 |
| `contextFiles` | 否 | `true` | 是否加载 `AGENTS.md`、`CLAUDE.md` 等上下文文件 |
| `systemPromptMode` | 否 | `append` | `append` 将模板正文追加到基础系统提示之后；`replace` 替换基础系统提示 |
| `model` | 否 | 继承父代理当前模型 | 格式：`provider/model` |
| `thinking` | 否 | 继承父代理当前等级 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

模板使用严格的 YAML frontmatter，仅支持上表所列字段。正文即为子代理的角色提示词。

省略 `tools` 或 `extensions` 与传入空数组并不等价：

| 写法 | 行为 |
| --- | --- |
| 省略 `tools` | 采用 Pi 正常的工具选择逻辑 |
| `tools: []` | 无业务工具，仅保留运行子代理所必需的工具 |
| 省略 `extensions` | 采用 Pi 正常的扩展发现规则 |
| `extensions: []` | 禁用正常扩展发现，仅加载本插件自身 |

完整示例：

```markdown
---
description: Implement the specified module and self-check
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

Confirm the existing implementation and constraints first, then make the changes. Keep the change scope focused and run relevant checks before reporting the result.
```

## ⚙️ 运行时配置

运行时配置可放置于：

```text
<PI_AGENT_DIR>/wj-pi-subagents.json
<PROJECT_DIR>/.pi/wj-pi-subagents.json
```

`<PI_AGENT_DIR>` 是 Pi 的用户级代理目录：跟随 `PI_CODING_AGENT_DIR` 环境变量；该变量未设置或为空串时回退 `<USER_HOME>/.pi/agent`。

已授权的项目配置优先于用户配置。未提供配置时，采用以下默认值：

```json
{
  "maxDepth": 2,
  "maxChildrenPerAgent": 4,
  "maxAgentsPerTree": 16,
  "waitTimeoutMs": 60000
}
```

| 字段 | 默认值 | 取值范围 | 说明 |
| --- | ---: | ---: | --- |
| `maxDepth` | `2` | `1..8` | 子代理最大深度；根会话为第 0 级 |
| `maxChildrenPerAgent` | `4` | `1..16` | 每个代理可保有的直接子级数量 |
| `maxAgentsPerTree` | `16` | `1..64` | 整棵树中未终止的子代理数量 |
| `waitTimeoutMs` | `60000` | `10000..600000` | 默认等待时长（毫秒） |

运行时配置在根会话启动时读取。修改后需退出并重启 Pi；`/reload` 不会重新读取这些配置。

### 桥接运行时

子代理桥接进程运行在 JavaScript 运行时之上。Pi 通常复用自身的可执行文件；当 Pi 本身是单文件编译产物（其可执行文件不是 `node`/`nodejs`/`bun`）时，插件会从 `PATH` 中依次解析 `node`、`bun`。

如需显式固定运行时，可在启动 Pi 前把 `WJ_PI_SUBAGENTS_BRIDGE_RUNTIME` 环境变量设置为运行时可执行文件的路径。若无法解析到可用运行时，`spawn_agent` 会立即以 `spawn_failed` 失败，而不是等待启动超时。

## 🗜️ 上下文压缩

Pi `>= 0.85.1` 在每次工具执行后，通过原生的 post-tool 流程决定并执行上下文压缩。根会话与每个子代理都是独立的 Pi 会话，各自根据实际上下文状态完成压缩并继续工作，无需任何额外的插件或协调协议。

本插件通过监听 Pi 原生压缩生命周期事件和 `get_state.isCompacting` 来校准代理状态与 TUI 动态提示。父代理发给子 Pi 的消息仍由 Pi 命令响应裁定；若 Pi 因正在压缩而拒绝消息，调用方会收到可重试的 `compaction_active`。Pi 没有 `abort_compaction` RPC，因此在压缩期间发起中断时，插件不会调用无法取消压缩的普通 `abort`，而是基于当前对原生压缩的观察返回 `compaction_active`。子级回复使用 Pi 的 fire-and-forget 扩展消息 API；调用成功仅表示父扩展运行时已接受该提交。

## 🔄 更新与卸载

更新插件：

```bash
pi update --extension npm:wj-pi-subagents
```

移除用户级安装：

```bash
pi remove npm:wj-pi-subagents
```

移除项目级安装：

```bash
cd <PROJECT_DIR>
pi remove npm:wj-pi-subagents -l
```

## 🛡️ 使用边界

- 子代理以与当前 Pi 进程相同的操作系统用户权限运行。
- 工作目录用于项目资源发现和相对路径解析；它并不是文件系统沙箱。
- 模板中的 `tools` 只限制模型可调用的工具；并不限制进程自身的系统权限。
- Pi 扩展可以执行原生代码；请只安装可信且经过审查的来源。
- 处理不可信代码时，请在容器、虚拟机或其他隔离环境中运行 Pi。

## 🛠️ 开发与调试

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

构建并保留一个从 npm tarball 安装的本地测试包：

```bash
npm run pack:smoke
```

每次运行都会重新构建 `package-smoke/`。验证完成后，可安装的包目录为 `package-smoke/node_modules/wj-pi-subagents`。例如，在仓库根目录下执行：

```bash
pi install "./package-smoke/node_modules/wj-pi-subagents"
```

本项目无需开发服务器。要在目标项目中临时加载源码：

```bash
cd <PROJECT_DIR>
pi --verbose -e "<REPOSITORY_PATH>"
```

修改源码或模板后执行 `/reload`。修改 `wj-pi-subagents.json` 后需重启 Pi。

## 📄 许可证

本项目基于 [MIT 许可证](./LICENSE) 授权。
