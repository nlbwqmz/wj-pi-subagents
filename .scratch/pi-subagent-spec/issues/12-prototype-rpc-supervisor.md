# 确定 RPC 监督器与跨平台进程回收架构

Type: prototype
Status: resolved
Blocked by: 03, 04, 08, 11

## Question

扩展应封装 Pi 公开 `RpcClient`，还是实现专用 RPC 监督器，才能统一保证逐节点命令串行化、进程启动与退出观测、stdin EOF 优雅关闭、超时升级、子树级联终止，以及 Windows 和其他目标平台上的强制进程树回收？原型需要给出清晰模块责任和可测试接口，而不能依赖只终止直接子进程的默认行为。

## Answer

本票据冻结子代理 RPC 监督器的模块边界、启动/关闭阶段和可测试接口。原型位于 [RPC 监督器原型](../prototypes/rpc-supervisor-throwaway/README.md)，只使用 fake RPC、fake 进程树和 fake 父子通道验证阶段与竞态，不启动真实 Pi 进程。

总体采用“封装 Pi `RpcClient`，外加专用监督器”，不复制 Pi RPC 协议，也不修改 Pi 核心。监督器把 Pi 的任务语义和扩展需要的所有权、顺序、回收语义接在一起：

```text
AgentController
  ├─ RpcSupervisor           单个子代理的 RPC/进程生命周期与命令顺序
  │   ├─ RpcClient            Pi prompt、abort、get_state、事件解析
  │   ├─ ProcessTreeAdapter  Job Object / process group/session
  │   └─ SupervisorChannel    直接父子握手、快照、回复和关闭通知
  └─ TreeController           所有权、生命周期、配额、tree_revision 和 UI 快照
```

### 1. 模块职责

#### `AgentController`

- 为一个子代理维护 `agent_id`、直接父关系、有效授权、生命周期和子树控制器；
- 接受七个公开父会话工具，经参数、直接父权限、模板和配额校验后交给 `RpcSupervisor`；
- 以 03 号票据的状态代际和终止屏障裁决命令、Pi 事件和监督通道事件；
- 向 `TreeController` 发布安全状态和 `tree_revision`，不暴露进程句柄、端点或原始 RPC 事件。

#### `RpcSupervisor`

- 独占一个子代理的 Pi `RpcClient`、stdin/stdout 和进程句柄；
- 负责启动顺序、无副作用 RPC 就绪确认、任务 prompt/abort、RPC 事件单读者和回复组装；
- 为状态变更命令提供单一串行执行通道，并给每条内部命令分配请求号和阶段；
- 负责优雅关闭、清理期限、强制阶段调用和最终资源确认，但不自行裁决公开生命周期；
- 监督通道或进程故障时只向 `AgentController` 报告规范化事件，不自动重启或恢复节点。

#### `ProcessTreeAdapter`

- 把一个已经启动并纳入监督的节点及其后代绑定到平台进程树原语；
- Windows 首选专用 Job Object，Unix 类系统首选 process group/session；
- 提供优雅关闭、整树强制回收、退出等待、资源观察和句柄释放；
- 不让控制器读取 PID 或递归枚举进程，不把“已发出信号”当作“资源已回收”。

#### `SupervisorChannel`

- 实现 11 号票据规定的独立本地父子监督通道；
- 负责 `hello`/快照握手、`stream_id`、单向 `seq`、ACK、断序重同步、回复序号和关闭通知；
- 只向直接父控制器报告本节点和自身子树，不向模型暴露、不写入 Pi 会话条目；
- 启动/有限重同步窗口允许换新流，运行期故障后不通过重连恢复生命周期。

#### `TreeController`

- 维护代理树所有权、直接子代理计数、全树名额和原子 `tree_revision`；
- 合并直接子代理的最新安全快照，向 `get_agent_tree`、`Agents` widget 和 `/agent` 面板提供只读数据；
- 负责 UI-only 聚合通知，不发送模型消息；
- 不直接接触 Pi RPC、stdin/stdout、socket、管道、PID 或平台句柄。

模块之间禁止以下反向依赖：模型工具不能调用 `ProcessTreeAdapter`，树视图不能发送 RPC，子代理不能直接访问祖先控制器，平台适配器不能修改生命周期或配额。

### 2. 单节点命令串行化

每个 `RpcSupervisor` 只有一个状态变更执行通道：`prompt`、`abort`、优雅关闭和强制清理请求按控制器已经接纳的顺序协调；不同节点拥有不同通道，可以并行。`get_state`、等待者、事件观察和只读树快照不阻塞该通道，但只读取最近一致快照。

终止屏障建立后：

- 取消尚未写入 Pi RPC 的普通命令；
- 抢占未完成的协作式中断清理；
- 拒绝新的 prompt、steering、创建和普通控制命令；
- 已被 Pi 接受的消息不追溯撤回；
- 迟到 RPC 响应、Pi 事件和监督帧必须通过当前状态代际校验，不能回写旧状态。

