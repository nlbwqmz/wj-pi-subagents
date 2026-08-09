# pi-subagents 父子代理交互机制研究

> 研究对象：`D:/code/open-source/pi-subagents`
>
> 证据范围：仅使用目标仓库的 `README.md`、`docs/`、`src/`、`test/`。文中路径均相对于目标仓库根目录，行号为 1-based。
>
> 研究重点：前台/后台创建与 prompt 下发、进程/文件/EventBus 通道、steering/interrupt/wait、最终输出与异常处理、result intercom、嵌套代理向直接父会话定向返回，以及 `pi-subagents-wj` 可借鉴的 `final` 降级策略。

## 1. 证据口径与结论摘要

本文使用四种标记：

- **【源码事实】**：源码当前直接实现的行为。
- **【源码推导】**：由多处源码组合得到、但源码未用一句注释直接宣告的结论。
- **【测试契约】**：测试明确锁定的行为；它说明维护者希望该行为不能回归，不替代源码事实。
- **【面向 pi-subagents-wj 的建议】**：建议性设计，不声称目标仓库已经完整实现。

核心结论如下：

1. **【源码事实】前台与后台不是同一进程拓扑。**前台由当前扩展进程直接 `spawn` child Pi；后台先 `spawn` 一个 detached TypeScript runner，runner 再启动实际 child Pi。前台 child 的 stdio 直接连回父扩展，后台 child 的生命周期和状态由 runner 持有。（`src/runs/foreground/execution.ts:372-381`；`src/runs/background/async-execution.ts:410-449`；`src/runs/background/subagent-runner.ts:1328-1393`）
2. **【源码事实】初始任务通过 Pi print/JSON 模式下发。**两条路径均以 `--mode json -p` 构造 child 参数；不超过 8000 字符的任务直接作为 `Task: ...` 参数，超过阈值则写入权限受限的 `task.md`，再用 `@<path>` 传给 Pi。（`src/runs/foreground/execution.ts:311-315`；`src/runs/background/subagent-runner.ts:1328-1334`；`src/runs/shared/pi-args.ts:65-65`；`src/runs/shared/pi-args.ts:570-597`）
3. **【源码事实】跨进程的权威信息主要在文件中。**后台控制请求、状态、事件、结果、steer capability/ack，以及 nested event/control 都有文件载体；`fs.watch`、轮询、OS signal 和 EventBus 主要用于降低延迟、补偿漏事件或通知宿主，不应被当成持久交付证明。（`src/runs/background/control-channel.ts:56-128`；`src/runs/background/control-channel.ts:521-604`；`src/runs/background/subagent-wait.ts:32-38`；`src/runs/background/result-watcher.ts:52-81`）
4. **【源码事实】“已发送”不等于“已投递”。**steer 只有 child runtime 写出关联 ack 后才可成为 `delivered`；grouped result intercom 只有收到相同 `requestId` 的 delivery event 且 `delivered: true` 才成功，默认确认窗口为 500 ms。（`src/runs/shared/subagent-prompt-runtime.ts:351-360`；`src/runs/shared/subagent-prompt-runtime.ts:366-426`；`src/intercom/result-intercom.ts:317-358`）
5. **【源码事实】最终文本不是简单取最后一条消息。**`getFinalOutput` 跳过 provider-error assistant 消息，逆序寻找有效 assistant 文本，跳过空白和纯工具消息，并优先保留显式 acceptance report。（`src/shared/utils.ts:74-108`）
6. **【源码推导】常规嵌套结果逐层返回直接父会话。**每一层 child 都被赋予稳定 session 名；该 child 再创建下一层时，执行器把自己当前 session 名解析为下一层的 `orchestratorTarget`。结果 payload 的 `to` 正是该 target。因此孙级普通结果先投递给直接父 child，而不是绕过父层直投根会话。（`src/runs/shared/pi-args.ts:701-710`；`src/runs/shared/subagent-prompt-runtime.ts:566-572`；`src/runs/foreground/subagent-executor.ts:5011-5016`；`src/runs/foreground/subagent-executor.ts:1641-1664`）
7. **【源码事实】根会话的整树视图来自另一条 nested sidecar/registry 路径。**nested events 带 `parentRunId`、路径和深度写入受限 route，根侧再投影成递归 registry；这与普通结果 intercom 的逐层交付是两个职责不同的机制。（`src/runs/shared/nested-events.ts:103-138`；`src/runs/shared/nested-events.ts:312-400`；`src/runs/shared/nested-events.ts:526-557`）

## 2. 进程与生命周期模型

### 2.1 前台执行

**【源码事实】前台主链：**

```text
父会话 subagent 工具
  -> createSubagentExecutor / runSync
  -> buildPiArgs(--mode json -p, task, env, extensions)
  -> 父扩展进程直接 spawn child Pi
  -> child stdout JSONL -> 有界行解析器 -> messages/progress/usage
  -> child close + agent lifecycle 收敛
  -> getFinalOutput / output file / acceptance
  -> 紧凑工具结果，或经确认的 grouped intercom receipt
```

