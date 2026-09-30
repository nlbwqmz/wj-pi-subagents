# Spec: 内置扩展工具在子代理活动面板中的适配（builtin-extension-tool-activity）

Status: ready-for-agent

## Problem Statement

父会话用户派发子代理后，只能通过子代理活动面板观察它在做什么。pi 0.99.1 提供四个内置扩展——`mcp`、`codemode`、`tool-search`、`llama.cpp`——子代理可以按需加载它们并使用其工具（`codemode`、`tool_search`、`mcp__<server>__<tool>` 以及 MCP 资源工具）。

但活动面板对这几类工具**只显示状态图标加工具名**（如 `✓ codemode`、`✓ mcp__chrome_devtools__navigate_page`）：

- codemode 脚本内容不可见，用户不知道子代理到底跑了什么脚本；
- tool_search 的查询词与加载结果不可见，用户不知道它发现了什么工具；
- MCP 工具的服务器、失败原因与只读/破坏性提示不可见，失败时只有一个 `×`；
- 更严重的是，codemode 脚本内的**嵌套调用**（`tools.read(...)`、`tools.mcp__...(...)`）会以扁平独立条目出现在面板上，看起来像子代理直接调用了这些工具，产生误导。

根因在链路最上游，不在渲染：

1. 活动契约的专用摘要闭集只覆盖 pi 原生基础工具（8 个）与本插件工具（10 个），其余工具一律走"无载荷安全兜底"；
2. 来源判定把内置扩展工具（`sourceInfo.source === "builtin"` 但名字不在原生闭集）归为 `unknown`；
3. 产生端不采集 Pi 的 `parentToolCallId`，嵌套调用没有归属标记；
4. `command` 虽"完整不截断"，但监督通道单字符串上限 16 KB 无法承载长脚本，超限会让活动帧被拒。

## Solution

为四类内置扩展工具建立**来源身份**与**专用摘要闭集**，让面板显示脚本内容、搜索查询与加载结果、MCP 服务器/工具与失败状态；采集嵌套调用事实，让脚本内的调用以 `codemode->` 前缀**独立显示**（保持原有渲染与折叠能力）；统一 `code` 与 `command` 的截断规格（32 KB、按行、`…（已截断，原文共 N 行）`标记，产生端完成）；把监督通道单字符串上限从 16 KB 提升到 64 KB 以承载 32 KB 字段。

所有新数据遵守既有安全原则：**只携带结构性事实，不携带载荷**——MCP 结果与错误正文（外部数据）不进入活动条目；被截断的脚本/命令部分不可恢复。

## User Stories

