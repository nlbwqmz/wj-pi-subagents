Status: open
Type: grilling
Blocked by: 02, 03, 04

# send_message 与 final_message 的并发边界

## Question

明确以下场景的协议取舍：两个父端 `send_message` 同时调用；父端发送消息与子端 `final_message` 同时发生；`final_message` 后仍有普通输出；子代理正在切换工作/空闲状态。是否有意接受调用顺序未定义、消息丢失或重复的最佳努力语义，哪些情况必须返回明确错误。把选择转化为可测试的验收条件，而不是依赖 `task_id` 或隐式时序。