`runSingleAttempt` 先解析模型、系统提示、权限、工具、nested route 和 intercom 元数据，再调用 `buildPiArgs`。（`src/runs/foreground/execution.ts:279-347`）随后在当前扩展进程中直接 `spawn` Pi，stdin 忽略，stdout/stderr 分别使用 pipe，且 Windows 下隐藏窗口。（`src/runs/foreground/execution.ts:372-381`）

child stdout 不是普通最终文本，而是 Pi 的 JSONL 事件流。前台解析 `message_end`、`turn_end`、`agent_end`、`agent_settled` 等事件，持续更新消息、工具、usage 和 lifecycle；只有 lifecycle 收敛并观察到进程关闭后才完成 promise。（`src/runs/foreground/execution.ts:626-654`；`src/runs/foreground/execution.ts:711-729`）

前台的进程句柄仍在当前进程内，因此 interrupt/detach 可以注册成直接回调。并发前台运行用 `activeChildren` 按 index 分别持有控制句柄，当前活跃 child 变化时再把顶层 `interrupt`/`detach` 指向对应 child。（`src/runs/foreground/foreground-control.ts:52-66`；`src/runs/foreground/foreground-control.ts:78-102`）

### 2.2 后台执行

**【源码事实】后台主链：**

```text
父会话 subagent(async: true)
  -> 将 runner config 写入临时 JSON
  -> detached spawn: node + jiti + subagent-runner.ts + config path
  -> 父工具立即取得 async id / runner pid

后台 runner
  -> 读取 config，维护 status.json / events.jsonl / control/*
  -> buildPiArgs(--mode json -p, task, child identity)
  -> spawn 实际 child Pi
  -> 汇总 child JSONL、状态、错误、输出、acceptance
  -> 原子写入 results/<runId>.json

父会话 result watcher
  -> 读取属于当前 session 的 result file
  -> grouped intercom（可选且需 ack）或原生 sendMessage 通知
  -> 交付被接受后删除 result file
```

父进程把完整 launch config 写到临时路径后，以 `detached: true` 启动 `node + jiti + subagent-runner.ts + cfgPath`，runner 的 stdin 被忽略，stdout/stderr 写 runner 日志或忽略。（`src/runs/background/async-execution.ts:410-449`）这说明后台父进程直接创建的是 **runner**，不是实际执行模型请求的 Pi 进程。

runner 对每个模型尝试重新构造 child 参数，并在 `runPiStreaming` 中启动实际 child Pi；它给 child 注入 step 专属 steer inbox、capability、ack 目录，以及 child/parent intercom target。（`src/runs/background/subagent-runner.ts:1328-1393`；`src/runs/background/subagent-runner.ts:3456-3473`）

运行终止时，runner 把 process state 与 output state 分开记录，并原子写 result file。结果包含 `success/state/summary/results/output/error/protocolError/sessionFile/intercomTarget` 等字段；顶层 `intercomTarget` 来自启动配置中的 `controlIntercomTarget`。（`src/runs/background/subagent-runner.ts:4443-4537`）

## 3. Prompt 与 child runtime 下发

### 3.1 初始 task 和 system prompt

**【源码事实】**前台和后台实际 child 都使用 `--mode json -p`，因此一次启动的 prompt 是 print-mode 输入，而 stdout 留给结构化事件协议。（`src/runs/foreground/execution.ts:311-315`；`src/runs/background/subagent-runner.ts:1328-1334`）

`buildPiArgs` 对两类文本使用文件化策略：

- system prompt 总是写入临时 Markdown，文件 mode 为 `0o600`；根据 `systemPromptMode` 选择 `--system-prompt` 或 `--append-system-prompt`。（`src/runs/shared/pi-args.ts:569-586`）
- task 长度不超过 8000 时直接追加 `Task: ${task}`；超过时写权限为 `0o600` 的 `task.md`，参数改为 `@${taskFilePath}`。（`src/runs/shared/pi-args.ts:588-597`）

**【测试契约】**约 16 KB 的长任务必须能经临时文件正常执行，防止 `ENAMETOOLONG`，且仍能提取最终输出。（`test/integration/single-execution.test.ts:2456-2465`）

### 3.2 child 专属运行时扩展

**【源码事实】**参数构造器总是注入 `subagent-prompt-runtime.ts`；只有 launch tool plan 明确授权 fanout 时才额外注入 `fanout-child.ts`。（`src/runs/shared/pi-args.ts:67-77`；`src/runs/shared/pi-args.ts:409-437`）

prompt runtime 负责：

- 根据环境设置 child 稳定 session 名。（`src/runs/shared/subagent-prompt-runtime.ts:566-572`）
- 重写 child boundary prompt，控制 project context、skills 和 fanout 语义。（`src/runs/shared/subagent-prompt-runtime.ts:574-589`）
- 注册 steer inbox、结构化输出、权限、tool budget、watchdog 和 child 内 `subagent_wait`。（`src/runs/shared/subagent-prompt-runtime.ts:484-505`）

