# 建模子代理生命周期与状态转换

Type: prototype
Status: resolved
Blocked by: 01, 02

## Question

用可评审的状态转换表或最小行为模型确定子代理从创建、启动、空闲、处理消息、中断、失败到终止的完整状态机，以及各状态允许的父会话操作、RPC 事件与工具结果边界；该模型必须能区分“中断当前处理但保留子代理”和“永久终止子代理及其子树”。

## Answer

本票据确定采用七态、事件驱动且终止优先的子代理生命周期。最小行为模型已落在 [子代理生命周期状态机原型（THROWAWAY）](../prototypes/lifecycle-state-machine-throwaway/README.md)；原型只验证状态与竞态，不启动真实 Pi RPC 进程，也不作为生产实现。

### 状态定义与权威来源

公开状态只允许以下七种：

| 状态 | 精确定义 | 是否接受新父子消息 | 是否占直接子代理名额 |
| --- | --- | --- | --- |
| `starting` | 已登记节点并预留名额，正在启动进程和完成 RPC 握手 | 否 | 是 |
| `idle` | RPC 可通信，当前没有活动处理 | 是 | 是 |
| `working` | 当前 prompt 已被 Pi 接受并处于一次活动处理内 | 是，作为 steering | 是 |
| `interrupting` | 协作式中断意图已接纳，但尚未收到最终 `agent_settled` | 是，排在中断之后 | 是 |
| `failed` | 终止意图建立前发生不可自动恢复的运行或控制面故障 | 否 | 是 |
| `terminating` | 终止意图已不可逆生效，但目标子树资源尚未全部确认回收 | 否 | 是 |
| `terminated` | 目标及其后代的终止和资源回收均已确认 | 否 | 否 |

`failed` 与 `terminated` 是 `wait_agent` 的稳定终态；`terminating` 虽然不可逆，但资源仍可能存在，因此不是等待终态。`queued`、`running`、`exited` 和底层 RPC 事件名都不得成为额外公开状态；队列用计数表示，意外退出归入 `failed`，终止流程中的预期退出归入 `terminated`。

公开状态由“控制器已经接纳的意图”和“Pi 或资源监督器已经确认的事实”共同驱动。Pi `get_state` 只用于启动同步或检测到事件缺口后的异常重同步，不能在正常路径覆盖事件驱动状态，更不能把已公开的 `failed` 恢复为工作状态。

### 状态转换表

| 当前状态 | 触发条件 | 下一状态 | 关键约束 |
| --- | --- | --- | --- |
| 无节点 | 原子预留名额、分配不可复用 `agent_id` 并登记关系 | `starting` | 登记先于进程启动，树视图可观察启动窗口 |
| `starting` | RPC 握手完成且确认可通信 | `idle` | `spawn_agent` 只有到达这里才成功返回 |
| `starting` | 启动、提前退出、握手、协议或启动期限失败 | `failed -> terminating` | 先留下故障转换记录，再自动清理；资源确认后进入 `terminated` |
| `idle` | prompt 获得 RPC 接受确认 | `working` | 接受前不得提前改变状态 |
| `working` | 新 steering 获得 RPC 接受确认 | `working` | 只更新消息计数，不新建 `queued` 状态 |
| `working` | `agent_settled` | `idle` | `agent_end`、turn/message/tool 结束均不能代替 settle |
| `working` | 控制器接纳协作式中断 | `interrupting` | 工具立即返回，不等待 `abort` 响应 |
| `interrupting` | `abort` 响应、`agent_end` 或取消回调 | `interrupting` | 已接受 steering 仍可能继续执行 |
| `interrupting` | `agent_settled` | `idle` | 这是协作式中断唯一的正常完成边界 |
| `starting`、`idle`、`working`、`interrupting` 或 `failed` | 终止屏障被接纳 | `terminating` | 终止不可逆，并原子覆盖全部已登记后代 |
| `starting`、`idle`、`working` 或 `interrupting` | 进程退出、RPC 断开或协议状态无法可信恢复 | `failed` | 不自动重启，不复用原 `agent_id` |
| `failed` | 迟到的正常 RPC 事件或 `get_state` | `failed` | 只允许查询、等待或显式终止，不允许恢复 |
| `terminating` | 优雅与强制阶段后仍有资源无法确认退出 | `terminating` | 附带 `termination_incomplete`，终止屏障继续生效 |
| `terminating` | 本节点资源已确认回收，且全部后代已是 `terminated` | `terminated` | 父节点必须后于后代确认终止 |
| `terminated` | 任意迟到事件或重复终止 | `terminated` | 保留会话内终止记录，身份不复用 |

