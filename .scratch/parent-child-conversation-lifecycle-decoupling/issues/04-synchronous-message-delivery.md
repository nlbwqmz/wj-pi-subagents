# 父端接纳与消息发送失败语义

Status: resolved
Type: grilling
Blocked by: 01, 02, 03

## Question

是否为 `send_message`、`normal_reply` 和 `final_report` 建立统一的同步发送契约：调用接收侧 Pi 的发送接口并正常返回即视为发送成功，接口抛错则同步返回稳定异常；本 effort 不做自动重试，不等待模型处理完成、父端 context 事件或最终渲染，也不因发送失败修改子代理生命周期。需要进一步决定 ParentReplyInbox、监督通道 ACK、通知登记和异常收敛如何适配该契约，避免“Pi 未接纳消息”和“子代理运行失败”再次混为一谈。

## Answer

三类发送操作统一采用同步的 **Pi 接纳契约**：调用方只有在接收侧 Pi 的消息接口正常返回后才得到 `accepted: true`。父代理的 `send_message` 以目标子代理 Pi 的 `prompt`/`steer` 调用正常返回为接纳点；子代理的 `normal_reply` 与 `final_report` 以父端 `ParentReplyInbox` 调用父 Pi `sendMessage` 正常返回为接纳点。这个返回只说明接收侧 Pi 接受了消息，不表示模型已经读取、开始处理或完成最终渲染。

监督通道不为消息发送建立 ACK、累计确认或发送窗口。`send_message`、`normal_reply` 和 `final_report` 都通过接收侧 Pi 接口的同步返回得到逐条接纳结果；成功说明 Pi 已接受该次调用，拒绝、调用异常或响应未知统一返回稳定的 `message_delivery_failed`。任何监督层传输细节都不携带或改写子代理生命周期，也不产生任务或任务结果。

`ParentReplyInbox` 只负责信封解析、身份校验和同步调用父 Pi。成功后在同一接纳点登记独立的 `reply`/`final_report` 事件供 `wait_agent` 观察；父端 context 或 UI 通知不再参与事件成立或清理协议。它不维护任务派发队列、插件 mailbox、应用消息顺序或重复裁决，不依据已删除的任务/回合标识结算 final，不设置 trigger 屏障，也不等待父 context 事件作为发送成功前提。

错误边界固定为：参数非法返回 `invalid_argument`，正文超过限制返回 `reply_too_large`，发送前目标已不可用返回 `agent_unavailable`；Pi 接口抛错、明确拒绝或响应未知统一返回 `message_delivery_failed`。这些错误只描述本次消息操作；健康子代理保持原生命周期状态，不产生失败/中断结果。只有独立的真实运行故障事实才允许生命周期权威写入 `failed`。

发送失败不暗存正文、不自动补发、不自动生成 final，也不结束当前 Pi 回合或会话。`final_report` 或普通回复已经生成但接纳失败时，内容只留在当前回合的调用上下文，由模型显式决定是否重新组织后再次发送；压缩或重连不自动重放应用消息。

本票据锁定发送接纳和错误分层；同一会话中多方并发发送、控制操作与迟到/重复事件的最终顺序裁决由《持续会话中的消息顺序与并发操作》决定。

## Amendment

后续并发决策覆盖本答案中关于监督层 ACK 的部分；更后续的并发决策又取消了消息事件的顺序语义：`send_message`、`normal_reply` 和 `final_report` 都以接收侧 Pi 接口的同步正常返回作为唯一接纳结果，监督层不再使用 transport ACK、reply ACK、累计确认、消息发送窗口或应用消息重放。`ParentReplyInbox` 不按 `reply_seq` 建立消息 FIFO 或重复裁决；每次上行消息都返回逐条接纳响应，接口拒绝、调用异常或响应未知统一返回 `message_delivery_failed`，不暗存正文、不自动重试，也不改变生命周期。相同正文的再次调用是新事件。