fanout child 扩展只在 `PI_SUBAGENT_CHILD=1` 且 fanout 被授权时注册，并构造 child-safe state；其 `subagent` 工具禁止 create/update/delete/eject/enable 等管理变更，但保留 list/get/status/interrupt/resume/steer 等控制能力。（`src/extension/fanout-child.ts:133-168`）

## 4. 通道矩阵：谁是权威，谁只是加速

| 通道 | 发送方 -> 接收方 | 主要载荷 | 语义与可靠性 |
|---|---|---|---|
| child stdout pipe | child Pi -> 前台父进程或后台 runner | Pi JSONL lifecycle、message、tool、usage | **协议事实来源**；有 16 MiB 单行上限和聚合事件投影。`src/runs/shared/child-protocol.ts:4-8,81-164` |
| child stderr pipe | child Pi -> 前台父进程或后台 runner | 启动/运行诊断 | **诊断来源，不是 final**；只保留 128 KiB UTF-8 尾部。`src/runs/shared/child-protocol.ts:169-186` |
| runner config file | 前台父扩展 -> detached runner | 完整 launch config | 后台启动契约；先写 JSON，再把路径交给 runner。`src/runs/background/async-execution.ts:410-426` |
| `status.json` / `events.jsonl` | runner -> watcher/status/wait | 当前状态、step 进度、控制与生命周期事件 | 后台跨进程状态与审计载体；wait 每轮重新扫描持久状态。`src/runs/background/subagent-wait.ts:280-294,481-600` |
| `control/*` JSON | 父管理 action -> runner -> step child | interrupt、stop、steer、checkpoint | **后台控制权威通道**；请求原子落盘并被消费。`src/runs/background/control-channel.ts:56-128,243-312` |
| `fs.watch` + polling | 文件生产者 -> runner/watcher | 文件变化提示 | `fs.watch` 只降低延迟；轮询处理漏事件、watch 失败和启动前已有请求。`src/runs/background/control-channel.ts:521-604` |
| OS signal | 父进程 -> runner/child | SIGINT/SIGTERM/SIGKILL | 机会性快速路径；文件请求仍保留语义。`src/runs/background/control-channel.ts:56-92` |
| result file | runner -> owning parent session watcher | 完整后台结果 | **可重试交付记录**；原生 notifier 接受前不删除。`src/runs/background/result-watcher.ts:131-199,272-304` |
| Pi EventBus | 同一宿主 runtime 内组件 | started/complete/control/wake/result-intercom | 通知、UI、提前唤醒和 intercom 桥接；普通 emit 本身不是跨进程 durable ack。`src/runs/background/subagent-wait.ts:128-199` |
| intercom delivery event | result producer -> bridge -> producer | `requestId`, `delivered` | grouped result 的显式确认；超时/异常返回 false。`src/intercom/result-intercom.ts:317-358` |
| nested event sidecar | child/fanout runner -> root registry projector | started/updated/completed、父路径、子树摘要 | 根级拓扑与观测权威记录，不等同于普通结果投递。`src/runs/shared/nested-events.ts:312-400` |
| nested control files | 根/祖先管理 action -> 直接 owner child -> result file | interrupt/resume request + result | 通过 route 定向到仍持有 child 句柄的 owner。`src/runs/shared/nested-events.ts:662-748`; `src/extension/fanout-child.ts:80-129` |
| native supervisor files | child -> 精确父 session -> child | 阻塞式 decision request/reply | 按 `orchestratorSessionId` 精确过滤，防止同名会话误接。`src/intercom/native-supervisor-channel.ts:375-402` |

矩阵中的关键原则是：**状态重建依赖文件或 child 协议；watch/signal/EventBus 用于把“下一次检查”提前；只有关联 ack 才能证明特定消息已被接收。**

## 5. 控制语义

### 5.1 Foreground interrupt 与 detach

**【源码事实】**前台 child 的进程句柄在当前扩展进程中，abort listener 和显式 interrupt 都可以直接终止 child；detach 则先快照一个 receipt，再解除当前工具调用对 child 生命周期的阻塞。（`src/runs/foreground/execution.ts:447-507`；`src/runs/foreground/execution.ts:611-624`）

前台并发运行不会把所有 child 混成一个句柄。`beginForegroundChild`、`updateForegroundChild`、`finishForegroundChild` 以 index 管理，每次只把顶层快捷控制指向当前活跃 child。（`src/runs/foreground/foreground-control.ts:52-102`）

**【测试契约】**两个并发 child 的 interrupt/detach 计数彼此独立；活跃 child 结束后控制会回退到剩余 child，全部结束后句柄被清空。（`test/unit/foreground-control.test.ts:32-87`）

### 5.2 Background interrupt/stop

**【源码事实】**`deliverInterruptRequest` 先写 interrupt request file，再尝试给 runner pid 发 `SIGINT`；即使 signal 发送失败，只要请求文件成功写入，函数仍返回成功并附 signal error。这明确体现“文件是请求语义，signal 是快速唤醒”。（`src/runs/background/control-channel.ts:56-92`）

runner 侧 `watchAsyncControlInbox` 在安装 watcher 前先执行一次 `consume()`，然后同时安装 `fs.watch` 与定时轮询。因此启动前已存在请求、漏掉的 watch event、watch 创建失败都仍可被处理。（`src/runs/background/control-channel.ts:521-604`）

