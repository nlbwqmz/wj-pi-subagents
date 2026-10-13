Status: ready-for-agent

# Spec：pi 最低依赖 1.2.0 升级与工具层能力利用

## Problem Statement

扩展当前要求 pi >= 0.85.1。从 0.85.1 到 1.2.0，pi 增加了大量对"子代理编排"直接有用的能力：工具结果的结构化输出（outputSchema / structuredContent / isError）、工具语义标注（annotations）、命名空间（namespace）、渲染耗时（durationMs）、settle 中断标记（agent_settled.aborted）等。维持旧下限意味着：

- 使用 codemode / 脚本 / 自动化的用户只能解析 JSON 文本，拿不到机器可读结果；
- 权限类扩展无法识别"只读/破坏性/开放世界"工具，无法做确认策略；
- 用户看不到工具执行耗时，长等待（wait_agent）没有时间反馈；
- 子代理"被取消"与"正常完成"在结果里无法区分；
- 扩展继续以 API 存在性探针代替明确的版本基线。

同时，提升最低版本本身是面向用户的破坏性变更（旧 pi 用户被挡），需要一次有计划的 minor 发布与迁移说明。

## Solution

发布扩展 0.7.0：最低 pi 版本提升到 1.2.0，并一次性利用新能力：

- 10 个工具全量声明 outputSchema / structuredContent，错误统一改为 isError 返回；
- 10 个工具加 annotations 与统一 namespace；
- 工具渲染接入 durationMs，在结果行尾显示耗时（pi 风格格式）；
- 消费 agent_settled.aborted，在工具结果中暴露"是否被取消"；
- host-gate 更新提示文案，peerDependencies 改为官方 `"*"` 模式，CI 覆盖"最低版本阻塞 + 最新版定时"；
- 文档同步：版本要求、迁移说明、模板内置扩展隔离说明、模板工具语法。

0.7.0 采用 minor 号：`^0.6.0` 用户不会被自动升级，主动更新后才遇到新要求，天然提供缓冲。

## User Stories

