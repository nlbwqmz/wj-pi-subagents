<div align="center">

# 🌳 wj-pi-subagents

[English](README.md) | [简体中文](README.zh-CN.md)

**A multi-level subagent orchestration plugin for [Pi](https://github.com/earendil-works/pi-mono)**

No built-in templates · No preset workflows · Everything is yours to shape

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2022.19.0-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D%200.85.1-2563EB)](https://github.com/earendil-works/pi-mono)

</div>

## 📖 Introduction

`wj-pi-subagents` creates independent subagents within the current Pi session, separating tasks such as analysis, implementation, testing, or review while the parent agent coordinates the results. Authorized subagents can in turn create the next level of agents, forming a multi-level agent tree.

> 💡 **This plugin ships with no built-in subagent templates and no preset workflows.**
> Before first use, create your own templates to freely define each agent's role, available tools, model, and multi-level permissions.
> The plugin only organizes the agent tree — how agents collaborate is entirely up to you.

## ✨ Highlights

| | Feature | Description |
| --- | :---: | --- |
| 🌳 | **Multi-level agent tree** | The root agent creates subagents; authorized subagents that have not reached the depth limit can create the next level in turn |
| 🧩 | **Fully customizable** | No built-in templates, no preset workflows — freely define prompts, tools, extensions, model, thinking level, and multi-level permissions via Markdown templates |
| 📦 | **Independent context** | Each subagent runs in its own Pi session without copying parent history, ideal for isolating large tasks and reducing context noise |
| ⚡ | **Parallel collaboration** | Tasks without dependencies or resource conflicts can be delegated to multiple subagents running in parallel |
| ♻️ | **Context reuse** | The same subagent can take on tasks consecutively while keeping its own session context |
| 🎛️ | **Controlled management** | A parent agent can only manage its direct children, supporting wait, status query, interrupt, reuse, and termination |
| 👁️ | **Visible status** | The TUI shows the status of direct subagents; `/agents` shows the full agent tree within the current session scope |
| 🔭 | **Live activity viewer** | Press `Enter` on any agent in the tree to watch it work in real time |
| 🗜️ | **Native context compaction** | Relies on the post-tool compaction flow of Pi `>= 0.85.1`; each root session and subagent manages its own context through its independent Pi session |

## 📦 Requirements

| Item | Requirement |
| --- | --- |
| Node.js | `>= 22.19.0` |
| Pi | `>= 0.85.1` |

## 🚀 Installation

### User-level installation

Enable for all Pi projects of the current user:

```bash
pi install npm:wj-pi-subagents
```

### Project-level installation

Enable only for the current project:

```bash
cd <PROJECT_DIR>
pi install npm:wj-pi-subagents -l
```

> Project-level installation writes to `<PROJECT_DIR>/.pi/settings.json`; it is loaded only after the project is authorized by Pi.

### Temporary use

Load only for this Pi process:

```bash
cd <PROJECT_DIR>
pi -e npm:wj-pi-subagents
```

Verify the installation with:

```bash
pi list
```

## 🏁 Quick Start

### 1️⃣ Create an agent template

User-level templates go in:

```text
<PI_AGENT_DIR>/agents/*.md
```

`<PI_AGENT_DIR>` is Pi's user-level agent directory: it follows the `PI_CODING_AGENT_DIR` environment variable and falls back to `<USER_HOME>/.pi/agent` when that variable is unset or empty.

Project-level templates go in:

```text
<PROJECT_DIR>/.pi/agents/*.md
```

For example, create `researcher.md`:

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

The template ID is the file name without the `.md` extension. In this example the template ID is `researcher`.

### 2️⃣ Start or reload Pi

Start Pi in the target project:

```bash
cd <PROJECT_DIR>
pi
```

After adding or modifying templates, run:

```text
/reload
```

`/reload` refreshes templates; already-created subagents keep their original configuration.

## 👀 View Agent Status

Whenever the current session has subagents, a persistent `Agents` area sits above the input box. Each direct subagent that has not been terminated yet gets one line there: a live status icon (an animated spinner while working) followed by template, name, state, activity phase, context usage, and elapsed time. The area disappears when no subagent is left:

```text
● Agents
├─ ⠋ researcher · explore-auth · working · processing · 12.3%/200k · 2m 14s
└─ ○ worker · fix-tests · idle · 0s
```

Run the following command to open the agent tree panel:

```text
/agents
```

The root session can view the entire agent tree; a subagent can only view its own subtree. A parent agent can only operate on its direct children.

Inside the tree panel:

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

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move the selection |
| `←` / `→` | Fold / unfold a branch |
| `Home` / `End` | Jump to the first / last row |
| `Enter` | Open the live activity viewer of the selected agent |
| `Esc` | Close the panel |

Mouse input works in Pi's fullscreen TUI mode (`--tui-mode fullscreen` at startup, or switch TUI mode in `/settings`): wheel scrolls, click selects a row, and clicking the selected row again folds or unfolds its children. In regular mode the terminal owns the mouse, so use the keyboard.

## 🔭 Live Activity Viewer

Wondering what a subagent is actually doing behind its `working` status? Select any agent in the tree — a direct child, a grandchild, or any deeper descendant — and press `Enter` to open its live activity viewer: a read-only, full-screen view of that agent's work, rendered much like your main session.

Opening the viewer first replays the agent's recent activity, then keeps appending new events live while the agent works. You can watch:

- **Assistant replies** rendered as Markdown, streamed in real time while they are being written
- **Thinking** collapsed into a single `Thinking` line — marked `streaming` while still being generated, and expandable to follow the reasoning live
- **Tool activity** as color-coded one-line summaries: which files were read or written, what was searched, which agents were spawned or messaged — with shell commands shown in full
- **Parent messages** and submitted replies/reports, expandable to their full Markdown body

The whole view looks like this:

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

| Key | Action |
| --- | --- |
| `↑` / `↓` | Scroll |
| `Home` / `End` | Jump to the top / bottom |
| `Tab` / `Shift+Tab` | Select the next / previous expandable entry |
| `Enter` or `Space` | Expand / collapse the selected entry |
| `→` / `←` | Expand only / collapse only |
| `Esc` | Back to the tree panel |

The mouse works here too: wheel scrolls, and clicking an expandable line expands or collapses it.

The viewer follows the newest activity automatically. Scrolling up pauses following; scrolling back to the bottom (or pressing `End`) resumes it.

A few things worth knowing:

- The viewer is **read-only**: browsing never sends anything to the agent.
- Activity is display-only: it never enters your main conversation and never consumes the parent agent's context or tokens.
- Each agent keeps its most recent 100 activity entries in memory for the current session; older entries are dropped with an `Older activity omitted` notice.
- Activity lives in memory only: exiting Pi or running `/reload` clears it.
- Terminated agents can still be replayed within the current session, so you can review what they did after they are gone.
- The viewer is available in TUI mode only.

## 🧩 Agent Templates

### Template locations

| Scope | Path | Description |
| --- | --- | --- |
| User-level | `<PI_AGENT_DIR>/agents/*.md` | Available to all projects |
| Project-level | `<PROJECT_DIR>/.pi/agents/*.md` | Available only after the project is authorized by Pi |

`<PI_AGENT_DIR>` is Pi's user-level agent directory: it follows the `PI_CODING_AGENT_DIR` environment variable and falls back to `<USER_HOME>/.pi/agent` when that variable is unset or empty.

The template directory only reads direct, lowercase `.md` files and does not scan subdirectories recursively. When a project template shares a name with a user template, the project template wins. Template IDs are case-sensitive.

### Template fields

| Field | Required | Default | Description |
| --- | :-: | :-: | --- |
| `description` | Yes | None | What the template is for |
| `tools` | No | Pi's default tools | Business tools available to the subagent |
| `extensions` | No | Pi's default extension discovery | Additional extension sources for the subagent: local paths, `npm:`, `git:`, URLs, or `builtin:<name>` |
| `allowSubagents` | No | `true` | Whether the subagent may create the next level of subagents |
| `contextFiles` | No | `true` | Whether to load context files such as `AGENTS.md` and `CLAUDE.md` |
| `systemPromptMode` | No | `append` | `append` appends the template body; `replace` replaces the base system prompt |
| `model` | No | Inherits the parent's current model | Format: `provider/model` |
| `thinking` | No | Inherits the parent's current level | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

Templates use strict YAML frontmatter, and only the fields in the table above are supported. The body is the subagent's role prompt.

Omitting `tools` or `extensions` is not the same as passing an empty array:

| Form | Behavior |
| --- | --- |
| Omit `tools` | Use Pi's normal tool selection |
| `tools: []` | No business tools; only the tools required to run a subagent |
| Omit `extensions` | Use Pi's normal extension discovery rules |
| `extensions: []` | Disable normal extension discovery; load only this plugin itself |

`extensions` accepts local paths, `npm:`, `git:`, URLs, and `builtin:<name>`. `builtin:<name>` references a Pi built-in extension (for example `builtin:mcp`) and requires Pi 0.99.0 or later. When `extensions` is declared, this plugin passes `--no-extensions`, so built-in extensions that are not listed (such as `builtin:llama.cpp`, `builtin:codemode`, and `builtin:tool-search`) are also disabled; only the listed entries load through `-e`.

Example that loads only the built-in MCP extension:

```markdown
---
description: Verify facts with MCP tools
extensions:
  - builtin:mcp
---
Gather facts through the MCP tools first, then report the conclusion.
```

Full example:

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

## ⚙️ Runtime Configuration

Runtime configuration can be placed at:

```text
<PI_AGENT_DIR>/wj-pi-subagents.json
<PROJECT_DIR>/.pi/wj-pi-subagents.json
```

`<PI_AGENT_DIR>` is Pi's user-level agent directory: it follows the `PI_CODING_AGENT_DIR` environment variable and falls back to `<USER_HOME>/.pi/agent` when that variable is unset or empty.

An authorized project configuration takes precedence over user configuration. When no configuration is provided, these defaults apply:

```json
{
  "maxDepth": 2,
  "maxChildrenPerAgent": 4,
  "maxAgentsPerTree": 16,
  "waitTimeoutMs": 60000
}
```

| Field | Default | Range | Description |
| --- | ---: | ---: | --- |
| `maxDepth` | `2` | `1..8` | Maximum subagent depth; the root session is level 0 |
| `maxChildrenPerAgent` | `4` | `1..16` | Direct children each agent may keep |
| `maxAgentsPerTree` | `16` | `1..64` | Non-terminated subagents in the whole tree |
| `waitTimeoutMs` | `60000` | `10000..600000` | Default wait time in milliseconds |

Runtime configuration is read when the root session starts. After changing it, exit and restart Pi; `/reload` does not re-read these settings.

### Bridge runtime

Subagent bridge processes run on a JavaScript runtime. Pi normally reuses its own executable; when Pi itself is a compiled single binary (its executable is not `node`/`nodejs`/`bun`), the plugin resolves `node`, then `bun`, from `PATH`.

To pin the runtime explicitly, set the `WJ_PI_SUBAGENTS_BRIDGE_RUNTIME` environment variable to the runtime executable path before starting Pi. If no runtime can be resolved, `spawn_agent` fails fast with `spawn_failed` instead of waiting for the startup timeout.

## 🗜️ Context Compaction

Pi `>= 0.85.1` decides on and runs context compaction through the native post-tool flow after each tool execution. The root session and every subagent are independent Pi sessions; each compacts and continues based on its actual context state, with no extra plugin or coordination protocol required.

This plugin observes Pi's native compaction lifecycle events and `get_state.isCompacting` to calibrate agent status and TUI activity hints. Messages from the parent to a child Pi are still adjudicated by Pi command responses; if Pi rejects a message because it is compacting, the caller receives a retryable `compaction_active`. Pi has no `abort_compaction` RPC, so an interrupt during compaction returns `compaction_active` based on the current native compaction observation instead of calling the plain `abort`, which cannot cancel compaction. Child replies use Pi's fire-and-forget extension message API; a successful result only means the parent extension runtime has accepted the submission.

## 🔄 Update and Uninstall

Update the plugin:

```bash
pi update --extension npm:wj-pi-subagents
```

Remove the user-level installation:

```bash
pi remove npm:wj-pi-subagents
```

Remove the project-level installation:

```bash
cd <PROJECT_DIR>
pi remove npm:wj-pi-subagents -l
```

## 🛡️ Usage Boundaries

- Subagents run with the same OS user permissions as the current Pi process.
- The working directory is used for project resource discovery and relative path resolution; it is not a filesystem sandbox.
- `tools` in a template only restricts the tools the model may call; it does not restrict the process's own system permissions.
- Pi extensions can execute native code; only install trusted and reviewed sources.
- When handling untrusted code, run Pi inside a container, virtual machine, or other isolated environment.

## 🛠️ Development and Debugging

Get the source and install dependencies:

```bash
git clone https://github.com/nlbwqmz/wj-pi-subagents.git
cd wj-pi-subagents
npm ci --legacy-peer-deps
```

Common check commands:

```bash
npm run typecheck
npm test
npm run check
```

Build and keep a local test package installed from the npm tarball:

```bash
npm run pack:smoke
```

Each run rebuilds `package-smoke/`. After verification, the installable package directory is
`package-smoke/node_modules/wj-pi-subagents`. For example, from the repository root:

```bash
pi install "./package-smoke/node_modules/wj-pi-subagents"
```

This project needs no dev server. To temporarily load the source in a target project:

```bash
cd <PROJECT_DIR>
pi --verbose -e "<REPOSITORY_PATH>"
```

Run `/reload` after changing source or templates. Restart Pi after changing `wj-pi-subagents.json`.

## 📄 License

This project is licensed under the [MIT License](./LICENSE).
