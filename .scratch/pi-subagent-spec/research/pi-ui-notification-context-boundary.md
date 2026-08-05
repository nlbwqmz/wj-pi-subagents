# Pi UI 通知与 AgentSession 上下文边界研究

> 研究基线：`D:\code\open-source\pi` 提交 `a96fb984d8c8b065fc5d193309fc812a882adee0`。
>
> 研究问题：扩展在根会话 `session_start` 钩子中调用 `ctx.ui.notify` 时，通知是否只用于用户界面而不会进入 `AgentSession` 的 user/assistant 消息、系统提示词、会话历史或模型上下文；RPC 与非交互模式如何表现。
>
> 证据范围：只引用上述固定提交中的 Pi 官方源码、官方仓库文档和该提交已有测试；没有修改上游仓库，也没有将本报告结论外推到其他提交。

## 结论摘要

可以。`ctx.ui.notify(message, type?)` 是 Pi 已有的 UI-only 通道，适合在根会话启动时给用户显示“哪些模板配置有问题”的汇总警告。固定提交中的实现没有向 `AgentSession`、`SessionManager` 或 Agent 消息数组追加任何内容：

- TUI 模式把通知直接渲染到当前交互界面的显示容器；
- RPC 模式把通知作为独立的 `extension_ui_request` JSON 行发给客户端，属于扩展 UI 子协议，不是 `AgentSessionEvent` 或会话消息；
- print 和 JSON 非交互模式没有 UI 上下文，`notify` 是 no-op，不会输出可见通知；
- 真正进入模型上下文的扩展消息使用 `pi.sendMessage()` / `sendUserMessage()` 等消息 API，而不是 `ctx.ui.notify()`。

因此，模板诊断应使用一次聚合的 `ctx.ui.notify(..., "warning")`，而不要使用 `sendMessage`、`sendUserMessage` 或 `appendCustomMessageEntry`。不过 UI 通知是非持久、fire-and-forget 的展示信号：RPC 客户端可以忽略它，TUI 也可能在界面重建时清除它（重建聊天时会先清空 `chatContainer`：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3708)）。它不适合作为可恢复的审计记录。

## 研究边界与验证方法

- 通过 `git rev-parse a96fb984d8c8b065fc5d193309fc812a882adee0` 核实目标提交存在；上游工作树在研究前后均未发现改动。
- 逐段检查 `ExtensionUIContext` 类型、扩展运行器绑定、TUI/RPC/print 实现、`AgentSession.bindExtensions()`、会话上下文构建，以及 `session_start` 通知回归测试。
- 没有启动 Pi 服务或运行会改变上游工作树的命令；本报告不声称重新运行了测试。

## 详细核查

### 1. 公开 API 的语义是 UI 通知

`ExtensionUIContext` 将 `notify` 定义为“向用户显示通知”，而不是发送消息的接口；同一接口还包含对话框、状态栏和 TUI 方法：[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:127)、[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:131)。`notify` 的公开签名只有文本和展示级别 `info | warning | error`：[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:141)。扩展上下文把它暴露在 `ctx.ui` 下，并将 `hasUI` 单独定义为“是否有可用于对话的 UI”：[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:307)、[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:310)。

官方扩展文档把 `ctx.ui.notify` 放在 Dialogs/UI 示例中，并标注为“non-blocking”：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2481)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2496)。文档的 `session_start` 示例也直接在启动钩子中调用它：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:392)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:397)。这与“根会话发现模板后给用户一次提示”的使用场景一致。

需要区分两类 API：

| API | 固定提交中的语义 | 是否进入模型上下文 |
| --- | --- | --- |
| `ctx.ui.notify()` | 非阻塞 UI 通知 | 否，见下文实现链路 |
| `pi.sendMessage()` | 向会话注入自定义消息 | 是；官方文档明确写明 custom messages participate in LLM context：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1388) |
| `pi.sendUserMessage()` | 注入实际 user message，并触发一轮 | 是；官方文档明确说明它表现为用户输入：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1411) |
| `pi.appendEntry()` | 持久化 TUI-only 自定义条目 | 不进入 LLM context，但会写入会话条目；官方文档将它作为持久化 UI 内容的另一条路径：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1390)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1588) |

