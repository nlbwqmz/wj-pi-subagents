# 直接调用 `steer`/`prompt` 的状态与原子性

## 研究范围与版本

本报告只做研究，不实现协议改造。证据来自：

- 当前仓库 `b027527` 的监督器、桥接、mailbox、final 交付代码和测试。
- 当前安装的 `@earendil-works/pi-coding-agent@0.84.2` 以及其依赖 `@earendil-works/pi-agent-core@0.84.2`。
- Pi 官方仓库 `earendil-works/pi` 的 `v0.84.2` 源码和 RPC 文档。当前项目元数据要求 Pi `>=0.84.1`（`package.json`），相关 `prompt`/`steer` 实现形状在 `v0.84.1` 也相同。

官方包的仓库目录是 `packages/coding-agent`，源码链接中的版本标签固定为 `v0.84.2`，避免把结论误套到未来版本。没有使用真实供应商请求做实验；以下结论是 API、源码和本仓库测试契约的结论。

## 结论先行

1. **不能采用“先读状态，再分支调用”的直接实现。** `get_state()` 或树上的 `working`/`idle` 都是快照，不是对后续 `prompt`/`steer` 的锁定。`working -> idle`、`idle -> working`、压缩和 final 交付都可能发生在读状态与调用之间。
2. **Pi 的单次 `prompt` 调用可以在一次会话方法内做自适应选择。** 对普通消息，推荐物理提交统一使用 `prompt(message, { streamingBehavior: "steer" })`。Pi 在该方法内部看到活动 run 时入 steering queue，看到空闲时走新 prompt 路径；因此不需要外层预读 `isStreaming`。当前桥接已经把逻辑 `steer` 映射为这个 adaptive prompt（`src/rpc-bridge-process.ts:701-722`）。
3. **Pi 的成功只表示命令已被接纳，不表示模型已读取、处理完成或 final 已交付。** RPC 文档明确说 `success:true` 表示 accepted、queued 或 handled；接纳后的失败通过事件/消息流报告，不会再发同一 request 的第二个 response。
4. **Pi 的 convenience `RpcClient.prompt()`/`steer()` 在 `0.84.2` 不会检查 wire response 的 `success:false`。** 它们只 `await this.send(...)`；`send()` 返回 response 但不抛出。只有调用 `getData()` 的方法会检查 `success` 并抛错。因此必须读取原始 response，或者在本地 `AgentSession` 层直接捕获异常。当前桥接保留 raw `send()` 正是必要的，不是重复封装。
5. **若 effort 只定义“普通 `send_message` 已同步提交给 Pi”这个窄契约，可以删掉大部分逻辑任务状态。** 最小保留项是每个子代理一个串行提交闸门/actor、一个 raw response 分类器，以及传输异常后的 `unknown` 处理策略；不得再用状态快照选路。
6. **若仍要保留当前 effort 的完整语义，不能删除等价机制。** `wait_agent` 的完成、`final_message` 的唯一性、迟到 settled/final 隔离、父端接纳和无重复重试至少需要一个内部 pending/in-flight reducer、代际/任务或等价序列，以及 final 的父端接纳/commit 屏障。`task_id`/`turn_id` 可以不暴露给模型，但不能在这些保证仍然存在时全部消失。

因此，对本 ticket 的明确判定是：

| 候选方案 | 判定 |
| --- | --- |
| `getState()` 后 `working ? steer() : prompt()` | **否**，有状态竞态，并且 idle 时调用 `steer` 本身不会启动 run |
| 每个子代理串行，统一调用 adaptive `prompt + streamingBehavior:"steer"`，只承诺 Pi 接纳 | **是**，足以满足窄化后的轻量最佳努力提交 |
| 删除 mailbox、所有内部关联、unknown 隔离和 final ACK，同时保留当前 `wait_agent`/完成语义 | **否**，会把顺序、重复 final 和未确定交付变成未定义行为 |

## Pi 第一方语义

### `prompt` 的响应边界

