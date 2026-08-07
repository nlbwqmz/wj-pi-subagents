# Codex 多代理消息设计研究

研究对象：`D:\\code\\open-source\\codex`（重点查看 `codex-rs/core` 和 `codex-rs/protocol`）。以下结论均来自源码，行号按当前工作树文件记录。

## 结论摘要

1. 父代理要让正在工作的子代理“汇报当前进展并继续工作”，对应的 v2 工具是 `followup_task`：它会把消息及时投递给目标；若目标正在运行，则在消息边界（或当前工具调用完成后）交付，并在目标空闲时触发新回合。`send_message` 只排队、不触发新回合。
2. 消息不会直接调用子代理函数，而是封装成 `InterAgentCommunication`，经 `AgentControl::send_inter_agent_communication` 写入目标会话输入队列。`trigger_turn` 决定是否唤醒调度器。
3. 子代理完成或终止时，Codex 会自动向父线程发送一条 `AgentCommunicationKind::Result` 通信。该通信包含格式化后的完成/错误/关闭状态和最后结果文本；父线程收到后由普通 mailbox 机制处理。
4. 没有名为“child-to-parent report/reply”的专用工具。子代理可以调用通用 `send_message`（目标设为父代理）主动汇报；最终完成通知则由会话内部自动发送，不依赖子代理再调用工具。

## 父代理发送进展请求时的路径

### 工具语义

`create_send_message_tool` 将 `send_message` 定义为“发送给现有代理，消息会及时投递，但不会触发新回合”（`codex-rs/core/src/tools/handlers/multi_agents_spec.rs:186-215`）。同一文件的 v2 `followup_task` 描述明确指出：如果目标已经运行，消息会在采样消息边界或待处理工具调用结束后及时交付；目标空闲时会触发回合（`multi_agents_spec.rs:218-239`）。因此“汇报当前进展并继续工作”应使用 `followup_task`，而不是只使用 `send_message`。

### 统一发送实现

`multi_agents_v2/message_tool.rs` 的 `handle_message_string_tool` 先解析目标线程并确认目标代理（第 51-91 行），再用当前发送者路径构造通信（第 92-102 行）。发送模式映射为：`QueueOnly`（`send_message`）对应 `AgentCommunicationKind::Message`，`TriggerTurn`（`followup_task`）对应 `AgentCommunicationKind::Followup`（第 103-109 行）；随后调用 `agent_control.send_inter_agent_communication`（第 110-115 行）。

通信载荷结构在 `codex-rs/protocol/src/protocol.rs:732-768`：包含 `author`、`recipient`、正文 `content`、可选加密正文以及 `trigger_turn` 标志。目标会话收到 `Op::InterAgentCommunication` 后进入 `inter_agent_communication`（`codex-rs/core/src/session/handlers.rs:769-777`）。该处理器把通信放进 mailbox，并仅在 `trigger_turn` 为真（或存在 durable sleep）时请求调度器启动回合（`session/handlers.rs:270-286`）。

mailbox 本身是队列：`enqueue_mailbox_communication` 将通信和可选父回合 ID 压入队列并发布 Mailbox 活动（`codex-rs/core/src/session/input_queue.rs:77-90`）；`drain_mailbox_input_items` 在组装下一次 turn 输入时转换为 `TurnInput::InterAgentCommunication`（`input_queue.rs:104-121`）。若当前 turn 已在执行，queue-only 邮件会被标记为下一回合交付，避免在同一采样中重复启动（`input_queue.rs:146-167`）。

## 子代理完成消息如何自动通知父代理

每次发送事件后，会话调用 `maybe_notify_parent_of_terminal_turn`；该函数只关注 v2 子代理且只处理 `TurnComplete`/`TurnAborted`（`codex-rs/core/src/session/mod.rs:1878-1890`）。它从 `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { parent_thread_id, agent_path })` 提取父线程和子代理路径（第 1892-1899 行），结合终止错误或事件推导 `AgentStatus`（第 1901-1913 行），只对最终状态继续通知（第 1914-1924 行）。

`forward_child_completion_to_parent` 负责构造和发送结果：先从子路径计算父路径（`session/mod.rs:1935-1941`），再调用 `format_inter_agent_completion_message` 生成标准完成信封（第 1943-1949 行）。该格式化函数将 `Completed(Some(message))` 的最后消息作为 payload，`Completed(None)` 为空，错误/关闭/找不到代理分别生成对应文本；`PendingInit`、`Running`、`Interrupted` 不生成完成消息（`codex-rs/core/src/session_prefix.rs:27-44`）。随后以 `InterAgentCommunication::new(..., trigger_turn = false)` 创建通信，并标记 `AgentCommunicationKind::Result`（`session/mod.rs:1957-1965`），通过 `send_inter_agent_communication(parent_thread_id, ..., parent_turn_id = None)` 发给父线程（第 1966-1978 行）。这是一条不触发父代理新回合的结果 mailbox 消息，父代理会在其正常输入处理/下一回合看到它。

此外，较早的控制层收尾路径也使用同样的标准格式：在 `codex-rs/core/src/agent/control.rs:501-536` 为 v2 子代理构造 `Result` 通信并发送到 `parent_thread_id`；非 v2 路径则注入普通用户消息（第 539-545 行），说明自动通知是框架内部行为而非工具调用结果。

## 是否存在 child-to-parent 专用 reply/report 工具

源码中的 v2 工具只有通用 `send_message` 与 `followup_task`（工具规格分别见 `multi_agents_spec.rs:186-239`），没有 `report_progress`、`reply_to_parent` 或类似专用工具。子代理如需主动回传中间进度，可以把父代理路径作为 `target` 调用 `send_message`；该调用会及时排队但不触发父代理回合。需要让父代理立即开始处理时，理论上可使用会触发回合的 `followup_task`，但其语义和权限约束应由当前代理工具层决定。最终完成状态由上述会话终止钩子自动回传，子代理无需显式 reply。

