# 以会话本地入口和直接父子边协调并行压缩

Status: accepted

父子监督协议硬切换到 `pi-subagent/10`，managed RPC bridge 保持 `pi-subagent/managed-rpc/3`。本扩展继续作为 `wj-pi-auto-compact/coordination/v1` 的可选参与者，但不再把一个会话的压缩事务递归传播为固定子树屏障。每个 Pi 会话独立协调自己的上下文：本地 EventBus 事务冻结当前会话的直接子 reply/final 入口和当前 child 自身的 reply/final outbox；若存在直接 parent，再由 child 沿唯一认证上游监督通道请求该直接边。parent 只能响应，不能向 child 发起压缩请求。

parent 收到 `compaction_prepare` 后先同步为目标 child 安装两类可叠加令牌：parent 到 child 的下行 mailbox 令牌，以及 child 到 parent 的上行 reply/final 令牌。随后异步等待准备线性化点前的下行工作静止。静止至少要求 mailbox `inFlight` 为空、宿主待处理计数为零、没有等待中的 prompt start，并且不存在粘性的 delivery uncertainty 或 maintenance failure。Pi RPC 的 `prompt()`/`steer()` 成功只表示命令被接纳；`queue_update.pendingMessageCount` 和 `get_state` 返回的同一计数才是 Pi 内部消息队列事实。屏障之后的新业务消息仍可被 mailbox 接纳，但必须可靠停留到全部事务令牌释放。prepare/complete、业务响应、transport ACK 和 close 属于控制面，不受业务消息闸门阻塞。

事务标识必须非空且不超过 256 字符。同一直接边允许不同事务令牌叠加，释放一个事务不能释放其他事务。根、父、子、孙和 sibling 会话即使边界范围相邻或重叠也可以并行压缩；祖先事务不固定后代成员，不拒绝压缩期间创建的新 child，也不递归冻结 descendant。`compaction_prepare` 与 `compaction_complete` 只允许 child 发往 parent，`compaction_prepared` 与 `compaction_completed` 只允许 parent 发往 child。累计 transport ACK 只证明帧送达，不能结算业务 waiter。

业务 `false` 是已经处理的 `rejected`；首次超时或异常是 `uncertain`。child 的 complete 不确定时，必须在首次 waiter 清理后使用独立、有限且未 abort 的期限向同一事务补发 `not_started`；补偿获得 `true` 或 `false` 都证明 parent 已闭合事务，补偿仍无业务响应才废止直接上游通道。监督通道故障、关闭或运行时 fault 会释放该边全部活动令牌。parent 若无法闭合目标 child 的直接边，沿既有终止与资源确认边界回收该 child，而不是继续复用不可判定状态。

协调层不拥有压缩实现或 continuation。只有本机会话 EventBus 发起的事务会把 `succeeded` 解释为等待本机会话 continuation；任一固定参与者 complete 未确认时，发起方仍对全体参与者补发同事务 `not_started`，允许已经确认成功的本地参与者撤销 continuation 等待并释放旧 interrupted final。managed child 仅在对应直接边已经 prepared 时接受扩展触发的 manual compaction。manual `compaction_start` 一旦消费授权，该授权保留到 Pi 实际 `compaction_end`；业务 complete 可以通过独立监督流先到，不能因此把稍后合法的 `compaction_end` 判为未授权。

reload 不转移协调参与者或活动事务。旧实例先以 `not_started` 释放本地入口和直接上游边并注销 EventBus 监听，新实例接管既有控制器、mailbox、reply outbox 和监督连接后重新发现并绑定。`pi-subagent/9` 及更早活动树不能由 `/10` 运行时热接管，必须结束旧树后重建。

## 备选方案

- 保留 ADR-0009 的递归固定子树屏障：物理压缩只作用于单个会话，递归冻结会把无关祖先、后代和 sibling 串行化，并扩大 ACK 丢失与关闭故障的影响范围。
- 只冻结 child 上行 reply：parent 到 child 的在途 prompt/steer 可能在 prepared ACK 后进入 Pi 队列，破坏压缩边界。
- 以 RPC 命令成功作为队列排空证明：Pi RPC 成功仅证明命令被接纳，不能证明内部 steering/prompt 队列为零。
- 让业务消息闸门阻塞压缩控制帧：prepare 与 complete 会等待由自身才能释放的消息边界，形成控制面死锁。
- complete 到达时立即撤销 manual 生命周期授权：监督流与 Pi RPC event bridge 没有全局顺序，合法 `compaction_end` 可能晚于 complete 到达。

## 影响

协议 `/10` 删除 parent-originated 递归压缩请求语义，但保留四类压缩帧及其业务 ACK 角色。`AgentTaskMailbox`、`ParentReplyInbox` 和 `ChildReplyCoordinator` 都按事务标识维护叠加令牌；`RpcSupervisor` 只管理一个具体 child 的直接边准备、Pi 队列探测、manual 生命周期授权、有限墓碑和故障释放。不同会话不共享全局压缩锁，测试必须覆盖 sibling、根与 child、祖先与孙节点的并行性，以及下行排空、提前 `not_started`、重复 complete、ACK 不确定、关闭、reload 和跨控制流结束重排。