interrupt 与 stop 的结果语义不同：runner 最终把 interrupt 记录为 `paused` 且 exitCode 可为 0；stop、timeout、预算超限或无法解释的 signal termination 形成 stopped/failed 和非零 exitCode。（`src/runs/background/subagent-runner.ts:4443-4521`）

**【测试契约】**interrupt/stop 请求必须是可解析 JSON，消费恰好一次并删除；steer 请求按时间排序，且请求 id 不直接进入文件名，避免路径穿越。（`test/unit/control-channel.test.ts:35-104`；`test/unit/control-channel.test.ts:106-145`）

### 5.3 Steering：请求、child acceptance、ack 与补救

**【源码事实】steer 的完整路径：**

```text
父 action
  -> control/steer-requests/*.json
  -> runner 分发到 step 专属 steer inbox
  -> child prompt runtime 消费请求
  -> child 调用 sendUserMessage(deliverAs=steer|followUp)
  -> child runtime 在观察到关联 input / turn boundary 后写 ack
  -> runner/父 action 读取 ack，状态才变为 delivered/queued/failed
```

child runtime 会发布 capability，轮询/监听 inbox，并将请求转换成 Pi 的 `sendUserMessage`。若 child 不支持该 API、队列已满或调用抛错，它写失败 ack；仅当 runtime 观察到由 extension 注入的关联 input 时，steer 才 ack 为 `delivered`，follow-up 先 ack 为 `queued`，到 turn boundary 才转 `delivered`。（`src/runs/shared/subagent-prompt-runtime.ts:331-426`；`src/runs/shared/subagent-prompt-runtime.ts:427-474`）

**【测试契约】**steer action 必须等 runner/child session acceptance 后才能返回 `delivered`。（`test/unit/steering-action.test.ts:111-131`）对未确认的顶层 single async run，系统可以提交一次 pause/revive 补救；如果没有可恢复 session，则保持 paused 并返回错误。（`test/unit/steering-action.test.ts:368-400`）对 nested single run则绝不自动 interrupt/recover，只保留 pending，让拥有该 child 的父层继续路由。（`test/unit/steering-action.test.ts:402-431`）

这项限制很重要：**steer 未确认不等于可以任意杀死任意深度的子树。**补救需要明确 owner、可恢复 session、剩余 deadline/turn/tool budget，并且每个 source run 只能提交一个 recovery claim。（`test/unit/steering.test.ts:69-114`）

### 5.4 Wait 与 headless auto-drain

**【源码事实】**`subagent_wait` 每轮按当前 `sessionId` 重新调用 `listAsyncRuns`，不是只相信内存 map；它支持等待任一、等待全部或等待指定 id，并在 completed/failed/paused、attention、timeout、abort 时返回。（`src/runs/background/subagent-wait.ts:280-294`；`src/runs/background/subagent-wait.ts:481-600`）

EventBus 的作用是提前结束 sleep。事件发生后代码仍重新扫描持久状态；没有 bus 时退化为纯轮询。（`src/runs/background/subagent-wait.ts:157-200`）

无 UI runtime 在 `agent_end` 上调用 `drainOutstandingWork`。（`src/extension/index.ts:583-587`）auto-drain 固定一个绝对 deadline，在循环中反复检查当前 session 是否仍有工作，并把剩余时间交给 `waitForSubagents(all: true)`；因此 draining 期间新增的工作也会纳入，而不是只等待最初快照。（`src/runs/background/auto-drain.ts:29-67`）

**【测试契约】**auto-drain 必须循环到 draining 期间新增的工作也消失，所有 wait 共享一个递减的绝对期限，且 wait error 不能被吞成成功。（`test/unit/auto-drain.test.ts:29-52`；`test/unit/auto-drain.test.ts:62-77`）

## 6. 输出提取、final 与异常边界

### 6.1 JSONL 协议及资源边界

**【源码事实】**child stdout 采用有界行读取器。默认 `MAX_CHILD_PENDING_LINE_BYTES = 16 MiB`；stderr 只保留 `MAX_CHILD_STDERR_BYTES = 128 KiB` 的尾部。（`src/runs/shared/child-protocol.ts:4-8`；`src/runs/shared/child-protocol.ts:169-186`）

超大 `turn_end`/`agent_end` 不是一律失败。`PI_AGGREGATE_EVENT_PROJECTOR` 可以只保留 lifecycle 所需字段，例如 `type`、`willRetry`，从而丢弃冗余的大 messages/toolResults 后继续解析；其他无法投影的超限行形成 `protocol_output_limit`。（`src/runs/shared/child-protocol.ts:22-78`；`src/runs/shared/child-protocol.ts:113-164`）

**【测试契约】**16 MiB 上限被直接断言；超大 `turn_end` 会投影后继续读取下一条，超大 `agent_end` 仍保留 retry lifecycle。（`test/unit/child-protocol.test.ts:36-77`）前台对普通超限 stdout 行必须返回 exitCode 1 和 `protocol_output_limit`，stderr 必须保留合法 UTF-8 尾部且不超过 128 KiB。（`test/integration/single-execution.test.ts:2535-2550`）

