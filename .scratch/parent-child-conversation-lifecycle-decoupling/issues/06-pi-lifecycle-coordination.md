# 移除自动 final 后的 Pi 生命周期协调

Status: open
Type: grilling
Blocked by: 01, 02, 03, 04

## Question

删除 `ChildReplyCoordinator` 自动 final 候选、settle 触发、父端接纳后 commit 等机制后，Pi 的 `message_end`、`agent_end`、`agent_settled`、压缩事件和工具事件各自还承担什么职责？需要决定 `final_report` 工具如何进入现有监督通道、自然停止且未报告时如何回到 idle、调用报告后仍继续运行时如何维护活动事实，以及中断和终止竞态如何不再借助消息交互结果改写生命周期。答案应给出新的职责边界，而非按文件罗列实现步骤。
