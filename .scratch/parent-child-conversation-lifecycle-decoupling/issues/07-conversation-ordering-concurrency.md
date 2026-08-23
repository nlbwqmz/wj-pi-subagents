# 持续会话中的消息顺序与并发操作

Status: open
Type: grilling
Blocked by: 01, 02, 03, 04, 06

## Question

父代理在旧回合停止后立即发送新消息、子代理在同一时间发送 final_report 或普通回复、父端正在 interrupt/terminate 时，消息应如何排序和裁决？需要在不依赖僵化任务概念的前提下，定义同一会话的顺序保证、发送队列、旧消息/迟到消息的处理和控制操作优先级；特别要保证已产生的 final_report 不被后来的父消息越过，同时发送失败不会永久锁死健康子代理。
