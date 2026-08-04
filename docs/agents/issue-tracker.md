# Issue 跟踪器：本地 Markdown

本仓库的 Issue 与规格文档（规格也可能称为 PRD）使用 `.scratch/` 下的 Markdown 文件管理。

## 约定

- 每个功能使用一个独立目录：`.scratch/<feature-slug>/`
- 规格文档位于 `.scratch/<feature-slug>/spec.md`
- 每个实现任务使用一个独立文件，存放于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 实现任务从 `01` 开始编号，禁止把所有任务合并到一个文件中
- Triage 状态记录在每个 Issue 文件顶部附近的 `Status:` 行中；角色字符串参见 `triage-labels.md`
- 评论与对话历史追加到文件末尾的 `## Comments` 标题下

## 当技能要求“发布到 Issue 跟踪器”时

在 `.scratch/<feature-slug>/` 下创建新文件；如果对应目录不存在，则同时创建该目录。

## 当技能要求“获取相关任务”时

读取用户指定路径所对应的文件。通常情况下，用户会直接提供文件路径或 Issue 编号。

## Wayfinding 操作

供 `/wayfinder` 使用。每项工作使用一个 Map 文件，并为每个任务创建一个独立的子任务文件。

- **Map**：`.scratch/<effort>/map.md`，正文包含 `Notes`、`Decisions-so-far` 和 `Fog`
- **子任务**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，正文中记录待回答的问题
- **任务类型**：文件顶部附近的 `Type:` 行记录任务类型，可选值为 `research`、`prototype`、`grilling` 或 `task`
- **任务状态**：文件顶部附近的 `Status:` 行记录 `claimed` 或 `resolved`
- **阻塞关系**：文件顶部附近使用 `Blocked by: NN, NN` 记录依赖；只有列出的所有任务均为 `resolved` 时，当前任务才解除阻塞
- **可执行前沿**：扫描 `.scratch/<effort>/issues/`，查找仍开放、未阻塞且未被认领的任务；编号最小的任务优先
- **认领任务**：开始工作前，将 `Status:` 设置为 `claimed` 并保存文件
- **解决任务**：在 `## Answer` 标题下追加答案，将 `Status:` 设置为 `resolved`，然后把上下文指针（摘要与链接）追加到 `map.md` 的 `Decisions-so-far` 中
