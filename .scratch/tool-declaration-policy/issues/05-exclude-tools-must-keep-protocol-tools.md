# 05 — 排除项不得命中协议工具（协议工具必须全部保留）

**What to build:** 模板 `excludeTools` 无论怎么写（含 `*` 通配），都不能把子进程的协议工具排掉。会命中协议工具的排除项（协议工具字面名、`*`、`*report*`、`normal_*` 这类模式）在加载期被判为无效，诊断指向模板与 `excludeTools` 字段；不会命中协议工具的排除项（如 `mcp_*`）照常有效。

背景（评审发现 + 已确认决策）：`--exclude-tools` 在 pi 0.85.1 上是精确名字匹配、无豁免名单、排除后不可恢复（allowlist 也救不回）；pi 1.1.0 起支持通配。因此"协议工具必须全部保留"只能通过加载期拒绝会命中协议工具的写法来实现。当前保留名清单缺 `final_report`，`excludeTools: ['final_report']` 加载期合法、启动期以 capability_mismatch 失败；`excludeTools: ['*']` 在支持通配的 pi 上会排掉全部协议工具。决策：协议工具保留优先于 `*` 通配的"排除所有"用法。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 保留名集合补全为协议工具全集（现缺 `final_report`），并有测试断言保留名集合 ⊇ 协议工具集合（协议工具集：8 个管理工具 + `normal_reply` + `final_report`）
- [x] `excludeTools: ['final_report']`（及其它协议工具名）在加载期判无效，诊断定位到模板与 `excludeTools` 字段
- [x] 含 `*` 且会匹配任一协议工具名的排除项（`*`、`*report*`、`normal_*` 等）在加载期判无效
- [x] 不会命中协议工具的排除项（如 `mcp_*`、`read`）照常有效，参数拼装行为不变
- [x] `tools` 字段既有保留名行为不变（补上 `final_report` 后同样拒绝该名字）；`tools` 的通配写法不受本次改动影响
- [x] 命中判断只针对协议工具名集合做保守匹配（`*` 为任意序列、全名匹配），不重建 pi 的完整选择语义
- [x] 文档（README.md / README.zh-CN.md 的排除字段说明）写明：排除项不得命中协议工具（含通配），协议工具必须全部保留
- [x] 既有测试全部保持通过

## Answer

`RESERVED_SYSTEM_TOOL_NAMES` 补全为协议工具全集（8 个管理工具 + `normal_reply` + `final_report`，共 10 项）并导出；`parseDeclaredToolNames` 增加保留名判断参数：`tools` 继续按字面名拒绝（含新增的 `final_report`，通配写法不受影响），`excludeTools` 改用保守命中匹配 —— `*` 为任意序列、其余字符按字面转义、全名匹配（`^…$`）—— 凡可能命中协议工具名的条目（字面名、`*`、`*report*`、`normal_*`、`spawn*` 等）在加载期判为无效，reason 为 `reserved_tool` 且诊断 field 定位到 `excludeTools`；不会命中协议工具的条目（`mcp_*`、`read`、`future_*`、`normal.reply` 等）照常有效。`excludeTools` 保留名诊断文案改为 "excludeTools contains an entry matching a reserved system tool"。

- 实现：`src/template-discovery-snapshot.ts`（保留名集合补全并导出、`matchesReservedSystemToolName`、`parseDeclaredToolNames` 参数化、诊断文案）
- 测试：`test/template-discovery-snapshot.test.ts`（保留名集合 ⊇ 协议工具集合断言；`final_report` 字面名拒绝；`*` / `*report*` / `normal_*` / `spawn*` 通配命中拒绝并定位字段；`mcp_*` / `read` / `future_*` / `normal.reply` 有效；既有保留名用例扩为 10 个）
- 文档：`README.md`、`README.zh-CN.md` 排除字段说明写明「排除项不得命中协议工具（含通配），协议工具必须全部保留」并补回 `tools` 拒绝协议工具字面名的说明；`CONTEXT.md` 新增「协议工具」术语并在「排除声明」条目记录命中规则
- 验证：`npm run typecheck` 通过；`npm test` 662 tests / 657 pass / 0 fail / 5 skipped（平台跳过）
- Review：Standards / Spec 两轴并行审查（ExplorerSimple）。Spec 轴：八项验收全部实现，无缺失、无范围蔓延、无实现错误。Standards 轴修复：CONTEXT.md 术语缺口（协议工具与命中规则）、README 删除 `tools` 保留名说明造成的文档回退、诊断与文档术语双名（术语表桥接）。Baseline 主观项（保留名表与 `agent-tools.ts` 定义重复、测试硬编码、`parseDeclaredToolNames` 双策略）按工单范围保留：验收项 1 的集合断言即为防漂移手段
