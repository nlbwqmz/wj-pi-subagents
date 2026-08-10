# 结构化父子回复协议

Status: implemented
Implementation: complete

## Problem Statement

父会话目前能够收到直接子代理的工作中回复和最终答复，但两类内容主要依赖 `kind`、自然语言正文和宿主侧展示元数据区分。父模型无法仅凭稳定的模型可见载荷可靠判断以下事实：这条内容属于哪一轮、子代理本轮如何结束、是否产生可用业务输出、回复是否需要父代理立即关注，以及节点故障是否来自子代理运行时还是一次模型处理结果。

当前最终答复在没有可用文本时还可能依赖说明性正文表达缺失结果。说明性正文既不是业务结果，也不能让父模型稳定地区分“正常收尾但没有输出”“模型错误”“协作式中断”和“监督节点故障”。工作中消息、最终答复、ACK、重放和父会话唤醒之间也缺少统一的结构化语义。

## Solution

为直接父子关系增加一套版本化、模型可见的结构化子代理回复信封。子代理继续使用自然语言表达业务正文，运行时负责生成通信类型、轮次和结果状态；父会话通过结构化字段识别本轮事实，通过既有 `send_message` 进行明确的后续协调。

监督通道升级为 v3。child reply 以 `reply_seq` 和结构化信封传输；父端运行时故障使用独立的 `TerminalNotice`，不伪装成 child final。工作中回复、最终答复和终止通知在父会话中分别渲染，但模型直接看到结构化 JSON。当前插件不引入 workflow、runner、备用模型、自动重跑或新的父子请求配对协议。

## User Stories

1. 作为父会话，我希望明确区分工作中回复和最终答复，以便不会把阶段性发现误认为任务已经完成。
2. 作为父会话，我希望每条回复携带发送者的 `agent_id`，以便多个直接子代理并行汇报时不会混淆来源。
3. 作为父会话，我希望工作中回复和最终答复共享同一个 `turn_id`，以便把同一轮的进度、问题、阶段性发现和最终结果归组。
4. 作为父会话，我希望知道一个 final 对应的运行时是正常收尾、失败还是中断，以便选择正确的后续协调方式。
5. 作为父会话，我希望独立知道本轮是否存在可用输出，以便不依赖自然语言猜测任务结果。
6. 作为父会话，我希望区分“正常结束但没有输出”和“模型错误导致失败”，以便给用户准确报告。
7. 作为父会话，我希望看到失败或中断时仍保留的部分业务内容，以便继续判断已完成的工作，而不是丢失已有信息。
8. 作为父会话，我希望部分输出被明确标记为非完整结果，以便不会把失败或中断的候选当作成功结果。
9. 作为父会话，我希望运行时故障通过独立的终止通知表达，以便不会把父端观察到的节点故障伪装成子代理 final。
10. 作为父会话，我希望无输出 final 不携带伪造的业务正文，以便状态字段和实际业务内容保持一致。
11. 作为父会话，我希望父代理空闲时只被重要的工作中消息唤醒，以便例行进度不会产生无意义的模型调用。
12. 作为父会话，我希望需要父端关注的工作中消息明确声明 `requires_response`，以便模型知道何时应优先回应子代理。
13. 作为父会话，我希望 final 和终止通知始终能够唤醒空闲父代理，以便子代理完成或故障后不会无人处理。
14. 作为父会话，我希望在执行 `wait_agent` 时仍能收到工作中回复，以便保留当前工具契约并及时处理阶段性问题。
15. 作为父会话，我希望工作中回复结束一次等待但不改变子代理生命周期，以便收到进度后可以继续等待同一子代理。
16. 作为父会话，我希望不需要从 `wait_agent` 或 `get_agent_status` 的结果中读取重复的 final 正文，以便 final 在父会话中保持唯一事实来源。
17. 作为父会话，我希望在收到无可用汇报的 final 后被明确要求向同一个 `agent_id` 追问，以便优先利用现有上下文总结已完成工作。
18. 作为父会话，我希望追问使用新的 `turn_id`，以便不会覆盖或修改上一轮已经记录的失败事实。
19. 作为父会话，我希望追问不会隐式触发完整任务重跑或备用模型切换，以便避免重复文件修改和外部副作用。
20. 作为子代理，我希望只需提供自然语言业务正文，运行时自动生成 `turn_id`、生命周期状态和输出状态，以便模型不能自行伪造成功或失败。
21. 作为子代理，我希望工作中回复明确要求填写 `requires_response`，以便每次汇报都表达清楚是否需要父代理关注。
22. 作为子代理，我希望 final 由运行时在 settled 边界自动提交且每轮最多产生一个，以便普通 assistant 过程不会被误转发为最终结果。
23. 作为子代理，我希望回复可以携带图片，并让图片-only 内容也被视为可用输出，以便视觉结果不会被错误判定为空。
24. 作为监督通道，我希望使用 `reply_seq` 保证回复按序交付，以便乱序到达时不会破坏父会话消息顺序。
25. 作为监督通道，我希望相同序号和相同信封的重放具有幂等性，以便断线恢复不会重复注入父会话消息。
26. 作为监督通道，我希望相同序号但不同信封被识别为协议错误，以便篡改或状态分叉不会静默覆盖原回复。
27. 作为监督通道，我希望未知信封字段可以忽略，同时必需字段和语义关系仍被校验，以便保留有限的扩展空间而不放松核心安全边界。
28. 作为 TUI 用户，我希望看到消息类型、发送者、最终状态和正文的可读投影，以便不必阅读原始 JSON 也能扫描协作进展。
29. 作为 TUI 用户，我希望原始 JSON、`turn_id` 和传输序号不成为主要展示内容，以便界面保持面向协作而非面向协议调试。
30. 作为扩展维护者，我希望所有父子回复通过统一的信封编解码接缝校验，以便协议规则不会在 child、监督通道和父端 inbox 中各自漂移。
31. 作为扩展维护者，我希望协议版本升级的兼容边界明确，以便不会误以为 v2 活动节点能够在 v3 扩展 reload 后继续运行。
32. 作为测试维护者，我希望能够在 fake 监督通道中模拟 ACK 丢失、回复重放、乱序和重复 final，以便验证协议在不可靠交付条件下仍保持外部行为一致。
33. 作为项目维护者，我希望运行时不携带原始异常、路径、凭据、进程信息或堆栈，以便结构化通信不会扩大现有安全事实边界。
34. 作为父会话，我希望当 final 的输出存在但业务上仍不可用时也能发起同一代理追问，以便结构化的 `present` 不会阻止必要的人工判断。
35. 作为父会话，我希望没有可用汇报时能够继续根据实际上下文协调同一子代理，以便不会被协议层的计数器或额度限制。

