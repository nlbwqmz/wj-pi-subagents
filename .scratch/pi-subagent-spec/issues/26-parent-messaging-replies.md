# 26 - 纵向打通父子消息、steering 与普通回复

**What to build:** 让父会话向直接子代理发送一次任务或当前处理引导，并在不泄露控制细节的前提下收到该子代理按序返回的普通对话回复。

**Blocked by:** 25 - 纵向打通 `spawn_agent` 创建旅程

**Status:** ready-for-agent

- [ ] `send_message` 校验直接子代理、非空文本、图片集合、长度、Base64 和 MIME，并为每次调用分配根内唯一且不复用的 `message_id`。
- [ ] 任务始终使用 Pi RPC `prompt` 与 `streamingBehavior: "steer"`；空闲节点启动处理，工作节点原子接受 steering，不创建独立后续任务。
- [ ] 消息进入 RPC 或 steering 队列后立即返回 `accepted:true`；明确未接受和接受状态未知均返回 `message_delivery_failed` 且不得自动重发，已接受结果不被后续故障改写。
- [ ] 普通 assistant 回复只经直接父子监督通道上行，按 `reply_seq` 注入父会话并 ACK/去重；pending 计数和多轮上下文延续符合生命周期语义。（REQ-026、REQ-036；AC-013、AC-020）