如果进程退出先于终止屏障在线性化顺序上提交，则先进入 `failed`，随后显式终止再进入 `terminating`；如果终止屏障先提交，后续退出属于终止流程，不得再产生 `failed`。

### 父会话工具操作矩阵

下表描述调用者已经通过参数、直接父子授权和工具可见性校验后的状态行为：

| 目标状态 | `send_message` | `wait_agent` | `interrupt_agent` | `terminate_agent` | 状态与树查询 |
| --- | --- | --- | --- | --- | --- |
| `starting` | `agent_unavailable` | 等待 `idle`、终态或超时 | `agent_unavailable` | 建立屏障并取消启动 | 允许 |
| `idle` | RPC 接受后转 `working` | 立即返回 `settled` | 幂等成功，`changed: false` | 转 `terminating` | 允许 |
| `working` | 接受 steering，保持 `working` | 等待 settle、终态或超时 | 转 `interrupting` | 转 `terminating` | 允许 |
| `interrupting` | 排在中断之后，接受后仍保持 `interrupting` | 等待 settle、终态或超时 | 幂等成功，`changed: false` | 抢占并转 `terminating` | 允许 |
| `failed` | `agent_unavailable` | 立即返回 `terminal` 并附故障 | 幂等成功，`changed: false` | 转 `terminating` 并清理 | 允许 |
| `terminating` | `agent_unavailable` | 等待 `terminated` 或超时 | 幂等成功，`changed: false` | 合并并等待同一终止流程 | 允许 |
| `terminated` | `agent_unavailable` | 立即返回 `terminal` | 幂等成功，`changed: false` | 幂等成功，`changed: false` | 允许读取终止记录 |

`get_agent_status` 仍只允许父会话查询直接子代理；`get_agent_tree` 仍按调用者身份裁剪，不因本矩阵扩大权限。`spawn_agent` 不针对既有目标状态：只有调用者尚未进入关闭屏障、`depth < maxDepth` 且名额可用时才能登记新的 `starting` 节点。达到最大深度的节点仍隐藏全部七个管理工具，服务端限制不因能力发现结果而取消。

### 消息接受、待处理计数与交付不确定性

`pending_message_count` 是控制器权威派生值，统计“已经被控制器受理，但尚未开始实际处理”的父子消息，统一覆盖控制器本地等待队列和 Pi steering 队列：

- 当前活动 prompt 不计入，因此 `working` 可以同时具有 `pending_message_count: 0`。
- 消息通过参数、权限和状态校验并进入节点串行通道时加一；从控制器队列迁移到 Pi 队列时仍是同一条消息，不重复计数。
- 消息成为活动 prompt、Pi 确认从队列取出、明确拒绝、交付失败，或在写入前被终止屏障取消时减一。
- `failed` 与 `terminated` 必须归零。`terminating` 立即取消控制器尚未写入的消息，但可暂时保留 Pi 已接受且尚未确认消费的消息，资源回收后归零。
- 计数不暴露正文或消息标识，也不直接驱动生命周期；每次公开计数变化都递增节点 `revision`。

控制调用结果与节点健康相互独立：