## Implementation Decisions

- **领域边界**：本规格只覆盖子代理回复的通信语义、父会话投递、父代理唤醒和故障通知，不引入 workflow、runner、自动 fallback 或任务重放系统。
- **唯一协议接缝**：新增一个统一的子代理回复信封编解码与语义校验模块。`ChildReplyCoordinator` 负责生成运行时事实，`SupervisorChannel` 负责传输适配，`ParentReplyInbox` 负责父会话注入与展示；三者不得各自实现一套不一致的信封解析器。
- **模型可见载荷**：父会话 custom message 的文本内容是结构化 JSON 信封。业务正文继续存放在 `text` 字段中并保持自然语言；不会把任意业务对象放进协议。
- **回复信封公共字段**：`schema`、`version`、`kind`、`agent_id` 和 `turn_id` 是所有 child reply 的必需字段。`agent_id` 是父模型可见的来源身份，不能只依赖 TUI 或宿主 `details`。
- **工作中回复字段**：`kind` 为 `message` 时，`requires_response` 和非空 `text` 必须存在；`images` 可选。模型必须显式填写 `requires_response`，运行时不得默认补齐。
- **最终答复字段**：`kind` 为 `final` 时，必需字段为 `run_state` 和 `output_state`；`text` 与 `images` 均可选，但至少一个存在时 `output_state` 才能为 `present`。`requires_response` 不出现在 final 中，final 的唤醒语义由运行时固定提供。
- **终止通知字段**：父端生成独立的 `TerminalNotice`，其 `kind` 为 `terminal`，只用于 `node_state: failed` 和 `reason_code: runtime_fault`。主动终止不生成该通知；`turn_id` 在父端能够确定时可选携带。
- **协议版本**：监督通道升级为 `pi-subagent/3`。v3 reply payload 保留传输字段 `reply_seq`，其余 child reply 内容放入 `envelope`。v3 不适配 v2；跨协议版本升级要求结束旧根会话并重建代理树。
- **监督帧边界**：`TerminalNotice` 不作为 child `SupervisorReply` 传输，不占用 child reply 序号和 child final ACK；它由父端运行时直接注入父会话。既有父子监督通道继续负责生命周期和节点故障事实。
- **字段校验**：信封的必需字段、类型、已定义枚举、UUID/轮次格式、文本和图片边界，以及 `output_state` 与正文载荷的一致性必须校验。未知字段允许忽略；字段顺序、空白和普通 JSON 序列化形式不属于协议语义。不实现 RFC 8785 或加密签名。
- **生命周期与输出分离**：`run_state` 表达本轮如何结束，`output_state` 表达是否存在可用业务载荷；child final 的状态不直接改变节点生命周期的 `failed`。节点 `failed` 只代表控制面或运行时节点故障。
- **状态矩阵**：正常有输出为 `settled/present` 且省略原因码；正常无输出为 `settled/absent/no_output`；provider 错误可为 `failed/present` 或 `failed/absent/provider_error`；子代理运行时故障仍可提交 final 时使用 `failed/present|absent/runtime_fault`；中断使用 `interrupted/present|absent`，不重复携带 `interrupted` 原因码。
- **部分输出**：失败或中断时保留本轮最近的安全候选。保留的文本或图片作为 final 载荷，但通过 `run_state` 表明它不是完整成功结果；不得再拼接运行时生成的说明性业务句子。
- **无输出**：无文本和图片的 final 仍通过结构化 JSON 信封传输；不会生成“本轮无输出”等业务正文。TUI 可以根据固定枚举渲染说明，但该说明不进入模型正文。
- **轮次**：每次 Pi `agent_start` 分配一个在当前 child 节点生命周期内未曾签发的随机 UUID v4 `turn_id`，直到本轮 `settled`、`failed` 或 `interrupted`。该轮中的所有工作中回复和 final 共用 `turn_id`；父代理追问使用新的轮次。轮次分配失败时废止当前轮次并关闭监督通道，后续生命周期事件不得借用上一轮标识出站。
- **唤醒规则**：工作中 `message` 在父代理空闲时，`requires_response: true` 才触发模型；`false` 只进入会话。父代理正在运行时，两者都作为 steering 进入当前处理；父代理正在 `wait_agent` 时，任何已接纳的工作中消息都让等待返回 `outcome: reply`，不改变子代理生命周期。final 和 TerminalNotice 在父代理空闲时都触发处理。
- **递归收尾顺序**：child runtime 从 `agent_end` 起暂缓会触发新 loop 的后代 final、`requires_response: true` message 和 TerminalNotice。自动续跑的下一次 `agent_start` 在 Pi 仍 streaming 时放行并重试；真正结束时只能在本轮 final 获 ACK 后延后一拍放行，暂缓期间不得提前发送 reply ACK。本扩展自己的 `agent_settled` handler 也必须先确认当前 `ExtensionContext.isIdle()`；若前置 handler 延迟期间已有新轮运行，则丢弃旧 settle，不借用新轮提交旧 final。若本扩展之后的第三方 settled handler 尚未返回，重叠 `agent_start` 会要求祖先监督器查询 Pi `isStreaming`，仍在运行时不得把旧轮迟到 `agent_settled` 提交为 idle。
- **收尾失败边界**：final 无法形成或确认时，唤醒屏障永久进入失败态，不能重试被挡回复或启动新的模型 loop；协调器也废止当前轮次并拒绝后续 `agent_start`。`settle()` rejection 必须交给 Pi ExtensionRunner，使同一任务 RPC 流先发布 `extension_error`，再忽略迟到 `agent_settled`。关闭独立监督流继续作为第二条故障信号。
- **自主生命周期**：任务 RPC 只公开无载荷 `agent_start` 安全事实。无命令接纳时，idle 节点收到该事实立即进入 `working`；命令接纳窗口先暂存 start，按到达顺序保留最后一个生命周期事实，命令成功时将对应 start 视为同轮启动事实，命令失败且节点仍 idle 时补交 `agent_started`，再处理同窗口的 `agent_settled`。若窗口末尾是新 start，则它覆盖更早的 settle；中断中的 settle-start 以不经过 idle 的方式恢复 `working`。
- **父代理追问规范**：父代理收到 child final 后，如果 `output_state: absent`，或父代理判断 `present` 正文仍不可用，必须向同一 `agent_id` 尝试发送“仅总结上一轮已完成工作、不要重新执行任务”的追问。协议不规定追问次数、计数器或上限；父代理运行时不能保证模型一定调用 `send_message`。后续是否继续由父代理根据上下文决定。
- **恢复边界**：当前插件不自动追问、不自动 fallback、不自动创建新代理、不自动完整重跑原任务。`provider_error`、`runtime_fault` 和副作用安全性只作为父代理决策事实，不携带 `retryable` 或恢复建议。
- **final 唯一性**：同一 `turn_id` 只接受第一个 final。Child runtime 通过 settled latch 和已签发轮次集合防止重复提交或轮次复用；父端在节点生命周期内保留已接纳 final 的轮次标识，对迟到的不同 final 不覆盖、不再次唤醒。普通工作中回复可以有多条。
- **传输幂等**：相同 `reply_seq` 且信封语义相同的重放不重复注入父会话，但重复 ACK；相同 `reply_seq` 携带不同信封属于协议错误。父端在节点生命周期内只保留已接纳信封的 SHA-256 语义摘要用于窗口外重放判定，不保留正文，也不形成回复或追问额度。`reply_seq` 只表达传输顺序，不表达模型结果。
- **父会话展示**：TUI 隐藏原始 JSON，展示消息类型、发送者、结果状态和自然语言正文；`turn_id`、`reply_seq` 和 schema 版本不作为主要展示内容。状态说明由 renderer 根据固定字段本地生成。
- **等待和状态查询**：`wait_agent` 与 `get_agent_status` 保持现有生命周期契约，不重复携带 final 正文或 `TurnCompletionSummary`。父会话 final 是本轮业务结果的唯一来源；TerminalNotice 是节点故障的独立控制面通知。
- **安全边界**：结构化信封不得包含 prompt、思考块、工具参数、工具结果、文件路径、环境、凭据、进程号、句柄、堆栈或原始 provider 异常。图片继续使用现有有界、可校验的图片载荷。
- **文档边界**：同一协议版本的 `/reload` 继续按现有运行时重载契约保留活动节点；v2 到 v3 的版本迁移是明确例外，必须重建代理树，并同步更新 reload 说明、监督协议说明和工具提示。

