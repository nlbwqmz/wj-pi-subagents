# 以 session entry 识别多目标 wait 批次并固定父唤醒语义

Status: accepted

## 背景

Pi 会把 OpenAI、Anthropic、Google 等 provider 的原始响应归一为统一的 assistant `ToolCall`：每个调用具有 `id`、`name` 和 `arguments`，工具执行回调收到相同的 `toolCallId`。一条最终 assistant message 中可以包含多个同名 `wait_agent`。如果插件把它们当作独立顺序工具，各自等待完整 timeout，会让一个 assistant 工具批次的总等待时间累加；父端已接纳的 steering 也可能等到整批 Promise 结束后才被模型消费。

Pi 没有单独暴露 `toolBatchId`，但最终 assistant message 在工具执行前已经进入 SessionManager，并具有稳定唯一的 session entry ID。因此可以在插件内部建立确定的批次身份，而不读取供应商原始协议或依赖时间窗口。

## 决策

### 1. 单次 wait 使用多目标 first-event 语义

`wait_agent` 输入字段闭集为：

```json
{
  "agent_ids": ["..."],
  "timeout_ms": 600000
}
```

`agent_ids` 必须非空、最多 64 个 canonical UUID，重复项按首次出现顺序去重。控制器在所有目标上登记同一个 waiter，并维护目标到 waiter 的反向索引。任一目标产生已提交的 reply、task outcome、suspended 或 terminal 时，原子结算 waiter 并从全部索引移除。

timeout 使用一个 timer，只返回完整目标集合，不改变节点状态。控制器支持 abort 清理等待器。

### 2. 用最终 session entry 作为批次身份

工具执行时沿当前 session branch 反向查找包含当前 `toolCallId` 的最终 assistant message：

- `batchId`：`SessionMessageEntry.id`；
- `callId`：`toolCall.id`；
- 批次成员：同一 message 中 `name === "wait_agent"` 的直接 tool call。

同一 message 内的 tool call ID 必须唯一。无法找到 entry、发现重复 ID 或实际执行参数与持久化参数不一致时，当前调用退化为独立的多目标 wait，插件不得猜测批次。

从 session entry 读取最终消息也确保其他扩展的 `message_end` 替换已经生效，并与 Pi 实际执行的调用一致。

### 3. ParentWaitBatchCoordinator 处理重复 sibling

插件为每个扩展实例维护 turn-local `ParentWaitBatchCoordinator`：

1. 分别解析和校验批次中的每个 sibling 参数；schema 非法调用不会进入 Pi 的 execute，语义非法调用单独返回错误；
2. 只把语义合法调用的目标合并为一个 union；
3. 共享 timeout 取合法调用解析后期限的最小值；
4. 只启动一个 `AgentController.waitAgents()`；
5. 获胜结果若包含当前 sibling 的任一目标，则返回真实结果；否则返回 `batch_released`，携带当前 `agent_ids`、`released_by_agent_id` 和 `released_by_outcome`；
6. 共享 timeout 时所有合法 sibling 返回同一个联合 timeout 数据；
7. 顺序执行的后续 sibling 读取缓存立即返回，`turn_end`、abort、reload 和 shutdown 清理 turn-local 状态。

`batch_released` 是工具协调结果，不表示对应子代理发生了状态变化。

### 4. 仅 wait_agent 使用 parallel

`wait_agent` 注册为 `executionMode: "parallel"`。其他管理工具继续使用 sequential。即使宿主因同批次其他工具强制顺序执行，session entry 预扫描和 cohort 缓存仍能解除后续 sibling，不累计 timeout。

### 5. reply_to_parent 不再暴露唤醒配置

`reply_to_parent` 只接受 `message`，并通过严格提示限制为必要的父子过程通信。每条成功接纳的工作中消息固定以 `triggerTurn: true` 和 `deliverAs: "steer"` 注入父会话；不得用于常规进度、心跳、阶段总结、完成通知或替代 final。

这是破坏性协议迁移：reply envelope 升为第 4 版，监督协议升为 `pi-subagent/6`。旧活动树不热接管，必须结束后以新协议重建。

## 后果

- 正确的单次多目标调用只使用一个 timer，任一目标事件即可返回；
- 错误生成的多个 sibling wait 不再因 Pi 的顺序执行模式累计完整 timeout；
- provider 差异留在 Pi adapter，插件只依赖统一 `ToolCall`；
- timeout 结果不再携带伪造的单一 `agent_id`，渲染器需要区分 timeout、节点事件和 `batch_released`；
- batch coordinator 是 turn-local 状态，不参与任务 mailbox、树生命周期或监督协议持久化；
- 协议版本升级要求旧树重建。

## 未采用方案

- 按工具名称或调用参数寻找 sibling：同名工具跨 assistant turn 会误合并；
- 依赖 `message_end` 回调顺序生成隐式批次：多个扩展可能替换 message，且无法保证回调缓存就是最终执行版本；
- 以时间窗口推断批次：无法区分相邻 turn，并会在延迟事件下错误唤醒；
- 把所有等待改成并行但不做 cohort：Pi 仍会等待同一批次所有 Promise，不能解决 sibling timeout 累加；
- 修改 Pi 核心或 provider adapter：超出插件责任边界。