1. 作为使用 codemode 的开发者，我希望 `wait_agent` / `get_agent_status` / `get_agent_tree` 返回机器可读对象，这样脚本不必解析 JSON 文本。
2. 作为脚本作者，我希望全部 10 个工具都有 `structuredContent`，这样任何工具结果都能直接消费。
3. 作为脚本作者，我希望工具失败时返回 `isError` + 结构化错误对象，这样我不必用 try/catch 解析异常文本。
4. 作为脚本作者，我希望 21 个既有错误码在结构化结果里保持稳定，这样我的错误处理逻辑不因升级而失效。
5. 作为使用权限扩展的用户，我希望 `terminate_agent` 带 `destructiveHint`，这样调用前能收到确认提示。
6. 作为使用权限扩展的用户，我希望查询类工具带 `readOnlyHint`，这样它们能自动放行。
7. 作为使用权限扩展的用户，我希望 `spawn_agent` 带 `openWorldHint`，这样它会被视为开放世界操作。
8. 作为使用 codemode 的开发者，我希望子代理工具归入统一 namespace，这样 `describeNamespace` 能一次取到全部工具文档。
9. 作为使用 tool_search 的用户，我希望子代理工具按 namespace 分组展示，这样搜索结果更清晰。
10. 作为使用 codemode 的开发者，我希望 `wait_agent` 结果带 `aborted` 字段，这样能区分"被取消"与"正常完成"。
11. 作为编排用户，我希望被中断的等待在结果里明确标记，这样我能决定重试还是继续。
12. 作为普通用户，我希望工具结果行尾显示耗时（如 ` · 4.2s`），这样我能看到 `wait_agent` 实际等了多久。
13. 作为普通用户，我希望所有工具都显示耗时，这样呈现一致、没有"为什么这个有那个没有"的疑问。
14. 作为普通用户，我希望失败结果也显示耗时，这样失败路径同样有时间信息。
15. 作为普通用户，我希望耗时格式与 pi 内置工具一致（`4.2s` / `3m 15s` / `1h 05m 30s`），这样观感统一。
16. 作为普通用户，我希望 `isError` 改造后错误的视觉呈现与现在完全相同，这样升级不带来观感变化。
17. 作为普通用户，我希望父回复卡片与树面板的现有外观不变，这样升级不影响我已习惯的界面。
18. 作为普通用户，我希望工具名保持不变，这样我已有的提示词/文档/脚本中的工具名继续有效。
19. 作为使用旧版 pi 的用户，我希望扩展明确告诉我"当前版本 X < 要求的 1.2.0"以及升级方式，而不是静默不工作。
20. 作为使用旧版 pi 的用户，我希望扩展以软禁用方式加载（只提示、不提供功能），这样我能理解发生了什么。
21. 作为通过 npm 安装扩展的用户，我希望 peerDependencies 使用 `"*"` 范围，这样不会出现 npm 与宿主两套版本管理冲突。
22. 作为锁定 `^0.6.0` 的用户，我希望 0.7.0 不会自动升级到我这里，这样破坏性变更由我主动选择。
23. 作为用户，我希望 release notes 明确列出迁移步骤（升级 pi、无工具名变化、错误处理可选用结构化字段），这样我能快速完成升级。
24. 作为维护者，我希望 CI 在最低支持版本（1.2.0）上阻塞验证，这样兼容性有保证。
25. 作为维护者，我希望有一个 latest 定时任务提前发现上游破坏，且不阻塞日常 PR，这样既能前瞻又不被打扰。
26. 作为维护者，我希望发布清单测试（requiresPi / peerDeps / devDeps / lock / CI 安装串）自动校验 1.2.0，这样版本升级不会被漏改。
27. 作为维护者，我希望新增工具的 annotations 有断言保护，这样未来新增工具不会漏标或误标。
28. 作为维护者，我希望 `agent_settled.aborted` 在事件归一化层有单测，这样字段解析与剥离行为可回归。
29. 作为维护者，我希望错误路径改造有回归测试覆盖（不再抛错、保留结构化错误），这样行为变化被显式锁定。
30. 作为模板作者，我希望文档说明"模板声明 extensions 后内置扩展被屏蔽；要 codemode 需 `builtin:codemode` 且列入 tools"，这样我知道如何给子代理配置内置扩展。
31. 作为模板作者，我希望文档明确 `*` 通配的用法与示例（不再标注 pi 1.1.0 条件），并说明 `+name`/`-name` 修饰符不受支持（ADR 0002 设计）、排除全部 MCP 应使用 `excludeTools: ["mcp__*"]`，这样我能正确配置子代理工具集。
32. 作为子代理的父代理，我希望被唤醒处理子代理回复时仍然拿到管理准则（messageType 不检查），这样我不会忘记"处理报告、向上汇报、继续等待"的职责。
33. 作为用户，我希望 `wait_agent` 取消时仍显示 `Operation aborted` 并追加耗时，这样既有语义保留、又补充了时间信息。
34. 作为用户，我希望树面板与活动查看器的状态显示保持现状（不新增 aborted 标注），这样 UI 不因本次升级而变化。
35. 作为维护者，我希望本次升级不引入 exposure 策略、unsubscribe、settle 编排等高风险改动，这样发布回归面可控。

## Implementation Decisions

### 1. 发布基线

- 最低 pi 版本：**1.2.0**；扩展版本：**0.7.0**（minor bump，利用 `^0.6.0` 不自动升级的语义提供缓冲）。
- `peerDependencies` 两个宿主包范围改为 `"*"`（官方约定；实际代码只检查 `dependencies`，不强制 `"*"`）；版本把关由宿主门禁 + `requiresPi` 元数据承担。
- `wjPiSubagents.requiresPi` 改为 `">=1.2.0"`；devDependencies 与 lock 同步 `1.2.0`。
- CI：最低版本（1.2.0）任务阻塞；另加 latest 定时任务，失败不阻塞 PR。
- 发布清单断言同步：requiresPi、peerDependencies、devDependencies、lock、CI 安装串。
- 兼容性冒烟脚本（`pi-compat-smoke`）随 `requiresPi` 自动取 1.2.0，断言集保持不变（get_state 响应 + setWidget 请求）。

### 2. 工具定义（10 个工具：8 个管理 + normal_reply / final_report）

- **annotations**（显式声明全部 4 个字段，避免 MCP 惯例默认值歧义）：

| 工具 | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
|---|---|---|---|---|
| spawn_agent | false | false | false | true |
| send_message | false | false | false | false |
| wait_agent | false | false | false | false |
| interrupt_agent | false | false | false | false |
| terminate_agent | false | true | true | false |
| get_agent_status | true | false | true | false |
| get_agent_tree | true | false | true | false |
| get_agent_templates | true | false | true | false |
| normal_reply | false | false | false | false |
| final_report | false | false | false | false |

  关键约束：`wait_agent` 不标只读（会消费/释放批次）；`terminate_agent` 幂等（终态），`interrupt_agent` 不幂等（可能打断之后的新活动）。
