# 显式 final_report 的持续会话语义

Status: open
Type: grilling

## Question

在取消自动 final 后，如何定义显式 `final_report` 与持续会话的关系？需要确定：它是否作为带 final 标记的父端消息；一次调用成功只代表消息已被 Pi 接收且不结束当前回合；未调用时子代理停止后是否仅回到 idle；同一回合允许多次调用时父端如何区分报告与普通 `reply_to_parent`；以及 `wait_agent` 在收到一条或多条报告时应返回什么结果。规格必须让“最终报告”成为显式交流行为，而不是另一套隐式生命周期状态机。