## Testing Decisions

- **测试原则**：测试观察到的父会话消息、工具结果、节点状态、唤醒行为、ACK 和重放行为，不测试私有字段布局或单个函数调用次数，除非该调用次数本身是公开幂等契约的一部分。
- **最高测试接缝**：以统一的 reply/terminal envelope codec 作为新增接缝。所有边界测试通过该接缝与既有 `ChildReplyCoordinator`、`SupervisorChannel`、`ParentReplyInbox` 和 `AgentController` 的公开行为完成，避免为 child、wire 和 TUI 各维护一套测试专用解析器。
- **信封 codec 测试**：覆盖 message/final/terminal 的必需字段、类型、UUID、`turn_id`、枚举、文本/图片边界、未知字段忽略、缺字段拒绝、语义不一致拒绝、JSON 字段顺序与空白不影响解析，以及无任意业务 JSON 的边界。
- **ChildReplyCoordinator 测试**：沿用当前候选提取和 ACK 测试，增加每次 `agent_start` 生成未复用 UUID v4 轮次、重复/非法轮次工厂值的重试与失败关闭、工作中消息与 final 共享轮次、运行时生成状态、正常无输出、provider error、interrupted partial output、图片-only 输出和同一轮 final latch。
- **SupervisorChannel 测试**：沿用现有握手、帧边界、身份和重同步测试，迁移到 v3，覆盖 `reply_seq + envelope`、未知字段忽略、相同 reply 重放幂等、待 ACK 窗口外的同序号不同信封故障、乱序有序交付、ACK 水位，以及多个后续轮次后旧 final 仍不再次注入和 v2 帧拒绝。
- **ParentReplyInbox 测试**：验证父会话收到的正文是模型可见 JSON，验证 `agent_id` 来源、message 的 `requires_response` 空闲唤醒矩阵、final/terminal 的固定唤醒、工作中消息的 `wait_agent` 通知、图片保留和 TUI 语义渲染；覆盖收尾屏障对 final、需响应 message 和 TerminalNotice 的统一暂缓，以及 final 失败后屏障不可恢复。
- **AgentController 测试**：沿用当前工作中 reply、settled、terminal 和 timeout 测试，证明 `wait_agent` 结果不复制 final 摘要，工作中消息仍返回 `outcome: reply`，节点生命周期不因 reply 改变，父端故障先注入 TerminalNotice 再让等待返回 terminal；覆盖自主 `agent_start` 后 wait/send/interrupt 的 working 路由和命令接纳失败时的 pending-start 恢复。
- **递归时序测试**：在 child 的 runtime handler 前后各注册一个可延迟的第三方 `agent_settled` handler，并延迟 final ACK；证明叶节点回复保持未 ACK，放行后的重叠新轮使祖先继续保持 working，旧轮迟到 settle 通过 Pi streaming 状态复核被压住，直至新轮自身 settled。final ACK 失败测试必须证明 handler rejection 向 Pi 冒泡且不会放行失败态屏障。
- **父代理协调规范测试**：使用模型可观察的工具描述或提示契约测试验证：无输出 final 以及父模型判断现有正文不可用时，规范要求使用同一 `agent_id` 追问；不把该要求伪装为运行时强制保证；没有自动 fallback 或自动任务重跑行为。
- **端到端测试**：在现有本地 fake Pi RPC 和父子 runtime 旅程上增加工作中消息、最终答复、无输出、部分失败、协作式中断、运行时故障和新轮次追问，验证消息进入直接父会话而不越级。
- **reload 测试**：同版本 reload 继续验证已接纳回复按序重试和活动节点保留；v2/v3 版本转换验证明确拒绝旧协议并要求重建代理树，不验证跨版本热接管。
- **安全测试**：使用 canary 验证原始异常、路径、凭据、prompt、工具参数、工具结果、进程信息和堆栈不会进入结构化信封、工具结果、TUI 或父模型可见正文。
- **测试先例**：优先复用现有监督通道协议测试、child reply coordinator 测试、父会话 inbox/TUI renderer 测试、agent controller wait/settle 测试和 runtime 集成测试的 fake seam；不以 snapshot 内部字段或实现私有方法作为主要断言。

