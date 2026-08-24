# 最终报告与 wait_agent 结果投影

Status: resolved
Type: grilling
Blocked by: 01, 02, 04

## Question

在任务结果与子代理生命周期分离后，如何把显式 `final_report`、普通回复、任务失败/中断和“没有调用 final_report”投影到 `wait_agent`、last_task、通知和父端可见结果？需要保持 `wait_agent` 能报告任务结果，同时独立返回子代理生命周期状态；明确 final_report 是否结束一次结果记录、同一回合多次报告如何处理、没有报告时何时可返回 idle，以及 final_report 发送失败时如何保留已生成内容而不伪造任务失败。

## Answer

本 effort 不再建模“任务”或“任务结果”。持续会话中的父消息、普通 `reply_to_parent`、显式 `final_report` 和 Pi 回合收束都不启动、结束或更新任务，也不维护 `task_result`、`last_task` 或任何任务/回合/提交身份。

`wait_agent` 的公开投影只包含两类相互独立的事实：

- 会话事件：至少区分 `reply`、`final_report`、`idle` 和终止/故障的 `terminal` 事件；事件说明这次等待为何被唤醒。
- 生命周期快照：独立返回七个生命周期状态之一及其安全修订/故障字段；事件名称不能覆盖或推断 `state`。

当没有新的会话事件但快照已经是稳定的 `idle`、`failed` 或 `terminated` 时，`wait_agent` 立即复用对应的 `idle`/`terminal` 投影返回当前状态，不额外登记会话事件。

成功的 Pi 接纳在返回成功的同一接纳点登记对应的 `reply` 或 `final_report` 事件并唤醒 `wait_agent`。这不是等待父端 context、UI 通知确认、模型读取或后续处理；那些后续事实不再参与发送成功或事件成立。报告正文仍只通过父端 Pi 已接纳的 custom message 可见，`wait_agent` 不重复携带正文。

同一回合内每次成功的 `final_report` 都是独立事件，不结束回合或会话，不覆盖任何结果，也不因正文相同而去重。报告发送失败只返回 `message_delivery_failed`，不登记事件、不暗存正文、不自动补发；普通回复遵循同一接纳与事件规则。

活动回合在没有待处理工作时自然停止，且没有显式报告时，只产生一次 `idle` 事件并回到 `idle`；启动就绪的 `starting -> idle` 不伪造 `idle` 任务完成。未报告的 assistant 文本不进入父端事件流，不生成自动 final、`no_output` 或其他结果标记。

provider/assistant 错误或中断请求真实收束、而 Pi 仍健康时，不创建失败/中断的任务或运行结果；收束后的可观察事实仍是 `idle` 事件与 `state: idle`。只有独立监督事实证明运行时故障时，才产生 `terminal` 事件并进入 `state: failed`。发送成功或失败都不能改写这些生命周期事实。

本票据锁定 `wait_agent` 的事件/状态边界；事件的跨来源顺序、重复/迟到处理和控制竞态由《持续会话中的消息顺序与并发操作》决定，Pi 生命周期事件职责由《移除自动 final 后的 Pi 生命周期协调》决定。
