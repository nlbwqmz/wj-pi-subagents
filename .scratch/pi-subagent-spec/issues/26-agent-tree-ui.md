# 26 - 交付代理树 TUI 可观测性

Type: task

**What to build:** 将常驻 `Agents` widget 与 `/agent` 只读遮罩面板作为一个一致的 UI 模块交付，消费控制器确认的安全树快照，支持稳定渲染、交互状态保持和 UI-only 故障通知。

Blocked by: 25 - 闭合递归代理树、级联清理与根生命周期

Status: resolved

- [x] 常驻 widget 只显示当前会话直接子代理，按稳定顺序展示 `template_id`、名称、生命周期、安全活动摘要、创建后时长、非零 pending 和稳定故障码；窄宽度下安全截断，不提供越权控制按钮。（REQ-044、REQ-046；AC-024）
- [x] `/agent` 统一支持根整树或普通父自身子树，初始读取绑定单一 `tree_revision`，默认展开直接子代理、折叠后代，支持滚动、左右展开/折叠和 `Esc` 关闭。（REQ-045；AC-025）
- [x] 树修订到来时原子更新状态、pending、计时、终止记录和后代汇总，保留用户的展开集合与滚动位置；终止记录进入默认折叠的 `finished` 区域，作用域失效或渲染失败显示安全错误状态。（REQ-044..046；AC-024、AC-025）
- [x] 对 `failed` 和 `termination_incomplete` 按可见作用域每批聚合一次脱敏 `ctx.ui.notify`；正常状态不通知，任何 prompt、回复、路径、环境、句柄、端点、堆栈和秘密 canary 都不得进入 UI 或模型上下文。（REQ-047；AC-026）

## Comments

<!-- 追加实现与审查记录。 -->

- 2026-08-06：按用户确认的批次范围，删除依赖真实 Windows TUI/RPC 宿主的测试任务；相关真实环境验证由人工完成，不作为本工单的代理任务项。

- 2026-08-06：完成一致的代理树 UI 模块。常驻 `Agents` widget 只展示当前会话的直接子代理，并按稳定字段顺序输出模板、名称、生命周期、安全活动、总时长、非零 pending 和稳定故障码；所有出口统一净化终端控制字符，并按 Unicode 字素簇在窄宽度下安全截断。单数 `/agent` 命令提供根整树或普通父自身子树的只读遮罩面板，支持直接子代理默认展开、深层后代默认折叠、上下滚动、左右展开或折叠及 `Esc` 关闭；新修订原子刷新事实，同时保留展开集合和滚动位置，作用域失效时关闭，非法快照或渲染异常时显示固定安全错误状态。

- 2026-08-06：`finished` 只统计真正进入 `terminated` 的记录，并显示控制器确认的 `completed`、`failed`、`incomplete` 三分类。递归快照从活动 `failed`、稳定 `termination_incomplete` 错误或既有终止结果恢复历史，并以单调标志保留，最终按 `incomplete > failed > completed` 结算，避免后续正常形状快照把历史降级。级联资源确认及同批清理不完整通过一次批量树提交只发布一个 `tree_revision`；UI 按严格递增的可见修订去重，并分别聚合运行故障 warning 与清理不完整 error。正常状态仅更新 widget 或面板，不发送通知，也不存在消息或 prompt 回退。

- 2026-08-06：运行时只注册单数 `agent` 命令。会话创建时绑定 widget、树订阅和计时器；shutdown 或 reload 交接时先清除旧 widget、退订监听、清除计时器并关闭活动 overlay，reload 新实例启动后重新绑定并重建 UI。测试验证旧实例 reload shutdown 后 widget 清除、新实例 reload start 后 widget 重建，且 UI 故障通知不会进入模型消息上下文。共享 `agent-snapshot-codec` 统一了树控制器、监督通道、根权威路由和 UI 的安全快照闭集校验；包含秘密的伪造故障消息会在进入 UI 缓存前被拒绝。

- 2026-08-06：最终门禁为 `npm run typecheck` 通过；`npm test` 共 227 项，222 通过、0 失败、5 项因当前 Windows 平台按条件跳过的 Unix 原生测试；当前 Windows Job Object 的 5 项原生测试实际通过。`git diff --check 6c1bc135b319667346066e42254c054b5d4cfab3` 无 whitespace error，仅输出 Git 的 LF/CRLF 工作区提示。静态核查确认 UI 模块没有 `sendMessage`、`sendUserMessage` 或 prompt 回退，只注册单数 `agent`，且本次路径没有 `DEBUG`、`TODO`、`FIXME` 或 `HACK` 标记。仓库中没有 `.log`、`.tmp`、`.bak` 或 `.orig` 文件，系统临时目录也没有 `pi-subagent-local-*` 残留。

- 2026-08-06：最终双轴复审结果为 Standards 硬违规 0、新增结构性阻断项 0；共享 codec 已修复此前的重复验证。统一 UI façade 同时承载 binding、notifier、model 与终端文本，后续可在 façade 内进一步拆分，但仓库要求 widget 与 `/agent` 作为一致 UI 模块，因此该维护建议不阻断提交。Spec 功能性发现 0；复核确认 `finished` 三分类、递归终止历史单调保留，以及级联确认或不完整批次的单一修订和单批通知均已闭合。用户明确要求连续完成工单 25 和工单 26，工单 26 不构成范围蔓延。

- 2026-08-06：自动化边界保持明确。TUI 行为通过结构化 fake 宿主验证，RPC widget 与 notify 只验证 UI-only 接口；纯逻辑、fake UI、协议及宿主接口测试不等于真实 Pi TUI。真实 Windows TUI/RPC 宿主、Pi 与模型的完整组合仍需人工验证，未将其表述为自动测试已经覆盖。
