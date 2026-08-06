# Pi 原生子代理承载能力研究

> 研究基线：`D:\code\open-source\pi` 提交 `a96fb984d8c8b065fc5d193309fc812a882adee0`。
>
> 研究范围：仅使用该提交内的官方文档、源码与测试；不以第三方资料或未检出的上游版本为依据。

## 结论摘要

Pi 能直接承载“一个父节点持有一个长期存活、无会话持久化的 RPC 子进程”这一基础单元；不需要修改 Pi 核心即可得到隔离上下文、连续追问、执行中 steering、中止当前运行、完整流式事件和优雅关闭钩子。

Pi **没有**原生的“子代理”“父子所有权”“深度预算”或“跨进程代理树”领域对象。递归层级、只允许直接父子通信、根节点只读全树、`maxDepth`、节点身份、状态上汇聚和级联生命周期都必须由扩展的控制层实现。

| 能力 | 判定 | 规格含义 |
| --- | --- | --- |
| `pi --mode rpc --no-session` 长期进程 | 原生直接支持 | 会话仅驻留内存，进程持续读取 stdin，适合作为临时子代理运行时。 |
| 空闲启动、繁忙纠偏的统一 `send_message` | 底层协议原生支持，公共 `RpcClient` 有接口缺口 | 严格原子映射需要 `prompt + streamingBehavior: "steer"`；本项目按 REQ-026 采用控制器顺序域的已确认状态路由：空闲 `prompt`、工作中/中断中 `steer`。 |
| `prompt`、`steer`、`abort` 与流式事件 | 原生直接支持，但有语义边界 | 接受响应不代表任务完成；完成应以 `agent_settled` 为准。 |
| 强中断并保证节点保持空闲 | 存在缺口 | `abort` 不清空已经排队的 steering/follow-up，RPC 又没有 `clear_queue`。 |
| 状态和队列观测 | 原生直接支持 | `get_state`、`queue_update`、agent/turn/message/tool 事件足以维护单节点状态机。 |
| 动态工具暴露 | 原生能力可组合实现 | 可条件注册、allowlist/denylist 或设置 active tools；没有 `unregisterTool`。 |
| 按深度加载扩展 | 原生 CLI 机制可组合实现 | `--no-extensions` 关闭发现，显式 `-e` 仍可加载受控扩展；深度本身由扩展传递和校验。 |
| 根节点全树状态 | 需要扩展协议 | Pi 的 `get_tree` 是会话条目树，不是代理进程树；每层必须汇总直接子节点并向直接父节点上报。 |
| 根 TUI 展示代理树 | 原生 UI 可承载，数据需扩展汇聚 | `setStatus`、`setWidget` 和工具自定义渲染可展示，但不会自动生成树状态。 |
| 正常退出时逐层清理 | 原生钩子可组合实现 | `session_shutdown` 与 RPC stdin EOF 提供优雅路径。 |
| Windows 强制回收整棵进程树 | 存在明确缺口 | Pi 内部有 `taskkill /T /F`，但未公开给扩展；公开 `RpcClient.stop()` 只杀直接进程。 |

因此，目标扩展可以保持为独立扩展，不必预设修改 Pi 核心；但规格必须包含一个薄的控制/兼容层，至少负责：每子节点 RPC 串行化、代理树状态协议、强中断策略、进程退出观测，以及跨平台进程树回收。

## 研究边界与验证方法

- 研究开始时用 `git rev-parse HEAD` 核实上游工作区精确位于提交 `a96fb984d8c8b065fc5d193309fc812a882adee0`，且未发现上游工作区改动。
- 结论优先以实现和测试为证据，文档用于确认公开契约；对文档没有承诺、但源码能够组合出的能力，统一标为“可组合实现”而非“原生直接支持”。
- 尝试定向运行 RPC、队列、动态工具和 shutdown 测试时，上游工作区缺少本地 `vitest` 依赖，配置加载阶段即以 `ERR_MODULE_NOT_FOUND: vitest/config` 失败。因此本报告没有声称测试已在本机通过；引用的是指定提交中已有测试所表达的一手预期。
- 本研究不实现扩展，也不决定最终工具参数、状态机或故障契约；只判断 Pi 能提供哪些底层事实，以及哪些问题仍需后续决策票解决。

## 详细核查

