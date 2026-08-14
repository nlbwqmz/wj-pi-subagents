# 以通用发现和逐跳业务 ACK 协调自动压缩屏障

Status: superseded by [ADR-0010](./0010-session-local-direct-edge-compaction.md)

> 本文记录 `pi-subagent/9` 的历史递归子树方案，不再是当前运行时契约。`pi-subagent/10` 改用会话本地、唯一直接父边协调；详见 ADR-0010。

父子监督协议硬切换到 `pi-subagent/9`，managed RPC bridge 保持 `pi-subagent/managed-rpc/3`。本扩展选择作为 `wj-pi-auto-compact/coordination/v1` 的可选参与者：EventBus 只负责发现不透明参与者和关联本地 prepare/complete 请求，真正跨进程的冻结与释放沿既有认证父子监督通道逐跳传输。`compaction_prepare`、`compaction_prepared`、`compaction_complete` 和 `compaction_completed` 都是业务帧；累计 transport ACK 只能证明帧已送达，不能结算业务 waiter。

协调事务固定 prepare 时已经接纳的直接子成员，并在固定前等待 in-flight spawn 完成；屏障期间拒绝新成员。本地会话触发压缩时同时冻结直接父级和全部后代，父级下发时只继续递归后代，避免回发来源形成环。父会话为某个直接 child 建立的屏障只冻结该 child 的上行 reply，不冻结 sibling。prepare 只在本地 reply/final、父级和后代全部确认后成功；任一拒绝、超时、ACK 丢失、传输故障或 reload 都向全部已请求侧传播幂等 `not_started`，因为没有收到 ACK 的对端仍可能已经建立屏障。

协调层不接管压缩实现或 continuation 所有权。Pi 的真实 `agent_start`、`agent_settled` 和 `CompactionEntry` 仍是执行事实；通用自动压缩扩展只在压缩成功且全部 complete 业务 ACK 成功后自行触发 continuation。对 child reply coordinator 而言，只有本机 EventBus 发起且全部固定成员完成业务确认的事务才采纳原 complete outcome：`succeeded` 会冻结被压缩中断轮的旧 final，下一次真实 `agent_start` 沿用逻辑 `task_id` 并创建新 `turn_id`。任一固定成员 complete 未确认时，发起方必须向全体固定参与者补偿同事务 `not_started`；已确认 `succeeded` 的参与者允许该补偿撤销 continuation 等待并释放旧轮。父级下发的 `succeeded` 仍逐跳传播并参与业务 ACK，但只释放本机屏障，不证明本机上下文已经压缩或存在本机 continuation。managed child 仅在该协调屏障已经建立时接纳扩展触发的 `manual` 压缩，未经协调的 child manual 继续作为协议故障处理。

运行时 reload 不转移协调参与者对象或旧 Pi EventBus API。旧实例先进入 handoff pending，等待活动 prepare/complete 以 `not_started` 闭合，并撤销已经确认成功但真实 continuation 尚未开始的本地等待，再注销 EventBus 与上游监听；新实例接管原控制器、mailbox、reply outbox 和监督连接后创建新参与者并重新绑定。`pi-subagent/8` 及更早活动树不能由 `/9` 运行时热接管，必须结束旧树后重建。

## 备选方案

- 只用 EventBus 本地标记冻结：无法跨 Pi 子进程确认父级和后代已经建立屏障，也无法区分发送成功与业务接纳。
- 把树角色、任务标识或节点身份放入公共发现协议：会把子代理领域泄漏给独立自动压缩 package，并形成反向依赖。
- prepare 失败时只释放已收到成功 ACK 的成员：ACK 丢失时会让已经建立屏障的未知成员永久冻结。
- 让协调参与者决定或发送 continuation：会与压缩扩展争夺任务续跑所有权，并重新引入 ADR-0008 已拒绝的恢复猜测。

## 影响

所有压缩控制帧在每条父子通道内串行处理，complete 即使先到也必须等待异步 prepare 结束。监督通道故障、显式终止和依赖注销都会以 `not_started` 释放所有已接受事务；prepare 回调在故障后迟到成功时也必须立即回滚。child 写回 `prepared/completed` 的操作若超过业务期限或失败，响应是否送达已不可判定；参与者先释放本地屏障，再把该监督通道置为协议故障并关闭，防止迟到正向响应在仍可复用的连接上恢复事务。child 主动向直接父级发送 complete 若没有业务响应，会在原请求 waiter 清理后使用独立期限向同一事务补发 `not_started`；补偿得到业务 `true` 或 `false` 都证明父端已闭合事务，只有正向与补偿均无业务响应时才废止上游通道。父控制器同样把业务 `false` 与传输不确定分开处理；若已接受或结果不确定的 child 连补偿 `not_started` 都没有任何业务响应，就先建立不可逆终止屏障并沿现有资源边界递归回收该 child。公共协调协议保持独立：`pi-subagents-wj` 可以缺席，自动压缩扩展仍直接运行；`pi-subagents-wj` 也不触发压缩，只在被发现和定向请求时参与屏障。