实现模板诊断时只能把“展示给用户”的内容放到 `notify`；不要把诊断字符串伪装成自定义消息，否则会改变模型上下文和会话语义。

### 2. `session_start` 时 UI 上下文已经绑定

`AgentSession.bindExtensions()` 先保存调用方提供的 UI 上下文和模式，再应用扩展绑定，随后才发出 `session_start` 事件：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:2232)、[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:2252)。因此，调用方只要在绑定时提供了 TUI 或 RPC UI 上下文，`session_start` 处理器即可调用 `ctx.ui.notify`。

扩展运行器的 `emit()` 为每个事件创建上下文并把同一个 `ctx` 传给处理器：[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:801)、[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:805)。`ctx.ui` 是延迟 getter，读取时返回当前运行器绑定的 UI 上下文；它没有经过消息队列或 Agent prompt 路径：[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:673)、[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:677)。

TUI 初始化顺序也明确保证了这一点：Pi 先启动 UI，再初始化扩展，使 `session_start` 处理器能够使用交互对话框：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:880)。随后 TUI 绑定自己的 UI 上下文并以 `mode: "tui"` 调用 `session.bindExtensions()`：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1792)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1795)。

固定提交还有一个针对启动通知时序的回归测试，测试名称直接称其为 `session_start transient UI`：[5943-session-start-notify.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:255)。测试中的扩展在 `session_start` 调用 `ctx.ui.notify`，测试 harness 收到的是独立的 `notify:Hello Error` 事件记录，而不是消息事件：[5943-session-start-notify.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:276)、[5943-session-start-notify.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:292)、[5943-session-start-notify.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:305)。测试还验证 reload 的 `session_start` 通知次序：[5943-session-start-notify.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:418)、[5943-session-start-notify.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:434)。

### 3. TUI 实现只修改显示组件

TUI 的 `createExtensionUIContext()` 把 `notify` 映射到 `showExtensionNotify()`：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2322)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2324)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2327)。`showExtensionNotify()` 只按级别调用 `showError`、`showWarning` 或 `showStatus`：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2623)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2626)。

这三个显示方法的写入目标是 TUI 的 `chatContainer`：

- `showStatus()` 创建/更新一个 `Text` 和 `Spacer`，然后只请求 TUI 重绘：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3369)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3375)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3386)。
- `showError()` 和 `showWarning()` 也只向 `chatContainer` 添加显示组件并请求重绘：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4059)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4065)。

这些代码路径没有调用 `SessionManager.appendMessage()`、`appendCustomMessageEntry()`、`AgentSession.sendMessage()` 或 `AgentSession.sendUserMessage()`。因此通知虽然可能看起来位于 TUI 的“聊天”区域，但它只是当前 UI 树里的显示节点，并不是 user/assistant message 或 session entry。它不能被会话恢复、分支遍历或模型 prompt 读取。

通知的非持久性还有一个实际表现：`showStatus()` 对连续状态通知会更新已有显示行而不是无限追加，源码注释称这是为了避免日志噪音：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3370)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3380)。这进一步说明它是展示状态，不是历史消息记录。

### 4. 为什么通知不会进入 AgentSession 历史或模型上下文

Pi 的会话上下文有明确的条目到消息映射边界。`sessionEntryToContextMessages()` 只把 `message`、`custom_message`、分支摘要和压缩摘要条目投影成 Agent 消息；普通自定义条目直接返回空数组：[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:379)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:383)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:396)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:407)。`buildSessionContext()` 从当前会话路径构造条目，再调用这个映射生成发送给 LLM 的 `messages`：[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:456)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:461)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:468)。