1. 作为父会话用户，我想在子代理调用 codemode 后展开条目看到它执行的脚本内容，以便知道它到底在编排什么。
2. 作为父会话用户，我想在折叠态就看到脚本行数与嵌套调用数，以便不展开也能判断这次调用的规模。
3. 作为父会话用户，我想看到脚本内实际调用了哪些工具（嵌套条目），以便知道编排的执行链。
4. 作为父会话用户，我想嵌套条目带 `codemode->` 前缀，以便一眼分辨"脚本内调用"与"子代理直接调用"。
5. 作为父会话用户，我想嵌套条目保持原有渲染与折叠能力，以便操作方式不因来源不同而改变。
6. 作为父会话用户，我想在多级嵌套时看到完整调用链（`codemode->A->B`），以便理解深层编排。
7. 作为父会话用户，我想超长调用链的中间层被省略（`codemode->…->B`），以便前缀不挤压正文。
8. 作为父会话用户，我想看到 tool_search 的查询词，以便知道子代理在找什么。
9. 作为父会话用户，我想看到 tool_search 加载了哪些工具及总数，以便知道它发现了什么。
10. 作为父会话用户，我想看到 MCP 工具所属的服务器与工具名，以便在多个 MCP 服务器之间分辨来源。
11. 作为父会话用户，我想在 MCP 工具失败时看到失败状态，以便区分"没调用"和"调用失败"。
12. 作为父会话用户，我想看到 MCP 工具的只读/破坏性注解（annotations），以便评估这次调用的风险性质。
13. 作为父会话用户，我想看到 MCP 资源工具的服务器与 URI，以便知道它读了哪个资源。
14. 作为父会话用户，我想超长脚本与命令被截断并带 `…（已截断，原文共 N 行）`标记，以便知道内容不完整但可读。
15. 作为父会话用户，我想截断后的字段不会导致面板条目或协议故障，以便长脚本不拖垮链路。
16. 作为父会话用户，我想 codemode 条目的展开/折叠沿用面板既有交互，以便学习成本为零。
17. 作为父会话用户，我想嵌套条目在活动窗口裁剪、滚动、选中上与普通条目同等待遇，以便行为可预期。
18. 作为父会话用户，我想面板宽度变化时新条目按新宽度重新折行，以便自适应终端。
19. 作为父会话用户，我想这些工具的活动条目按发生顺序进入时间线，以便回溯过程。
20. 作为父会话用户，我想来源类别不在面板上额外加标记，以便界面保持简洁（MCP 工具名本身可辨识）。
21. 作为父代理，我想子代理的内置扩展工具活动不进入我的模型上下文，以便观测信息不消耗我的上下文预算。
22. 作为父代理，我想子代理使用 codemode/MCP 不影响我对它的控制手段，以便观测能力不改变控制能力。
23. 作为子代理，我想我的脚本内容被如实采集（截断除外），以便父会话用户能审查我的编排。
24. 作为子代理，我想嵌套调用的采集不改变我的工具执行语义，以便观测不成为新的行为来源。
25. 作为扩展维护者，我想四类工具拥有明确的来源类别（`pi_extension` / `mcp`），以便契约语义清晰。
26. 作为扩展维护者，我想来源判定基于注册来源路径（`builtin:codemode` / `builtin:tool-search` / `builtin:mcp`），以便第三方 replaceable 替换时自动回落 `unknown`。
27. 作为扩展维护者，我想 MCP 工具单独成类（不与 pi 自带实现混列），以便将来对外部来源做专门策略时无需再改契约。
28. 作为扩展维护者，我想新摘要字段只携带结构性事实（不携带 MCP 结果与错误正文），以便安全边界不被扩大。
29. 作为扩展维护者，我想截断在产生端完成且规则统一（`code` 与 `command` 共用），以便实现集中、行为一致。
30. 作为扩展维护者，我想监督通道单字符串上限的提升被明确记录并覆盖所有帧类型，以便评估影响面。
31. 作为扩展维护者，我想规范活动契约版本与监督协议版本同步递增（`/13` 与 `/31`），以便不同版本不会被误当成兼容。
32. 作为扩展维护者，我想旧版本条目按既有兼容性边界处理（不认领、不转换、不迁移），以便 clean break 语义不变。
33. 作为扩展维护者，我想新字段与新来源的 wire 闭集校验与产生端同时就位，以便版本一致时条目不被拒。
34. 作为扩展维护者，我想嵌套调用的父引用字段有界且被严格校验，以便不引入越界数据。
35. 作为实现者，我想测试能在不依赖真实 MCP 服务器与真实模型的前提下复现"pi 事件 → 面板显示"，以便用例稳定可重复。
36. 作为实现者，我想"展开查看被截断的完整内容"这类扩展被明确排除，以便不引入载荷存储机制。
37. 作为实现者，我想嵌套调用的多级链、超 3 层省略、超量聚合都有可断言的用例，以便边界行为可验证。
38. 作为实现者，我想来源判定的既有用例（pi 原生、插件、SDK、第三方）不回归，以便适配不破坏既有分类。

## Implementation Decisions

### 来源判定

- **新增两个来源类别**：`pi_extension`（codemode、tool_search）与 `mcp`（MCP 工具与 MCP 资源工具），与既有 `pi_native`、`plugin`、`unknown` 并列。
- **判定依据是注册来源路径**（`sourceInfo.path`）：`builtin:codemode` → `pi_extension`；`builtin:tool-search` → `pi_extension`；`builtin:mcp` → `mcp`。不按工具名判定，因为内置基础工具同样以 `builtin:<toolName>` 形式注册，名字判定会把它们误分；路径判定同时天然兼容 replaceable 替换（第三方注册同名工具时该扩展不加载，工具来源变为第三方路径，回落 `unknown`）。
- **不改变既有分类**：`pi_native`（8 个原生工具）、`plugin`（本插件工具）、`unknown` 的判定规则与用例保持不变。

