# 06: 模板通配语法文档对齐与测试补齐

**What to build:** 模板工具声明中 `*` 通配的文档与版本基线对齐：去掉 README/README.zh-CN 中"`*` 需要 pi 1.1.0 或更高版本"的条件说明（最低版本已是 1.2.0），补充 `mcp__radius__*` / `mcp__*` 示例，并说明扩展不暴露 `--no-mcp`（排除全部 MCP 应使用 `excludeTools: ["mcp__*"]`）。`+name`/`-name` 修饰符的加载期拒绝行为保持不变（ADR 0002 的有意设计）。补齐两条缺失的测试。

**Blocked by:** 01（版本语义前提：文档不再需要标注 1.1.0 条件）

**Status:** resolved

- [x] README 与 README.zh-CN 去掉 `*` 的"需 pi 1.1.0"条件说明，补 `mcp__radius__*` / `mcp__*` 示例
- [x] 文档补充"扩展不暴露 `--no-mcp`；排除全部 MCP 使用 `excludeTools: ["mcp__*"]`"
- [x] `+name`/`-name` 的拒绝行为与现有文档说明保持不变（不改校验、不动 ADR 0002）
- [x] 补测试：tools 含通配符时 `--tools` 参数直连断言；`mcp__radius__*` 形态的接受用例
- [x] 现有测试全绿