### 6.2 `getFinalOutput` 的选择规则

**【源码事实】**实现规则可以精确归纳为：

1. 只检查 assistant message。
2. 忽略 `stopReason === "error"` 或带 `errorMessage` 的 provider-error assistant。
3. 在每条消息中收集非空 text part；逆序选择最新有效候选，因此纯工具和空白 assistant 被跳过。
4. 扫描过程中若发现可解析的 acceptance report，优先返回该候选，即使后面还有普通 summary。
5. 没有有效文本时返回空字符串。（`src/shared/utils.ts:74-108`）

**【测试契约】**测试分别锁定了多 part 取最后有效文本、空白回退旧消息、tool-only 回退、早期 acceptance report 优先、provider-error 不得成为 final、全部空白则返回空字符串。（`test/unit/get-final-output.test.ts:10-46`；`test/unit/get-final-output.test.ts:48-119`；`test/unit/get-final-output.test.ts:121-150`）

provider error 与最终成功也不是仅看进程 exitCode。后续出现有效 assistant 文本时可以视为恢复；后续只有空 assistant 时仍失败。（`test/integration/single-execution.test.ts:2797-2825`；`test/integration/single-execution.test.ts:2827-2853`）

### 6.3 文件输出与结构化输出

**【源码事实】**配置 output path 时，目标实现不会盲目把磁盘上的任何内容归因于 child。`extractChildWrittenOutput` 只接受 child 的 `write` tool call，且对应 tool result 必须成功、路径必须精确匹配；这样可避免并发 sibling 写同一路径造成错误归属。（`src/runs/shared/single-output.ts:17-49`）

若 output file 在本次运行期间发生变化，`resolveSingleOutput` 读取它作为 full output；否则把 assistant fallback 持久化到该路径。`file-only` 成功模式只显示文件引用，inline 模式则附加引用；失败状态不会用“已保存文件”掩盖失败。（`src/runs/shared/single-output.ts:187-236`）

严格 structured output 则要求 child 最终调用 `structured_output`，并由 runtime 按 schema 校验；不能用 prose-only final 冒充结构化成功。（`src/runs/shared/subagent-prompt-runtime.ts:34-38`；`src/runs/shared/subagent-prompt-runtime.ts:506-549`）

### 6.4 状态与输出存在性必须正交

**【源码事实】**result intercom 单独计算 process status 和 output state。一个 child 可以是 `failed + output present`，也可以是 `completed + output absent/unknown`；grouped status 不通过“有文本”自动改写为成功。（`src/intercom/result-intercom.ts:20-86`；`src/intercom/result-intercom.ts:246-314`）

**【测试契约】**测试明确要求 failed child 即使有 output，grouped payload 仍为 failed，同时提示先检查可挽救输出再决定是否重试。（`test/unit/result-intercom.test.ts:172-192`）

### 6.5 前台完成态压缩

**【源码事实】**正常完成且未 detached 的前台结果会移除原始 `messages` 和完整 `progress`，保留 `finalOutput`、progress summary 和有界 tool-call summaries；这是工具返回面的压缩，不是运行时没有保存/处理消息。（`src/shared/utils.ts:134-161`）

**【测试契约】**tool-heavy 前台结果不得内联 raw messages/full progress，仍需保留紧凑 tool-call summary，整个 payload 必须小于测试设定的 80,000 字符。（`test/integration/foreground-result-size.test.ts:164-187`）

## 7. Result intercom 与后台通知

### 7.1 前台 grouped result intercom

**【源码事实】**启用 bridge 且 `resultDelivery` 为 true 时，前台将 single/parallel/chain 的 children 汇成一个 payload，目标为当前 `intercomBridge.orchestratorTarget`。`deliverSubagentResultIntercomEvent` 返回 true 后才用简短 receipt 替代原始 inline output，并从 receipt details 删除 `messages/finalOutput/truncation` 等重字段。（`src/runs/foreground/subagent-executor.ts:1631-1690`）

底层确认协议为：先注册 `SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT` listener，再 emit 带 UUID `requestId` 的 result event；只有匹配 requestId 且 `delivered === true` 才成功，默认 500 ms 超时。（`src/intercom/result-intercom.ts:317-358`）

**【测试契约】**有 ack 时前台只返回 compact receipt，不重复 inline full output；无 ack 时即使 event 已 emit，也必须回退到原有前台输出。（`test/integration/intercom-result-delivery.test.ts:211-235`；`test/integration/intercom-result-delivery.test.ts:283-296`）

### 7.2 后台 result file 与原生通知

**【源码事实】**result watcher 只处理属于当前精确 `sessionId` 的文件；它可尝试 grouped intercom，但 grouped intercom 未确认时仍继续走本地 notifier。交付成功后才 emit async-complete 并删除 result file。（`src/runs/background/result-watcher.ts:131-199`；`src/runs/background/result-watcher.ts:272-304`）