SessionManager 的公开注释把 `buildSessionContext()` 定义为“what gets sent to the LLM”，并把 `buildContextEntries()` 定义为上下文/渲染所用的活动条目列表：[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1272)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1276)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1280)。而写入历史的 `appendMessage()` 会显式创建 `type: "message"` 条目并调用内部持久化：[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1051)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1057)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1065)。

`ctx.ui.notify` 的 TUI 实现没有走上述任何写入或投影函数；它只操作 `chatContainer`。因此可以逐项确认：

1. 不会创建 `role: "user"` 或 `role: "assistant"` 的消息。
2. 不会创建 `SessionEntry`，也不会进入 SessionManager 的 JSONL 历史、`getEntries()`、分支或恢复路径。
3. 不会改变 AgentSession 的 `agent.state.messages`。
4. `notify` 这一次调用不会改变系统提示词。系统提示词在扩展资源发现等专门路径中重建；`notify` 的调用链没有访问或更新 `agent.state.systemPrompt`。如果同一个 `session_start` 处理器另外调用了追加系统提示词或资源注册 API，那是另一条显式路径，不能归因于通知。
5. 不会进入发送给模型的 `buildSessionContext().messages`。

这与官方文档对消息 API 的反向说明相互印证：`pi.sendMessage()` 明确“Custom messages participate in LLM context”，而 `pi.appendEntry()` 被明确指定为不发送给 LLM 的持久 TUI 内容：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1388)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1390)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1588)。`notify` 比 `appendEntry` 更轻：它连会话条目都不写，只做即时 UI 展示。

### 5. RPC 模式是同一边界的出站 UI 子协议

RPC 模式的文件头把 Extension UI 单独列为“Extension UI requests”，并明确普通 AgentSession 事件与扩展 UI 请求是两类输出：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:1)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:7)。RPC 的 `output()` 接受 `RpcResponse | RpcExtensionUIRequest | object`，直接序列化到 stdout：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:50)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:60)。

RPC UI 上下文的 `notify()` 实现是：生成唯一 ID，输出 `type: "extension_ui_request"`、`method: "notify"`、消息和级别，然后立即返回；源码注释明确这是 fire-and-forget，不需要响应：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:133)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:152)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:161)。RPC 在绑定扩展时把这个 UI 上下文和 `mode: "rpc"` 传给 `session.bindExtensions()`：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:317)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:319)。

协议类型把通知定义成单独的扩展 UI stdout 事件，字段为 `type`、`id`、`method: "notify"`、`message` 和可选 `notifyType`：[rpc-types.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:233)、[rpc-types.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:237)、[rpc-types.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:250)。官方 RPC 文档进一步把 `notify` 归类为 fire-and-forget 方法，客户端可以显示或忽略，不会回写响应：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1144)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1148)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1150)。具体通知示例也写明“Display a notification. Fire-and-forget, no response expected”：[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1237)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1249)。

RPC 的示例客户端收到 `method: "notify"` 后只把它追加到自己的输出日志并请求 TUI 重绘：[rpc-extension-ui.ts](D:/code/open-source/pi/packages/coding-agent/examples/rpc-extension-ui.ts:434)、[rpc-extension-ui.ts](D:/code/open-source/pi/packages/coding-agent/examples/rpc-extension-ui.ts:438)。它没有把通知转换成 `prompt`、`sendMessage` 或会话条目。因此 RPC 客户端看到的是“出站 UI 信号”，不是模型可读消息。

RPC 实现还把普通会话事件通过 `session.subscribe()` 转成 JSON 事件，而通知直接调用 `output()`；两者是不同代码路径：[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:353)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:355)。这为规格提供了清晰边界：通知可以展示在宿主 UI，但不得被宿主误当作会话历史或模型消息。

### 6. print/JSON 非交互模式不会显示通知

扩展运行器预置了 `noOpUIContext`，其中 `notify` 是空函数：[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:235)、[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:239)。当没有提供 UI 上下文时，`setUIContext()` 使用这个 no-op，并把运行模式设置为调用方传入的模式；`hasUI()` 通过是否仍为 no-op 判断：[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:433)、[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:442)。

