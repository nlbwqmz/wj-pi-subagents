# 02 — codemode 适配

**What to build:** 子代理调用 codemode 后，父会话用户能在活动面板看到它执行的脚本——来源判定把 `builtin:codemode` 注册的工具识别为 `pi_extension`；start 摘要携带按行截断后的 `code`（上限 32 KB）与原文总行数，end 摘要携带 `isError` 与嵌套调用数；截断规格建立并被 `code` 与 `command` 共用（`command` 从"完整不截断"变为"截断到 32 KB"，标记统一为 `…（已截断，原文共 N 行）`，单行超长走字节兜底）；wire 闭集校验同步就位；面板折叠态摘要行显示脚本行数与嵌套调用数、展开体显示截断后的脚本。

**Blocked by:** 01 — 契约与传输基线

**Status:** resolved

- [x] `builtin:codemode` 的工具判为 `pi_extension`；既有 `pi_native` / `plugin` / `unknown` 判定与用例不回归
- [x] codemode start 摘要携带截断后的 `code` 与 `codeLines`；end 摘要携带 `isError` 与 `nestedCalls`
- [x] 32 KB 以内字段原样保留；超限字段按行截断并带 `…（已截断，原文共 N 行）`；单行超限按字节兜底截断，标记一致
- [x] `command` 与 `code` 共用同一截断规则（含标记格式）；超长命令行确实被截断
- [x] wire 闭集校验与产生端同时就位：新字段键集合与类型严格闭合，未知键拒绝
- [x] 面板折叠态显示"脚本行数 + 嵌套调用数"，展开体显示截断后的脚本（沿用既有预格式化正文渲染）
- [x] 端到端可演示：一次超长 codemode 调用在面板上显示截断脚本与行数标记，且不触发 `frame_too_large`
- [x] 活动事实语义不变：不改变子代理生命周期状态、不进入实时显示草稿、不进入父模型上下文

## Answer

实现只覆盖工单 02 的 codemode 适配，未触及 tool-search / MCP（03）与嵌套条目显示（04）。

- **来源判定**（`src/wj-pi-subagents-runtime.ts`）：新增 `pi_extension` 来源类别与 `PI_EXTENSION_TOOL_SOURCE_PATHS` 闭集（当前仅 `builtin:codemode`），按注册来源路径判定；第三方 replaceable 替换后路径变化自动回落 `unknown`，`pi_native` / `plugin` / `unknown` 判定不变。
- **截断规格**（`src/rpc-bridge-event.ts`）：`ACTIVITY_FIELD_MAX_BYTES = 32 KB`，`command` 与 `code` 共用同一按行截断（保留完整行、单行超限按 UTF-8 字节兜底、标记计入上限），标记统一为独立成行的 `…（已截断，原文共 N 行）`（N 为净化后原文总行数）。
- **codemode 摘要**：start 携带 `{tool, code, codeLines}`；end 携带 `{tool, code?, codeLines?, isError, nestedCalls?}`。**决策说明**：活动快照只保留工具 end 条目（start 被 end 覆盖），若 end 摘要不含脚本正文，收束后的展开体将丢失脚本，因此 end 事实自包含 `code`/`codeLines`（沿用既有“end 摘要自包含”模式，是 spec 声明形状之外的必要扩展）；`nestedCalls` 取自 codemode 结果 `details.calls` 中排除 `models.classify` 记录后的嵌套工具调用数（该数组与模型调用记录共用，模型调用不产生嵌套条目），结果结构异常时省略该字段而不臆造 0。
- **wire 闭集**：`parseToolSummary` 按来源分派；`pi_extension` 摘要按 start/end 形状分别闭合（start 不接受结束字段；end 要求 `isError` 与事件事实一致、`nestedCalls` 为非负整数、`code`/`codeLines` 同进同出且 ≤32 KB）；`command` 与 `code` 超 32 KB 在 wire 上拒绝，未知键拒绝，来源未验证时携带专用摘要即违约。
- **面板**（`src/agent-activity-viewer.ts`）：折叠态显示 `codemode · N lines · M nested calls`；展开体复用预格式化正文渲染（新 `guided-codemode-code` kind 与 `tool-code:` 展开键），缺少脚本正文时不提供展开入口。
- **验证**：`npm run check`（`tsc --noEmit` + 全量测试）通过：587 pass / 0 fail / 5 skipped；新增用例覆盖来源判定与第三方回落、截断边界（32 KB 原样 / 按行截断 / 单行字节兜底 / 多字节不切断）、codemode start/end 摘要、模型调用过滤、wire 闭集与未知键、面板折叠/展开、超长 codemode 条目经监督通道发布/接收不触发 `frame_too_large`。
- **代码审查**：Standards 轴无硬性违规，6 项 baseline 判断项经评估保留（与既有 shell/摘要模式保持一致、32 KB 字段上限与传输分块预算是语义独立的两个常量）；Spec 轴确认各验收项均满足，指出的 `nestedCalls` 混入 `models.classify` 已修复，另记录两项有意决策（end 摘要自包含脚本正文、`nestedCalls` 结构异常时省略）。
