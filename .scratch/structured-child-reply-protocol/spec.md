# 结构化父子回复协议

Status: implemented
Implementation: complete

> 当前契约已由 [ADR-0006](../../docs/adr/0006-multi-target-wait-batches.md) 升级：工作中 reply 删除 `requires_response` 并固定唤醒父代理，信封版本为 4，监督协议为 `pi-subagent/6`。下文保留为第 3 版协议的历史实现规格。

## Problem Statement

父会话目前能够收到直接子代理的工作中回复和最终答复，但两类内容主要依赖 `kind`、自然语言正文和宿主侧展示元数据区分。父模型无法仅凭稳定的模型可见载荷可靠判断以下事实：这条内容属于哪一轮、子代理本轮如何结束、是否产生可用业务输出、回复是否需要父代理立即关注，以及节点故障是否来自子代理运行时还是一次模型处理结果。

当前最终答复在没有可用文本时还可能依赖说明性正文表达缺失结果。说明性正文既不是业务结果，也不能让父模型稳定地区分“正常收尾但没有输出”“模型错误”“协作式中断”和“监督节点故障”。工作中消息、最终答复、ACK、重放和父会话唤醒之间也缺少统一的结构化语义。

## Solution

为直接父子关系增加一套版本化、模型可见的结构化子代理回复信封。子代理继续使用自然语言表达业务正文，运行时负责生成通信类型、轮次和结果状态；父会话通过结构化字段识别本轮事实，通过既有 `send_message` 进行明确的后续协调。

监督通道升级为 v5。child reply 使用第 3 版纯文本结构化信封，并以稳定 `task_id`、单次 `turn_id` 和 final `commit_id` 区分逻辑任务、Pi loop 与幂等提交；父端运行时故障继续使用独立 `TerminalNotice`。raw settlement、父会话接纳和压缩恢复通过节点 mailbox 线性化，当前插件不引入 workflow、备用模型或自动重跑。

## User Stories

1. 作为父会话，我希望明确区分工作中回复和最终答复，以便不会把阶段性发现误认为任务已经完成。
2. 作为父会话，我希望每条回复携带发送者的 `agent_id`，以便多个直接子代理并行汇报时不会混淆来源。
3. 作为父会话，我希望每条回复同时携带逻辑 `task_id` 和实际 `turn_id`，以便把跨 steering、压缩和恢复的同一任务归组，并拒绝旧轮次结果。
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
18. 作为父会话，我希望追问建立新的逻辑任务和处理轮次，以便不会覆盖或修改上一任务已经记录的失败事实。
19. 作为父会话，我希望追问不会隐式触发完整任务重跑或备用模型切换，以便避免重复文件修改和外部副作用。
20. 作为子代理，我希望只需提供自然语言业务正文，运行时自动生成 `task_id`、`turn_id`、`commit_id` 和结果状态，以便模型不能自行伪造任务身份或成功。
21. 作为子代理，我希望工作中回复明确要求填写 `requires_response`，以便每次汇报都表达清楚是否需要父代理关注。
22. 作为子代理，我希望 raw settlement 只准备 final 且立即返回，匹配 final 在后台等待父端 ACK 后才提交，以便第三方压缩 handler 不会被本扩展阻塞。
23. 作为子代理，我希望所有父子业务通信只携带文本，并让图片-only 内容被稳定判定为无输出，以便无效二进制载荷不会进入父会话或 provider。
24. 作为监督通道，我希望使用 `reply_seq` 保证回复按序交付，以便乱序到达时不会破坏父会话消息顺序。
25. 作为监督通道，我希望相同序号和相同信封的重放具有幂等性，以便断线恢复不会重复注入父会话消息。
26. 作为监督通道，我希望相同序号但不同信封被识别为协议错误，以便篡改或状态分叉不会静默覆盖原回复。
27. 作为监督通道，我希望未知信封字段可以忽略，同时必需字段和语义关系仍被校验，以便保留有限的扩展空间而不放松核心安全边界。
28. 作为 TUI 用户，我希望看到消息类型、发送者、最终状态和正文的可读投影，以便不必阅读原始 JSON 也能扫描协作进展。
29. 作为 TUI 用户，我希望原始 JSON、`turn_id` 和传输序号不成为主要展示内容，以便界面保持面向协作而非面向协议调试。
30. 作为扩展维护者，我希望所有父子回复通过统一的信封编解码接缝校验，以便协议规则不会在 child、监督通道和父端 inbox 中各自漂移。
31. 作为扩展维护者，我希望协议版本升级的兼容边界明确，以便不会误以为 v4 活动节点能够在 v5 扩展 reload 后继续运行。
32. 作为测试维护者，我希望能够在 fake 监督通道中模拟 ACK 丢失、回复重放、乱序和重复 final，以便验证协议在不可靠交付条件下仍保持外部行为一致。
33. 作为项目维护者，我希望运行时不携带原始异常、路径、凭据、进程信息或堆栈，以便结构化通信不会扩大现有安全事实边界。
34. 作为父会话，我希望当 final 的输出存在但业务上仍不可用时也能发起同一代理追问，以便结构化的 `present` 不会阻止必要的人工判断。
35. 作为父会话，我希望没有可用汇报时能够继续根据实际上下文协调同一子代理，以便不会被协议层的计数器或额度限制。
36. 作为父会话，我希望 `send_message.accepted` 只声明插件 mailbox 接纳并返回 `message_id/task_id`，以便不会误以为 Pi 或模型已经读取。
37. 作为监督通道，我希望 task assignment 获 transport ACK 后才调用 Pi，并让 child 的 `task_started` 严格先于该 turn reply，以便身份事实不会被业务结果越过。
38. 作为父会话，我希望 final 同时满足 provisional settlement 和父会话接纳后才 commit，以便压缩或迟到事件不能制造伪完成。
39. 作为父会话，我希望压缩恢复使用同一 `task_id` 和新 `turn_id`，并隔离旧 turn final。
40. 作为父会话，我希望无法证明交付或压缩恢复时看到 `suspended`，以便系统不猜测完成或自动重发。
41. 作为状态消费者，我希望 mailbox、宿主和 reply outbox 三类队列在一个投影中原子更新，并让 `idle` 严格表示全部静止。

