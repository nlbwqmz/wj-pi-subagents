# 28 - 交付递归创建、能力衰减与只读树查询

**What to build:** 让子代理在授权范围内创建下一层子代理，同时让根和普通父会话看到各自允许的安全树视图而不能越级控制。

**Blocked by:** 26 - 纵向打通父子消息、steering 与普通回复

**Status:** ready-for-agent

- [ ] 子代理可使用整组管理工具递归创建下一层，深度达到 `maxDepth` 后叶节点隐藏管理能力；绕过工具发现仍返回 `max_depth_reached`。
- [ ] 祖先 `subagents: disabled`、直接父授权和名额限制沿父子关系只能保持或收窄，后代不能重新开启或扩大能力。
- [ ] `get_agent_status` 只读取直接子代理最近确认的安全快照；故障节点仍以 `ok:true` 返回 `data.error`，查询不触发 RPC、不等待、不改变状态。
- [ ] `get_agent_tree` 返回根整树或当前父会话自身子树的完整扁平快照，父先、稳定创建顺序、全局深度和原子 `tree_revision` 一致，查询不授予控制权。（REQ-001..003、REQ-018、REQ-030..031；AC-001、AC-010、AC-017）

