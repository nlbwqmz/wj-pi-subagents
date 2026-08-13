# 以 generation 恢复事实和原子自适应提交处理压缩续跑

Status: superseded by ADR-0008

> [ADR-0008](./0008-native-compaction-lifecycle-and-root-manual-boundary.md) 移除了本文的 generation 恢复事实、`compaction_resume` 和 `adaptive_steer`。本文仅保留为历史决策。

父子监督协议硬切换到 `pi-subagent/7`，managed RPC bridge 硬切换到 `pi-subagent/managed-rpc/2`。child runtime 为每次成功压缩提交单调 generation，并在跨两个事件循环阶段观察其他扩展输入后，通过有 ACK 的 `compaction_resume` 发布 `continuation_pending` 或 `host_idle`；父端只消费当前 generation，前者还必须与实际 `agent_start` 同时成立，后者才授权 mailbox 恢复。缺失、迟到或矛盾事实保持 `suspended`，不再使用固定毫秒窗口猜测 continuation。

mailbox 对恢复消息使用 bridge 内的原子自适应提交：Pi 已 streaming 时加入当前 run，Pi idle 时启动 prompt。对应任务租约使用 `adaptive_steer` 表达提交意图，不预先伪造实际 prompt/steer 结果；不采用先读状态再 steer、`followUp` 或 fire-and-forget extension 输入。`pi-subagent/6`、managed bridge `/1` 和更早活动树不提供兼容层，必须结束后重建。