默认 notifier 使用 Pi 原生 `sendMessage`，成功调用即返回 true；EventBus completion event 是后续观察通知，不是 `sendMessage` 的接受证明。（`src/runs/background/notify.ts:43-69`；`src/runs/background/result-watcher.ts:288-297`）

**【测试契约】**notifier 第一次拒绝时 result file 必须保留供重试；第二次接受后才删除，而且 async-complete 只发一次。（`test/integration/result-watcher.test.ts:1193-1215`）另一个 session 的 watcher不得消费或删除不属于自己的 result file。（`test/integration/result-watcher.test.ts:91-127`）

## 8. 嵌套代理：定向返回直接父会话

### 8.1 身份链如何形成

**【源码事实】**每个 child target 由 run id、agent 和 index 生成稳定名称，例如 `subagent-worker-78f659a3-2`。（`src/intercom/intercom-bridge.ts:69-77`）launch 时：

- `PI_INTERCOM_STABLE_ID` 和 `PI_SUBAGENT_INTERCOM_SESSION_NAME` 被设置成该 child 的稳定名称；
- inherited `PI_INTERCOM_SESSION_ID` 被清除；
- `PI_SUBAGENT_ORCHESTRATOR_TARGET` 被设置成启动者当前的 target。（`src/runs/shared/pi-args.ts:701-710`）

child runtime 在 `before_agent_start` 调用 `pi.setSessionName(childStableName)`。（`src/runs/shared/subagent-prompt-runtime.ts:566-572`）当该 child 的 fanout executor 再启动孙级时，统一执行路径通过 `resolveIntercomSessionTarget(pi.getSessionName(), sessionId)` 解析当前 orchestrator target。（`src/runs/foreground/subagent-executor.ts:5011-5016`）

**【源码推导】逐层例子：**

```text
根会话 target = subagent-chat-root
  启动 child A:
    A.session = subagent-a-runA-1
    A.orchestratorTarget = subagent-chat-root

A 启动 grandchild B:
    A 的 pi.getSessionName() = subagent-a-runA-1
    B.session = subagent-b-runB-1
    B.orchestratorTarget = subagent-a-runA-1

B 的常规结果 -> A
A 汇总/处理后自己的常规结果 -> 根会话
```

这个结论还由实际交付点闭合：前台 payload 的 `to` 取当前 bridge 的 `orchestratorTarget`；后台 launch 把同一个 target 写入 `controlIntercomTarget`，runner 最终把它写进 result file 顶层 `intercomTarget`。（`src/runs/foreground/subagent-executor.ts:1641-1664`；`src/runs/foreground/subagent-executor.ts:1457-1464`；`src/runs/background/subagent-runner.ts:4523-4537`）

**【测试契约】**child env 必须同时包含自己的 stable id 和父 orchestrator target，并清除继承的 runtime session id；没有 child session name 时也必须清除继承身份，避免误复用父身份。（`test/unit/pi-args.test.ts:608-659`）集成测试还断言这些字段确实进入 child 进程环境。（`test/integration/single-execution.test.ts:3820-3846`）

### 8.2 根级整树视图不是“孙级直投根会话”

**【源码事实】**nested route 在受限目录下创建 `events/`、`controls/` 和 route metadata，包含随机 `capabilityToken`；从 env 恢复 route 时必须同时满足安全 id、目录 containment、共同 route root 和 metadata token 匹配。（`src/runs/shared/nested-events.ts:103-138`）

nested child 把 started/updated/completed 记录写成独立原子 JSON 文件；projector 校验 token、root id、文件名与 record id 后，按父地址挂接到 registry 树。（`src/runs/shared/nested-events.ts:312-400`）根侧可按 root id 找 route，并把 events 投影为递归 registry。（`src/runs/shared/nested-events.ts:526-557`）

因此需要明确区分：

- **常规结果交付**：按 intercom identity 逐层返回直接父会话。
- **拓扑/状态观测**：nested sidecar 向根 route 写事件，根会话据此看到孙级及更深 descendants。
- **不能推出**：孙级普通 assistant final 绕过父层直接投递根会话。源码没有实现这个语义。

**【测试契约】**route token 不匹配必须拒绝，unsafe parent id 必须忽略；started/updated/completed 事件应投影出包含 grandchild 的递归树。（`test/unit/nested-events.test.ts:102-145`；`test/unit/nested-events.test.ts:147-184`）

### 8.3 嵌套控制回到 owner

**【源码事实】**root/ancestor 对 nested run 的 interrupt/resume 不是直接拿孙进程句柄，而是把 request 写入 nested control inbox，再等待对应 result file。（`src/runs/shared/nested-events.ts:662-748`）仍持有实际 foreground control 的 fanout owner child 轮询该 inbox：interrupt 调自己的 control callback；resume 则向当前 leaf intercom target 发送 follow-up，最后写 nested control result。（`src/extension/fanout-child.ts:80-129`）

这解释了为什么 nested steer 未确认时不能由根侧自动 interrupt/revive：根侧不一定是句柄和 session 的 owner，强行跨层补救会破坏逐层所有权。

### 8.4 阻塞式 supervisor 请求