### 1. 无会话 RPC 进程

#### 原生直接支持

RPC 模式通过 stdin 接收严格 JSONL 命令，通过 stdout 输出响应与事件；官方文档明确把它定义为适合嵌入其他应用的无头模式：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:3)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:22)。

`--no-session` 的公开含义是禁用会话持久化：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:17)。CLI 实际会选择 `SessionManager.inMemory(...)`：[main.ts](D:/code/open-source/pi/packages/coding-agent/src/main.ts:325)，而内存 SessionManager 以 `persist: false` 构造且不创建会话文件：[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1567)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1015)。这满足“子代理不跨父会话结束持久化”的会话边界。

RPC 不会在一次回答结束后退出；建立输入监听后，它返回一个永不自行完成的 Promise：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:805)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:815)。同一进程因而可以保留内存上下文，依次接受多次 `prompt` 或执行中消息。

#### 扩展必须补充

Pi 只提供“RPC 会话进程”，不会把它命名为子代理，也不维护父节点、子节点或深度。子代理 ID、父 ID、当前 `depth`、根设定的 `maxDepth`、模板和进程句柄都属于扩展状态。

`--no-session` 只保证 Pi 会话不落盘，不等于整个进程绝不读写任何配置或缓存。规格中“非持久化”应精确定义为：不保存可恢复的子代理身份、代理树和子代理对话；不能把它扩大解释为 Pi 及模型提供方绝对零磁盘写入。

### 2. `send_message`、`prompt` 与 `steer`

#### 底层原子映射（参考能力）

对外保留单一 `send_message` 是可行的。Pi 底层协议支持不查状态的单命令形式：

```json
{"id":"message-42","type":"prompt","message":"...","streamingBehavior":"steer"}
```

原因是 `AgentSession.prompt()` 只在当前正在运行时检查 `streamingBehavior`，并在该分支把消息加入 steering 队列：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:1157)、[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:1167)。空闲时则跳过该分支，照常启动新的 prompt。这样一条命令原子覆盖两种状态：

- 子代理空闲：开始一次新的 agent run。
- 子代理繁忙：消息作为 steering，在当前 assistant 轮次已经发起的工具调用完成后、下一次 LLM 调用前注入；这是文档承诺的行为：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:56)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:62)。

指定提交已有测试覆盖“运行中带 streaming behavior 的 prompt 被接受并只返回一次成功响应”：[rpc-prompt-response-semantics.test.ts](D:/code/open-source/pi/packages/coding-agent/test/rpc-prompt-response-semantics.test.ts:253)。虽然该用例使用 `followUp`，它验证的是同一 prompt 分流入口和响应语义；`steer` 分支由上述同一实现选择。

#### 为什么不能始终发送原生 `steer`

原生 `steer` 命令只调用 `session.steer(...)`：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:418)。`AgentSession.steer()` 无空闲检查，只把消息交给 `_queueSteer`：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:1334)，底层 `Agent.steer()` 也只是 enqueue：[agent.ts](D:/code/open-source/pi/packages/agent/src/agent.ts:282)。现有单元测试明确验证消息只是进入 steering queue、尚未出现在会话消息中：[agent.test.ts](D:/code/open-source/pi/packages/agent/test/agent.test.ts:481)。

因此，对空闲节点直接发 `steer` 会成功入队，却不会主动开始一次运行；消息要等未来某个 prompt 才可能被消费。由于 Pi `0.83.0` 公共 `RpcClient` 没有暴露 `streamingBehavior`，本项目不调用私有 `send()` 或复制 JSONL，而采用以下兼容路由：控制器在单节点命令顺序域内读取已确认状态，空闲发送 `prompt`，工作中或中断中发送 `steer`；状态竞态导致无法确认接受时返回 `message_delivery_failed` 且不自动重发。这是扩展的明确兼容决策，不宣称等价于底层原子映射。

#### 响应与完成不是一回事

`prompt` 的 `success: true` 只表示消息已被接受、排队或立即处理，并不表示模型工作已经完成；接受后的失败通过事件流报告，不会再为同一请求 ID 返回第二个 response：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:73)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:76)。扩展必须把“命令已接受”和“代理已完成”建模为不同状态。

### 3. 状态、队列和完成事件

#### 原生直接支持

