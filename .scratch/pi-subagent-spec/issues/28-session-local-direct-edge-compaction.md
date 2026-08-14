# 28 - 迁移会话本地直接边压缩协调

Type: task

**What to build:** 将 `pi-subagent/9` 的递归固定子树压缩屏障替换为 `pi-subagent/10` 的会话本地、直接父子边协议。child 只能向唯一直接 parent 请求 prepare/complete，parent 只能响应；每个会话独立冻结本地 reply/final 入口和自身上游边，不递归锁定 descendant。

Blocked by: 21 - 实现父子监督协议与安全子树汇聚；24 - 闭合受管 RPC 节点与直接父子控制旅程

Status: resolved

- [x] 协议硬切换到 `pi-subagent/10`，四类压缩帧限制为 child 请求、parent 响应，拒绝历史 `/9` 活动树和已移除的递归控制契约。
- [x] `AgentTaskMailbox`、`ParentReplyInbox` 和 `ChildReplyCoordinator` 使用非空、至多 256 字符的事务标识维护可叠加令牌；释放单个事务不影响同一边其他事务。
- [x] parent 为目标 child 同步安装下行 mailbox 与上行 reply/final 令牌，再等待 in-flight、host pending、prompt start 和 Pi `pendingMessageCount` 静止；交付不确定或维护失败使 prepare 明确拒绝。
- [x] 屏障后的普通消息可靠停留在 mailbox，控制帧、业务响应、transport ACK 和关闭帧绕过消息闸门。
- [x] 删除 controller 的递归后代屏障、固定成员和压缩期间 spawn 拒绝；根、child、祖先、孙节点和 sibling 会话可以独立并行压缩。
- [x] 保留 accepted/rejected/uncertain 三态、同事务 `not_started` 补偿、waiter 清理、有限墓碑、通道故障与关闭释放；补偿仍无业务响应才废止上游通道。
- [x] manual `compaction_start` 消费 prepared 授权后保留到真实 `compaction_end`，覆盖业务 complete 先到、Pi RPC end 后到的跨控制流重排。
- [x] reload 不转移活动参与者；旧实例释放事务并解绑，新实例重新发现既有监督连接。
- [x] 更新 README、领域词汇和 ADR；ADR-0009 保留为 superseded 历史，当前决策记录于 ADR-0010。

## Answer

实现以单个会话和单条直接边为并发单元。EventBus 参与者只协调本地 reply/final 入口与唯一直接上游；parent 端 `RpcSupervisor` 只管理对应 child 的 mailbox/reply 边，不再递归调用后代 controller。Pi 队列静止以 `queue_update.pendingMessageCount` 和 `get_state` 探测为事实，RPC 命令成功不作为排空证明。

回归覆盖本地入口、直接上游、不同会话并行、叠加令牌、屏障后延迟消息、准备中提前 `not_started`、重复 complete、业务 ACK 不确定、故障/关闭释放，以及 complete 先于 manual `compaction_end` 的顺序竞态。架构决策见 [ADR-0010](../../../docs/adr/0010-session-local-direct-edge-compaction.md)。