- 能证明消息未被接受且 RPC 节点仍健康时，`send_message` 返回 `message_delivery_failed`，移除该待处理消息，节点保持原状态。
- 接受状态未知但连接仍可观察时，返回不可自动重试的 `message_delivery_failed`，内部保留未决交付；后续 message/queue/settle 事件或异常重同步负责消解，不能自动重发以免重复执行。
- 只有确认进程、RPC 或协议状态已无法继续可信使用时，节点才进入 `failed`。
- 已经返回 `{ accepted: true }` 的消息，后续模型、工具或进程失败只影响节点状态和回复流，不得反向修改原工具结果。

### `wait_agent` 的完成与竞态边界

等待器使用原子的“检查当前状态、登记等待、再次检查”流程，避免错过恰好同时到达的 settle 或终态事件；多个等待器可以被同一事件完成。

| 当前或后续状态 | 等待结论 |
| --- | --- |
| 调用时已经 `idle`，或 `starting` 完成握手进入 `idle` | `settled` |
| `working` 或 `interrupting` 收到 `agent_settled` | `settled` |
| 调用时已经或等待期间进入 `failed`、`terminated` | `terminal` |
| `terminating` | 继续等待资源确认；期限到达时为 `timeout` |
| 期限先于上述事件提交 | `timeout` |

`outcome` 锁定结束本次等待的触发原因；结果中的 `state`、`revision` 和 `observed_at` 则取生成结果前控制器持有的最新一致快照。因此并发新消息可以产生合法的 `outcome: "settled", state: "working"`；等待因 `failed` 完成后若并发终止已经开始，也可以产生 `outcome: "terminal", state: "terminating"`。首版不增加触发事件修订号，调用者通过返回修订号或再次查询判断新鲜度。

超时与 settle/终态事件在同一顺序点裁决，先提交者决定唯一 `outcome`。超时只结束观察窗口，绝不改变节点、中断当前处理或升级为终止。

### 命令、事件与迟到响应的顺序规则

每个节点的状态变更命令和会改变公开状态的事件必须进入同一个控制器顺序域；不同节点仍可并行。节点维护内部状态代际或命令序号，只有与当前代际和状态兼容的事件才能改变公开快照。

终止屏障拥有最高优先级：

- 屏障接纳后，旧 `agent_settled`、`agent_end`、queue 事件和 RPC 响应不能把节点恢复为 `idle`、`working` 或 `interrupting`。
- 屏障取消所有尚未写入 RPC 的普通命令；已经被 Pi 接受的消息不追溯撤回。
- 并发终止合并到同一清理流程；已 `terminated` 的重复调用直接幂等成功。
- 被忽略的迟到事件不增加节点 `revision`。若事件只更新仍有诊断价值的可见元数据，则只更新该元数据，仍不得跨越状态守卫。

`agent_end`、`abort` 成功响应、工具取消回调和局部 message/turn 结束都不是 settle 边界。中断长期不响应时保持 `interrupting`；父会话需要保证停止时必须显式使用终止。

### 启动失败、运行故障与所有者结束

创建时先分配不可复用的 `agent_id`、登记 `starting` 并原子预留名额。启动或握手失败采用以下路径：

```text
starting -> failed -> terminating -> terminated
```

控制器先记录 `spawn_failed` 或 `spawn_timeout` 故障，再自动建立清理屏障。`spawn_agent` 只有在残留资源已经确认回收、名额释放后，才以原始 `spawn_failed` 或 `spawn_timeout` 返回；错误 `details.agent_id` 可以暴露该诊断身份，但它不是可工作的代理。若清理无法确认，则节点保持带 `termination_incomplete` 的 `terminating`、名额不能提前释放，并由 `spawn_agent` 返回顶层 `termination_incomplete`，在安全诊断详情中保留原始启动错误和 `agent_id`。