- **namespace**：10 个工具统一归入一个 namespace；建议 name 取 `subagent`（codemode 分组标题简短），aliases 含包名（`wj-pi-subagents`、`subagents`），description 说明"多级子代理编排"，instructions 简述工具选择顺序。namespace 不改变工具名（模型看到的仍是原名）。
- **outputSchema**：10 个工具全部声明，形状与现有 `details` 结构一致；成功结果的 `structuredContent` 等于现有 `details`（不新增数据结构）。
- **类型**：保持"不导入 pi 类型"的现状，在本地类型定义中补 `ToolAnnotations` 结构类型（4 个可选布尔）与 `outputSchema` 字段。

### 3. 工具执行与错误路径

- 成功路径：`content`（模型可见 JSON 文本）保持现状；新增 `structuredContent` = 现有 `details`。
- 失败路径：**统一改为 `isError: true` 返回**，不再抛 `SubagentToolError`；模型可见的 `content` 错误文本与现在保持一致（错误 JSON）；`details` / `structuredContent` 保留 `{ok:false, error}` 结构。
- 21 个错误码与错误元数据结构不变。
- 参数校验错误仍由 pi 在 execute 之前处理，不属于本次改造范围。
- 影响面：错误外壳的三处既有断言（启动错误、活动归一化、工具渲染错误）需同步改造为 isError 断言。

### 4. RPC 事件与状态

- 事件归一化层保留 `agent_settled.aborted`（1.1.0 起 RPC 透传，值为布尔）。
- 子代理状态模型记录"最近一次 settle 是否为 aborted"作为**独立事实字段**，不修改生命周期闭集（starting / idle / working / interrupting / terminating / terminated / failed）。
- `wait_agent` 与 `get_agent_status` 的结果暴露 `aborted`；`wait_agent` 取消时的既有 `Operation aborted` 文本保留。

### 5. 工具渲染

- 渲染接口新增只读 `durationMs`（来自 pi 渲染上下文）。
- 所有 10 个工具的结果最后一行尾部追加 dim 耗时段：` · 4.2s`。
- 成功与失败结果都显示耗时（pi 异常路径同样记录 durationMs）。
- 格式规则（pi 风格，移植 `formatToolDuration` 语义）：`<60s → 4.2s`（一位小数）；`<60m → 3m 15s`；否则 `1h 05m 30s`。
- `outputPad` **不做处理**：工具走默认 shell，宿主已统一应用左右 padding，扩展再应用会造成双份缩进。
- 父回复卡片与消息卡片的 padding 逻辑保持不变（现有实现正确）。
- 既有精确匹配的渲染断言（wait_agent woken / aborted / 错误行等）需同步更新。

### 6. 生命周期行为

- `before_agent_start` **不检查 `messageType`**：所有 run（含 `sendMessage(triggerTurn:true)` 触发的 custom run）都注入准则；在代码注释中写明这是有意行为——被唤醒处理子代理回复的父代理同样需要准则。
- busy 处理不动：RPC prompt 语义未变，`host_busy` 分类仍必要；1.2.0 下 `isStreaming` 从 run 启动即为 true，现有 steer/prompt 决策自动受益。
- 不使用 `pi.on()` 返回的 unsubscribe：`/reload` 会新建 api 对象并整体丢弃旧注册；扩展没有动态增删 handler 的需求。
- settle 编排（`agent_before_settle` / `turn_end` 返回值）不做。

### 7. 明确不做（本次范围外）

- exposure 暴露策略（全部保持 direct）。
- reachesTools（当前无消费场景）。
- TUI 颜色 API、`registerToolRenderer`、Home/End 处理。
- 树面板 / 活动查看器的 aborted 标注；model_call_failure 行的 aborted/error 区分。
- busy 处理简化、settle 编排。

### 8. 门禁与文档

- host-gate 提示文案更新：写明"当前 pi 版本 X < 要求的 1.2.0"与升级指引；保持软禁用策略（仅一次 `session_start` 提示）；保留 API 探针作为前瞻防御。
- README / README.zh-CN：更新版本要求与迁移说明；新增"模板声明 extensions 后内置扩展被屏蔽，要内置扩展需 `builtin:<name>` 且列入 tools"；模板工具语法去掉 `*` 的"需 pi 1.1.0"条件说明并补 `mcp__radius__*` / `mcp__*` 示例；说明扩展不暴露 `--no-mcp`（排除全部 MCP 用 `excludeTools: ["mcp__*"]`）；`+name`/`-name` 保持 ADR 0002 的加载期拒绝，文档说明不变。
- CONTEXT 文档中的版本表述同步更新。
- release notes（0.7.0）列出：最低 pi 1.2.0、错误路径改为 isError（模型可见文本不变）、新增结构化输出/annotations/namespace/耗时显示、无工具名变化。
- 核对确认（无需改代码）：`*` 通配在解析 → wire → 参数构造全程原样透传（已有测试覆盖）；`+`/`-` 前缀的加载期拒绝是 ADR 0002 的有意设计，保持不变。