## Implementation Decisions

- **领域边界**：本规格只覆盖子代理回复的通信语义、父会话投递、父代理唤醒和故障通知，不引入 workflow、runner、自动 fallback 或任务重放系统。
- **唯一协议接缝**：新增一个统一的子代理回复信封编解码与语义校验模块。`ChildReplyCoordinator` 负责生成运行时事实，`SupervisorChannel` 负责传输适配，`ParentReplyInbox` 负责父会话注入与展示；三者不得各自实现一套不一致的信封解析器。
- **模型可见载荷**：父会话 custom message 的文本内容是结构化 JSON 信封。业务正文继续存放在 `text` 字段中并保持自然语言；不会把任意业务对象放进协议。
- **回复信封公共字段**：`schema`、`version`、`kind`、`agent_id`、`task_id` 和 `turn_id` 是所有 child reply 的必需字段。`agent_id` 标识来源，`task_id` 标识父级逻辑工作所有权，`turn_id` 标识实际 Pi loop；不能依赖 TUI 或宿主 `details` 推断这些身份。
- **工作中回复字段**：`kind` 为 `message` 时，`requires_response` 和非空 `text` 必须存在；`images` 被显式拒绝。模型必须显式填写 `requires_response`，运行时不得默认补齐。
- **最终答复字段**：`kind` 为 `final` 时，`commit_id`、`run_state` 和 `output_state` 必须存在；只有非空 `text` 存在时 `output_state` 才能为 `present`，`images` 被显式拒绝。`commit_id` 是运行时分配的幂等提交身份，不能由模型声明。
- **终止通知字段**：父端生成独立的 `TerminalNotice`，其 `kind` 为 `terminal`，只用于 `node_state: failed` 和 `reason_code: runtime_fault`。主动终止不生成该通知；`task_id/turn_id` 在父端能够确定时可选携带。
- **协议版本**：监督通道升级为 `pi-subagent/5`，回复信封版本升级为 3。v5 reply payload 保留传输字段 `reply_seq`，其余内容放入 `envelope`；v5 不适配 v4 及更早版本，跨主版本升级要求结束旧树并重建。
- **监督帧边界**：`TerminalNotice` 不作为 child `SupervisorReply` 传输，不占用 child reply 序号和 child final ACK；它由父端运行时直接注入父会话。既有父子监督通道继续负责生命周期和节点故障事实。
- **字段校验**：信封的必需字段、类型、已定义枚举、UUID/轮次格式、文本边界，以及 `output_state` 与正文载荷的一致性必须校验；`images` 是显式保留的拒绝字段。其他未知字段允许忽略；字段顺序、空白和普通 JSON 序列化形式不属于协议语义。不实现 RFC 8785 或加密签名。
- **生命周期与输出分离**：`run_state` 表达任务结果，`output_state` 表达是否存在可用业务文本；它们不等于节点顶层状态。raw settlement 只形成 provisional candidate，只有 final commit 才产生任务级 `last_task`，节点 `failed` 仍只代表控制面或运行时节点故障。
- **状态矩阵**：正常有输出为 `settled/present` 且省略原因码；正常无输出为 `settled/absent/no_output`；provider 错误可为 `failed/present` 或 `failed/absent/provider_error`；子代理运行时故障仍可提交 final 时使用 `failed/present|absent/runtime_fault`；中断使用 `interrupted/present|absent`，不重复携带 `interrupted` 原因码。
- **部分输出**：失败或中断时保留本轮最近的安全文本候选。保留的文本作为 final 载荷，但通过 `run_state` 表明它不是完整成功结果；不得再拼接运行时生成的说明性业务句子。
- **无输出**：无文本的 final 仍通过结构化 JSON 信封传输；assistant 图片块被忽略，图片-only 输出也进入此分支。不会生成“本轮无输出”等业务正文。TUI 可以根据固定枚举渲染说明，但该说明不进入模型正文。
- **任务与轮次**：首条被 mailbox 接纳的父消息建立 UUID v4 `task_id`；没有新的 `task_assignment` 时，自动重试、steering、压缩和恢复继续保持该值。每次实际 Pi `agent_start` 分配新的 UUID v4 `turn_id`，child 必须先发布并获确认的 `task_started { task_id, turn_id }`，再发布该 turn reply；旧 turn final 不得提交到新 turn。中断栅栏后的消息分配后继 task，不能 steer 到正在取消的 run。
- **任务 assignment**：父端在调用 Pi 前发布 `task_assignment { message_id, task_id }` 并等待 transport ACK，child 据此把后续 prompt/steer 与任务身份绑定。应用 listener 重入产生的高序帧不能越过当前 receive 生成的低序 ACK；Stream 与 Managed RPC 适配器遵循同一出站顺序。
- **唤醒规则**：工作中 `message` 在父代理空闲时，`requires_response: true` 才触发模型；`false` 只进入会话。父代理正在运行时，两者都作为 steering 进入当前处理；父代理正在 `wait_agent` 时，任何已接纳的工作中消息都让等待返回 `outcome: reply`，不改变子代理生命周期。final 和 TerminalNotice 在父代理空闲时都触发处理。
- **递归收尾顺序**：child runtime 的 raw `agent_settled` handler 只记录 provisional settlement 并立即返回，final 发布和 ACK 在 callback 外异步完成，因而不会阻塞同一事件上的第三方压缩 handler。自动重试发生在 `agent_end` 与 `agent_settled` 之间时，沿用当前 `task_id` 并等待后继 `agent_start`；压缩在 provisional settlement 后开始时撤销候选并等待新 `agent_start`；处理中压缩不要求新 turn。恢复后保持 `task_id`、更新 `turn_id`，旧候选与旧 turn final 被隔离。
- **双条件提交**：final 先以唯一 `commit_id` prepare；仅当匹配 task/turn 的 settlement 可提交、压缩未活动、任务正文已排空且父会话成功接纳 final 时，才从 `prepared` 单调推进到 `accepted`，发送 reply ACK，记录 `last_task` 并允许静止节点进入 `idle`。重复 commit 幂等，final 或 settlement 任一单独到达都不得伪造完成。
- **压缩不确定性**：第三方压缩不提供可预先取得的 maintenance lease。压缩失败进入 `suspended/maintenance_failed`；settlement 后压缩成功但有界复核内未出现恢复 start 时进入 `suspended/resume_required`，不自动重跑、不猜测成功。
- **收尾失败边界**：final 无法形成或 ACK 失败时，协调器进入 terminal failure、废止当前 task/turn，并通过独立故障通知让祖先节点失败关闭；已准备但未提交的 final 不得变成 `last_task`。因为发布发生在 callback 外，失败不依赖 raw settled handler rejection，也不能由后代回复恢复。
- **mailbox 单写者**：父消息接纳、task assignment、Pi prompt/steer、interrupt 栅栏、生命周期、压缩、reply 与 ACK 在每节点唯一 reducer 中线性化。`accepted: true` 只证明插件已分配 `message_id/task_id` 并接纳正文；后续 Pi command rejection 或 EOF 不能倒写该事实，而应保守投影为 `suspended/delivery_uncertain`。
- **父代理追问规范**：父代理收到 child final 后，如果 `output_state: absent`，或父代理判断 `present` 正文仍不可用，必须向同一 `agent_id` 尝试发送“仅总结上一轮已完成工作、不要重新执行任务”的追问。协议不规定追问次数、计数器或上限；父代理运行时不能保证模型一定调用 `send_message`。后续是否继续由父代理根据上下文决定。
- **恢复边界**：当前插件不自动追问、不自动 fallback、不自动创建新代理、不自动完整重跑原任务。`provider_error`、`runtime_fault` 和副作用安全性只作为父代理决策事实，不携带 `retryable` 或恢复建议。
- **final 唯一性**：同一 task/turn 只接受第一个 final，且 `commit_id` 不复用。Child runtime 通过 assignment、started identity 和 settled latch 防止跨轮提交；父端按 reply/commit 身份去重，对迟到或不匹配 final 隔离而不覆盖、不再次唤醒。普通工作中回复可以有多条。
- **传输幂等**：相同 `reply_seq` 且信封语义相同的重放不重复注入父会话，但重复 ACK；相同 `reply_seq` 携带不同信封属于协议错误。父端在节点生命周期内只保留已接纳信封的 SHA-256 语义摘要用于窗口外重放判定，不保留正文，也不形成回复或追问额度。`reply_seq` 只表达传输顺序，不表达模型结果。
- **父会话展示**：TUI 隐藏原始 JSON，展示消息类型、发送者、结果状态和自然语言正文；`turn_id`、`reply_seq` 和 schema 版本不作为主要展示内容。状态说明由 renderer 根据固定字段本地生成。
- **等待和状态查询**：`wait_agent` 返回 `reply`、`task_completed`、`task_failed`、`task_interrupted`、`suspended`、`timeout` 或 `terminal`，不再用 `settled` 混合表达 idle 与任务结果。任务结果和快照只保留安全 `last_task` 身份/枚举，不复制 final 正文；状态原子公开 mailbox、宿主和 reply outbox 三类计数及正交 activity phase。
- **安全边界**：结构化信封不得包含 prompt、思考块、图片块、工具参数、工具结果、文件路径、环境、凭据、进程号、句柄、堆栈或原始 provider 异常。父子业务通信只使用有界文本。
- **文档边界**：同一 v5 协议的 `/reload` 保留活动节点、mailbox 和未确认 reply；v4 到 v5 是明确的破坏性边界，必须重建代理树。README、提示词、工具描述、TUI、领域词汇和 ADR 必须同步说明 mailbox 接纳、任务级等待与 suspension。