`get_state` 返回 `isStreaming`、`isCompacting`、steering/follow-up 模式、消息数和 `pendingMessageCount`：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:446)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:459)。其中 `isStreaming` 在实现中表示整个 session-level agent run 或后置 continuation 是否仍活跃，而不只是当前 token 是否正在到达：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:868)。

`queue_update` 每次都会给出完整的 steering 与 follow-up 文本队列：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:560)。RPC 把每个 `AgentSessionEvent` 转成 JSON 后原样输出：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:355)。公开事件还覆盖 agent、turn、message、tool、compaction、retry 和 extension error：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:838)。这些信息足以让扩展维护单个直接子节点的 `starting/running/idle/interrupting/exited/failed` 等派生状态。

判断一次处理真正结束必须使用 `agent_settled`，不能使用 `agent_end`。`agent_end` 之后仍可能发生自动重试、压缩恢复或排队 continuation，而 `agent_settled` 才表示 Pi 不会自动继续：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:840)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:882)。回归测试也验证 follow-up 全部处理完成后才发出唯一的 `agent_settled`：[6363-agent-settled-event.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts:64)。

#### 扩展必须补充

普通流式事件通常没有 RPC 请求 ID；官方文档只为直接 RPC bash 的更新事件承诺来源 ID：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:834)。队列项同样只有文本，没有稳定消息 ID 或任务 ID。扩展应以“RPC 连接所对应的子代理 ID + 自身递增的操作序号”关联公开工具调用、命令响应和状态变化，不能假设 Pi 会提供端到端任务 ID。

RPC 输入处理没有内建的逐连接命令串行队列。每一行都以 `void handleInputLine(line)` 独立启动异步处理：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:805)。同时，Pi 的模型工具调用默认可以并行：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1891)。为避免两个父工具调用同时操作同一直接子节点，控制层必须为每个子节点串行化状态变更命令，并明确只读查询是否允许并发。

### 4. `abort`、steering 队列与强中断

#### 原生直接支持的部分

RPC `abort` 会调用并等待 `session.abort()`：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:428)。后者停止自动重试、触发当前 Agent run 的 AbortSignal，并等待 session 回到 idle：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:1541)。Pi 会把同一个 AbortSignal 传给当前工具的 `execute`：[agent-loop.ts](D:/code/open-source/pi/packages/agent/src/agent-loop.ts:675)、[agent-loop.ts](D:/code/open-source/pi/packages/agent/src/agent-loop.ts:678)，所以正确遵守 signal 的模型请求、内建工具和扩展工具可以协作取消。

这足以承载“中止当前模型/工具运行，但不销毁 RPC 进程”这一弱语义。父节点可以在收到成功响应和后续 `agent_settled` 后继续向同一个子代理发送消息。

#### 关键缺口：`abort` 不清队列

`session.abort()` 没有调用 `clearQueue()`；`clearQueue()` 是另一个独立方法：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:1509)、[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:1541)。当前 run 结束后，AgentSession 发现底层仍有排队消息时会自动 `continue()`：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:1058)、[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:1093)。现有并发测试甚至验证了：先排入 steering、再 abort 当前 run 后，steering 仍会被处理：[agent-session-concurrent.test.ts](D:/code/open-source/pi/packages/coding-agent/test/agent-session-concurrent.test.ts:280)、[agent-session-concurrent.test.ts](D:/code/open-source/pi/packages/coding-agent/test/agent-session-concurrent.test.ts:288)。

RPC 命令联合类型没有 `clear_queue`：[rpc-types.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:20)。因此，目标扩展不能把原生 `abort` 描述成“清除当前工作及其尚未交付的纠偏消息，并保证节点保持空闲”。后续规格必须明确选择一种行为：

1. `interrupt_agent` 仅中止当前 run，已接受的 steering 允许随后继续。
2. 强中断通过终止并重建该 RPC 节点实现，代价是丢失该子代理的内存上下文。
3. 增加一个小型兼容入口，使子进程能够执行 `clearQueue + abort`；这不属于当前公开 RPC 契约。
4. 推动 Pi 上游增加公开 `clear_queue` RPC，再将其作为最低版本依赖。

此外，AbortSignal 是协作式取消。若某个自定义工具忽略 signal 或永不 settle，RPC `abort` 自身也可能长时间无法返回。控制层仍需超时和最终进程终止兜底。

