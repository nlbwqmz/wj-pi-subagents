# 02: 工具元数据（annotations + namespace）

**What to build:** 10 个子代理工具（8 个管理 + normal_reply/final_report）携带完整的语义元数据：每个工具显式声明全部四个 annotations 字段（readOnlyHint / destructiveHint / idempotentHint / openWorldHint，按 spec 表），并归入统一 namespace（含 aliases 与描述）。权限类扩展据此识别只读/破坏性/开放世界操作；codemode 与 tool_search 用户可按 namespace 分组发现工具。工具名保持不变。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 10 个工具均显式声明四个 annotations 字段，取值与 spec 表一致（wait_agent 不标只读；terminate_agent 标 destructive + idempotent；interrupt_agent 不标 idempotent；spawn_agent 标 openWorld）
- [x] 10 个工具携带同一 namespace（name/aliases/description/instructions 齐备），且不改变对模型暴露的工具名
- [x] 新增测试断言全部工具的 annotations 与 namespace，未来新增工具漏标会被测试捕获
- [x] 现有测试全绿