运行期意外退出或 RPC/协议故障在必要的短暂重同步后进入稳定 `failed`。控制器不自动重启、不复用身份，也不允许后续 `get_state` 或迟到事件恢复节点。父会话可以查询、等待或显式终止；只有确认进入 `terminated` 后才释放名额。

终止被接纳时，控制器在一个原子树修订中固定目标及全部已登记后代，对所有未终止节点建立屏障并转为 `terminating`。并发子节点登记在线性化顺序上若先完成则纳入本次子树，若落后于屏障则拒绝，不能形成逃逸节点。实际确认采用后代优先顺序；只要任何后代尚未 `terminated`，父节点就不能确认 `terminated`。

根会话退出、`new`、`resume`、`fork`、`reload` 或扩展 runtime 关闭时，自动对所有直接子代理启动同一套级联终止，无需用户逐个调用工具。中间节点意外崩溃时，该节点先保留为 `failed`，监督器只对其后代自动建立防孤儿终止屏障；故障父节点继续占用其直接父会话名额，直到直接父会话显式终止。根会话清理结束后释放所有终止记录，不跨会话恢复。

### 修订号、时间与当前故障

- 节点的公开状态、`pending_message_count` 或当前 `error` 发生真实变化时，节点 `revision` 单调递增；内部句柄、命令阶段或被忽略事件变化不递增。
- `observed_at` 使用控制器接受该公开变化时的 UTC RFC 3339 毫秒时间，只表示新鲜度；状态顺序始终由 `revision` 判断。
- 原子级联终止中的所有节点变化属于同一个树修订，节点仍分别递增自己的 `revision`。
- `data.error` 表示当前故障而不是历史列表：`failed` 必须携带；发生 `termination_incomplete` 的 `terminating` 必须携带；成功进入 `terminated` 后省略。历史故障留在工具错误详情、状态转换轨迹或内部日志中。

### 原型验证结论

原型将纯状态机与终端外壳分离，可用以下命令人工推动或运行内置场景：

```powershell
node .scratch/pi-subagent-spec/prototypes/lifecycle-state-machine-throwaway/tui.mjs
node .scratch/pi-subagent-spec/prototypes/lifecycle-state-machine-throwaway/tui.mjs --demo
```

在 Node.js `v22.21.1` 下完成了以下验证：

- `machine.mjs` 与 `tui.mjs` 均通过 `node --check`。
- 内置演示完整执行启动、消息接受、中断、等待竞态、迟到事件、终止未完成、启动超时、未知交付、原子级联和防孤儿清理路径。
- 实际模型得到 `outcome: "settled", state: "working"` 的等待竞态组合；迟到 `agent_settled` 在 `terminating` 被忽略；`termination_incomplete` 保持终止屏障和故障；启动超时形成 `starting -> failed -> terminating`；中间节点崩溃时父节点保留 `failed`、后代进入 `terminating`。
- 原子级联演示中父子节点在同一个 `tree_revision` 进入 `terminating`，且后代未终止前尝试确认父节点资源回收会被拒绝。
- 交互入口通过管道逐行执行 `add`、`handshake`、`matrix`、`quit`，验证了一条命令启动和逐动作完整状态渲染。

结论是：七态模型能够闭合本票据要求的正常、故障、中断和永久终止路径；无需增加公开 `queued`、`exited`、`cancelling` 或 `unknown` 状态。实现阶段应保留本答案中的状态守卫和线性化边界，但不得直接复制 throwaway TUI 作为生产代码。

## Comments

