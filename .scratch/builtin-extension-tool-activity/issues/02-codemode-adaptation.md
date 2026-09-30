# 02 — codemode 适配

**What to build:** 子代理调用 codemode 后，父会话用户能在活动面板看到它执行的脚本——来源判定把 `builtin:codemode` 注册的工具识别为 `pi_extension`；start 摘要携带按行截断后的 `code`（上限 32 KB）与原文总行数，end 摘要携带 `isError` 与嵌套调用数；截断规格建立并被 `code` 与 `command` 共用（`command` 从"完整不截断"变为"截断到 32 KB"，标记统一为 `…（已截断，原文共 N 行）`，单行超长走字节兜底）；wire 闭集校验同步就位；面板折叠态摘要行显示脚本行数与嵌套调用数、展开体显示截断后的脚本。

**Blocked by:** 01 — 契约与传输基线

**Status:** ready-for-agent

- [ ] `builtin:codemode` 的工具判为 `pi_extension`；既有 `pi_native` / `plugin` / `unknown` 判定与用例不回归
- [ ] codemode start 摘要携带截断后的 `code` 与 `codeLines`；end 摘要携带 `isError` 与 `nestedCalls`
- [ ] 32 KB 以内字段原样保留；超限字段按行截断并带 `…（已截断，原文共 N 行）`；单行超限按字节兜底截断，标记一致
- [ ] `command` 与 `code` 共用同一截断规则（含标记格式）；超长命令行确实被截断
- [ ] wire 闭集校验与产生端同时就位：新字段键集合与类型严格闭合，未知键拒绝
- [ ] 面板折叠态显示"脚本行数 + 嵌套调用数"，展开体显示截断后的脚本（沿用既有预格式化正文渲染）
- [ ] 端到端可演示：一次超长 codemode 调用在面板上显示截断脚本与行数标记，且不触发 `frame_too_large`
- [ ] 活动事实语义不变：不改变子代理生命周期状态、不进入实时显示草稿、不进入父模型上下文
