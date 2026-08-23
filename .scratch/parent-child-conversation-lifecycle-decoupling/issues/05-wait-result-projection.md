# 最终报告与 wait_agent 结果投影

Status: open
Type: grilling
Blocked by: 01, 02, 04

## Question

在任务结果与子代理生命周期分离后，如何把显式 `final_report`、普通回复、任务失败/中断和“没有调用 final_report”投影到 `wait_agent`、last_task、通知和父端可见结果？需要保持 `wait_agent` 能报告任务结果，同时独立返回子代理生命周期状态；明确 final_report 是否结束一次结果记录、同一回合多次报告如何处理、没有报告时何时可返回 idle，以及 final_report 发送失败时如何保留已生成内容而不伪造任务失败。
