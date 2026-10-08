# 02 — 模板排除字段：从声明到子进程参数

**What to build:** 模板作者在模板里新增排除字段后，写进去的条目（支持 `*` 通配）会被解析出来，并作为排除项传给子进程，在工具注册阶段生效——被排除的工具既不在 `活动工具集` 里，也无法经 codemode 一类间接路径调用（即从 `可达能力` 中移除）。父代理查看模板清单时能看到该模板的排除项。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 排除字段接受 YAML 字符串数组，条目顺序保留
- [x] 排除字段与 `工具声明` 共用名字形状规则：内部逗号、内部空白、空串、重复项、非字符串一律让模板无效
- [x] 排除字段与 `工具声明` 一样拒绝保留系统工具名（否则子进程会缺协议工具，并在启动时以能力不匹配失败）
- [x] 排除字段被正式接纳进模板字段白名单，不再被当作未知字段而让模板整体无效
- [x] 排除字段为空数组时与不写该字段等价（不产生排除参数）
- [x] 声明了排除字段的模板，其子进程启动参数中出现排除参数，条目与声明一致、顺序一致
- [x] 未声明排除字段（或缺省为空）时，启动参数中不出现排除参数
- [x] `工具声明` 缺省时仍然不产生白名单参数（既有语义不变）
- [x] 父代理查看模板清单时能看到该模板的排除项
- [x] 既有模板清单输出与既有参数拼装用例保持不变

## Answer

模板新增 `excludeTools` 字段（YAML 字符串数组，条目支持 `*` 通配），解析后经 `--exclude-tools` 作为排除参数传给子 pi，在工具注册阶段生效。字段与 `工具声明` 共用 `parseDeclaredToolNames`：名字形状要求非空、trim 后不重复、无内部逗号、无内部空白，并同样拒绝保留系统工具名；空数组与不写等价。父代理经 `get_agent_templates` 可见 `exclude_tools`（根会话直连、子会话经控制路由 wire、展开渲染均保留）。

- 实现：`src/template-discovery-snapshot.ts`（字段白名单、共用解析、诊断 `exclude_tools_invalid`、保留名文案按字段区分）、`src/agent-supervisor-factory.ts`（`--exclude-tools` 拼装，空数组/缺省不传）、`src/authority-control-router.ts` 与 `src/tree-authority.ts`（wire 与模板克隆保真）、`src/agent-tool-rendering.ts`（清单渲染与顺序）、`src/agent-tools.ts`（工具描述）、`CONTEXT.md`（新增「排除声明」术语）
- 测试：`test/template-discovery-snapshot.test.ts` 新增 5 条、`test/agent-supervisor-factory.test.ts` 新增 3 条、`test/template-list-wire.test.ts` 新增 2 条、`test/agent-tool-rendering.test.ts` 新增 2 条；既有用例未改动
- 验证：`npm run typecheck` 通过；`npm test` 653 pass / 0 fail / 5 skipped（平台跳过）
- Review：Standards / Spec 两轴并行审查；已修复保留名诊断文案指向错字段、解析块与渲染校验重复、渲染顺序不一致、工具描述滞后、领域术语缺口；`tools` 收紧（拒绝内部逗号/空白）是「排除字段与 `工具声明` 共用名字形状规则」的直接后果，`excludeTools: ['*']` 可匹配协议工具属 spec 自身边界（US6 要求排除项支持 `*` 与保留名保护冲突），均记录未扩大范围；第三轮 Simple 复核确认全部修复点闭环
