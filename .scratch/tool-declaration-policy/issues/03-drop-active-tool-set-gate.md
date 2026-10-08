# 03 — 删除"活动工具集 = 声明"的结果门禁

**What to build:** 子进程上报的 `活动工具集` 与模板 `工具声明` 不一致时，子代理不再被拒绝启动，而是正常接受并继续；含 `*` 的模板因此从"必然启动失败"变成可用。`活动工具集` 仍然上报并显示在活动面板上。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 子进程上报的业务活动工具集与模板声明不同时，启动被接受（新增用例）
- [x] 含 `*` 的模板可以正常派发子代理（不再因字面集合比较而失败）
- [x] 活动工具集仍然进入能力清单，并可供活动面板显示（不因删除门禁而丢失）
- [x] 其余启动校验行为不变：协议工具集、系统工具来源路径、扩展路径身份、provider / model / thinking 仍然不匹配即拒绝
- [x] 既有启动错误分类与协议故障用例全部保持通过
- [x] 若既有启动接受 harness 无法表达"带 `工具声明` 的模板 + 不匹配的清单"，以最小注入点扩展它，不引入新的测试框架

## Answer

删除子进程启动接受中"`活动工具集` 必须等于 `工具声明`"的结果门禁：`childCapabilityMatches` 不再比较模板声明的工具集与子进程上报的业务活动工具集，含 `*` 的模板因此可正常派发；`business_active_tools` 仍由子端上报并进入能力清单。其余启动校验逐项保留：协议工具集集合、系统工具来源键与路径身份、扩展路径身份、provider / model / thinking。

- 实现：`src/agent-supervisor-factory.ts`（删除结果门禁；`childCapabilityMatches` 与 `ExpectedChildCapability` 导出为最小注入点）
- 测试：`test/spawn-startup-errors.test.ts` 扩展既有启动接受 harness（`StartupTestChannel` 可注入能力清单），新增 1 条接受用例 + 4 条"不变校验"拒绝用例；既有启动错误分类与协议故障用例未改动
- 验证：`npm run typecheck` 通过；`npm test` 653 pass / 0 fail / 5 skipped（平台跳过）；单文件 19/19
- Review：Standards / Spec 两轴并行审查 + 两轮 Simple 闭环终检。已修复用例名/注释与 harness 不符的问题；曾试保留 `template` 契约出处字段，终检判定为只写不读死字段后回退。终检确认门禁删除干净、其余校验未变、无新增硬违规；遗留发现均判定为可接受或超范围：测试注入点导出（工单明文允许）、4 条补强拒绝用例、helper 装配形状与既有用例重复（重构既有 7 处超范围）、`business_active_tools` 无显示消费方（既有缺口，超本 diff）
