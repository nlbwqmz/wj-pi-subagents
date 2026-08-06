# 26 - 交付代理树 TUI 可观测性

Type: task

**What to build:** 将常驻 `Agents` widget 与 `/agent` 只读遮罩面板作为一个一致的 UI 模块交付，消费控制器确认的安全树快照，支持稳定渲染、交互状态保持和 UI-only 故障通知。

Blocked by: 25 - 闭合递归代理树、级联清理与根生命周期

Status: ready-for-agent

- [ ] 常驻 widget 只显示当前会话直接子代理，按稳定顺序展示 `template_id`、名称、生命周期、安全活动摘要、创建后时长、非零 pending 和稳定故障码；窄宽度下安全截断，不提供越权控制按钮。（REQ-044、REQ-046；AC-024）
- [ ] `/agent` 统一支持根整树或普通父自身子树，初始读取绑定单一 `tree_revision`，默认展开直接子代理、折叠后代，支持滚动、左右展开/折叠和 `Esc` 关闭。（REQ-045；AC-025）
- [ ] 树修订到来时原子更新状态、pending、计时、终止记录和后代汇总，保留用户的展开集合与滚动位置；终止记录进入默认折叠的 `finished` 区域，作用域失效或渲染失败显示安全错误状态。（REQ-044..046；AC-024、AC-025）
- [ ] 对 `failed` 和 `termination_incomplete` 按可见作用域每批聚合一次脱敏 `ctx.ui.notify`；正常状态不通知，任何 prompt、回复、路径、环境、句柄、端点、堆栈和秘密 canary 都不得进入 UI 或模型上下文。（REQ-047；AC-026）
- [ ] 在 Windows TUI/RPC 宿主上完成 widget、遮罩、窄宽度、树修订竞态、Esc 关闭和 UI-only 脱敏测试；无 UI 模式保持无可见回退。跨平台终端差异留给后续平台计划。

## Comments

<!-- 追加实现与审查记录。 -->