## Out of Scope

- 自动备用模型、模型 fallback、完整任务重跑、workflow、runner 或任务调度。
- 运行时对父代理协调行为的追问计数、额度管理或工具调用拦截；父代理可根据上下文决定后续协调。
- 父子请求-响应配对、`in_reply_to_turn_id`、父代理回复 ACK 或未回复状态机。
- 任意业务 JSON schema、业务字段验证、业务结果的机器化拆解。
- provider 原始错误、HTTP 状态、堆栈、路径、进程信息和凭据透传。
- 将 child final 的业务结果复制到 `wait_agent` 或 `get_agent_status`。
- 通过 TerminalNotice 传递最后正文或部分业务输出。
- 跨 v2/v3 的协议兼容、跨版本 `/reload` 活动节点接管或旧树自动迁移。
- 子代理跨根会话、Pi resume/fork 或根关闭后的持久恢复。
- 自动判断业务正文质量；`present` 但不可用的判断由父代理协调规范要求模型自行处理。
- macOS/Linux 原生进程树验证和平台支持结论；这些继续遵循既有独立计划边界。
- 性能、吞吐、延迟、token/费用和内存指标。

## Further Notes

- 本规格补充既有代理树基础规格和两个受管 RPC/直接监督 ADR，不改变代理树权威、直接父子通信、生命周期七态、终止屏障或资源回收边界。
- 父代理追问属于模型协调规范，协议不追踪追问次数或额度；运行时只负责交付结构化 final/terminal、唤醒父代理和报告节点事实。
- `output_state: present` 只证明运行时保留了文本或图片，不证明业务质量。父代理认为内容不可用时仍必须尝试同一子代理追问。
- 未知字段忽略策略仅适用于新结构化信封；监督帧的认证、身份、长度、序号、ACK、重同步和安全边界仍由父子监督通道负责。
- 已同步更新领域词汇中关于父子回复、最终答复、工作中回复、终止通知、运行时重载和 v3 监督通道的描述；实现由统一 codec、child 运行时、父端 inbox/TUI、控制器交付和测试验收共同覆盖。
- 实现完成后已运行 `npm run check`、聚焦 runtime/bridge 测试和独立 code review；最终提交前以最新工作树的完整检查结果为准。
