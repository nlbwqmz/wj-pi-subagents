# 子代理消息协议简化路线图

## Destination

产出一份可直接交给实现者的内部消息协议改造规格：明确父端 `send_message` 如何同步调用 `steer`/`prompt`、子端 `final_message` 如何声明完成、运行状态与并发边界、错误和重试语义，以及 `task_id`/`turn_id` 等身份字段应保留到什么范围。外部模板与配置入口保持不变。

## Notes

- 领域：Pi 递归子代理运行时的父子消息与完成协议。
- 每次推进应结合 `grilling`、`domain-modeling`；需要外部 Pi API 事实时使用 `research`，需要具体行为取舍时使用 `prototype`。
- 当前偏好：优先最小状态机；Pi 方法调用成功即可视为本次同步调用成功；明确抛错才反馈错误；不为兼容旧内部协议保留复杂度；除非分析证明必要，不向模型暴露或围绕身份、ACK、顺序增加机制。
- “工作/空闲”是运行时接纳状态；`steer`/`prompt` 是投递方法；`send_message` 是同步提交操作；`final_message` 是可重复提交的结果声明。这些术语的领域含义已记录在根目录 `CONTEXT.md`。

## Decisions so far

- [直接调用 steer/prompt 的状态与原子性](issues/01-direct-steer-prompt-atomicity.md) — 普通消息不预读状态分支；每个子代理以串行 gate 统一提交 adaptive `prompt`，检查 raw `success`；完整 final/wait 语义仍需内部关联与接纳屏障。
- [send_message 的最佳努力与错误语义](issues/02-send-message-error-semantics.md) — 每个子代理用串行 gate 统一提交 adaptive `prompt`；raw `success:true` 才算接纳，所有错误均可由模型重试；消息操作失败不改变节点状态，但明确接受重复或未定义投递的可能。
- [final_message 的权威完成与回合收束](issues/03-final-message-completion.md) — `final_message` 成功只提交一条结果，不封存子代理；后续消息和重复 final 仍可继续，抛错可重试，不引入 ACK 或任务身份。

## Not yet specified

- 重试次数、退避方式、重复消息容忍边界，以及何时停止自动重试。
- 不再依赖逻辑任务身份后，哪些内部关联键仍是传输实现不可避免的细节，哪些可以彻底删除。
- `send_message`、`final_message` 和多次并发调用之间是否接受未定义顺序，以及如何把该取舍写成验收条件。

## Out of scope

- 子代理模板发现、模板内容、运行配置和用户侧创建方式的改动。
- 旧版内部 wire 协议的兼容迁移。
- 在路线未清晰前直接实现代码或重写测试。
