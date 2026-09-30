# 03 — tool_search 与 MCP 适配

**What to build:** tool_search 与 MCP 工具的活动在面板上变得可读——来源判定补齐 `builtin:tool-search` → `pi_extension` 与 `builtin:mcp` → `mcp`（含资源工具）；摘要补齐：tool_search 的 start 携带 `query`（上限 1 KB）、end 携带 `loaded`（最多 20 个工具名）与 `loadedTotal`；MCP 工具的 start 携带 `server` 与 `mcpTool`、end 携带 `isError` 与实际存在的 annotations；MCP 资源工具的 start 携带 `server` 与 `uri`、end 携带 `isError`；wire 闭集校验同步；面板沿用既有摘要渲染。MCP 结果正文与错误正文（外部数据）确认不进入活动条目。

**Blocked by:** 02 — codemode 适配

**Status:** resolved

- [x] `builtin:tool-search` 判为 `pi_extension`；`builtin:mcp` 的工具与资源工具判为 `mcp`；第三方路径（replaceable 替换后）回落 `unknown`
- [x] tool_search start/end 摘要按上述字段携带；`query` 超 1 KB 截断、`loaded` 最多 20 个且 `loadedTotal` 为真实总数
- [x] MCP 工具 start 摘要携带 `server` / `mcpTool`（工具名带哈希后缀时仍能正确解析）；end 摘要携带 `isError` 与存在的 annotations（缺省 hint 不补 false、不带空对象）
- [x] MCP 资源工具（`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`）按上述字段携带
- [x] MCP 结果正文（content / structuredContent）与错误正文不进入任何活动条目字段
- [x] wire 闭集校验按新来源类别分别闭合；未知键、错误组合拒绝
- [x] 端到端可演示：tool_search 显示查询与加载结果；MCP 工具失败时显示 `isError` 状态且无外部正文
- [x] 活动事实语义不变：不改变生命周期、不进入实时显示草稿与父模型上下文

## Answer

实现只覆盖工单 03 的 tool_search 与 MCP 适配，未触及 04 的嵌套调用显示。

- **来源判定**（`src/wj-pi-subagents-runtime.ts`）：`PI_EXTENSION_TOOL_SOURCE_PATHS` 加入 `builtin:tool-search`；新增 `mcp` 来源类别与 `MCP_TOOL_SOURCE_PATHS`（`builtin:mcp`），按注册来源路径判定，第三方 replaceable 替换后自动回落 `unknown`。新增 `createMcpToolAnnotationsResolver`（注册表查询 annotations，与来源解析共用提取后的 `findRegisteredTool`）。
- **摘要数据面**（`src/rpc-bridge-event.ts`）：`SafeToolSummary` 新增 tool_search、MCP 工具（`tool: \`mcp__${string}\``）与 MCP 资源工具三类；`query` 超 1 KB 按 UTF-8 字节截断；`loaded` 最多 20 个且 `loadedTotal` 为真实总数（数组长度，含非法元素时整体降级）；MCP 工具名按第一个 `__` 解析 server/mcpTool，哈希后缀留在工具名侧；annotations 在产生端净化（只保留 4 个已知布尔 hint，空对象/未知键/非布尔过滤）。MCP 结果正文（content/structuredContent）与错误正文一律不进入摘要。
- **wire 闭集**：`parseToolSummary` 按来源分派；新增 tool_search、MCP 工具、MCP 资源工具三套 start/end 键集合与类型校验；成功事实强制 loaded+loadedTotal、失败事实禁止携带；annotations 空对象/未知键/非布尔拒绝；来源未验证携带专用摘要拒绝。
- **面板**（`src/agent-activity-viewer.ts`）：tool_search 折叠态显示查询词与加载列表/总数（超 20 截断显示 `20/25 tools`）；MCP 工具显示完整工具名与实际存在的 true hint 标签（read-only/destructive/idempotent/open world）；资源工具显示 server 与 URI（URI 作为可中间省略的路径字段）。来源类别不上屏。
- **决策说明**：① end 摘要自包含输入字段（tool_search 的 `query`、资源工具的 `server`/`uri`）——活动快照只保留 end 条目，沿用 02 的“end 摘要自包含”惯例，是 spec 声明形状之外的必要扩展；MCP 工具的 `server`/`mcpTool` 由工具名解析，不依赖缓存。② `uri` 上限 2048B——URI 是资源标识而非工具 ID，可能超过 256B；沿用既有 `validBoundedText` 机制并设明确上限。③ 超长 server 名（≥49 字符）被 pi 截断到 55 字符后不再含第二个 `__` 时整体降级——名字信息已丢失不可恢复，降级是安全行为。
- **验证**：`npm run check`（`tsc --noEmit` + 全量测试）通过：627 pass / 0 fail / 5 skipped；新增用例覆盖来源判定与第三方回落、annotations 解析、四类摘要提取与边界（1 KB 截断、loaded 截断、哈希后缀解析、净化）、wire 闭集与错误组合拒绝、面板渲染与端到端链路（原始事件 → 产生端 → 面板）。
- **代码审查**：Standards 轴 1 项硬违规（tool_search 成功但结果结构异常时产生端产生 wire 拒绝的形状，已改为完整降级并补用例）+ 流程项（工单写回，已处理）；判断项中提取了注册表查询重复、修正了资源工具的失实类型断言并收敛 annotations 类型，6 参数签名与 URI 上限作为有意决策保留。Spec 轴确认各验收项均满足，指出的 `loadedTotal` 语义已修正为真实总数，end 自包含扩展与 URI 上限已在上面记录决策。