## Testing Decisions

- **测试原则**：测试观察到的父会话消息、工具结果、节点状态、唤醒行为、ACK 和重放行为，不测试私有字段布局或单个函数调用次数，除非该调用次数本身是公开幂等契约的一部分。
- **最高测试接缝**：以统一的 reply/terminal envelope codec 作为新增接缝。所有边界测试通过该接缝与既有 `ChildReplyCoordinator`、`SupervisorChannel`、`ParentReplyInbox` 和 `AgentController` 的公开行为完成，避免为 child、wire 和 TUI 各维护一套测试专用解析器。
- **信封 codec 测试**：覆盖 message/final/terminal 的必需字段、UUID `task_id/turn_id/commit_id`、枚举、文本边界、`images` 拒绝、未知字段忽略、缺字段拒绝、task/turn 语义不一致拒绝，以及 JSON 字段顺序与空白不影响解析。
- **ChildReplyCoordinator 测试**：覆盖 assignment 消费、`task_started` ACK、同任务多 turn、工作中消息身份、raw settlement 立即返回、final 后台 ACK、settlement 后压缩撤销、处理中压缩保持任务、stale turn 隔离、正常无输出、provider error、interrupted partial output、图片-only 转 absent 和 final failure。
- **SupervisorChannel 测试**：迁移到 v5，覆盖 `task_assignment`/`task_started` 累计 ACK、`reply_seq + envelope`、重放幂等、窗口外篡改、乱序恢复和旧协议拒绝。加入确定性重入交错：receive 生成的低 seq ACK 必须先于 listener 同步发布的高 seq 应用帧入队，Stream 与 Managed RPC 都不得死锁。
- **ParentReplyInbox 测试**：验证父会话收到的正文是模型可见 JSON，验证 `agent_id` 来源、message 的 `requires_response` 空闲唤醒矩阵、final/terminal 的固定唤醒、工作中消息的 `wait_agent` 通知、纯文本投递和 TUI 语义渲染；覆盖收尾屏障对 final、需响应 message 和 TerminalNotice 的统一暂缓，以及 final 失败后屏障不可恢复。
- **AgentTaskMailbox/Controller 测试**：确定性交错并发 submit、prompt/steer 路由、中断后的后继任务、Pi command rejection 的 delivery uncertainty、压缩恢复、stale turn 与双阶段 final。验证 `wait_agent` 七类 outcome、`last_task` 不复制正文、工作中 reply 去重和三类队列/phase 原子投影。
- **递归时序测试**：在 child 的 runtime handler 后注册会调用 compact 的第三方 settled handler，证明本扩展 callback 不等待 final ACK；显式同步 parent/leaf settlement，验证 grandchild spawn、interrupt 后继任务、跨实例 reload 和 final projection 不会因 ACK/control frame 顺序死锁。
- **父代理协调规范测试**：使用模型可观察的工具描述或提示契约测试验证：无输出 final 以及父模型判断现有正文不可用时，规范要求使用同一 `agent_id` 追问；不把该要求伪装为运行时强制保证；没有自动 fallback 或自动任务重跑行为。
- **端到端测试**：在本地 fake Pi RPC 和父子 runtime 旅程上覆盖工作中消息、双条件 final、协作式中断、处理中/settlement 后压缩、delivery uncertainty、suspension、递归 spawn、reload 和运行时故障，验证消息只进入直接父会话。
- **reload 测试**：同版本 reload 验证 mailbox、已接纳 reply、活动任务身份和控制器认领保持；v4/v5 转换明确拒绝旧协议并要求重建，不验证跨主版本热接管。
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
- 跨 v4/v5 的协议兼容、跨版本 `/reload` 活动节点接管或旧树自动迁移。
- 子代理跨根会话、Pi resume/fork 或根关闭后的持久恢复。
- 自动判断业务正文质量；`present` 但不可用的判断由父代理协调规范要求模型自行处理。
- macOS/Linux 原生进程树验证和平台支持结论；这些继续遵循既有独立计划边界。
- 性能、吞吐、延迟、token/费用和内存指标。

## Further Notes

- 本规格补充既有代理树基础规格和三个受管 RPC/直接监督 ADR，不改变代理树权威、直接父子通信、生命周期八态、终止屏障或资源回收边界。
- 父代理追问属于模型协调规范，协议不追踪追问次数或额度；运行时只负责交付结构化 final/terminal、唤醒父代理和报告节点事实。
- `output_state: present` 只证明运行时保留了文本，不证明业务质量。父代理认为内容不可用时仍必须尝试同一子代理追问。
- 未知字段忽略策略仅适用于新结构化信封；监督帧的认证、身份、长度、序号、ACK、重同步和安全边界仍由父子监督通道负责。
- 已同步更新领域词汇中关于逻辑任务、处理轮次、最终提交、任务队列、运行时重载和 v5 监督通道的描述；实现由 mailbox、统一 codec、child 协调器、监督适配器、父端 inbox/TUI 和确定性并发测试共同覆盖。
- 实现完成后已运行 `npm run check`、聚焦 runtime/bridge 测试和独立 code review；最终提交前以最新工作树的完整检查结果为准。