print mode 的 `rebindSession()` 只绑定 `mode: "print"` 或 `mode: "json"`，没有传 `uiContext`：[print-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/print-mode.ts:74)、[print-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/print-mode.ts:76)。因此在这两种模式下，扩展仍能收到 `session_start`，但调用 `ctx.ui.notify()` 不会产生任何 stdout UI 行，也不会进入消息或模型上下文。

官方扩展文档把模式边界写得更直接：`ctx.hasUI` 在 TUI/RPC 为 `true`，在 `-p` print 和 JSON 为 `false`；通知等 fire-and-forget UI 方法应以它作为可用性条件：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:940)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:944)。模式表也明确 JSON 的 UI 方法是 no-op、print 扩展可以运行但不能 prompt：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2892)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2896)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2898)。

因此，“标准非交互模式下是否存在同等 UI-only 通道”的答案是：没有可见的 `notify` 通道。非交互调用方若必须看到诊断，应另行约定 stderr 或专用结构化诊断事件；不能把 `ctx.ui.notify` 当作可靠输出，也不应为此改用会污染模型上下文的消息 API。自定义 SDK/宿主如果主动通过 `AgentSession.bindExtensions({ uiContext, ... })` 提供了自己的 `ExtensionUIContext`，则输出语义由该宿主实现决定；这不改变标准 print/JSON 模式的 no-op 结论。

## 面向模板发现的实施建议

### 推荐调用方式

根会话完成模板发现和配置校验后，收集所有无效模板，按稳定顺序生成一条简短汇总，再调用一次：

```ts
if (isRootSession && invalidTemplates.length > 0 && ctx.hasUI) {
  ctx.ui.notify(formatInvalidTemplateSummary(invalidTemplates), "warning");
}
```

这里的 `isRootSession` 必须由子代理扩展的控制层维护；Pi 的 `session_start` 事件本身会在启动、reload、新会话、恢复和 fork 等场景触发：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:392)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:397)。不能仅凭“当前发生了 `session_start`”推断这是根会话，否则子代理也会重复提示。

格式化内容只应包含可安全公开的模板标识、来源类别/路径和简短错误原因，例如：

```text
发现 2 个模板配置无效，已忽略：
- project:reviewer（.pi/agents/reviewer.md）：缺少必填 tools
- user:planner（~/.pi/agent/agents/planner.md）：tools 必须是逗号字符串
```

不要把模板正文、环境变量、工作目录之外的秘密路径、模型凭据或异常对象完整堆栈放进通知。通知内容既会显示给交互用户，也可能经 RPC 原样发送给宿主客户端。

### 必须保持的上下文边界

- 对合法模板继续正常发现和枚举；无效模板只加入扩展自己的诊断集合，不创建可用模板条目。
- 无效模板诊断只通过 `ctx.ui.notify` 展示，不通过 `pi.sendMessage`、`pi.sendUserMessage`、`appendCustomMessageEntry` 或任何 prompt/system-prompt API 传播。
- 不为了让诊断在 TUI 中“看起来像历史”而调用 `pi.appendEntry`；该 API 会持久化 session entry。只有产品明确需要可恢复审计记录时才采用它，并单独接受“写入会话但不进入 LLM context”的语义。
- 对多个无效模板聚合为一次通知，避免多个 warning 造成 UI 噪音；TUI 的 `showStatus` 还会合并连续状态行，说明通知不应承担逐条历史记录职责：[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3370)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3380)。
- 根会话 reload 是否再次显示，应由扩展生命周期规则决定；每次实际调用 `session_start` 时 Pi 都会照常转发通知，但 Pi 不会自动去重。

### TUI、RPC、print/JSON 的契约

