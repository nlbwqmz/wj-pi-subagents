# 移除自动 final 后的 Pi 生命周期协调

Status: resolved
Type: grilling
Blocked by: 01, 02, 03, 04

## Question

删除 `ChildReplyCoordinator` 自动 final 候选、settle 触发、父端接纳后 commit 等机制后，Pi 的 `message_end`、`agent_end`、`agent_settled`、压缩事件和工具事件各自还承担什么职责？需要决定 `final_report` 工具如何进入现有监督通道、自然停止且未报告时如何回到 idle、调用报告后仍继续运行时如何维护活动事实，以及中断和终止竞态如何不再借助消息交互结果改写生命周期。答案应给出新的职责边界，而非按文件罗列实现步骤。

## Answer

自动 final 相关职责全部移除。持续会话不再从 assistant `message_end`、`agent_end`、`agent_settled` 或任何 ACK 推导隐式报告、结算或结果；不保留旧 `ChildReplyCoordinator` 的任务、回合、提交、候选、prepared/accepted commit、settle 触发和 ACK 回调状态，也不引入替代性的会话协调器。`normal_reply` 与 `final_report` 工具直接使用当前子运行时的监督发送端口，父端 `ParentReplyInbox` 负责 Pi 接纳和事件登记，生命周期事实由唯一生命周期权威归约。

### Pi 事件职责

- `agent_start` 是真实 Pi 回合开始事实；它允许生命周期权威从 `idle` 转为 `working`，并只建立必要的短暂运行观察。它不创建任务身份或隐式结果。
- `message_end` 只属于 Pi 的 assistant 内容/停止事实和必要的运行诊断；不再复制到父端，不建立候选正文，不触发报告或生命周期转换。未通过 `final_report` 发送的 assistant 文本留在本地回合。
- `agent_end` 只标记本轮模型循环离开活动集合并清理工具活动观察；它不直接产生 `idle`，因为压缩、续跑或待处理输入可能仍存在。
- `agent_settled` 是真实静止的候选事实。只有在没有待处理 Pi 输入、上下文压缩屏障和中断/终止收尾时，才提交 `working -> idle` 并登记 `idle` 会话事件；缺失该事实不得猜测 `idle`。
- `queue_update` 与 `tool_execution_start/end` 只用于观察宿主队列和工具活动，帮助判断是否可静止；它们不直接写公开生命周期，也不产生 `wait_agent` 会话事件。`extension_error` 单独是可继续运行的诊断，不能仅凭该事件进入 `failed`。

### 显式报告与压缩

`final_report` 是显式工具消息，直接沿监督通道进入父端 Pi。只要当前 Pi 回合仍可发送且没有控制/压缩屏障，父端 Pi 接纳成功就立即登记一个 `final_report` 事件；同一回合可以多次发送，成功不改变 `working`、`idle` 或其他生命周期状态，也不结束回合。没有活动回合或已进入控制屏障时，本次调用按消息接纳错误返回。发送失败不暗存、不重试、不回调生命周期归约。

自动和手动压缩协调继续保留，但只作为**上下文一致性屏障**：负责父子双方的 prepare/complete、`not_started` 补偿，并在屏障期间暂缓会破坏上下文顺序的消息接纳/注入。`compaction_end` 解除屏障后，是否继续工作只由真实 `willRetry` 和后续 `agent_start` 决定。压缩不生成 final、不提交会话完成、不改变公开生命周期；本地压缩失败而 Pi 仍健康时不进入 `failed`，只有不可恢复的监督协议或资源一致性故障才提交独立运行故障。

### 中断与终止

`interrupt_agent` 被接纳后立即建立 `interrupting` 屏障并请求 Pi abort；只有真实 `agent_settled` 才能回到 `idle`，缺失 settled 不得伪造任何状态。`terminate_agent` 被接纳后建立不可逆的 `terminating` 屏障，停止新消息、报告和续跑；资源全部确认释放后才进入 `terminated`。在途报告的接纳结果只能完成或失败本次消息操作，不能把节点改成 `idle`、`failed` 或 `terminated`；已经被 Pi 接纳的报告仍保留为会话事件。父消息、报告与控制操作的精确同序裁决留给并发票据。

本票据确定 Pi 事件、显式报告、压缩屏障和控制屏障的职责边界；跨来源顺序、迟到/重复事件以及中断/终止与发送同时发生时的最终裁决由《持续会话中的消息顺序与并发操作》决定。