### 摘要数据面

- **新增摘要闭集**，四类工具的字段形状（决策形状，实现时可微调命名）：

```
pi_extension / codemode:
  start: { tool: "codemode", code: string, codeLines: number }
  end:   { tool: "codemode", isError: boolean, nestedCalls: number }

pi_extension / tool_search:
  start: { tool: "tool_search", query: string }
  end:   { tool: "tool_search", isError: boolean, loaded: string[], loadedTotal: number }

mcp / MCP 工具:
  start: { tool: "mcp__<server>__<tool>", server: string, mcpTool: string }
  end:   { tool: <同上>, isError: boolean, annotations?: { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? } }

mcp / MCP 资源工具:
  start: { tool: "list_mcp_resources" | "list_mcp_resource_templates" | "read_mcp_resource", server: string, uri?: string }
  end:   { tool: <同上>, isError: boolean }
```

- **边界**：`query` 上限 1 KB；`loaded` 列表最多 20 个工具名、另带 `loadedTotal` 总数；`server`/`mcpTool`/`uri` 有界（沿用既有有界文本校验）；`nestedCalls` 为非负整数。
- **annotations 只携带实际存在的 hint**（4 个布尔中缺省的不补 false、不带空对象）。
- **不携带**：MCP 结果正文（content/structuredContent）、MCP 错误正文、codemode 脚本之外的结果文本、tool_search 返回的描述文本。MCP 是外部数据，遵循与 shell 工具失败不带 `errorText` 相同的安全先例。

### 截断规格

- **上限 32 KB（UTF-8 字节）**，适用于 `code` 与 `command` 两个字段；`command` 从"完整不截断"变为"截断"（行为变更）。
- **按行截断**：保留完整行；单行本身超限时按字节兜底截断。
- **标记统一为** `…（已截断，原文共 N 行）`（N 为原文总行数；两种截断方式共用同一标记）。
- **截断在产生端完成**（数据层）：被截断部分不进入活动条目，不可恢复；面板不提供"展开查看全文"。

### 嵌套调用

- **产生端采集** Pi 事件上的 `parentToolCallId`（嵌套调用的直接父 id；toolCallId 形如 `<callerId>/<n>`），随活动条目携带。
- **显示为独立条目**：不放进 codemode 条目的折叠体；条目名前加 `codemode->` 前缀标识来源。
- **多级链**：前缀按完整调用链拼接（`codemode->A->B`）；超过 3 层时中间省略（`codemode->…->B`）。
- **嵌套条目保持原有显示能力**：该有摘要的（如嵌套的 `read`、MCP 工具）照常显示摘要；该可折叠的照常可折叠；前缀只加在最前面，不改变其余渲染。
- **超量聚合**：单次 codemode 调用最多 256 条嵌套记录，面板对超量部分聚合显示（如 `其余 N 条省略`）。

### 面板呈现

- **codemode 条目**：折叠态摘要行为"状态图标 + `codemode` + 脚本行数 + 嵌套调用数"；展开体显示截断后的 `code` 脚本（沿用既有预格式化正文渲染）。
- **嵌套条目**：正常条目渲染 + `codemode->` 前缀（前缀不参与摘要内容，只加在工具名显示处）。
- **tool_search / MCP 工具 / MCP 资源工具**：沿用既有摘要行与展开体渲染，内容按新摘要字段填充。
- **来源类别不上屏**：不在面板上显示 `pi_extension` / `mcp` 标记；origin 作为契约事实保留。

### 传输边界

- **监督通道单字符串上限**：16 KB → **64 KB**（`maxStringBytes`），以承载 32 KB 字段并留出帧内其他字段余量。
- **影响面明确记录**：该常量作用于**所有帧类型**（活动帧、快照、控制帧等）的字符串校验，不只活动条目；帧总大小上限（512 KB）与 JSON 条目数上限不变。
- **超限行为不变**：超过上限的帧仍按 `frame_too_large` 协议错误处理。