**【源码事实】**child 的 `contact_supervisor` fallback 使用另一套 request/reply 文件通道。父侧 listener 读取 request 后，先要求 `request.orchestratorSessionId === state.currentSessionId`，再把请求送入精确父 session；回复同样写回对应 request id。（`src/intercom/native-supervisor-channel.ts:375-402`）

它与 result intercom 的职责不同：supervisor channel 用于运行中的 decision/interview/progress 协调，result intercom 用于完成结果的 grouped handoff。

## 9. 关键测试契约清单

以下是本研究认为最应在借鉴实现中保留的契约：

| 契约 | 测试证据 |
|---|---|
| 长 task 文件化，避免命令行长度失败 | `test/integration/single-execution.test.ts:2456-2465` |
| JSON chunk 即使跨 UTF-8/数据块边界也能恢复完整消息 | `test/integration/single-execution.test.ts:2506-2519` |
| 聚合 lifecycle 超大时投影，普通超限行明确失败 | `test/unit/child-protocol.test.ts:36-77`; `test/integration/single-execution.test.ts:2522-2541` |
| stderr 有界且 UTF-8 尾部完整 | `test/integration/single-execution.test.ts:2544-2550` |
| final 跳过空白、tool-only、provider-error并保留 acceptance | `test/unit/get-final-output.test.ts:10-150` |
| 完成态前台 result 不携带 raw messages/full progress | `test/integration/foreground-result-size.test.ts:164-187` |
| interrupt/stop/steer 文件请求可解析、一次消费、安全命名 | `test/unit/control-channel.test.ts:35-145` |
| steer 只有 child acceptance 后才 delivered | `test/unit/steering-action.test.ts:111-131` |
| nested steer 不触发跨层自动 interrupt/recover | `test/unit/steering-action.test.ts:402-431` |
| wait 的 `all:true` 等到所有初始活动项终止 | `test/unit/subagent-wait.test.ts:104-133` |
| auto-drain 覆盖 draining 期间新增工作并共享绝对 deadline | `test/unit/auto-drain.test.ts:29-44` |
| grouped intercom 无 ack 时保留普通前台输出 | `test/integration/intercom-result-delivery.test.ts:283-296` |
| 后台 notifier 未接受前保留 result file | `test/integration/result-watcher.test.ts:1193-1215` |
| process failure 与 output presence 正交 | `test/unit/result-intercom.test.ts:172-192` |
| child stable identity 与直接父 target 分离 | `test/unit/pi-args.test.ts:608-659` |
| nested route 做 containment/token 校验并投影递归树 | `test/unit/nested-events.test.ts:102-184` |

## 10. 面向 pi-subagents-wj 的 `final` 降级建议

> 本节全部是 **【面向 pi-subagents-wj 的建议】**。它借鉴上述证据，但不是对 `pi-subagents` 当前行为的复述。

### 10.1 首先拆开三个维度

不要用一个 `final: string` 同时表达所有事实。建议至少拆成：

```ts
interface ChildCompletion {
  lifecycle: {
    state: "completed" | "failed" | "paused" | "stopped" | "timed_out" | "protocol_error";
    exitCode?: number;
    signal?: string;
    error?: string;
  };
  output: {
    state: "present" | "absent" | "unknown";
    source?: "explicit_final" | "acceptance_report" | "assistant_text" |
      "structured_output" | "authored_file" | "bounded_diagnostic";
    text?: string;
    structured?: unknown;
    artifactPath?: string;
  };
  delivery: {
    state: "not_requested" | "pending" | "delivered" | "unacknowledged";
    requestId?: string;
  };
}
```

理由：目标仓库已经通过 `process status` 与 `outputState` 分离证明，有输出不能把失败进程改成成功；同理，EventBus emit 也不能自动把 delivery 改成 delivered。（证据基础：`src/intercom/result-intercom.ts:20-86,246-314`；`src/intercom/result-intercom.ts:317-358`）

### 10.2 建议的 final 选择优先级

建议把“运行状态判定”和“输出候选选择”分成两个纯函数。输出选择按以下层次降级：

1. **显式协议 final / 有效 acceptance report**：必须通过类型/结构校验，且不得来自 provider-error message。显式 final 若是新协议字段，应带 version 与 source event id。
2. **最新有效 assistant 文本**：从后向前扫描 assistant；每条消息取最后非空 text part；跳过 whitespace-only、tool-only 和 provider-error。
3. **已验证 structured output**：仅在 schema 校验通过且确认 child 调用了约定工具时采用。若调用方明确配置 structured-only，可把这一层提升为第 1 层，并让 prose 只作诊断。
4. **可归因的 authored file/artifact**：要求路径属于本 run，且有成功 write/tool-result、原子 manifest 或 content digest 证明归属；不要因为目标路径存在就归因给 child。
5. **有界错误诊断**：没有业务输出时，返回结构化错误摘要和有界 stderr/protocol tail。该文本的 `source` 必须是 `bounded_diagnostic`，不能冒充 assistant final。
6. **完全缺失**：明确 `output.state = "absent"`，不要生成“完成”类占位文本。

