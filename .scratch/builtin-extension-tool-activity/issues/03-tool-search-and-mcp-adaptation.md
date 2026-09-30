# 03 — tool_search 与 MCP 适配

**What to build:** tool_search 与 MCP 工具的活动在面板上变得可读——来源判定补齐 `builtin:tool-search` → `pi_extension` 与 `builtin:mcp` → `mcp`（含资源工具）；摘要补齐：tool_search 的 start 携带 `query`（上限 1 KB）、end 携带 `loaded`（最多 20 个工具名）与 `loadedTotal`；MCP 工具的 start 携带 `server` 与 `mcpTool`、end 携带 `isError` 与实际存在的 annotations；MCP 资源工具的 start 携带 `server` 与 `uri`、end 携带 `isError`；wire 闭集校验同步；面板沿用既有摘要渲染。MCP 结果正文与错误正文（外部数据）确认不进入活动条目。

**Blocked by:** 02 — codemode 适配

**Status:** ready-for-agent

- [ ] `builtin:tool-search` 判为 `pi_extension`；`builtin:mcp` 的工具与资源工具判为 `mcp`；第三方路径（replaceable 替换后）回落 `unknown`
- [ ] tool_search start/end 摘要按上述字段携带；`query` 超 1 KB 截断、`loaded` 最多 20 个且 `loadedTotal` 为真实总数
- [ ] MCP 工具 start 摘要携带 `server` / `mcpTool`（工具名带哈希后缀时仍能正确解析）；end 摘要携带 `isError` 与存在的 annotations（缺省 hint 不补 false、不带空对象）
- [ ] MCP 资源工具（`list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`）按上述字段携带
- [ ] MCP 结果正文（content / structuredContent）与错误正文不进入任何活动条目字段
- [ ] wire 闭集校验按新来源类别分别闭合；未知键、错误组合拒绝
- [ ] 端到端可演示：tool_search 显示查询与加载结果；MCP 工具失败时显示 `isError` 状态且无外部正文
- [ ] 活动事实语义不变：不改变生命周期、不进入实时显示草稿与父模型上下文