### 5. 动态工具暴露与 `maxDepth`

#### 原生可组合机制

扩展可以在加载时或启动后调用 `pi.registerTool()`，新工具无需 reload 即进入当前 session 的工具注册表：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1337)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1341)。`pi.getActiveTools()`、`pi.getAllTools()` 和 `pi.setActiveTools()` 可以控制当前模型实际可调用的工具集合：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1645)。`setActiveTools` 的变化在下一次模型请求生效：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:914)，回归测试覆盖了同一次 run 内下一次 provider request 看到新工具的行为：[6162-extension-active-tools-next-turn.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts:8)。

CLI 还提供两类启动期过滤：

- `--tools` 是内建、扩展和自定义工具的 allowlist；`--exclude-tools` 可排除指定工具。测试验证被排除的扩展工具既不在 all tools 中，也不在 active tools 或 system prompt 中：[5109-exclude-tools.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5109-exclude-tools.test.ts:40)。
- `--no-builtin-tools` 只关闭内建工具并保留扩展工具，而 `--no-tools` 关闭全部工具：[usage.md](D:/code/open-source/pi/packages/coding-agent/docs/usage.md:209)、[usage.md](D:/code/open-source/pi/packages/coding-agent/docs/usage.md:212)。

Pi 没有 `unregisterTool`；公开 ExtensionAPI 只有 `registerTool` 与 active-tool 控制：[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:1245)、[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:1330)。因此，`depth` 是节点创建时确定且不可提高的事实时，最清晰的做法是在首次模型调用前决定工具集合，而不是运行中改变深度后尝试注销。

#### 达到深度上限时的边界

Pi 不理解 `maxDepth`，也不会生成 `max_depth_reached`。扩展必须同时实现两层约束：

- 能力最小化：当 `depth >= maxDepth` 时，从加载阶段就不注册管理工具，或通过启动 allowlist/denylist 让整套管理工具完全不进入该节点的工具注册表和 system prompt。
- 权威校验：所有内部 spawn 入口在创建进程前再次检查 `currentDepth + 1 <= maxDepth`；失败返回稳定、明确的 `max_depth_reached`，不能只依赖模型看不见工具。

第二层是扩展控制器的错误契约，不是 Pi 的能力。若“绕过能力发现”特指模型臆造一个未注册的 `spawn_agent` 工具调用，Pi 只能给出普通的未知工具错误；要把这种情况也转换为 `max_depth_reached`，规格还需定义额外拦截机制，不能把它视为现成行为。

### 6. 子进程按深度加载扩展

CLI 的 `--no-extensions` 只关闭自动发现；显式 `--extension/-e` 路径仍被记录：[args.ts](D:/code/open-source/pi/packages/coding-agent/src/cli/args.ts:151)、[args.ts](D:/code/open-source/pi/packages/coding-agent/src/cli/args.ts:154)。ResourceLoader 的实现也明确在 `noExtensions` 为真时只保留 CLI 显式扩展：[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:451)。因此可建立受控启动形态：

```text
可继续派生的节点:
pi --mode rpc --no-session --no-extensions -e <本扩展> ...

纯叶节点:
pi --mode rpc --no-session --no-extensions ...
```

这可以阻止子进程从用户级或项目级自动发现另一份同名扩展，避免重复注册和不受根节点控制的递归能力。是否让叶节点仍加载本扩展但条件性不注册工具，取决于叶节点是否还需要扩展内部状态上报；这是后续内部协议决策，不影响 CLI 可行性。

深度元数据可通过受控环境变量传入；公开 `RpcClientOptions` 原生支持 `cwd`、`env` 和附加 CLI `args`：[rpc-client.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:28)。扩展自定义 CLI flag 也可用 `registerFlag/getFlag` 表达字符串值：[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:1266)，但叶节点若不加载扩展，这些 flag 会成为未知选项并触发启动错误：[agent-session-services.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session-services.ts:99)、[agent-session-services.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session-services.ts:120)。因此，在“叶节点不加载扩展”的候选设计中，内部深度元数据优先用环境变量更稳妥。

无论选择 flag 还是环境变量，Pi 都不会验证父节点没有伪造或扩大剩余深度。根配置的不可突破性必须来自扩展只从可信父控制器生成子进程参数，并在每层递减预算、拒绝后代提高上限。