| 运行模式 | `ctx.hasUI` | `ctx.ui.notify` 的结果 | 规格要求 |
| --- | --- | --- | --- |
| TUI | `true` | 在当前交互界面显示；只改 UI 组件，不写 AgentSession | 可用于根会话一次性汇总警告 |
| RPC | `true` | 输出 `extension_ui_request(method: "notify")`；fire-and-forget | 宿主客户端必须消费并展示；不等待 ack，不假设一定可见 |
| JSON | `false` | no-op | 如需可见诊断，另定义 JSON 事件/协议；不要改用会话消息 |
| print | `false` | no-op | 如需可见诊断，另定义 stderr/CLI 诊断策略；不要改用会话消息 |

RPC 客户端必须把 `extension_ui_request` 与普通会话事件区分处理。协议中所有 UI 请求都有独立 `type` 和 `method` 字段：[rpc-types.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:237)、[rpc-types.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:250)。客户端可以忽略 fire-and-forget 通知，服务端没有确认通知是否已渲染的能力；因此它只能作为“尽力展示”，不能作为控制层已经向用户确认的事实。

## 建议的回归测试

固定提交已有启动通知时序测试，但没有把“AgentSession 消息和历史保持不变”作为 `ctx.ui.notify` 的公开断言。实现模板诊断时建议补充以下扩展测试（测试新增功能的仓库可以实现，不应修改本研究基线）：

1. 在 TUI harness 中于 `session_start` 调用 `ctx.ui.notify`，记录 `sessionManager.getEntries()` 和 `session.messages` 的快照；通知前后两者相同。
2. 让同一钩子调用 `pi.sendMessage` 作为对照，验证只有消息 API 会新增 `custom_message`/Agent 消息，从而防止后续维护者误把通知接到消息管线。
3. 在 RPC harness 中验证 stdout 出现 `extension_ui_request` 且 `method === "notify"`，同时 `get_entries` / `get_messages` 结果不包含通知文本。
4. 在 print 和 JSON harness 中验证 `ctx.hasUI === false`、`ctx.mode` 分别为 `"print"`/`"json"`，调用 `notify` 不产生 UI 输出。
5. 在根/子代理两层都触发 `session_start`，验证只有根控制层发出汇总通知，子代理不重复展示。

## 最终判定

对当前规格问题的直接回答是：**有这种方式，使用 `ctx.ui.notify`；在 TUI 中它只展示给用户，不进入 user/assistant 消息、系统提示词、会话历史或模型上下文。RPC 中它会作为独立 UI 子协议事件发给宿主，同样不进入 AgentSession，但宿主可以忽略。print/JSON 中没有可见 UI 通道，`notify` 静默 no-op。**

因此“根会话开始时提示无效模板”的首选实现是：根控制层在模板发现完成后聚合诊断，若 `ctx.hasUI` 为真则调用一次 `ctx.ui.notify(summary, "warning")`；无效模板本身不进入发现目录，也不借助任何会话消息 API传播。

## 固定提交源码索引

| 主题 | 文件与行号 |
| --- | --- |
| `ExtensionUIContext.notify` 公开类型 | [types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:127)、[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:131)、[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:141) |
| no-op UI 与 `hasUI` | [runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:235)、[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:433)、[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:442) |
| session_start 绑定与发出 | [agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:2232)、[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:2252) |
| TUI notify 显示实现 | [interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2322)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2626)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3375)、[interactive-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4059) |
| RPC notify 出站实现 | [rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:60)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:152)、[rpc-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:161) |
| RPC UI 请求协议/文档 | [rpc-types.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:237)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1144)、[rpc.md](D:/code/open-source/pi/packages/coding-agent/docs/rpc.md:1237) |
| print/JSON no-op 行为 | [print-mode.ts](D:/code/open-source/pi/packages/coding-agent/src/modes/print-mode.ts:74)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:944)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2898) |
| AgentSession 上下文投影 | [session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:379)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:461)、[session-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/session-manager.ts:1280) |
| 启动通知回归测试 | [5943-session-start-notify.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:255)、[5943-session-start-notify.test.ts](D:/code/open-source/pi/packages/coding-agent/test/suite/regressions/5943-session-start-notify.test.ts:276) |
