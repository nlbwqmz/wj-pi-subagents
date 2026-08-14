# 以任务 mailbox 和延迟 final 提交统一生命周期

Status: accepted

> 当前监督协议已经由 [ADR-0010](./0010-session-local-direct-edge-compaction.md) 破坏性升级为 `pi-subagent/10`，managed bridge 仍为 `/3`；历史递归 `/9` 方案由 [ADR-0009](./0009-generic-recursive-compaction-barrier.md) 记录，reply envelope 仍为第 4 版。下文的 v5/v3 版本号保留为本 ADR 作出时的历史记录。

Pi 任务 RPC、父子监督流和压缩生命周期会以不同顺序报告 prompt、`agent_start`、raw `agent_settled`、自动重试、压缩与 reply。监督协议因此破坏性升级为 `pi-subagent/5`，reply envelope 升级为第 3 版：每个节点使用单写者任务 mailbox 线性化消息接纳、中断、宿主交付、生命周期、reply 和 ACK；稳定 `task_id` 与单次 Pi loop 的 `turn_id` 分离，父端先发布并确认 `task_assignment`，child 每次实际 loop 先发布有序 `task_started`，之后才允许该 turn 的 reply。

raw settlement 只形成 provisional candidate，不能直接进入 `idle`。final 使用稳定 `commit_id` 执行 `prepared -> accepted` 单调提交，只有匹配的任务/轮次已经 settlement 且父会话接纳正文后才 ACK 和记录 `last_task`；自动重试或新轮可以在提交前撤销旧 candidate，旧 turn final 被隔离。无法证明 Pi 交付或维护结果时公开为 `suspended`，不猜测完成、不自动重发。当前自动压缩候选规则与根会话人工压缩边界由 ADR-0008 覆盖。

## 影响

`idle` 严格表示没有当前任务、压缩、未决命令、候选 final 或未确认 reply。安全快照原子拆分 `mailbox_pending_count`、`host_pending_count` 和 `reply_outbox_pending_count`，并用正交 `activity.phase` 表达处理、压缩、对账、finalizing 与挂起原因。`send_message.accepted` 只证明插件 mailbox 接纳；`wait_agent` 返回任务级 `task_completed`、`task_failed`、`task_interrupted`、`suspended` 等 outcome。v4 活动树和第 2 版 reply 不能通过 reload 热接管，必须结束旧树后重建。
