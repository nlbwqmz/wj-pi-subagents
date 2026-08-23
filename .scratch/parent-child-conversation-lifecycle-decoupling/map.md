# 父子代理连续对话与生命周期解耦重构规格

Status: open
Label: wayfinder:map

## Destination

形成一份可交给后续实现会话的完整重构规格：父代理与子代理通过持续会话和显式 `final_report` 交流；子代理生命周期状态只由真实运行事实驱动；自动 final 以及消息、任务结果、生命周期之间的错误耦合被移除；`wait_agent` 仍能获得独立的任务结果语义。

## Notes

本 effort 的领域是 pi agent 的父子代理运行时。决策时必须使用根目录 `CONTEXT.md` 中的术语，并持续遵循 `/grilling` 与 `/domain-modeling` 的方法。

本地图只产出决策和实现前规格，不在地图内直接改代码。用户配置、子代理模板发现和模板字段不属于本 effort。当前会话不使用子代理。

已确认的方向：保留 `starting`、`idle`、`working`、`interrupting`、`terminating`、`terminated`、`failed` 作为子代理生命周期状态，移除 `suspended`；不新增消息自动重试；没有显式 `final_report` 时不自动补发 final；`final_report` 成功发送不强制结束当前 Pi 回合；任务结果与生命周期状态分开。

## Decisions so far

<!-- closed ticket 的索引；开放票据由 issues 查询，不在这里重复列出 -->

## Not yet specified

- 显式最终报告与普通父子消息的精确协议语义，以及多次报告、未报告和等待结果之间的关系。
- 去除僵化任务叙事后，消息顺序、身份元数据、重复/迟到消息和父端接纳的最小机制。
- 自动 final 删除后 Pi 生命周期事件、邮箱、压缩、中断和终止协调各自保留的职责。
- 旧内部协议、热重载和正在运行实例是否需要兼容，以及安全迁移边界。
- 最终规格的验收不变量、并发竞态场景和回归测试范围。

## Out of scope

- 用户配置格式、配置读取逻辑、子代理模板发现结果和模板字段语义。
- 本 effort 新增或重设计 `send_message`、`reply_to_parent`、`final_report` 的自动重试策略。
- 在本地图内直接完成代码实现；地图结束后再交给实现会话执行。
