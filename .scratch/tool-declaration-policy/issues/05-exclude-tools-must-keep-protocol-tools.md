# 05 — 排除项不得命中协议工具（协议工具必须全部保留）

**What to build:** 模板 `excludeTools` 无论怎么写（含 `*` 通配），都不能把子进程的协议工具排掉。会命中协议工具的排除项（协议工具字面名、`*`、`*report*`、`normal_*` 这类模式）在加载期被判为无效，诊断指向模板与 `excludeTools` 字段；不会命中协议工具的排除项（如 `mcp_*`）照常有效。

背景（评审发现 + 已确认决策）：`--exclude-tools` 在 pi 0.85.1 上是精确名字匹配、无豁免名单、排除后不可恢复（allowlist 也救不回）；pi 1.1.0 起支持通配。因此"协议工具必须全部保留"只能通过加载期拒绝会命中协议工具的写法来实现。当前保留名清单缺 `final_report`，`excludeTools: ['final_report']` 加载期合法、启动期以 capability_mismatch 失败；`excludeTools: ['*']` 在支持通配的 pi 上会排掉全部协议工具。决策：协议工具保留优先于 `*` 通配的"排除所有"用法。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 保留名集合补全为协议工具全集（现缺 `final_report`），并有测试断言保留名集合 ⊇ 协议工具集合（协议工具集：8 个管理工具 + `normal_reply` + `final_report`）
- [ ] `excludeTools: ['final_report']`（及其它协议工具名）在加载期判无效，诊断定位到模板与 `excludeTools` 字段
- [ ] 含 `*` 且会匹配任一协议工具名的排除项（`*`、`*report*`、`normal_*` 等）在加载期判无效
- [ ] 不会命中协议工具的排除项（如 `mcp_*`、`read`）照常有效，参数拼装行为不变
- [ ] `tools` 字段既有保留名行为不变（补上 `final_report` 后同样拒绝该名字）；`tools` 的通配写法不受本次改动影响
- [ ] 命中判断只针对协议工具名集合做保守匹配（`*` 为任意序列、全名匹配），不重建 pi 的完整选择语义
- [ ] 文档（README.md / README.zh-CN.md 的排除字段说明）写明：排除项不得命中协议工具（含通配），协议工具必须全部保留
- [ ] 既有测试全部保持通过

## Answer

（待实施填写）
