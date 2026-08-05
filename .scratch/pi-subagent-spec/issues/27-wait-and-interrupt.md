# 27 - 交付竞态安全的等待与协作式中断

**What to build:** 让父会话可以观察一个直接子代理的 settle、终态或超时，并请求它停止当前处理而保留节点与上下文继续工作。

**Blocked by:** 26 - 纵向打通父子消息、steering 与普通回复

**Status:** ready-for-agent

- [ ] `wait_agent` 只接受直接子代理和 `10000..600000` 的单次超时，采用原子检查、登记、再次检查，支持多个等待者共享同一事实。
- [ ] 等待 outcome 仅为 `settled`、`terminal`、`timeout`；`agent_settled` 是正常边界，`agent_end`、等待超时和查询都不改变节点状态或工作。
- [ ] `interrupt_agent` 对 `working` 立即接纳 RPC `abort` 并进入 `interrupting`，不等待响应、不清除已接受 steering、不释放名额，只有 `agent_settled` 才回到 `idle`。
- [ ] 对 idle、interrupting、failed、terminating、terminated 提供幂等结果；长期不 settle 时保持可观察状态并要求调用者显式终止。（REQ-023、REQ-027..028；AC-014、AC-015）

