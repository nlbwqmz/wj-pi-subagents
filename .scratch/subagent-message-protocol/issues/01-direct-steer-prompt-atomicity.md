Status: resolved
Type: research

# 直接调用 steer/prompt 的状态与原子性

## Question

在当前 Pi API 与监督器架构下，`send_message` 是否可以不经过现有逻辑 mailbox、任务/回合身份和父端 ACK，而同步调用：子代理处于工作状态时使用 `steer`，处于空闲状态时使用 `prompt`？需要查明 Pi 对这两个调用的真实返回/抛错语义、监督器可观察的状态边界、状态切换时的竞态，以及实现一次串行选择所需的最小内部机制。结论应明确：直接调用是否足以满足本 effort 的轻量最佳努力目标；若不能，最小必要保留项是什么。

## Answer

完整证据与建议见 [`research/01-direct-steer-prompt-atomicity.md`](../research/01-direct-steer-prompt-atomicity.md)。结论分两种契约：

- **不能**实现为 `get_state`/`get_agent_status` 后再做 `working ? steer : prompt`。状态读取不是锁；旧 run 可能在调用前 settled，idle 时 Pi 的 `steer` 只入队而不启动新 run。
- 对窄化的轻量最佳努力目标，即“同步确认 Pi 接纳普通消息”，**可以简化**：每个 child 保留一个串行提交 gate，物理上统一发 Pi `prompt` 并附 `streamingBehavior: "steer"`，由 Pi 在同一 session 方法内自适应判断 active/idle；读取 raw response，只有匹配的 `success: true` 才算接纳。
- Pi RPC 文档把成功定义为 accepted/queued/handled，不是模型已读或完成。Pi `0.84.2` 的 `RpcClient.prompt()`/`steer()` convenience wrapper 还不会检查 wire `success:false`，监督器必须保留 raw response 检查。
- 若继续保证当前 `wait_agent`、`final_message`、严格 `idle`、迟到事件隔离和不重复交付，不能删除所有 mailbox/内部关联/ACK。最小等价机制是 pending/in-flight reducer、每 child 串行域、unknown 交付隔离，以及 final 的 opaque generation（可由 task/turn/commit 等字段实现）和父端接纳后 commit。普通 `send_message` 可以不向模型暴露这些字段，也可以不等待 final ACK，但 final 完成语义不能没有父端接纳屏障。
- transport 超时、EOF 或 response 丢失属于 unknown，不得盲目重发同一正文；明确 `success:false` 才可按稳定拒绝原因反馈或等待事件重试。

本 ticket 只完成研究，没有实现代码；`map.md` 未修改。
