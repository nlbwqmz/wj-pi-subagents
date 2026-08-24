# 子代理生命周期状态的唯一事实源

Status: resolved
Type: grilling

## Question

如何把子代理生命周期状态限制为真实运行事实？需要锁定七个对外状态 `starting`、`idle`、`working`、`interrupting`、`terminating`、`terminated`、`failed` 的定义、合法转换和唯一写入者，明确移除 `suspended`；区分任务失败、消息发送失败、final_report 发送失败与运行时故障；并决定中断/终止过程可保留哪些内部操作标记但不得投影成错误的生命周期状态。目标是不论消息或任务结果如何，状态都只回答“子代理节点当前真实处于什么运行阶段”。

## Answer

对外生命周期状态只有七个：

- `starting`：节点资源、监督通道或 Pi 尚未完成启动握手。
- `idle`：节点健康，没有正在执行的 Pi 回合，也没有正在进行的中断或资源终止收尾。`idle` 不等于最近一次任务成功。
- `working`：Pi 已发出真实回合开始事实，当前正在执行回合。
- `interrupting`：中断请求已被 Pi/监督器接纳，节点仍在等待真实运行收束。
- `terminating`：终止意图已被接纳，正在关闭后代、Pi、监督通道或释放资源。
- `terminated`：要求的后代和资源都已确认释放；这是不可复活的终态。
- `failed`：启动或运行时出现真实故障，节点不能继续作为健康会话使用，等待终止清理。

合法转换锁定为：`starting -> idle`（启动就绪）；`starting -> failed`（启动故障，随后可进入 `terminating`）；`idle -> working`（真实回合开始）；`working -> idle`（真实回合结束且没有中断或终止收尾）；`working -> interrupting`（中断被接纳）；`interrupting -> idle`（真实收束并静止）；`idle | working | interrupting -> failed`（真实运行故障）；任一未终态 `starting | idle | working | interrupting | failed -> terminating`（终止意图被接纳）；`terminating -> terminated`（资源确认）。清理不完整时保持 `terminating` 并附带 `termination_incomplete`，允许重试；`terminated` 没有出边，迟到事实只能被忽略。中断不会直接回到 `working`，继续工作必须在真实回到 `idle` 后重新开始。

树控制器/根权威是公开生命周期状态的唯一写入者。监督器只提交带生命周期代际的运行事实，由树控制器归约和校验；报告、普通消息和 Pi 的 assistant 文本都不能改写生命周期。子树快照也不能覆盖其作用域根节点的生命周期。生命周期代际只是拒绝迟到事实的传输校验元数据，不是另一种操作状态。

本 effort 不维护插件侧 `AgentTaskMailbox`、父端派发队列或消息待处理队列。`send_message`、`normal_reply` 和 `final_report` 直接同步调用接收侧 Pi 的接口；成功只表示 Pi 接纳调用，失败返回稳定的消息发送错误。Pi 内部若有排队，不进入本领域模型，也不据此把节点从 `idle` 猜成 `working`。消息在 `idle` 节点被 Pi 接纳后，公开状态仍保持 `idle`，直到收到真实回合开始事实；正在运行的节点保持 `working`。

故障分类保持解耦：provider/assistant 回合错误、没有报告、`reply_too_large`，以及 `send_message`/`normal_reply`/`final_report` 的同步发送失败，不自动进入 `failed`。健康 Pi 的执行错误或中断真实收束后只按生命周期事实回到 `idle`，不产生任务或运行结果字段。只有 Pi/RPC/监督通道 EOF、非法协议、受管资源丢失或内部运行不变量破坏等真实运行故障，才提交 `runtime_failed` 并进入 `failed`。压缩失败但 Pi 仍健康时也不进入 `failed`。

`interrupt_agent` 只有在中断调用被接纳且节点仍有活动运行时才使状态进入 `interrupting`；调用抛错或未被接纳时保持原状态。进入 `interrupting` 后，缺失 `agent_settled` 不能自动伪造 `idle` 或 `failed`；可以由显式终止进入 `terminating`，或由独立的真实资源/传输故障进入 `failed`。终止请求立即建立 `terminating` 屏障并停止继续派发；资源不完整只记录 `termination_incomplete`，终态的 `termination_result` 独立保留历史故障或清理不完整分类，不能把 `terminating` 重新改成 `failed`。

规格不定义 `suspended`，也不保留 `delivery_uncertain`、`abort_requested`、`compaction_active`、`cleanup_pending` 或 `interrupt_outcome_unknown` 这类持久内部操作标记；同步调用的成功/失败和后续真实 Pi 事件直接决定公开事实。实现若因 Promise 或重入保护需要短暂控制流变量，它们不得成为领域状态、快照字段、生命周期转换条件或 `wait_agent` 结果。