Pi RPC 文档的 `prompt` 小节（[`docs/rpc.md#L43-L76`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#L43-L76)）给出以下契约：

- response 在 prompt 被 accepted、queued 或 handled 后发出；事件继续异步流出。
- 空间中的活动 run 要求提供 `streamingBehavior`；`"steer"` 在当前 assistant turn 的工具调用结束后、下一次 LLM 调用前投递。
- 没有 `streamingBehavior` 时，活动 run 会拒绝 prompt。
- `success:true` 只表示 accepted/queued/handled；`success:false` 表示在接纳前拒绝。
- 接纳后的处理失败通过正常事件和消息流报告，不会为同一个 request id 再发一个失败 response。

RPC 实现 [`rpc-mode.ts#L394-L416`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L416) 不是简单地 `await` 后返回：它启动 `session.prompt(...)`，由 `preflightResult(true)` 输出成功 response；只有在 preflight 尚未成功时，catch 才输出失败 response。核心实现 [`agent-session.ts#L1116-L1271`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts#L1116-L1271) 的顺序是：

1. 处理扩展命令、压缩检查、输入扩展和模板展开。
2. 若此时 `isStreaming` 为真，要求 `streamingBehavior`，然后调用 `_queueSteer` 或 `_queueFollowUp`。
3. 若此时不在 streaming，完成模型、认证、压缩和消息构造等 preflight。
4. 调用 `preflightResult(true)`。
5. 才调用 `_runAgentPrompt(messages)`，由它设置运行活动并开始实际 agent loop。

所以 `prompt` 的 response 是**提交前置检查通过**的同步边界，不是 agent 开始或完成的边界。尤其是普通 prompt 的 response 可能先于 `agent_start`；接纳后 `_runAgentPrompt` 或供应商调用失败，不会撤销已经发出的成功 response。

明确的 preflight 错误包括：压缩进行中、活动 run 未给 `streamingBehavior`、没有模型、认证失败，以及扩展/输入处理抛错。对本仓库来说，这些是“明确拒绝”或“明确抛错”，不能把它们当成已投递。

### `steer` 的真实行为

RPC 文档的 `steer` 小节（[`docs/rpc.md#L80-L100`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#L80-L100)）把它描述为运行中排队的 steering message，交付点同样是当前 assistant turn 的工具调用结束后、下一次 LLM 调用前。

核心实现的细节更重要：

- [`agent-session.ts#L1343-L1353`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts#L1343-L1353) 的 `AgentSession.steer()` 只做扩展命令检查、模板展开，然后调用 `_queueSteer()`。
- [`agent-session.ts#L1379-L1390`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts#L1379-L1390) 的 `_queueSteer()` 先把文本放入 session 的 steering 列表，再调用 agent core 的 `steer()`。
- [`agent.ts#L283-L309`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/agent.ts#L283-L309) 的 core `Agent.steer()` 只是把消息放进 queue，没有检查 `activeRun`，也不会因为入队而启动新 run。
- core 只有在当前 loop 的 queue drain 点，或新 run 开始时，才会消费 steering queue；[`agent.ts#L350-L380`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/agent.ts#L350-L380) 还明确把活动 run 时的普通 `prompt` 与 queued steering 分开处理。

因此，**空闲时直接调用 `steer` 可能返回成功但不启动任何 agent run**。该消息会留在 pending queue，之后某个 prompt/continuation 才可能消费它。一个把旧快照误判为 working 的调用，会得到这种“已接纳但没有本轮唤醒”的结果。

RPC handler 对 `steer` 是 `await session.steer(...); return success(...)`（[`rpc-mode.ts#L418-L423`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L418-L423)）。这表示成功 response 的边界是 queue 写入成功，不是 steering 已执行。

### `RpcClient` convenience wrapper 的抛错陷阱

官方 typed client 的实现需要单独看，不能只看文档：

- [`rpc-client.ts#L198-L205`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-client.ts#L198-L205) 的 `prompt()` 和 `steer()` 都只是 `await this.send(...)`，没有调用 `getData()`。
- [`rpc-client.ts#L540-L592`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-client.ts#L540-L592) 的 `send()` 会等待并返回 `RpcResponse`，但 response 为 `success:false` 时不会自行抛错；[`getData()`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-client.ts#L592-L599) 才会检查并抛出错误。
- 进程退出、stdin 不可写、超时等传输层问题仍会让 `send()` reject。

因此要区分三层：

| 层 | 拒绝/成功表现 |
| --- | --- |
| `AgentSession.prompt/steer` | preflight 或队列操作抛异常/reject |
| Pi RPC wire | 发 `response`，`success:false` 或 `success:true` |
| 官方 `RpcClient.prompt/steer` wrapper | 对 wire `success:false` 仍可能 resolve；传输异常才 reject |

本仓库的 [`src/rpc-bridge-process.ts:44-159`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/rpc-bridge-process.ts#L44-L159) 直接使用原始 `send()`，并检查 response 的 `type`、`command` 和 `success`；测试 [`test/rpc-bridge-process.test.ts:528-579`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/test/rpc-bridge-process.test.ts#L528-L579) 覆盖 `success:false` 不得误报成功。这是当前实现必须保留的语义边界。

### Pi 状态、队列和 settled 不是锁

RPC 文档的 `get_state` 示例（[`docs/rpc.md#L169-L188`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#L169-L188)）同时暴露 `isStreaming`、`isCompacting` 和 `pendingMessageCount`。它们是一次读取的字段，不是预约或条件提交接口。

核心 session 定义为：

- `isStreaming` 是当前 agent run 或 post-run continuation 是否活动；[`agent-session.ts#L878-L883`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts#L878-L883)。
- `isIdle` 只是 `!_isAgentRunActive`；它不等于压缩未进行，也不保证 pending steering/follow-up 为零。
- `isCompacting` 是独立状态；空闲快照可能同时处于压缩，prompt 仍会被拒绝。
- `pendingMessageCount` 只表示 Pi 的 steering/follow-up 队列数量，不表示消息已被模型读取。

`agent_settled` 比 `agent_end` 强：官方文档把它定义为 session-level run 已完全 settled，不再有自动 retry、compaction retry 或 queued continuation（[`docs/rpc.md#L836-L887`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#L836-L887)）。但它仍是异步事件，没有任务/回合 id；它不是父端 final 已接纳的证明，也不是把下一条调用锁在同一原子事务中的 API。

Pi RPC 输入也没有替调用方建立这样的锁。`runRpcMode` 对 JSONL 每行调用 `void handleInputLine(line)`（[`rpc-mode.ts#L748-L807`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L748-L807)），不会等待前一个异步 command handler 完成。多个 prompt 的 preflight 还可能在 `_isAgentRunActive` 置真之前交错。因此，即使使用 adaptive `prompt`，**跨多个并发调用仍需上层 per-node 串行域**。

## 当前仓库的实际状态边界

### `send_message` 的当前接纳点

`AgentController.sendMessage()` 先做参数和直接子代理授权/终态检查，然后调用 `entry.supervisor.submit()`；见 [`src/agent-controller.ts:354-379`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-controller.ts#L354-L379)。

监督器的 `enqueueMessage()` 先调用 mailbox `submit()`，提交成功后立即返回 `message_id`、`task_id` 和 `accepted:true`，明确注释“接纳点是插件 mailbox，而不是 Pi 命令响应”（[`src/rpc-supervisor.ts:1782-1812`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/rpc-supervisor.ts#L1782-L1812)）。当前工具描述也把这一点暴露给模型：`accepted:true` 只表示 mailbox 接纳，不表示模型已读或任务完成（[`src/agent-tools.ts:170-172`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-tools.ts#L170-L172)）。

这与“直接等待 Pi response 后才返回”的候选新契约不同。改成后者会改变 `send_message` 的含义，不能只删除字段而不更新错误、重试和模型指导。

### mailbox 如何避免状态预读竞态

`AgentTaskMailbox` 的设计把选择动作放在同一 reducer 顺序域内：

- `submit()` 只把消息写入逻辑 mailbox，并在 idle 时先进入 `working/reconciling`（[`src/agent-task-mailbox.ts:124-134`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-task-mailbox.ts#L124-L134)）。
- `takeNextDelivery()` 在 reducer 内选择逻辑 `prompt`/`steer`，外层不应预读瞬时状态（[`src/agent-task-mailbox.ts:137-166`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-task-mailbox.ts#L137-L166)）。
- 物理提交模式另有 `strict_prompt` 与 `adaptive_steer`；同一已启动任务走 adaptive 路径，不靠外层猜测 Pi active 状态。
- `src/rpc-supervisor.ts:1820-1922` 只在 command queue 的单一活动命令中向宿主提交，并在 raw response 后再调用 `hostAccepted()`。

桥接层把逻辑 steer 物理化为 `prompt + streamingBehavior:"steer"`，让 Pi 自己在同一个 `AgentSession.prompt()` 调用内判断 active/idle（[`src/rpc-bridge-process.ts:701-722`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/rpc-bridge-process.ts#L701-L722)）。它不使用 `getState()` 作为先决条件；`success:false` 被映射为压缩中、host busy 或未分类拒绝。

### 对外 `working`/`idle` 的含义

当前外部生命周期不是 Pi 的 `isStreaming` 原样透传：

- [`src/agent-snapshot-codec.ts:1-34`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-snapshot-codec.ts#L1-L34) 把 `idle` 定义为严格静止态，并把 `working`、`interrupting`、`suspended` 与 activity phase 分开。
- 快照校验 [`src/agent-snapshot-codec.ts:197-247`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-snapshot-codec.ts#L197-L247) 要求 idle 时 mailbox、host queue、reply outbox 都为零；工作/中断/挂起时必须有 activity，suspended 只能表示维护失败或 delivery uncertainty。
- mailbox 的 `deliveryAllowed()` 会同时检查中断屏障、压缩、协调屏障、prompt start 等待、host pending、unknown delivery、finalizing/waiting-parent-ack 等条件（[`src/agent-task-mailbox.ts:964-986`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-task-mailbox.ts#L964-L986)）。所以 `state === working` 并不等于“现在可立即发送”，`state === idle` 也只是最近一次已确认投影。
- `TreeController.getStatus()` 是只读快照，不等待 RPC、不触发同步（[`src/tree-controller.ts:1047-1053`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/tree-controller.ts#L1047-L1053)）。`applyTaskProjection()` 才把状态、三类队列、activity 和 last task 在同一 revision 中提交（[`src/tree-controller.ts:983-1031`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/tree-controller.ts#L983-L1031)）。

因此，外部 `get_agent_status` 是一致的**已确认投影**，但不是可拿来和下一次 Pi 调用组成 compare-and-swap 的锁。

### settled、final 和 idle 的额外屏障

监督器收到 `agent_start`、`agent_end`、`agent_settled`、`queue_update` 等事件后，分别更新 mailbox，再提交投影（[`src/rpc-supervisor.ts:1422-1520`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/rpc-supervisor.ts#L1422-L1520)）。关键点：

- `agent_end` 只是低层轮次边界；`agent_settled` 先被视为 provisional candidate。
- `observeAgentSettled()` 在还有 mailbox、host pending、prompt start 未确认、压缩/continuation 或 unknown delivery 时保持 `working/reconciling`，不能直接进入 idle（[`src/agent-task-mailbox.ts:432-529`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-task-mailbox.ts#L432-L529)）。
- raw settled 只有在 final prepare、父端注入接纳和本地 `commitPreparedFinal()` 都完成后才会使节点进入 idle；commit 还会清理当前 task、queue 和 uncertainty（[`src/agent-task-mailbox.ts:697-805`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-task-mailbox.ts#L697-L805)）。
- child 侧 final 协调器明确等待 settled 后才建立 final outbox；父端接纳 final 后才完成本地 commit（[`src/child-reply-coordinator.ts:65-72`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/child-reply-coordinator.ts#L65-L72)、[`src/child-reply-coordinator.ts:377-405`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/child-reply-coordinator.ts#L377-L405)）。
- `ParentReplyInbox.accept()` 用父 Pi 的 `sendMessage(..., { triggerTurn:true, deliverAs:"steer" })` 接纳消息或 final，并以 `${agent_id}:${turn_id}` 去重；接纳失败返回 false（[`src/parent-reply-inbox.ts:202-249`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/parent-reply-inbox.ts#L202-L249)）。

这些屏障不是普通 `send_message` 的同步接纳所必需，但它们是当前“完成后才 idle、final 不重复、不被旧 turn 覆盖”的语义组成部分。

## 状态选择的竞态矩阵

| 场景 | 发生的竞态 | 直接分支的结果 | 当前/推荐处理 |
| --- | --- | --- | --- |
| 读到 idle，随后另一个调用启动 run | `get_state` 与 `prompt` 之间发生 `agent_start` | strict prompt 可能收到 `success:false` 的 host busy；官方 `RpcClient.prompt()` wrapper 还可能把它静默当成功 | 不预读；串行域内发 adaptive prompt，检查 raw response |
| 读到 working，随后旧 run settled | `get_state` 与 `steer` 之间进入 idle | `steer` 仍可能成功入队，但 idle 时没有 run 消费它 | 不直接调用 idle-sensitive `steer`；用 `prompt(streamingBehavior:"steer")` |
| 两个调用同时从 idle 做 preflight | Pi RPC 输入行并行 dispatch；两个 session prompt 可能都在 active bit 置真前通过部分 preflight | 一个最终可能在 core `Agent.prompt()` 处发现 active run；若 preflight callback 已发成功，外层会得到错误/成功不一致 | 每个子代理至少一个 async mutex/actor；定义 FIFO 或明确返回 busy |
| adaptive prompt response 先于 `agent_start` | Pi response 只证明 preflight/queue 接纳 | 若把 response 当完成，会误报已启动；若立刻结算 final，会与 start 交错 | `accepted` 只表示 Pi 接纳；启动/完成由事件和更高层协议确认 |
| 旧 `agent_settled` 晚于新 prompt/continuation start | Pi settled 事件没有 task/turn id | 旧 settled 可能误结算新任务或提交旧 final | 保留 start epoch/turn 或等价 reducer；当前测试覆盖旧 settled 隔离 |
| 压缩与 prompt/steer response 交错 | `isCompacting`、`compaction_end` 和 response 分属异步流 | 快照探针可能在边界读到相反状态；盲目重试会重复正文或忙循环 | 明确 `compaction_active` 拒绝后等待真实生命周期；不把探针当锁 |
| response/transport 超时或 EOF | 命令可能已写入 Pi，但 response 丢失 | 重发可能重复；当作未投递可能丢失 | 标记 `unknown/delivery_uncertain`，禁止自动重发，等待可验证事实或回收节点 |
| final 与普通 send 同时发生 | final 注入父 Pi 会触发父 turn；child 仍可能收到新消息 | 没有 final commit 屏障时，旧 final 会覆盖后继消息或提前 idle | final prepare、父端接纳、commit 后再重放重入操作 |

当前测试直接覆盖这些边界，例如同节点 prompt/steer 的单一 RPC 顺序域（`test/rpc-supervisor.test.ts:758`）、adaptive 入队先于旧 settled（`:1921`）、strict prompt 的 host busy 等待真实 settled（`:2009`）、unknown delivery 不重发（`:4406`）以及 final 接纳前后的重入（`:2872-2995`）。

## 最小必要机制

需要先明确“成功”承诺到哪一层。以下是按保证强度拆分的最小集合。

| 要求 | 最小机制 | 能否删掉现有复杂度 |
| --- | --- | --- |
| 一次普通调用只判断 Pi 是否接纳 | 统一 adaptive `prompt`；raw response 检查；每 child 一个串行 gate | 可以把逻辑 mailbox 缩为提交闸门，不需要 task/final 状态 |
| 两个并发调用有确定顺序 | gate/actor 以 FIFO 串行，或显式拒绝第二个调用 | 不能完全无状态；至少需要 promise chain/队列或 busy 标志 |
| transport 异常不造成重复/乱序 | 保存 in-flight 正文和 `unknown` 屏障，直到事件/回收裁决 | 不能删；若不保存，只能明确接受“可能丢失或重复” |
| 外部树准确显示 working/idle | 事件 reducer；状态、pending counts、activity 用同一 revision 提交 | 可换成更小 reducer，但不能只读 Pi 状态 |
| `wait_agent` 返回“回复/任务完成” | reply notification/final outbox 或等价事件记录 | 不能靠 Pi `isStreaming=false` |
| final 唯一且对应正确任务/回合 | 至少一个不暴露给模型的单调 generation/sequence；当前为 task/turn/commit | 字段名可以换，关联事实不能全删 |
| 父 Pi 已接纳 final 后才释放 child | 父端接纳结果 + final commit/ACK，或同等可靠的同步回调 | 不能删，除非把“完成”降级为“Pi settled、父端可能没收到” |

### 适合窄化最佳努力目标的最小方案

如果本 effort 明确把普通 `send_message` 的契约改成“同步提交命令”，而不声称模型已读或任务完成，建议如下：

1. 保留直接子代理授权和终态检查。
2. 每个 child 保留一个串行提交 gate。它可以是很小的 promise chain/actor，不必继续维护完整 task mailbox。
3. gate 内始终向 Pi 发一个 raw `prompt`：消息语义是 steering 时附带 `streamingBehavior:"steer"`；空闲时 Pi 会走普通 prompt 分支。不要先调用 `get_state`。
4. 只有收到匹配的 `response` 且 `success === true` 才返回 `accepted:true`。检查 `type` 和 `command`，不能使用会吞掉 `success:false` 的 convenience wrapper。
5. `success:false` 映射为明确错误；压缩中和 host busy 只能按事件驱动等待/重试。传输异常或超时标为“不确定”，不自动重发同一正文；至少在该 child 上阻塞后续发送，或直接进入 suspended/回收路径。
6. 普通 `send_message` 可以不返回 `task_id`/`message_id`，也不等待 final ACK，前提是这个 API 明确只承诺 Pi 接纳，并把完成交给独立的 final/wait 协议。

这个方案的“最小”不是零状态：串行 gate 是原子性所需，raw response 分类器是 Pi RPC 实际语义所需，unknown 处理是跨进程传输所需。若连这三项也删除，只能接受并发顺序未定义、响应 false 被误报、消息重复或丢失。

### 当前完整 effort 不能删除的部分

当前 Destination 还要求 `wait_agent`、`final_message`、working/idle 投影、异常恢复和完成通知。对这些语义，建议把“物理提交简化”和“逻辑完成协议”分层，而不是把后者一并删掉：

- 物理层可以统一 adaptive prompt，甚至移除 `strict_prompt`/`adaptive_steer` 的外部差异。
- 逻辑层仍需记录一个 pending/in-flight 消息，以便 response 乱序、EOF、重入和取消时知道正文是否已定案。
- final 层仍需一个 opaque task/turn generation 和 commit id，防止旧 settled/final 关闭新任务。
- 父端 final 接纳仍需可观察的成功/失败结果；ACK 可以改成更简单的同步返回，但不能被“Pi 命令成功”替代。
- 模型和公开工具结果不必暴露这些内部字段。删除模型可见身份与删除内部关联是两个不同决定。

## 推荐决策

对本 ticket 建议固化以下规则，交给后续实现 ticket：

1. **禁止** `get_state`/`get_agent_status` 后自行选择 `steer` 或 `prompt`。
2. 普通父端消息的物理投递统一走 Pi 的 adaptive `prompt`（`streamingBehavior:"steer"`），由 Pi 在同一 session 方法中判断当前活动状态。
3. 同一 child 的提交必须经过单一串行域；并发调用按 FIFO，或明确返回 `busy`，不得依赖事件到达顺序形成未定义顺序。
4. `send_message.accepted` 的推荐新含义是“匹配的 Pi RPC response 为 `success:true`”，不是模型已读、run 已开始或任务完成。若暂时保留现有 mailbox 接纳点，工具描述必须继续明确这是 mailbox acceptance，不能与新契约混用。
5. 明确 `success:false` 才返回可重试/不可重试错误；wrapper 静默忽略 false 的行为不得进入监督器边界。
6. response 丢失、EOF、超时属于 `unknown`，禁止自动重发同一正文；除非后续事件给出确定的未接纳证明，否则保持隔离或回收节点。
7. `agent_settled` 只表示 Pi session-level run settled。它不能单独使当前仓库节点进入 idle；idle 仍需 final candidate、父端接纳和 commit（如果保留现有完成语义）。
8. `task_id`、`turn_id`、`commit_id` 可以继续是内部实现细节，不应要求模型参与；但在保留 final/wait/重入保证时，必须保留等价的单调关联事实。

## 后续验收条件

后续若实现窄化方案，至少应测试：

- idle 快照后立即被另一调用启动时，adaptive 提交不会把消息静默丢入 idle steering queue。
- working 快照后旧 run settled 时，消息仍会启动/接入正确的下一轮。
- 两个并发 `send_message` 按 gate 顺序各只提交一次，返回顺序和 Pi 接纳顺序一致。
- Pi wire `success:false` 不会被 `RpcClient.prompt()`/`steer()` 包装误报为成功。
- prompt 接纳 response 先于 `agent_start` 时，API 只返回 accepted，不提前报告完成。
- transport response 丢失时不自动重发，后续状态显示 unknown/suspended 或按既定回收策略处理。
- final 与新 send 交错时，final commit 前不提前进入 idle，旧 turn final 不会覆盖后继任务。

## 第一方来源

- Pi RPC 文档：[`packages/coding-agent/docs/rpc.md`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md)，重点为 prompt/steer [`#L43-L100`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#L43-L100)、state [`#L169-L188`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#L169-L188)、events/settled [`#L836-L887`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#L836-L887)、错误 [`#L1347-L1356`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/rpc.md#L1347-L1356)。
- Pi RPC handler：[`packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L423`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L423)，输入并发 dispatch [`#L748-L807`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L748-L807)。
- Pi session：[`packages/coding-agent/src/core/agent-session.ts#L878-L946`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts#L878-L946)、prompt preflight [`#L1116-L1271`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts#L1116-L1271)、steer queue [`#L1343-L1390`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session.ts#L1343-L1390)。
- Pi core Agent：[`packages/agent/src/agent.ts#L247-L380`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/agent.ts#L247-L380)。
- Pi typed RPC client：[`packages/coding-agent/src/modes/rpc/rpc-client.ts#L198-L205`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-client.ts#L198-L205)、send/getData [`#L540-L599`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/modes/rpc/rpc-client.ts#L540-L599)。
- Pi 包版本和官方仓库目录：[`packages/coding-agent/package.json`](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/package.json)。

## 本仓库来源

- [`src/rpc-bridge-process.ts`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/rpc-bridge-process.ts#L44-L159)：raw response 分类；`#L701-L722`：adaptive prompt。
- [`src/agent-task-mailbox.ts`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-task-mailbox.ts#L124-L166)：mailbox 接纳和 reducer 内选路；`#L432-L529`：settled provisional 处理；`#L697-L805`：final prepare/commit。
- [`src/rpc-supervisor.ts`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/rpc-supervisor.ts#L1782-L1989)：mailbox 接纳、串行 command queue、物理提交和拒绝/unknown 处理；`#L1422-L1520`：事件对账。
- [`src/agent-snapshot-codec.ts`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/agent-snapshot-codec.ts#L1-L34)：严格生命周期定义；`#L197-L247`：快照不变量。
- [`src/parent-reply-inbox.ts`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/parent-reply-inbox.ts#L202-L249) 和 [`src/child-reply-coordinator.ts`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/src/child-reply-coordinator.ts#L377-L405)：父端接纳、final ACK 和 commit 屏障。
- [`test/rpc-bridge-process.test.ts`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/test/rpc-bridge-process.test.ts#L506-L579)：`success:false` 不误报；[`test/rpc-supervisor.test.ts`](https://github.com/nlbwqmz/wj-pi-subagents/blob/b027527/test/rpc-supervisor.test.ts#L758-L4436)：顺序、settled、adaptive、拒绝、unknown 和 final 竞态覆盖。