同一目标的并发终止请求合并到一个清理流程；重复调用等待或返回该流程的同一结果。监督器是对应 RPC stdin/stdout 的唯一读写者，避免多个工具调用直接竞争 JSONL 流。

### 3. 启动阶段

监督器启动必须按以下顺序执行，且每一步失败都能回滚：

1. `TreeController` 原子预留直接子代理和全树名额，分配不可复用的 UUID v4 `agent_id`，登记 `starting`。
2. 创建本地父子监督端点和一次性凭据，准备固定 `cwd`、根环境快照、模板解析结果及内部元数据。
3. 先创建 Job Object 或 process group/session 归属，再启动 Pi 子进程，避免后代脱离监督范围。
4. 子控制器连接监督端点，完成协议版本、根会话、直接父标识、`agent_id` 和初始完整子树快照校验。
5. 启动 Pi `RpcClient`，完成无副作用 RPC 请求/响应，确认任务通道可通信。
6. 控制器同时确认监督通道和 Pi 任务通道就绪，记录 `created_at`，把节点从 `starting` 置为 `idle`；此刻才返回 `spawn_agent` 成功。

进程启动、Job Object/process group 绑定、扩展加载、监督握手、首个快照、RPC 就绪或启动期限任一步失败，都先记录启动诊断，再走 08 号票据的终止清理。清理确认后返回 `spawn_failed`/`spawn_timeout`；若残余资源无法确认则返回 `termination_incomplete`，保留失败节点和名额。失败 `agent_id` 不复用。

### 4. 任务事件归一化

`RpcSupervisor` 是 Pi RPC stdout 的唯一读取者，把原始事件映射为控制器可裁决的规范事件：

- `prompt` 获得接受确认后发布 `message_accepted`；空闲节点由控制器推进到 `working`，活动节点只增加 pending/steering 计数；
- `agent_settled` 发布 `settled`，它是 `working`/`interrupting` 回到 `idle` 的唯一正常边界；
- `agent_end`、turn/message 完成、abort 响应和工具取消回调只发布诊断阶段，不单独结束中断或发布资源回收；
- 工具开始/结束事件只生成有界的安全活动摘要，不携带工具参数、结果、路径或逐 token 内容；
- 普通 assistant 输出组装成带 `reply_seq` 的直接父子 `reply` 帧，父控制器按序注入并确认，重复回复不再次注入；
- Pi `get_state` 只用于启动同步、事件缺口后的异常重同步和故障诊断，不能在正常路径覆盖状态，也不能恢复已发布的 `failed`；
- RPC EOF、非法事件、协议损坏和进程退出映射到 `transport_failed`/`protocol_failed` 规范事件，由 `AgentController` 按当前终止屏障进入 `failed` 或终止流程。

监督器不把 Pi 原始事件写入 `entry_appended`，也不把控制事件转成 prompt；11 号票据的独立监督通道才是树状态和回复确认的控制载体。

### 5. 优雅关闭、强制阶段与资源确认

`terminate_agent` 或根关闭流程建立终止屏障后，`RpcSupervisor` 按 08 号票据执行：

1. 向子控制器发送关闭意图；子控制器先为自己的后代建立终止屏障，并停止向下创建和转发普通工作。
2. 对当前活动 Pi 会话发送 `abort`，等待 `agent_settled` 或明确进程退出；不把 abort 响应当作资源回收。
3. 取消尚未写入 RPC 的命令，保留已被 Pi 接受的消息用于收尾。
4. 发送 Pi RPC stdin EOF 或等价优雅关闭请求，等待子进程、监督通道和后代在内部优雅期限内退出。
5. 期限到达后调用 `ProcessTreeAdapter.forceTerminate()`，针对整个 Job Object 或 process group/session。
6. 调用 `waitForExit()`、`inspect()` 和监督通道确认，只有进程、IPC 端点、本节点和所有后代都已确认回收，才向控制器报告 `resources_confirmed`。

`ProcessTreeAdapter` 的生产实现和测试替身都遵循以下不透明接口（名称是规范职责，不限定 TypeScript 具体签名）：

```ts
interface ProcessTreeAdapter {
  attach(processHandle): Promise<ProcessTreeHandle>;
  requestGracefulClose(tree, signal): Promise<void>;
  forceTerminate(tree): Promise<void>;
  waitForExit(tree, deadline): Promise<ExitObservation>;
  inspect(tree): Promise<ResourceObservation>;
  release(tree): Promise<void>;
}
```

