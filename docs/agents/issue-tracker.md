# Issue 跟踪器：本地 Markdown

本仓库的 issue 和 spec 以 Markdown 文件存放在 `.scratch/` 下。

## 约定

- 每个 feature 使用一个目录：`.scratch/<feature-slug>/`
- spec 文件为 `.scratch/<feature-slug>/spec.md`
- implementation issue 按 ticket 分文件存放于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号；不要将多个 ticket 合并到一个文件
- triage 状态记录在 issue 文件顶部附近的 `Status:` 行中，角色字符串见 `triage-labels.md`
- 评论和对话历史追加在文件末尾的 `## Comments` 标题下

## 技能要求“发布到 issue tracker”时

在 `.scratch/<feature-slug>/` 下创建文件；目录不存在时一并创建。

## 技能要求“获取相关 ticket”时

读取用户提供路径或 issue 编号对应的文件。

## Wayfinder 导航约定

`/wayfinder` 使用一个包含每个 ticket 子文件的 map：

- Map：`.scratch/<effort>/map.md`，正文包含 Notes / Decisions-so-far / Fog
- 子 ticket：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，正文包含问题；用 `Type:` 记录 ticket 类型（`research`/`prototype`/`grilling`/`task`），用 `Status:` 记录 `claimed`/`resolved`
- 阻塞：在文件顶部附近用 `Blocked by: NN, NN` 记录依赖；列出的文件全部为 `resolved` 后，ticket 才算解除阻塞
- Frontier：扫描 `.scratch/<effort>/issues/`，按编号优先找到未关闭、未阻塞且未认领的 ticket
- Claim：设置 `Status: claimed` 后保存
- Resolve：在 `## Answer` 标题下追加答案，设置 `Status: resolved`，然后在 `map.md` 的 Decisions-so-far 中追加上下文指针（摘要和链接）
