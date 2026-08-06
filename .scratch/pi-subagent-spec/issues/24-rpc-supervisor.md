# 24 - 封装 Pi RPC 监督器与单节点命令顺序域

**What to build:** 让每个子代理由一个专用监督器统一管理 Pi RPC、父子监督通道、启动握手、任务事件和关闭顺序，同时允许不同节点并行工作。

**Blocked by:** 17 - 预构资源确认边界与可注入进程树替身；21 - 实现父子监督协议与安全子树汇聚

**Status:** needs-info

- [ ] 监督器封装 Pi `RpcClient`，独占对应 stdin/stdout，并把 prompt 接受、`agent_settled`、安全工具活动、回复、EOF 和协议故障归一化为控制器事件。
- [ ] 启动按预留登记、监督绑定、子控制器握手、首个快照、无副作用 RPC、双通道就绪的顺序执行；任何阶段失败都可回滚且不复用身份。
- [x] 单节点 prompt、steering、abort、优雅关闭和强制清理共用一个状态变更顺序域；终止屏障最高优先级，迟到响应按状态代际丢弃，同一节点之外允许并行。
- [x] 注入 `FakeRpcClient`、资源替身和监督通道替身，确定性覆盖启动超时、提前退出、settle 竞态、EOF、非法事件和命令串行。（REQ-038..040；AC-012、AC-021）

## Comments

- 2026-08-06：已在 `src/rpc-supervisor.ts` 实现监督器核心、Pi 公共命令适配层和 `FakeRpcClient`，并在 `test/rpc-supervisor.test.ts` 覆盖启动回滚、单节点串行、跨节点并行、settle 竞态、安全事件归一化、运行故障、终止屏障、内部清理期限、后代资源确认和释放失败重试。`src/tree-controller.ts` 同步允许 `interrupting` 状态中的 steering 接受事实清零 pending。
- 2026-08-06：双轴审查发现并已修复三项行为缺陷：后代未终止时误报监督器成功、终止屏障后的迟到 prompt 仍返回 accepted、abort 响应占住命令通道；另补齐底层关闭调用不返回时的内部期限保护。最终完整测试 114 项，其中 109 通过，5 个 Unix 原生场景在当前 Windows 平台按既有条件跳过；类型检查通过。
- 2026-08-06：生产装配仍需架构决策。当前 Pi `0.83.0` 的公共 `RpcClient.start()` 固定自行 `spawn` 子进程，不接受外部 transport，也不公开独立进程退出订阅；本仓库 Windows/Unix 平台适配器的 `attach()` 则会先启动另一受管进程。直接组合两者会使受管进程与 RPC 进程不一致，并丢弃平台适配器返回的 transport，不能满足本 Issue 前两项和 AC-021。代码已用 `RpcSupervisorClient.process_binding: "managed"` 阻止直接命令适配器被误作完整生产绑定。
- 2026-08-06：需要确认后续方向后才能解决本 Issue：其一是在 Pi 公共 `RpcClient` 增加可注入 spawn/transport/退出观察能力；其二是在本仓库增加一个先进入 Job Object/process group、再于内部托管 Pi `RpcClient` 的受管桥接进程。后者会新增一层本地控制协议和常驻进程，属于实质架构扩展，未在缺少决策时自行引入。
