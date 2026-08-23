# 重构规格的验收不变量与回归边界

Status: open
Type: grilling
Blocked by: 01, 02, 03, 04, 05, 06, 07, 08

## Question

最终规格需要哪些可验证不变量和场景，才能证明消息交互与子代理生命周期已经解耦？至少要覆盖：健康 working 子代理发送消息失败后状态不变；运行时故障才进入 failed；interrupting/terminating/terminated 的真实转换；显式 final_report 成功与失败；未调用 final_report 的自然停止；多次报告与普通消息的顺序；wait_agent 任务结果和独立 state；压缩、热重载、父端 context 接纳和终止竞态。需要确定测试层次、旧测试哪些语义应删除或改写，以及实现会话的完成判据。
