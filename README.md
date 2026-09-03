<div align="center">

# 🌳 wj-pi-subagents

**A multi-level subagent orchestration plugin for [Pi](https://github.com/earendil-works/pi-mono)**

No built-in templates · No preset workflows · Everything is yours to shape

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2022.19.0-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Pi](https://img.shields.io/badge/Pi-%3E%3D%200.84.4-2563EB)](https://github.com/earendil-works/pi-mono)

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
| 🗜️ | **Native context compaction** | Relies on the post-tool compaction flow of Pi `>= 0.84.4`; each root session and subagent manages its own context through its independent Pi session |

## 📦 Requirements

| Item | Requirement |
| --- | --- |
| Node.js | `>= 22.19.0` |
| Pi | `>= 0.84.4` |

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
<USER_HOME>/.pi/agent/agents/*.md
```

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

The `Agents` area in the TUI shows the direct subagents of the current session. Run the following command to view the agent tree:

```text
/agents
```

The root session can view the entire agent tree; a subagent can only view its own subtree. A parent agent can only operate on its direct children.

## 🧩 Agent Templates

### Template locations

| Scope | Path | Description |
| --- | --- | --- |
| User-level | `<USER_HOME>/.pi/agent/agents/*.md` | Available to all projects |
| Project-level | `<PROJECT_DIR>/.pi/agents/*.md` | Available only after the project is authorized by Pi |

The template directory only reads direct, lowercase `.md` files and does not scan subdirectories recursively. When a project template shares a name with a user template, the project template wins. Template IDs are case-sensitive.

### Template fields

| Field | Required | Default | Description |
| --- | :-: | :-: | --- |
| `description` | Yes | None | What the template is for |
| `tools` | No | Pi's default tools | Business tools available to the subagent |
| `extensions` | No | Pi's default extension discovery | Additional extension sources for the subagent |
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
<USER_HOME>/.pi/agent/wj-pi-subagents.json
<PROJECT_DIR>/.pi/wj-pi-subagents.json
```

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

## 🗜️ Context Compaction

Pi `>= 0.84.4` decides on and runs context compaction through the native post-tool flow after each tool execution. The root session and every subagent are independent Pi sessions; each compacts and continues based on its actual context state, with no extra plugin or coordination protocol required.

This plugin observes Pi's native compaction lifecycle events and `get_state.isCompacting` to calibrate agent status and TUI activity hints. Messages from the parent to a child Pi are still adjudicated by Pi command responses; if Pi rejects a message because it is compacting, the caller receives a retryable `compaction_active`. Pi 0.84.4 has no `abort_compaction` RPC, so an interrupt during compaction returns `compaction_active` based on the current native compaction observation instead of calling the plain `abort`, which cannot cancel compaction. Child replies use Pi's fire-and-forget extension message API; a successful result only means the parent extension runtime has accepted the submission.

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
