# 05: aborted 消费

**What to build:** RPC 模式下 `agent_settled.aborted` 在事件归一化层被保留；子代理状态记录"最近一次 settle 是否被中断"作为独立事实字段（不改生命周期闭集）；`wait_agent` 与 `get_agent_status` 的结果暴露 aborted，使脚本能区分"被取消"与"正常完成"。`wait_agent` 取消时的既有 `Operation aborted` 文本保留。UI 不加 aborted 标注。

**Blocked by:** 04（同一测试文件，串行避免冲突）

**Status:** resolved

- [x] 事件归一化保留 agent_settled.aborted；未知字段继续被剥离；该事件补齐专门单测
- [x] 子代理状态模型记录"最近 settle 是否 aborted"，不修改生命周期取值闭集
- [x] wait_agent 与 get_agent_status 结果暴露 aborted；wait_agent 取消时文本仍为 `Operation aborted`
- [x] 测试覆盖：事件归一化单测 + 工具结果断言；现有测试全绿