### 7. 根节点全树状态汇聚

#### 不存在原生代理树 API

RPC 虽然有一个名为 `get_tree` 的命令，但它返回的是单个 Pi 会话中 message、tool result、compaction 等条目的分支树：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:724)。实现直接调用当前 `sessionManager.getTree()`：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:647)。它与跨进程代理树没有关系，不能用于发现子进程、父子所有权或深度。

RPC 命令联合类型中也没有代理注册、子节点枚举、跨连接查询或自定义事件命令：[rpc-types.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:20)。因此，根只读查看整棵代理树必须由扩展维护如下逐层结构：

```text
每个节点的控制器
  ├─ 权威保存自己的直接子节点
  ├─ 订阅每个直接子进程的 RPC 事件和退出
  ├─ 合并直接子节点上报的子树摘要
  └─ 只向自己的直接父节点上报本子树状态
```

这保留了“只有直接父子通信”：根节点看到孙节点，是因为中间节点上报了只读摘要，而不是根建立到孙节点的控制通道。

#### 可组合的上报载体及其风险

Pi 没有公开的任意 typed RPC event API。最接近的结构化上报载体是 `pi.appendEntry(customType, data)`：它创建不参与 LLM context 的自定义 session entry；实现随后发出包含该 entry 的 `entry_appended` 事件：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:2380)。RPC 对非 `message_update` 的 `AgentSessionEvent` 不做裁剪即可输出：[json-event.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/json-event.ts:28)。因此，中间节点可以追加例如 `subagent_tree_delta`，直接父进程从该节点的 RPC stdout 收到结构化数据。

这个方案属于“可组合实现”，不是正式的代理树协议，存在以下约束：

- `entry_appended` 虽在公开 TypeScript 事件联合中，但 RPC 文档的事件表没有列出它；跨版本兼容性需要验收测试锁定。
- append 会推进该无会话进程的内存 session entry tree；高频状态心跳会造成无界内存增长，不应把它当 telemetry 总线。
- 事件没有确认、重放游标或树版本语义。扩展需要自定义 schema version、节点 revision、父节点接收确认或定期完整快照，才能从漏报、乱序或子进程重启中恢复一致视图。
- `pi.sendMessage()` 也能产生 RPC message 事件，但官方明确说明 custom message 会参与 LLM context：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1388)，不适合承载内部树状态。

如果最终规格不接受利用 session entry 作为控制面事件，就必须增加独立的内部父子状态通道。无论选哪种载体，状态 schema 和一致性语义都不是 Pi 原生能力。

### 8. 根 TUI 的只读代理树视图

根会话拿到扩展汇聚的树后，Pi TUI 足以承载展示：

- `ctx.ui.setStatus` 可在 footer 保持简短状态，直到显式清除：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2551)。
- `ctx.ui.setWidget` 可在编辑器上方或下方显示多行树摘要，也可以在真正的 TUI 模式使用组件工厂：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2578)。
- 自定义工具可用 `renderCall/renderResult` 提供稳定的树查询结果展示：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2205)。

RPC 子节点不是完整 TUI。其 `ctx.mode` 为 `rpc`；`setStatus` 与字符串数组 `setWidget` 会被编码为 `extension_ui_request`，但自定义组件、footer、header 和 `custom()` 不可用或退化：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1144)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1155)。所以完整树 UI 应只由根交互会话绘制；中间 RPC 节点只负责结构化上报。

TUI API 解决的是渲染，不解决数据所有权。根的只读工具或视图必须读取控制器的汇聚快照，且不得复用它建立到后代的写通道。

### 9. 正常退出与逐层优雅关闭

官方扩展指南明确要求长期进程、socket、watcher 等延迟到 `session_start` 或实际使用时创建，并在幂等的 `session_shutdown` handler 中关闭：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:220)。`session_shutdown` 在 runtime 销毁前触发，reason 覆盖 `quit/reload/new/resume/fork`：[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:615)。运行时 `dispose()` 会 await 全部 shutdown handler 后才 dispose session：[agent-session-runtime.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session-runtime.ts:398)。

这意味着根会话不仅在程序退出时要销毁代理树；`/reload`、new session、resume、fork 等导致当前扩展 runtime 被替换的路径也必须终止旧树，否则会留下不再受当前父会话拥有的进程。