- 2026-08-04：用户确认公开生命周期状态固定为 `starting`、`idle`、`working`、`interrupting`、`failed`、`terminating`、`terminated`；不公开 `queued` 或 `exited`，分别用待处理消息计数和 `failed`/`terminated` 结果表达。
- 2026-08-04：用户确认公开状态由“控制器已经接纳的意图”与“Pi 或资源监督器已经确认的事实”共同驱动：登记节点进入 `starting`；RPC 握手完成且确认可通信后进入 `idle`；`prompt` 获得 RPC 接受后进入 `working`；中断请求被控制器接纳后立即进入 `interrupting`；只有 `agent_settled` 能把活动节点推进回 `idle`，`agent_end` 不能；终止屏障被控制器接纳后立即进入 `terminating`；资源回收得到确认后进入 `terminated`；意外退出以及 RPC/协议故障进入 `failed`。
- 2026-08-04：用户确认 Pi `get_state` 只用于启动同步或检测到事件缺口后的异常重同步，不能在正常路径覆盖事件驱动的公开生命周期；每次公开状态或其他可见状态元数据发生变化时，节点 `revision` 都必须单调递增。
- 2026-08-04：用户确认创建时先分配不可复用的 `agent_id`，登记 `starting` 并原子预留直接子代理名额；启动、握手或启动期限失败时先记录 `failed` 故障，再自动转入 `terminating` 执行清理，资源回收确认后转为 `terminated` 并释放名额；`spawn_agent` 只在清理确认后返回 `spawn_failed` 或 `spawn_timeout`，终止记录保留至根会话结束，诊断可携带 `details.agent_id` 但该节点不可继续操作。
- 2026-08-04：用户确认终止清理在优雅关闭和强制回收后仍无法确认部分资源退出时，已确认回收的节点可先进入 `terminated`，目标以及仍有未确认资源的相关节点保持 `terminating` 并附带 `termination_incomplete` 故障；终止工具返回顶层错误，终止屏障持续生效，未终止节点继续占名额；后续幂等终止重试确认全部资源后才进入 `terminated`。`failed` 保留给终止意图建立前的意外运行故障。
- 2026-08-04：用户确认运行期节点意外退出或发生无法继续通信的 RPC/协议故障时，在必要的短暂重同步后进入稳定的 `failed`；控制器不自动重启、不复用原 `agent_id`，已公开为 `failed` 后也不能由 `get_state` 恢复为 `idle` 或 `working`。故障节点拒绝新消息，但仍可查询、等待和显式终止；在 `terminate_agent` 确认资源回收前继续占直接子代理名额，随后经 `terminating` 进入 `terminated` 并释放名额。
- 2026-08-04：用户确认级联终止被接纳时，控制器在一个原子树状态变更中固定目标及其全部已登记后代，并为所有尚未终止的节点同时建立终止屏障、转为 `terminating`；与之并发的子节点登记若先完成则纳入本次终止，若在线性化顺序上落后则拒绝，不能形成逃逸进程。资源清理按后代优先、父节点最后确认；已终止记录不变，全部后代确认回收后目标才能进入 `terminated`。
- 2026-08-04：用户确认协作式中断被接纳后立即进入 `interrupting`；`abort` RPC 成功响应、`agent_end` 或工具取消回调都不能结束该状态，Pi 已接受的 steering 即使随后继续执行也仍保持 `interrupting`。只有 `agent_settled` 能转回 `idle`；此前若出现进程退出、RPC 断开、协议错误或中断命令无法交付则进入 `failed`，不能退回 `working`；长期不 settle 时持续保持 `interrupting`，直到父会话显式终止。
- 2026-08-04：用户确认每个节点使用控制器状态代际/命令序号裁决乱序与迟到事件；事件只有与当前代际和状态兼容时才能改变公开状态。终止屏障优先于旧 `agent_settled`、`agent_end`、队列事件和 RPC 响应，屏障后的进程退出属于终止流程；意外退出若先线性化则先进入 `failed`，再由显式终止推进。`failed` 发布后迟到正常事件不得恢复节点；被忽略的事件不制造较低或虚假的 `revision`，只有真实可见元数据变化才递增修订号。
- 2026-08-04：用户确认 `starting` 状态允许 `get_agent_status`、`get_agent_tree` 只读观察和 `wait_agent` 等待启动结果；`send_message`、`interrupt_agent` 返回 `agent_unavailable`，取消创建必须使用 `terminate_agent`。终止可在握手前建立屏障并清理节点；`spawn_agent` 必须等 RPC 握手完成、确认可通信且节点进入 `idle` 后才成功返回，绝不以 `starting` 作为成功结果。
- 2026-08-04：用户确认 `wait_agent` 的稳定终态只有 `failed` 与 `terminated`，均立即返回 `outcome: "terminal"`，前者必须附带 `data.error`、后者不附错误；`terminating` 不是终态，继续等待资源回收确认，期限内未完成则返回 `timeout` 并保留状态及终止故障。`idle` 立即返回 `settled`；`working`、`interrupting` 等待 `agent_settled`；`starting` 等待握手进入 `idle` 后返回 `settled`，启动失败或被终止则返回 `terminal`；任何超时都不改变节点。
- 2026-08-04：用户确认 `pending_message_count` 统计已被控制器受理但尚未开始实际处理的父子消息，统一覆盖控制器本地等待队列与 Pi steering 队列，当前活动 prompt 不计入且跨队列迁移不重复计数。消息进入节点串行通道时加一，转为活动处理、确认消费、交付失败、明确拒绝或在写入前被终止屏障取消时减一；`failed` 与 `terminated` 必须归零，`terminating` 只暂时保留已被 Pi 接受但尚未确认消费的消息，最终终止归零。计数不暴露正文或标识、不驱动生命周期，但每次变化都递增节点 `revision`。
- 2026-08-04：用户确认 `send_message` 的工具结果与节点健康相互独立：只有 RPC 明确接受 prompt 后，空闲节点才进入 `working`，活动节点被接受的 steering 只更新计数而不改变生命周期。能够证明未接受且节点仍健康时返回 `message_delivery_failed`、移除待处理记录并保持原状态；接受状态未知但连接仍可观察时返回不可自动重试的同码错误，不立即置为 `failed`，而由后续事件或重同步消解内部未决交付。只有确认进程、RPC 或协议状态无法继续可信使用时才进入 `failed`；已经返回 `accepted: true` 的结果不因后续执行失败而回写。
- 2026-08-04：用户确认 `wait_agent` 使用原子的检查、登记、复查流程避免丢失事件，多个等待器可由同一事件完成；`outcome` 锁定结束等待的触发原因，返回的 `state`、`revision`、`observed_at` 则取结果生成前的最新一致快照，因此允许 `settled + working` 或 `terminal + terminating` 等并发推进组合。超时与事件按同一顺序点裁决，先提交者决定唯一结果；首版不增加触发事件修订号或时间字段，调用方通过返回修订号或再次查询判断新鲜度。
- 2026-08-04：用户确认根会话退出、切换会话或扩展 runtime 关闭时，控制器无需用户逐个调用工具即对全部直接子代理建立终止屏障并级联清理全树；正常终止的中间节点与后代属于同一终止流程。中间节点意外崩溃时先进入并保留 `failed`，监督器自动对其全部后代建立防孤儿终止屏障，使后代终止；故障父节点本身继续占名额，直到直接父会话显式终止。根会话清理完成后释放全部终止记录且不跨会话保存，具体进程回收机制由 08、12 号票据细化。
- 2026-08-04：用户最终确认七态工具操作矩阵：`starting` 只允许观察、等待和终止；`idle`、`working`、`interrupting` 按消息接受与 settle 规则推进；`failed`、`terminating`、`terminated` 拒绝新消息但保留查询、等待和幂等中断/终止语义。当前故障只在 `failed` 或发生 `termination_incomplete` 的 `terminating` 中公开，成功 `terminated` 省略错误。
- 2026-08-04：throwaway 原型已完成并验证 26 个演示动作；确认等待结果可出现 `settled + working`、终止屏障忽略迟到 settle、未知交付不等于节点故障、启动失败自动清理、级联终止同树修订且父节点后于后代确认，以及中间节点崩溃后的防孤儿清理。
