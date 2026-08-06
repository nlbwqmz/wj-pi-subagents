# 24 - 闭合受管 RPC 节点与直接父子控制旅程

Type: task

**What to build:** 交付一个真正可启动的受管 RPC 节点，并以它纵向闭合 `spawn_agent`、父子消息、回复、等待和协作式中断。一个受管节点必须把平台进程树、桥接进程和 Pi 公共 `RpcClient` 绑定在同一启动事务中；不同节点仍可并行，单节点命令仍由唯一顺序域协调。

Blocked by: 17 - 预构资源确认边界与可注入进程树替身；19 - 发布可信代理模板发现快照；20 - 建立代理树身份、七态生命周期与配额内核；21 - 实现父子监督协议与安全子树汇聚；22 - 实现 Windows Job Object 进程树适配器

Status: ready-for-agent

- [ ] 把现有监督器的外部接口收敛为 `ManagedRpcNode`：`ProcessTreeAdapter.launch()` 先启动包内受管桥接进程，桥接进程内部独占 Pi 公共 `RpcClient`；桥接与 Pi RPC 子进程继承同一 Job Object/process group，监督器不再分别接收客户端和树句柄。
- [ ] 为桥接协议提供固定长度边界、一次性认证、有限命令/事件集合和故障观察；只转发高层命令与安全事件，不复制 Pi JSONL，不允许第二个模块直接读写同一 RPC 流。（REQ-038、REQ-039、AC-021）
- [ ] 启动按预留登记、平台树绑定、桥接握手、父子监督握手、首个快照、无副作用状态请求、双通道就绪的顺序执行；任何阶段失败都可回滚且不复用身份。
- [x] 单节点 prompt、steering、abort、优雅关闭和强制清理共用一个状态变更顺序域；终止屏障最高优先级，迟到响应按状态代际丢弃，同一节点之外允许并行。
- [x] 注入 `FakeRpcClient`、资源替身和监督通道替身，确定性覆盖启动超时、提前退出、settle 竞态、EOF、非法事件和命令串行。（REQ-038..040；AC-012、AC-021）
- [ ] 将 `spawn_agent` 接入模板快照、能力/模型/配额预检和真实受管节点启动；只有监督握手、首个快照和 RPC 就绪后才返回 `idle` 与 canonical UUID，启动失败区分清理完整与不完整。（REQ-015..016、REQ-025；AC-009、AC-012）
- [ ] 将 `send_message`、直接回复、`wait_agent` 和 `interrupt_agent` 接入同一节点顺序域：空闲 prompt、工作 steering、settled 边界、reply ACK/去重、未知交付不得重发，协作式中断保留节点和上下文。（REQ-026..028、REQ-036；AC-013、AC-014、AC-015、AC-020）
- [ ] 在 Windows 完成受管节点的真实子进程/孙进程归属、启动回滚、双握手、直接父子六段旅程和无孤儿验证；macOS/Linux 只运行代码、类型、纯逻辑和 fake 测试，不把 Unix 原生测试列为本工单通过条件。

## 计划决策

采用 [ADR-0001](../../../docs/adr/0001-managed-rpc-bridge.md) 的受管 RPC 桥接进程方案。直接修改 Pi `RpcClient` 会越过独立扩展边界，复制 Pi JSONL 会造成协议分叉；桥接方案增加一个本地进程和有界协议，但能让平台树适配器在进程启动前完成归属，并保证监督器拿到的 RPC 命令面与资源句柄来自同一节点。

## Comments

- 2026-08-06：已在 `src/rpc-supervisor.ts` 实现监督器核心、Pi 公共命令适配层和 `FakeRpcClient`，并在 `test/rpc-supervisor.test.ts` 覆盖启动回滚、单节点串行、跨节点并行、settle 竞态、安全事件归一化、运行故障、终止屏障、内部清理期限、后代资源确认和释放失败重试。`src/tree-controller.ts` 同步允许 `interrupting` 状态中的 steering 接受事实清零 pending。
- 2026-08-06：双轴审查发现并已修复三项行为缺陷：后代未终止时误报监督器成功、终止屏障后的迟到 prompt 仍返回 accepted、abort 响应占住命令通道；另补齐底层关闭调用不返回时的内部期限保护。最终完整测试 114 项，其中 109 通过，5 个 Unix 原生场景在当前 Windows 平台按既有条件跳过；类型检查通过。
- 2026-08-06：生产装配仍需架构决策。当前 Pi `0.83.0` 的公共 `RpcClient.start()` 固定自行 `spawn` 子进程，不接受外部 transport，也不公开独立进程退出订阅；本仓库 Windows/Unix 平台适配器的 `attach()` 则会先启动另一受管进程。直接组合两者会使受管进程与 RPC 进程不一致，并丢弃平台适配器返回的 transport，不能满足本 Issue 前两项和 AC-021。代码已用 `RpcSupervisorClient.process_binding: "managed"` 阻止直接命令适配器被误作完整生产绑定。
- 2026-08-06：需要确认后续方向后才能解决本 Issue：其一是在 Pi 公共 `RpcClient` 增加可注入 spawn/transport/退出观察能力；其二是在本仓库增加一个先进入 Job Object/process group、再于内部托管 Pi `RpcClient` 的受管桥接进程。后者会新增一层本地控制协议和常驻进程，属于实质架构扩展，未在缺少决策时自行引入。
- 2026-08-06：计划重排已选择第二条路径并记录在 [ADR-0001](../../../docs/adr/0001-managed-rpc-bridge.md)。本工单不再等待用户补充信息，改为 `ready-for-agent`；后续实现必须先闭合 `ManagedRpcNode` 这一深模块，再沿同一接口交付直接父子旅程。当前验收只执行 Windows，Unix 原生测试延期。
