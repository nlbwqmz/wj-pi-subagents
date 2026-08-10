# 使用结构化子回复信封并由运行时裁决最终状态

Status: accepted

父子监督协议升级为 `pi-subagent/3`。reply 帧只传输单调 `reply_seq` 和一个经过统一 codec 校验的 `pi-subagent.reply` envelope；v2 顶层 `kind`、`text` 和 `images` 不再兼容，协议主版本不同的活动树必须结束并重建，不能通过 reload 热接管。模型可见父会话消息直接包含普通 JSON envelope，TUI 只展示其发送者、类型、状态、自然语言正文和图片摘要，不显示原始协议字段。

每次 child `agent_start` 由运行时分配一个在该节点生命周期内未曾签发的随机 UUID v4 `turn_id`，同轮显式 message 与自动 final 共享该标识。轮次分配失败会废止当前轮次并关闭监督通道，后续生命周期事件不能借用上一轮标识出站。message 必须包含非空 `text` 和模型显式选择的 `requires_response`，并可选携带经过统一 codec 校验的图片；该布尔字段只控制父代理空闲时是否触发处理，任何已接纳 message 仍会解除一次 `wait_agent`。final 的 `run_state`、`output_state` 和 `reason_code` 完全由运行时依据结束边界与安全候选生成，模型不能自行声明。无输出 final 可以没有业务正文；失败和中断可以保留最近的安全候选，但运行时不追加说明性文字。

节点 runtime fault 由直接父运行时生成独立 `pi-subagent.terminal` 通知。它不属于 child reply、`reply_seq` 或 final ACK，不携带原始错误和业务正文，并且必须先尝试进入父会话，随后 `wait_agent` 才能返回 terminal。主动终止不生成该通知。

递归 child runtime 从 `agent_end` 起阻止后代 final、需响应 message 和 TerminalNotice 在 Pi 收尾窗口启动新 loop；自动续跑的下一次 `agent_start` 在仍 streaming 时安全放行，真正结束则在本轮 final 获 ACK 后延后一拍重试。本扩展自己的 `agent_settled` handler 会先检查 `ExtensionContext.isIdle()`，前置 handler 延迟期间若已有新轮则丢弃旧 settle；若本扩展之后仍有未结束的第三方 settled handler，新 loop 可以先于旧轮 `agent_settled` 启动，任务 RPC 的重叠 `agent_start` 会要求祖先监督器查询 Pi `isStreaming`，只有实际不再运行时才接受该 settle。final 形成或确认失败时，handler rejection 由 Pi 先在任务 RPC 流发布为 `extension_error`，唤醒屏障永久进入失败态。任务 RPC 只转发无载荷 `agent_start`；命令接纳窗口中的生命周期事实按最后到达顺序收束，命令成功时消化，命令失败且节点仍 idle 时补交为自主 `working`。

## 备选方案

- 继续使用人类可读的 `Message Type` 文本前缀：模型需要重新解析显示文案，无法稳定区分生命周期结束方式与业务输出是否存在。
- 允许模型提交 final 状态：会把 provider error、中断和 runtime fault 的裁决交给不可信业务输出，无法形成一致的等待与恢复语义。
- 用说明性正文代表无输出或故障：会把运行时诊断伪装成业务结果，也会让父代理无法可靠判断是否应向同一节点追问。
- 在 `wait_agent` 或状态快照中复制 final：会形成多个业务结果事实来源，并扩大正文和图片在控制面的保留范围。

## 影响

`ChildReplyEnvelope` codec 成为监督通道、child coordinator、父会话 inbox 和 TUI renderer 的共同协议边界。未知 envelope 扩展字段可以忽略，但必需字段、枚举、UUID、文本/图片边界、变体保留字段和状态矩阵必须拒绝非法值。父端在节点生命周期内保留已接纳 envelope 的 SHA-256 语义摘要和 final 轮次标识，以保证待 ACK 窗口外旧序号仍可检测篡改、旧 final 不会再次注入；索引不保留业务正文，也不限制回复或追问次数。final 与 TerminalNotice 固定触发父代理；message 的空闲唤醒由 `requires_response` 决定。父代理遇到 `output_state: absent` 或不可用的 present 内容时，只能向同一 `agent_id` 请求总结上一轮已完成工作，运行时不会自动重跑、切换模型或创建替代代理。
