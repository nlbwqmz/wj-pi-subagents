# 子代理生命周期状态的唯一事实源

Status: open
Type: grilling

## Question

如何把子代理生命周期状态限制为真实运行事实？需要锁定七个对外状态 `starting`、`idle`、`working`、`interrupting`、`terminating`、`terminated`、`failed` 的定义、合法转换和唯一写入者，明确移除 `suspended`；区分任务失败、消息发送失败、final_report 发送失败与运行时故障；并决定中断/终止过程可保留哪些内部操作标记但不得投影成错误的生命周期状态。目标是不论消息或任务结果如何，状态都只回答“子代理节点当前真实处于什么运行阶段”。
