# 父子代理连续对话与生命周期解耦重构规格

Status: resolved
Label: wayfinder:map

## Destination

形成一份可交给后续实现会话的完整重构规格：父代理与子代理通过持续会话和显式 `final_report` 交流；子代理生命周期状态只由真实运行事实驱动；自动 final 以及消息、会话事件、生命周期之间的错误耦合被移除；`wait_agent` 能独立观察已接纳的会话事件和生命周期状态。

## Notes

本 effort 的领域是 pi agent 的父子代理运行时。决策时必须使用根目录 `CONTEXT.md` 中的术语，并持续遵循 `/grilling` 与 `/domain-modeling` 的方法。

本地图只产出决策和实现前规格，不在地图内直接改代码。用户配置、子代理模板发现和模板字段不属于本 effort。当前会话不使用子代理。

本 effort 不建模任务、任务结果或 `last_task`/`task_result`；`wait_agent` 只投影会话事件和独立生命周期快照。

已确认的方向：保留 `starting`、`idle`、`working`、`interrupting`、`terminating`、`terminated`、`failed` 作为子代理生命周期状态，移除 `suspended`；不新增消息自动重试；没有显式 `final_report` 时不自动补发 final；`final_report` 成功发送不强制结束当前 Pi 回合；本 effort 不建模任务或任务结果；不引入替代性的会话协调器，Pi 事件、显式报告和压缩屏障各自履行独立职责。

## Decisions so far

<!-- closed ticket 的索引；开放票据由 issues 查询，不在这里重复列出 -->

- [显式 final_report 的持续会话语义](issues/01-explicit-final-report-semantics.md) — `final_report` 是活动回合中的独立、可重复报告事件，不结束回合或会话；未报告自然停止直接回到 `idle`；`final_report`、普通 `reply_to_parent` 和进入 `idle` 都唤醒 `wait_agent`，且不重复携带报告正文。
- [子代理生命周期状态的唯一事实源](issues/02-lifecycle-state-authority.md) — 对外只保留七个生命周期状态，由树控制器/根权威依据监督器真实事实唯一写入；消息和报告不改状态；插件不维护 mailbox/派发队列，消息工具直接同步交给 Pi。
- [连续会话消息的最小协议与身份元数据](issues/03-message-protocol-identities.md) — 删除 `message_id`、`task_id`、`turn_id`、`commit_id` 及任务租约帧；不建模任务或任务结果；消息信封不携带 `reply_seq`，底层传输元数据不进入会话语义，控制与生命周期事件各走独立协议域。
- [父端接纳与消息发送失败语义](issues/04-synchronous-message-delivery.md) — 三类发送以接收侧 Pi 正常返回为同步接纳点；逐条返回接纳或稳定错误，不使用 transport/reply ACK、消息窗口、排序去重或应用消息重放，发送失败不改生命周期、不自动重试。
- [最终报告与 wait_agent 结果投影](issues/05-wait-result-projection.md) — `wait_agent` 只投影 Pi 已接纳的 `reply`/`final_report`/`idle`/终止事件和独立生命周期状态；移除任务、任务结果及 context/UI 后续观察依赖。
- [移除自动 final 后的 Pi 生命周期协调](issues/06-pi-lifecycle-coordination.md) — Pi 事件只归约真实运行边界，显式报告直接发送并登记事件；压缩保留为上下文一致性屏障，控制屏障独立于消息结果，删除自动 final 和替代协调器。
- [持续会话中的消息顺序与并发操作](issues/07-conversation-ordering-concurrency.md) — 取消消息级 FIFO、业务队列、`reply_seq`、ACK、发送窗口、去重和跨方向排序；三类发送都是独立同步 Pi 接纳操作，成功即交给 Pi，失败不改生命周期、不自动重试；控制/压缩屏障只拒绝其后的新调用。
- [旧内部协议与运行时迁移边界](issues/08-migration-compatibility-boundary.md) — 本次是 clean break：旧 wire、v5 信封、旧运行实例和旧 lease 不兼容；版本不匹配立即报告 `protocol_mismatch` 并清理，不迁移在途消息或上下文；只允许同一新规格内的 reload lease 交接，不支持滚动升级。
- [重构规格的验收不变量与回归边界](issues/09-acceptance-invariants-and-regressions.md) — 四层验收、七状态不变量、事件独立投影和 P0 竞态矩阵确定；旧任务/自动 final 语义测试删除或改写，clean-break 实现以全量 P0 通过为完成判据。

## Not yet specified


## Out of scope

- 用户配置格式、配置读取逻辑、子代理模板发现结果和模板字段语义。
- 本 effort 新增或重设计 `send_message`、`reply_to_parent`、`final_report` 的自动重试策略。
- 本地图内直接完成代码实现不属于本 effort；地图结束后再交给实现会话执行。
- 任务、任务结果、`last_task`/`task_result` 及其历史关联不属于本 effort；`wait_agent` 不提供这些字段。
