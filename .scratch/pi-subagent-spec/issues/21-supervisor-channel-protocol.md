# 21 - 实现父子监督协议与安全子树汇聚

**What to build:** 让每条直接父子关系拥有独立、可认证、可重同步且有界的监督通道，用于传播生命周期和完整子树快照，同时不把控制帧带入模型上下文。

**Blocked by:** 20 - 建立代理树身份、七态生命周期与配额内核

**Status:** resolved

- [x] 监督帧采用带长度边界的 UTF-8 JSON，校验协议版本、根关联、直接父子身份、深度、目标和一次性本地凭据；任务 RPC 与监督通道保持隔离。
- [x] 每个流从随机 `stream_id`、单向 `seq=1` 和根内唯一 `request_id` 开始；重复帧只回 ACK，断序触发一次完整快照 reset，旧流和屏障后的帧全部丢弃。
- [x] 子控制器只上报自身作用域的完整安全快照和有序回复；父控制器按 `subtree_revision` 原子替换缓存并分配 `tree_revision`，不保存无限事件日志。
- [x] 固定帧、字符串、节点和回复窗口上限，超限按协议故障处理；凭据、端点、序号、正文、工具参数/结果和原始异常不进入工具、UI 或模型。
- [x] `FakeSupervisorChannel` 测试覆盖握手、身份篡改、重复/断序、重同步、回复确认、EOF、损坏载荷和有界状态。（REQ-033..037；AC-019、AC-020、AC-026）

## Answer

已实现独立的 `SupervisorChannel` 与可手工 pump、丢帧、重排、篡改和 EOF 的
`FakeSupervisorChannel`。协议使用四字节长度前缀 UTF-8 JSON、严格的握手/快照
校验和安全事件白名单；父端只原子替换完整安全子树并公开 `tree_revision`。

每个根会话由 `SupervisorRequestIdRegistry` 提供常数内存的唯一请求号分配；EOF 后
端点进入有限 `resyncing` 窗口，以新流重新握手和首快照确认，未确认回复仅在该确认
后按 `reply_seq` 重放。首快照的传输 ACK 是 child 进入 `ready` 的唯一协议门槛，回复
注入失败不会错误生成 reply ACK。旧流集合达到固定容量时关闭重连窗口，避免淘汰旧流后
被重新接受。

验证：`npm run check` 通过（84/84），`git diff --check` 通过。
