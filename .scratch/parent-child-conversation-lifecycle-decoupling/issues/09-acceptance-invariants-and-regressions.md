# 重构规格的验收不变量与回归边界

Status: resolved
Type: grilling
Blocked by: 01, 02, 03, 04, 05, 06, 07, 08

## Question

最终规格需要哪些可验证不变量和场景，才能证明消息交互与子代理生命周期已经解耦？至少要覆盖：健康 working 子代理发送消息失败后状态不变；运行时故障才进入 failed；interrupting/terminating/terminated 的真实转换；显式 final_report 成功与失败；未调用 final_report 的自然停止；多次报告与普通消息的顺序；wait_agent 的会话事件与独立 state；压缩、热重载、父端 context 接纳和终止竞态。需要确定测试层次、旧测试哪些语义应删除或改写，以及实现会话的完成判据。

## Answer

验收规格采用四层测试体系，所有并发场景使用可控 fake Pi、延迟 Promise、人工事件注入和明确屏障，不使用真实睡眠或时间窗口碰运气：

1. **生命周期归约与事件投影单元层**：覆盖合法转换矩阵、非法转换、迟到代际、`terminated` 吸收态、消息/报告与生命周期解耦，以及 `wait_agent` 事件和独立 state 的投影。可用属性测试验证每条非法或迟到事实都保持当前快照不变。
2. **协议与工具契约层**：覆盖新 wire 和信封解析、版本拒绝、`send_message`、`reply_to_parent`、`final_report` 的同步 Pi 接纳、稳定错误、`ParentReplyInbox` 接纳点和不依赖父端 context/UI 的事件登记。
3. **运行时集成层**：用可控 Pi 事件序列覆盖自然停止、显式报告、普通回复、压缩、中断、终止和 `wait_agent`；验证事件不会因后续 state 变化而被吞掉。
4. **监督进程与资源 smoke 层**：覆盖同规格 reload、协议不匹配、监督通道故障、父子进程资源回收和终止收尾；只保留少量跨进程测试，详细状态矩阵在前两层完成。

### 强制生命周期不变量

- 对外只允许 `starting`、`idle`、`working`、`interrupting`、`terminating`、`terminated`、`failed`；`suspended`、消息状态、任务结果和 `last_task` 均不属于公开模型。
- 树控制器/根权威是生命周期唯一写入者。监督事实必须经过代际和合法转换校验；非法或迟到事实不得改变快照，并产生稳定诊断。`terminated` 没有出边，迟到事实不能复活节点。
- 健康节点上 `send_message`、`reply_to_parent`、`final_report` 的成功或失败都不改生命周期。发送失败只结算本次调用，不暗存正文、不自动重试、不自动重放。
- 只有真实 Pi/RPC/监督通道或受管资源故障进入 `failed`。provider/assistant 错误、没有报告、报告发送失败、`reply_too_large` 和压缩失败（Pi 仍健康时）不构成生命周期故障。
- `interrupting` 只能由已接纳的中断意图建立，并须等待真实 `agent_settled` 才能回到 `idle`；`terminating` 在接纳终止意图时建立不可逆屏障，资源确认后才进入 `terminated`。

### `wait_agent` 投影契约

`wait_agent` 的子代理会话结果只允许 `reply`、`final_report`、`idle`、`terminal` 和 `timeout`。结果中的 `state`、revision 和安全故障信息是独立生命周期快照，不由事件名称推断；结果不包含任务结果、`task_*`、`suspended`、`last_task` 或报告正文。

保留同一 assistant message 内重复 `wait_agent` 调用的工具层批次合并。`batch_released` 若仍作为调用外壳存在，只表示本次工具调用由同批次另一调用释放，不是子代理会话事件、生命周期状态或任务结果。`interrupting`、`terminating` 只改变 state，不单独产生会话事件；启动就绪的 `starting -> idle` 不伪造 `idle`，活动回合真实收束后的 `working -> idle` 才产生 `idle` 事件。

每次 Pi 已接纳的 `reply` 或 `final_report` 都形成不可覆盖的可观察事件；当前等待调用至多因该事件完成一次，context/UI 是否观察成功不影响事件成立，也不能造成重复注入。多次报告和普通消息不去重、不合并、不覆盖。并发来源之间不承诺公开相对顺序，测试只断言事件存在、次数、可观察性和独立 state，不断言 `reply` 与 `final_report` 的顺序；不为此引入 `message_id`、`reply_seq`、ACK、发送窗口或应用消息队列。

### P0 竞态矩阵

实现会话必须覆盖以下正向和负向场景：

- `working` 节点普通消息发送失败、`final_report` 发送失败后仍保持 `working`，Pi 健康时后续显式发送仍可用。
- 报告成功不结束回合；同一回合多次报告与普通回复均可观察；自然停止且未调用报告只产生 `idle`，不生成自动 final、`no_output` 或其他结果。
- 真实 `interrupting -> idle`、各阶段进入 `terminating`、资源确认后的 `terminated`，以及真实运行故障进入 `failed`；消息和报告的成功/失败不能伪造这些转换。
- 压缩屏障建立前已接纳的调用保留，屏障期间新调用拒绝，解除后新调用可接纳；压缩失败但 Pi 健康不进入 `failed`，也不重放正文。
- Pi 已接纳父端消息但 context 事件延迟、缺失或抛错时，发送仍成功、事件仍可等待且不会重复注入。
- 同规格 reload 保留可观察生命周期和已接纳事件，不重放应用正文；不匹配的 lease/wire 立即报告 `protocol_mismatch`，进入运行故障和清理流程。
- 消息、报告与 `interrupt_agent`/`terminate_agent` 同时发生时，已进入接纳裁决点的调用不回滚；屏障建立后新调用拒绝；最终 state 只由真实生命周期事实决定。

### 旧测试迁移与完成判据

以 `agent-task-mailbox`、`ChildReplyCoordinator` 自动 final、v5 任务/回合/提交信封、ACK/窗口、`suspended`、`last_task` 或 `task_*` 结果为前提的测试必须删除或彻底改写；不保留旧协议兼容测试。传输、树权威、资源边界、压缩、reload 和父端 context 测试中仍有效的行为保留，但改为断言新契约。新增测试按上述不变量和 P0 竞态命名并逐项覆盖。

实现会话的完成判据是：类型检查/构建通过；全部 P0 契约与竞态测试通过；公共协议、快照和 `wait_agent` 投影不再暴露禁用字段或状态；旧 mailbox、自动 final、任务结果和兼容分支已删除；clean-break 的版本拒绝、同规格 reload 和资源清理路径均有测试。该 Wayfinder effort 只交付这份规格和验收清单，不在地图内直接修改实现代码。