### 契约与兼容

- **规范活动契约版本**：`wj-pi-subagents.activity/12` → `/13`。
- **监督协议版本**：`wj-pi-subagents/30` → `/31`（两个常量同步递增，避免错配窗口）。
- **已发布版本的确认**：`/12` 与 `/30` 已随 0.5.4 发布，因此本次是发布后的不兼容递增，不再适用"未发布版本可并入"的惯例。
- **不提供兼容层**：版本不一致按既有兼容性边界处理（不认领、不转换、不迁移旧会话），旧版本条目按协议故障处理。
- **一次交付**：来源判定、摘要、截断、嵌套、显示与传输调整作为同一功能切片交付，一次升版。

### 模块影响

- **来源判定**：新增 `pi_extension` / `mcp` 的路径判定分支。
- **产生端规范化器**：新增四类工具的摘要提取与截断；采集 `parentToolCallId`；`code`/`command` 共用截断函数。
- **wire 闭集校验**：新增字段、新来源类别的键集合与类型校验；截断边界校验；旧版本拒绝不变。
- **规范活动契约**：契约版本常量递增。
- **活动缓存与查看器**：嵌套条目的前缀投影；codemode 摘要行与展开体；超量聚合显示。
- **监督通道**：帧校验常量调整；协议版本常量递增。

## Testing Decisions

- **好测试的标准**：只断言外部可观察行为——产生端规范化器的输出条目、wire 校验的接受/拒绝结果、面板渲染出的文本行；不断言内部字段结构、私有状态或调用次数。用例名写成中文行为陈述句（本仓库既定风格）。
- **接缝（全部复用现有测试文件，新增接缝为 0）**：
  - **S1 来源判定**（`classifyRegisteredToolOrigin`，`test/tool-origin.test.ts`）：新类别的路径判定、第三方替换回落、既有分类不回归。
  - **S2 产生端规范化**（`normalizeOwnToolActivityEvent`，`test/canonical-activity-normalization.test.ts`）：四类工具摘要提取、截断边界、嵌套父引用采集。
  - **S3 wire 校验**（`parseAgentActivityEvent` / `parseCanonicalAgentActivityEvent`，`test/rpc-bridge-event.test.ts`）：新字段闭集、新来源类别规则、截断边界、旧版本拒绝。
  - **S4 面板模型与渲染**（`AgentActivityViewerModel` / `renderAgentActivityViewerSurface`，`test/agent-activity-viewer.test.ts`）：`codemode->` 前缀（含多级链与省略）、codemode 展开体、超量聚合。
  - **S5 传输边界**（`SupervisorChannel` 帧校验，`test/agent-activity-channel.test.ts`）：64 KB 字符串接受、超限 `frame_too_large` 拒绝。
- **必须覆盖的验收用例**：
  1. `builtin:codemode` / `builtin:tool-search` 的工具判为 `pi_extension`；`builtin:mcp` 的工具与资源工具判为 `mcp`；第三方路径回落 `unknown`。
  2. codemode start 摘要携带截断后的 `code` 与 `codeLines`；end 摘要携带 `isError` 与 `nestedCalls`。
  3. tool_search start/end 摘要携带 `query`、`loaded`（≤20）、`loadedTotal`。
  4. MCP 工具摘要携带 `server`/`mcpTool`；end 携带 `isError` 与存在的 annotations；MCP 结果正文与错误正文不进入条目。
  5. MCP 资源工具摘要携带 `server`/`uri`；end 携带 `isError`。
  6. 32 KB 内字段原样接受；超限字段被按行截断并带 `…（已截断，原文共 N 行）`；单行超限走字节兜底。
  7. `command` 与 `code` 共用同一截断规则（含标记一致）。
  8. 嵌套调用条目携带父引用；面板渲染 `codemode->` 前缀；多级链完整、超 3 层省略中间。
  9. 嵌套条目自身的摘要与折叠能力不回归（如嵌套 `read` 显示 path、嵌套 MCP 工具显示 server/tool）。
  10. 超 256 条嵌套记录在面板上聚合显示"其余 N 条省略"。
  11. wire 校验：新字段闭集严格（未知键拒绝）；新来源类别按各自闭集校验；旧契约版本条目仍按不兼容处理（发布端拒绝、接收端按协议故障）。
  12. 监督通道：32 KB 字符串跨端发布/接收被接受；超过 64 KB 上限的字符串按 `frame_too_large` 拒绝。
  13. **版本一致时，活动链路故障不得把子代理判为失败**（沿用既有硬约束用例的断言方向）。
  14. 活动事实语义不变：四类工具条目与嵌套条目不改变子代理生命周期状态、不进入实时显示草稿、不进入父模型上下文。