`ExitObservation`/`ResourceObservation` 必须能区分“已确认退出”“仍存在”和“无法确认”。监督器不读取 PID、不自行递归枚举进程，也不因成功发出终止信号而发布 `terminated`。无法确认时把安全节点标识和阶段交给控制器，由控制器保留 `terminating`/`termination_incomplete`。

### 6. 父子监督通道与重连

监督通道使用 11 号票据规定的本地可靠字节流和有界 JSON 帧，监督器负责传输生命周期但不拥有树权限：

- 启动握手或仍未判定故障的有限断序重同步窗口内，可以用新 `stream_id` 重新握手并发送当前完整快照；
- 运行期 EOF、身份不匹配、协议非法、快照校验失败或重同步期限耗尽后，监督器发布稳定故障，控制器进入 `failed`，不通过重连恢复；
- 终止屏障建立后拒绝新流，旧流的回复、快照和 ACK 全部按代际丢弃；
- 回复序号、子树修订和 ACK 只保留有界水位，不保存无限事件历史；
- 通道帧、端点、凭据、进程句柄和原始错误不进入模型、工具返回或 UI。

监督通道故障与 Pi 任务通道故障分别归一化，但最终都由同一 `AgentController` 状态代际裁决；一条通道健康不能覆盖另一条通道已经确认的终止屏障。

### 7. 测试替身和原型结论

实现阶段至少提供三个可注入替身：

- `FakeRpcClient`：模拟 prompt 接受、steering、`agent_settled`、abort、EOF、非法事件和迟到响应；
- `FakeProcessTreeAdapter`：模拟 Job Object/process group 的优雅退出、强制整树回收、孙进程残留、部分失败、重复回收和资源观察；
- `FakeSupervisorChannel`：模拟 hello/快照握手、重复帧、序号断档、重同步、新流、回复 ACK、EOF 和协议损坏。

原型至少推动以下场景并在每个动作后输出完整监督器状态：

1. 空闲 prompt、工作 steering、同节点命令串行和不同节点并行；
2. `working -> interrupting` 后只有 `agent_settled` 能回 `idle`；
3. 优雅关闭超时后强制整树回收，确认孙进程不会残留；
4. 父节点崩溃触发后代防孤儿清理；
5. 一个后代强制回收失败时兄弟继续终止、父节点保持 `terminating`；
6. 重复终止、重复 ACK、迟到 RPC 事件和旧 `stream_id` 幂等或安全丢弃；
7. 启动握手、首个快照或协议版本失败时完整回滚并返回正确错误码；
8. 根关闭在内部期限内完成或超期退出，均不提前释放未确认名额。

结论是：`RpcSupervisor` 复用 Pi 的任务和事件语义，扩展自己的控制器、父子监督通道和平台进程树适配器；所有命令按节点串行，终止具有优先级，启动与关闭均以资源观察确认为边界。该拆分能在不修改 Pi 核心的情况下实现跨平台整树回收，并可用 fake 适配器稳定复现所有竞态。

## Comments

<!-- 追加讨论历史。 -->

- 2026-08-05：用户确认监督器采用“封装 Pi `RpcClient`、由扩展补充专用监督器”的形态，不复制 Pi RPC 协议或修改 Pi 核心；监督器负责启动、命令串行、事件归一化、监督通道和资源清理，平台回收交给独立适配器。
- 2026-08-05：用户确认每个节点只有一个状态变更串行通道，终止屏障最高优先级；只读查询和不同节点可并行，迟到响应按状态代际丢弃，同一目标的重复终止合并幂等。
- 2026-08-05：用户确认优雅关闭顺序为终止屏障、后代屏障、abort、取消未写入命令、stdin EOF、内部期限等待、平台级整树强制回收和最终资源确认。
- 2026-08-05：用户确认 `ProcessTreeAdapter` 使用可注入的不透明树句柄，Windows Job Object、Unix process group/session 由平台实现负责，fake adapter 覆盖孙进程残留和部分回收失败，监督器不能自行递归 PID 或提前发布 `terminated`。
- 2026-08-05：用户确认启动必须先预留并登记、先绑定 OS 进程树监督、再建立父子握手和 Pi RPC，双通道就绪与首个快照成功后才进入 `idle`；任一失败统一回滚，失败标识不复用。
- 2026-08-05：用户确认监督器独占 Pi RPC 事件流，`agent_settled` 是唯一正常 settle 边界，工具事件只生成安全摘要，assistant 回复按 `reply_seq` 组装、上行和去重，迟到事件不能越过状态代际。
- 2026-08-05：用户确认监督通道只在启动或尚未判定故障的有限重同步窗口内允许新 `stream_id`；运行期故障后不自动恢复，终止屏障拒绝新流。
- 2026-08-05：用户确认原型和测试至少提供 fake RPC、fake 进程树和 fake 监督通道，覆盖串行命令、中断 settle、整树回收、防孤儿、部分失败、断序重同步、启动回滚和根关闭期限。