RPC 进程的 stdin EOF 会调用并等待同一个 shutdown 流程：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:724)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:800)。因此可组合出逐层优雅算法：父节点停止接受新控制命令，关闭每个直接子节点的 stdin；子节点收到 EOF 后先在自己的 `session_shutdown` 中递归关闭直接孩子，再退出；父节点等待直接孩子退出。

SIGTERM 路径也注册了 shutdown handler；Windows 只注册 SIGTERM，非 Windows 另注册 SIGHUP：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:366)。但异常崩溃、强制 `process.exit`、断电或宿主被外部强杀不保证执行 extension hook。正常清理必须有超时和强制兜底，且“非持久化”不能被误解为操作系统自动保证绝无孤儿进程。

### 10. 公开 `RpcClient` 的可用范围

Pi 导出了 typed `RpcClient`、RPC 类型和 `runRpcMode`，它们属于包公共入口：[index.ts](D:/code/open-source/pi/packages/coding-agent/src/index.ts:333)。`RpcClient` 可以设置 `cwd/env/args`、发送 prompt/steer/abort、订阅 AgentSession events，并以 `agent_settled` 等待 idle：[rpc-client.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:28)、[rpc-client.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:454)。它可作为 RPC 编解码参考或基础组件。

但它不是现成的分层代理 supervisor：

- `start()` 固定执行 `node <cliPath> --mode rpc ...`，默认 `cliPath` 是相对的 `dist/cli.js`：[rpc-client.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:81)、[rpc-client.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:94)。独立发布扩展仍需可靠定位当前 Pi 启动方式。
- child 意外退出时，它会拒绝在途请求：[rpc-client.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:107)，但没有公开独立的 process-exit subscription，也没有代理树级故障传播。
- `stop()` 直接发 SIGTERM，1 秒后发 SIGKILL，只等待直接子进程 exit：[rpc-client.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-client.ts:145)。它不先关闭 stdin，也不管理后代进程树。
- `waitForIdle()` 只监听未来的 `agent_settled`；如果调用方错过该事件且未先核对状态，会等到超时。因此控制器仍需维护事件驱动状态，而不是把此 helper 当权威状态机。

结论是：可以复用其类型、JSONL 和请求关联思路，但规格不能直接写成“使用 `RpcClient` 即获得完整生命周期保证”。

### 11. Windows 级联终止

Pi 内部确实实现了跨平台 `killProcessTree(pid)`。Windows 分支启动 `taskkill /F /T /PID <pid>`；Unix 分支优先向负 PID 的进程组发 SIGKILL：[shell.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/shell.ts:197)、[shell.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/shell.ts:200)。内建 Bash 工具会跟踪自己的 PID，并在 abort 时调用这个整树终止函数：[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:108)、[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:111)。

这不能直接转化成目标扩展的保证：

- `killProcessTree` 与 detached-child tracker 没有从包公共入口导出；公共入口导出了 RpcClient 等 mode API，但没有这些 shell helpers：[index.ts](D:/code/open-source/pi/packages/coding-agent/src/index.ts:331)。
- Pi 只跟踪经内建 Bash 路径登记的进程。扩展自行 spawn 的长期 RPC 子节点不会自动加入 `trackedDetachedChildPids`：[shell.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/shell.ts:180)。
- Windows 的 taskkill 调用是 detached fire-and-forget，异常被忽略，不等待退出状态，也不验证结果：[shell.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/shell.ts:203)、[shell.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/shell.ts:209)。
- 官方 Subagent 示例同样只对直接子进程执行 `proc.kill("SIGTERM")`，超时后 `SIGKILL`，不是多层进程树方案：[index.ts](D:/code/open-source/pi/packages/coding-agent/examples/extensions/subagent/index.ts:399)。
- 指定提交中未发现 Windows Job Object 或“父进程死亡即由内核关闭整组进程”的实现。

所以 Windows 必须由扩展自建回收层：先逐层 EOF/优雅等待；超时后对仍存活的最高未退出子树根执行并等待 `taskkill /T /F`；确认 exit；记录无法回收的 PID 和错误。其他平台则需要显式创建和终止进程组。仅调用公开 `RpcClient.stop()` 不能作为“终止节点会可靠级联终止整个子树”的验收证据。