- **不自动化**：真实 MCP 服务器与真实模型的端到端验证作为手工验收步骤，不进入 `npm test`。

## Out of Scope

- **llama.cpp 扩展**：只有 provider 与 `/llama` 命令，没有工具面，不在活动面板适配范围。
- **MCP 能力面扩展**：prompts、sampling、elicitation、MCP Apps、资源订阅等内置 mcp 不支持的能力，不属于本次活动适配。
- **展开查看被截断的完整内容**：截断在产生端完成且不可恢复；不引入"原文落盘 + 引用"机制。
- **嵌套调用的折叠树**：本次按"独立条目 + 前缀"呈现，不做父子折叠/树形分组。
- **嵌套条目的二级展开**：嵌套条目沿用其自身渲染能力，不新增独立展开体。
- **面板来源标记**：不显示 `pi_extension` / `mcp` 标签。
- **兼容层**：不为旧契约/旧协议提供迁移或转换。
- **重试/去重/节流**：不做条目合并、去重或聚合（超量聚合仅限单次调用的嵌套记录显示）。
- **通道故障语义调整**：不改变"无法解析的活动帧导致通道故障"的既有裁决，只保证版本一致时新条目可被接受。

## Further Notes

- **调研依据（pi 0.99.1 侧事实）**：
  - codemode 脚本内的嵌套调用走正常 `tool_execution_start/update/end` 事件；toolCallId 形如 `<callerId>/<n>`（多级 `<a>/<n>/<m>`），携带 `parentToolCallId`（直接父 id）；嵌套调用不写 transcript，父结果上记 `nestedCalls`（上限 256）。
  - 内置扩展工具在 `ToolInfo.sourceInfo` 中为 `path: "builtin:<name>"`、`source: "builtin"`、`scope: "temporary"`；内置**基础**工具同样以 `builtin:<toolName>` 形式注册，因此不能只凭 `source` 区分。
  - tool_search 的返回值形如 `Loaded N tool(s). They are available from your next call: ...`，并改变后续工具声明。
  - MCP 工具名规则 `mcp__<server>__<tool>`，超长或重名时带 8 位哈希后缀；annotations 为 4 个可选布尔 hint。
  - 监督通道既有硬限：单字符串 16 KB、单帧 512 KB（`frame_too_large` 为协议错误）。
- **术语**：使用 `CONTEXT.md` 的领域语言——本特性属"活动条目"与"活动事实"范畴，不改变"子代理生命周期状态"，不进入"实时显示草稿"，不改变"控制屏障"；版本不一致按"兼容性边界"处理。
- **与 ADR-0001 的一致性**：新条目沿用"活动事实逐条登记、不撤回、不合并、不驱动生命周期"的既有决策；本次同样属不兼容契约变化，契约与协议版本同步递增、不提供兼容层。
- **明确接受的副作用**：`command` 从"完整"变为"截断"（超 32 KB 的命令行会丢尾部）；嵌套调用会让面板条目数量增加（脚本内每次调用各一条）；通道字符串上限提升使所有帧类型的单字符串校验放宽到 64 KB。
- **已知边界**：多级嵌套在当前环境下几乎不会发生（codemode 不能被脚本调用、MCP 与内置工具不编排其他工具），但按完整链实现以防御未来编排型扩展工具。