其中第 2 层可直接借鉴 `getFinalOutput` 的逆序/过滤思路；第 4 层可借鉴 `extractChildWrittenOutput` 的成功 tool-result 和精确路径关联；第 5 层可借鉴 stdout 16 MiB 单行上限、stderr 128 KiB tail 的有界策略。（证据基础：`src/shared/utils.ts:74-108`；`src/runs/shared/single-output.ts:17-49`；`src/runs/shared/child-protocol.ts:4-8,169-186`）

### 10.3 不要让降级掩盖失败

建议最终展示采用如下规则：

```text
lifecycle=completed + output present
  -> 正常 final

lifecycle=failed/stopped/timed_out + output present
  -> 先显示失败状态和原因，再附“可挽救输出”；不改写为成功

lifecycle=failed + output absent
  -> 显示结构化错误 + 有界诊断 + artifact/session 定位信息

lifecycle=completed + output absent
  -> 标记异常完成：no valid final output；是否重试由上层策略决定
```

这可避免两个常见错误：一是 child 在崩溃前写了半份答案却被判成功；二是进程 exit 0 但只有 provider error/空白消息却被判完成。

### 10.4 建议的提取伪代码

```ts
function selectFinal(evidence: Evidence, contract: OutputContract): SelectedOutput {
  const explicit = validExplicitFinal(evidence.messages);
  if (explicit) return present(explicit.kind, explicit.value);

  if (contract.mode === "structured-only") {
    const structured = validStructuredOutput(evidence.structured);
    return structured ?? absent();
  }

  const assistant = latestValidAssistantText(evidence.messages);
  if (assistant) return present("assistant_text", assistant);

  const structured = validStructuredOutput(evidence.structured);
  if (structured) return structured;

  const artifact = attributableArtifact(evidence.artifacts, evidence.toolEvents);
  if (artifact) return artifact;

  const diagnostic = boundedDiagnostic(evidence.protocolError, evidence.stderrTail);
  if (diagnostic) return present("bounded_diagnostic", diagnostic);

  return absent();
}
```

随后独立执行：

```ts
const lifecycle = classifyLifecycle(processExit, timeout, interrupt, protocolError);
const output = selectFinal(evidence, outputContract);
const completion = { lifecycle, output, delivery: { state: "not_requested" } };
```

### 10.5 建议的交付与嵌套规则

- 每个 child 建立稳定 `sessionTarget`，并把创建者当前 target 固化为 `parentTarget`；child 不能继承父 runtime identity 后直接复用。
- 普通 final 只投 `parentTarget`；根级树视图走独立的 sidecar/event projection，避免孙级结果绕开父层的聚合与所有权。
- result delivery 必须有 `requestId` 和 ack；超时后保留 inline/result-file fallback。
- durable result 在 notifier/bridge 明确接受前不能删除。
- nested control 发给实际 owner，由 owner 操作它持有的 child handle/session；祖先不应因 steer timeout 自动 kill 深层 child。

这些规则分别对应目标仓库的稳定 child identity、逐层 orchestrator target、nested registry、result ack 和 owner-routed nested control，但在 `pi-subagents-wj` 中应作为明确协议写入类型和测试，而不是依赖环境变量组合后的隐式推导。

### 10.6 最小验收测试集

建议 `pi-subagents-wj` 至少添加以下测试：

1. 最后一条 assistant 为空白或纯工具时，回退上一条有效文本。
2. provider-error assistant 永不成为 final；后续有效文本可恢复，后续空白不可恢复。
3. 显式 final/acceptance 不被后续“Done”摘要覆盖。
4. structured-only 未调用结构化工具时失败，不能回退 prose 为成功。
5. sibling 写同一路径时，没有本 child 归属证据就不得采用该文件。
6. failed + output present 仍保持 failed，并保留 salvage output。
7. stdout 超限返回 protocol_error，stderr 只保留 UTF-8 安全的有界尾部。
8. result event 未 ack 时保留原始 inline 或 durable result file。
9. 三层嵌套中，孙级 result 的 `to` 是直接父 child target；根通过 registry 看到孙级，但不直接收到孙级普通 final。
10. nested steer 未 ack 时不触发祖先跨层 kill/revive。

## 11. 最终判断

`pi-subagents` 的父子交互并不是单一 IPC 方案，而是分层协议：

- child Pi stdout JSONL 负责模型运行事实；
- detached runner 和原子文件负责后台生命周期、控制与可恢复结果；
- EventBus、watch、poll、signal 分别负责宿主通知和低延迟唤醒；
- ack 把“发出请求”提升为“确认接收”；
- stable session target 让普通结果逐层返回直接父会话；
- nested sidecar/registry 给根会话提供整棵树的独立观测面。

对 `pi-subagents-wj` 最值得直接吸收的不是某个函数，而是三个协议原则：**生命周期与输出正交、交付以 ack 为准、嵌套结果与根级拓扑分通道。**在此基础上实现显式 final、有效 assistant、结构化/文件产物、有界诊断的分层降级，才能在 child 空 final、provider error、进程异常、超大输出和多层嵌套下保持可解释且不丢结果。