## 对规格的约束

### 可以直接依赖的 Pi 契约

1. 每个临时子代理可由一个 `pi --mode rpc --no-session` 进程承载，并在该进程存活期间连续保持上下文。
2. `send_message` 在扩展的单节点命令顺序域内先读取已确认状态：空闲发送 `prompt`，工作中或中断中发送 `steer`；无法确认交付时不得自动重发。底层 `prompt + streamingBehavior: "steer"` 仍是 Pi 协议能力，但不是本项目对公共 `RpcClient` 的依赖要求。
3. 命令 response 只表示接受；节点完整 settle 以 `agent_settled` 为准，并结合 `queue_update`、`get_state` 和 tool/message events 派生状态。
4. `--no-extensions -e <受控扩展>` 可以让中间节点只加载指定递归能力；达到最大深度时可以条件注册或过滤掉整套管理工具。
5. 根交互会话可以用现有 TUI widget/status/tool renderer 显示只读树视图。
6. `session_shutdown` 和 RPC stdin EOF 可以承载正常情况下的逐层优雅销毁。

### 扩展必须拥有的模块责任

1. **节点注册表**：维护 node ID、direct parent ID、depth、maxDepth、模板、RPC 连接、PID、状态、revision 和直接子节点集合。
2. **每节点 RPC 适配器**：严格 JSONL、请求 ID、每节点写串行化、接受与 settle 分离、超时、stderr、意外 exit 和 late event 处理。
3. **深度与授权守卫**：只允许直接父控制直接子；所有创建入口重复校验深度；树快照不得携带可用于越级控制的连接句柄或秘密。
4. **树状态协议**：中间节点把直接子状态与下游摘要合并后只向直接父上报；定义 schema version、revision、快照/增量、乱序和重同步行为。
5. **生命周期协调器**：停止接单、interrupt、graceful EOF、等待、超时、forced tree kill、退出确认和幂等清理。
6. **根只读投影**：把汇聚状态转换成稳定 TUI/工具输出，但不开放越级 mutation。

### 不能写入规格的错误假设

- “原生 `steer` 在空闲时会开始工作。”错误；它只入队。
- “RPC `prompt` 成功响应代表子代理任务完成。”错误；它只代表被接受或排队。
- “`agent_end` 代表节点已经完全空闲。”错误；retry、compaction 或 continuation 仍可能继续。
- “`abort` 会清除所有待处理消息。”错误；已有 steering/follow-up 可能随后继续。
- “Pi 的 `get_tree` 是代理树。”错误；它是单会话 entry tree。
- “`--no-session` 会自动关闭自动发现的扩展。”错误；扩展发现与会话持久化是两套开关。
- “公开 `RpcClient.stop()` 会在 Windows 可靠终止所有后代。”错误；它只操作直接子进程。
- “只隐藏 `spawn_agent` 就自然获得不可突破的 `maxDepth`。”错误；扩展仍需权威入口校验和明确错误。

### 研究产生的实现前决策点

以下问题已经足够明确，应在现有相关决策票中解决，或由地图维护者决定是否新建票；本研究不代替这些决定：

1. `interrupt_agent` 是弱中断，还是必须清队列并保持空闲；若为强中断，选择终止重建、内部兼容入口还是要求上游 `clear_queue`。
2. 树状态上报采用 `entry_appended` 组合方案，还是独立父子控制通道；对应的 revision、快照与重同步契约是什么。
3. 达到 `maxDepth` 的叶节点是不加载扩展，还是加载扩展但零管理工具；如何满足绕过能力发现时的稳定 `max_depth_reached`。
4. Windows 强制回收是调用并等待 `taskkill /T /F`，还是引入 Job Object；父进程崩溃时的孤儿进程保证达到什么级别。
5. 是否直接封装公开 `RpcClient`，还是实现专用 supervisor；最低要求必须包含可观测 exit、优雅 stdin EOF、每节点命令锁与进程树兜底。

最终判定：Pi 的 CLI、RPC、ExtensionAPI 与 TUI API 足以作为独立扩展的承载底座；“代理树控制面”不是 Pi 原生功能，必须由扩展明确设计。当前最需要独立兼容处理的不是模型调用，而是强中断、结构化树状态上报和跨平台进程树回收。
