# 25 - 闭合递归代理树、级联清理与根生命周期

Type: task

**What to build:** 在 24 号工单交付单节点纵向旅程后，补齐递归创建、能力衰减、只读树查询、同步级联终止、父故障防孤儿、根关闭和 reload 交接，形成一棵可长期运行且可完整回收的临时代理树。

Blocked by: 24 - 闭合受管 RPC 节点与直接父子控制旅程

Status: resolved

- [x] 让直接子代理在授权范围内递归调用整组管理工具；`maxDepth`、祖先 `subagents` 开关、直接父授权和两类配额只能保持或收窄，叶节点隐藏管理能力，绕过工具发现仍返回稳定深度错误。（REQ-018、REQ-030；AC-010、AC-017）
- [x] 交付 `get_agent_status` 与 `get_agent_tree`：按直接父/自身子树裁剪安全快照，保证父先、稳定创建顺序、全局深度、原子 `tree_revision` 和终止记录语义，不因查询触发 RPC、等待或状态变化。（REQ-001..003、REQ-030..031；AC-001、AC-017）
- [x] 交付 `terminate_agent` 的单次树线性化屏障和后代优先清理：取消未写命令、活动 abort、优雅关闭、内部期限、平台强制整树回收、资源确认和幂等合并；部分确认时释放已完成节点名额，未确认节点保留 `terminating`/`termination_incomplete`。（REQ-029、REQ-041..042；AC-016、AC-022）
- [x] 闭合运行故障、RPC/监督通道 EOF、非法事件、中间父故障、根退出/new/resume/fork/runtime 关闭和 reload 激活失败；不自动重启、不恢复、不复用身份，并确保无孤儿和未确认资源不提前释放。（REQ-003、REQ-017、REQ-043；AC-001、AC-023）

## Comments

<!-- 追加实现与审查记录。 -->

- 2026-08-06：按用户确认的批次范围，删除依赖真实 Windows、Pi 进程树和 Job Object 环境的测试任务；相关真实环境验证由人工完成，不作为本工单的代理任务项。

- 2026-08-06：完成递归代理树闭环。真实 child 扩展通过本地认证监督通道发布完整子树、直接回复和逐跳根权威请求；根权威唯一裁决身份、模板修订、全树配额、终止屏障与资源确认。`terminate_agent` 采用固定成员的后代优先清理，部分确认只释放已完成节点；中间父故障以平台进程树边界防止孤儿并保留故障父状态。根 `new`、`resume`、`fork`、`quit` 与跨扩展实例 reload 均闭合所有权，reload lease 协调已收口到独立模块。

- 2026-08-06：最终验证为 `npm run typecheck` 通过；`npm test` 共 200 项，195 通过、0 失败、5 项因当前平台为 Windows 而跳过的 Unix 原生测试；`git diff --check` 通过。纯逻辑、内存 fake 和监督协议测试覆盖树权威、能力衰减、快照裁剪、递归终止、故障及 reload。生产 bridge 成功旅程使用不会访问网络或模型的 fake `RpcClient`，但实际运行生产 bridge、Windows 本地 IPC、父/子监督协议、回复 ACK 与端点清理；它是 fake/协议集成，不是实际 Pi 或模型旅程。本机 5 项 Windows Job Object 原生测试实际运行通过，验证启动前归属、失败回滚、孙进程整树回收、优雅超时升级与未确认资源语义；这仍不等同于真实 Pi、真实模型和 Job Object 的完整组合旅程。

- 2026-08-06：第二轮双轴复审结果为 Spec 0 项发现；Standards 发现 1 项运行时职责发散判断项，已通过抽取 reload 交接协调模块修复并重新完成全量门禁。静态核查未发现调试标记、旧跨控制器注册表、伪回复命令、树控制兼容别名或生产伪 child 端点；系统临时目录无 `pi-subagent-local-*`、测试日志、调试缓存或 loader 中间产物残留。真实 Windows + Pi + 模型 + Job Object 组合继续由人工验证，未将其记录为自动测试通过。

- 2026-08-07：根据真实会话尾部的递归终止失败记录补齐回归：单节点监督器把“物理资源已确认、整树权威尚待提交”与真实 `termination_incomplete` 分离，`AgentController` 随后按固定屏障批量确认父节点及后代，避免父等子、外层又等监督器成功的循环依赖。同步修复 shutdown 与 in-flight spawn 的登记竞态，关闭开始后拒绝新创建并等待已接纳创建进入可回收集合。另按 Pi 真实 `session_shutdown(reload) -> oldRunner.invalidate() -> 新扩展加载` 顺序修正跨实例 reload：有界 transfer 同时发布到进程级共享 lease 注册表，不再依赖会被 invalidate 自动撤销的旧 EventBus 订阅；测试显式模拟旧 API 失效、递归 root/child 交接和 watchdog 清理。