## Testing Decisions

好测试的标准：只断言**外部可观察行为**——注册后的工具定义字段、`execute` 的返回值、渲染出的文本行、事件归一化的输出对象；不耦合内部实现细节、不断言私有函数。

**Seam 1（主 seam）：工具注册入口**（复用现有"假 ExtensionAPI 捕获 registerTool"模式）
- 断言 10 个工具的 annotations 四字段、namespace、outputSchema 存在性（新增工具漏标/误标可被捕获）。
- 断言成功结果的 `structuredContent` 与 `details` 一致。
- 断言失败路径返回 `isError: true` 且携带结构化错误（不再抛错）。
- 断言渲染结果行尾出现耗时 dim 段，覆盖格式三分支（`4.2s` / `3m 15s` / `1h 05m 30s`）与失败结果。
- 改造既有精确匹配断言：错误外壳三处、wait_agent woken/aborted/错误行渲染。
- Prior art：现有工具注册捕获与 `executeRegisteredTool` / `renderRegisteredError` 辅助模式；现有成功路径的 `content`/`details` 断言。

**Seam 2：RPC 事件归一化**（复用 `normalizeRpcBridgeEvent` 纯函数直调测试表）
- 断言 `agent_settled` 保留 `aborted`；未知字段继续被剥离；`agent_settled` 用例表补齐（当前该事件无专门单测）。
- 可选：真实 bridge 子进程脚本事件端到端验证 aborted 传播（复用现有脚本 fake 集成模式）。

**Seam 3：发布清单与门禁**（复用 `package-manifest` 与 `host-gate` 测试）
- 断言 requiresPi / peerDependencies / devDependencies / lock / CI 安装串均为 1.2.0 基线。
- 断言门禁提示文案包含当前版本与要求版本；失败路径仍不注册工具。
- 更新测试桩中的 `piVersion` 为 1.2.0。

**不新增**：测试框架、loader hook、UI 颜色/Home-End 相关测试、树面板 aborted 标注测试（不在范围）。

## Out of Scope

- exposure / prepareLoadout 工具暴露策略（未来如工具数量增长再考虑，届时做成配置项）。
- reachesTools 声明（当前无消费场景）。
- `pi.on()` unsubscribe、settle 编排（agent_before_settle / turn_end 可操作返回值）。
- TUI 颜色 API 改造、`registerToolRenderer`、Home/End 处理。
- aborted 的 UI 标注（树面板 / 活动查看器 / model_call_failure 行）。
- busy 处理简化、`ctx.executeTool()`、`ctx.modelRegistry.streamSimple()`、虚拟模型、MCP 注册等无场景能力。
- 多 pi 版本兼容分支：升级后不再保留 0.85.1 路径。

## Further Notes

- **CI 触发条件**：现有 CI 为 `workflow_dispatch` 手动触发。要实现"最低版本阻塞 + latest 定时"的策略，建议改为 push/PR 触发主任务并新增定时 latest 任务；该改动需在实现时一并处理。
- **aborted 数据来源**：RPC 模式下 `agent_settled` 原样透传 `aborted`（1.1.0+）；父会话侧事件同名字段。本次只在工具结果暴露，不改 UI。
- **messageType 决策理由**：custom run（子代理回复注入）需要父准则与模板目录，1.2.0 的 union 变化恰好补上了旧版 custom run 无准则的空档；注释需写明"有意不检查"。
- **namespace 文本**：name / aliases / description / instructions 的具体措辞可在实现时微调，但必须保证 name 不与常见扩展命名空间冲突，且 aliases 覆盖包名。
- **错误路径改造的影响面**：现有三处错误外壳断言（启动错误、活动归一化、工具渲染）与测试辅助函数需同步改造；这是本次最大的回归面，测试改造应在实现前先完成（红→绿）。
- **未来候选**：exposure 配置化、settle 编排、树面板 aborted 标注、reachesTools（若 pi 出现消费场景）、`--no-mcp` 模板字段（需先重新评估 ADR 0002 的相关否决）。
