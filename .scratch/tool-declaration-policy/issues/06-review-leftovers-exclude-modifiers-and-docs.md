# 06 — 评审遗留：excludeTools 修饰符拒绝 + ADR / README 文档修正

**What to build:**
1. `excludeTools` 条目 trim 后以 `+` 或 `-` 开头（含与普通名混用）时，模板在加载期判无效，诊断定位到模板与 `excludeTools` 字段（与 `tools` 的修饰符拒绝一致）。
2. `docs/adr/0002-template-tool-declaration-boundary.md` 中与代码事实不符的表述修正：「活动工具集…显示在活动面板」改为「仍上报并进入能力清单」（全文核对，只改与事实不符处）。
3. `README.md` / `README.zh-CN.md` 补旧 pi 警示：pi < 1.1.0 时 `*` 与 `excludeTools` 条目按字面工具名处理，排除静默不生效（被排除的工具仍可达）。

背景：三项均来自 `tool-declaration-policy` 的代码评审遗留清单（Standards #3/#7、#4、Spec a3）。决策：修饰符在 `excludeTools` 同样不受支持——与 `tools` 边界一致，且 pi 1.1.0 起 `+`/`-` 为选择表达式修饰符，不拒绝会静默无效或静默改义。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `excludeTools: ['+x']` / `['-x']`（含与普通名混用、trim 后判断）在加载期判无效，诊断定位到 `excludeTools` 字段，复用既有 `tool_modifier_unsupported` 诊断码
- [ ] `tools` 既有修饰符拒绝行为不变；`excludeTools` 既有协议工具命中拒绝行为不变；合法条目（`read`、`mcp_*`、`normal.reply` 等）不受影响
- [ ] ADR 0002 中活动工具集表述与代码事实一致（不显示在活动面板，仍上报并进入能力清单）
- [ ] README.md / README.zh-CN.md 补旧 pi 排除静默失效警示，中英对齐
- [ ] 既有测试全部保持通过

## Answer

（待实施填写）
