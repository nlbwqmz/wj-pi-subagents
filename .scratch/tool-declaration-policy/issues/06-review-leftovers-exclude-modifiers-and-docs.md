# 06 — 评审遗留：excludeTools 修饰符拒绝 + ADR / README 文档修正

**What to build:**
1. `excludeTools` 条目 trim 后以 `+` 或 `-` 开头（含与普通名混用）时，模板在加载期判无效，诊断定位到模板与 `excludeTools` 字段（与 `tools` 的修饰符拒绝一致）。
2. `docs/adr/0002-template-tool-declaration-boundary.md` 中与代码事实不符的表述修正：「活动工具集…显示在活动面板」改为「仍上报并进入能力清单」（全文核对，只改与事实不符处）。
3. `README.md` / `README.zh-CN.md` 补旧 pi 警示：pi < 1.1.0 时 `*` 与 `excludeTools` 条目按字面工具名处理，排除静默不生效（被排除的工具仍可达）。

背景：三项均来自 `tool-declaration-policy` 的代码评审遗留清单（Standards #3/#7、#4、Spec a3）。决策：修饰符在 `excludeTools` 同样不受支持——与 `tools` 边界一致，且 pi 1.1.0 起 `+`/`-` 为选择表达式修饰符，不拒绝会静默无效或静默改义。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] `excludeTools: ['+x']` / `['-x']`（含与普通名混用、trim 后判断）在加载期判无效，诊断定位到 `excludeTools` 字段，复用既有 `tool_modifier_unsupported` 诊断码
- [x] `tools` 既有修饰符拒绝行为不变；`excludeTools` 既有协议工具命中拒绝行为不变；合法条目（`read`、`mcp_*`、`normal.reply` 等）不受影响
- [x] ADR 0002 中活动工具集表述与代码事实一致（不显示在活动面板，仍上报并进入能力清单）
- [x] README.md / README.zh-CN.md 补旧 pi 排除静默失效警示，中英对齐
- [x] 既有测试全部保持通过

## Answer

`excludeTools` 条目在加载期拒绝 `+` / `-` 修饰符形态：排除字段完成既有形状与保留名校验后，用与 `tools` 共用的 `hasSelectionModifier` 谓词检查 trim 后的条目，命中即返回 `tool_modifier_unsupported`，诊断 field 定位到 `excludeTools`；保留名诊断仍优先于修饰符，与 `tools` 的既有顺序一致。`excludeTools` 的修饰符诊断文案按字段区分，不再复用 `tools` 的基准集说明。ADR 0002 第 (3) 条边界改为「该事实仍上报并进入能力清单」，与代码事实（`business_active_tools` 进入 capability manifest、结果门禁已删除）一致。README 中英 excludeTools 段落补两条说明：修饰符同样在加载期被拒绝；pi < 1.1.0 时通配排除条目按字面名处理，排除静默不生效（被排除的工具仍可达）。

- 实现：`src/template-discovery-snapshot.ts`（`hasSelectionModifier` 共享谓词、`excludeTools` 修饰符判定、按字段区分的诊断文案）
- 测试：`test/template-discovery-snapshot.test.ts` 新增 2 条（`+`/`-`/混用/trim 拒绝并定位 `excludeTools` 字段；保留名优先于修饰符）；既有用例未改动
- 文档：`docs/adr/0002-template-tool-declaration-boundary.md`、`README.md`、`README.zh-CN.md`
- 验证：`npm run typecheck` 通过；`npm test` 659 pass / 0 fail / 5 skipped（平台跳过）
- Review：Standards / Spec 两轴并行审查 + 一轮 Simple 复核闭环。已修复：tools 与 excludeTools 修饰符检测重复（提取共享谓词）、README 中英未写明 excludeTools 拒绝修饰符（两轴共同指出）、诊断文案对 pi 语义断言过强（改为陈述扩展拒绝行为与静默失效/改义风险）
- 遗留（超本工单范围）：`CONTEXT.md` 的「排除声明」定义未写明同样拒绝 `+`/`-` 修饰符（与「工具声明」定义不对称，属文档遗漏而非事实错误）
