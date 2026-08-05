# 确定父会话控制工具契约

Type: grilling
Status: resolved
Blocked by: none

## Question

父会话管理直接子代理所需的职责单一工具应采用哪些最终名称、参数、返回值、状态前置条件和稳定错误码？契约必须覆盖创建、`send_message`、等待、中断当前处理、终止并级联清理、查询指定子代理状态、按权限查看代理树，以及子代理在不中止当前任务时向直接父会话回传进度/结果消息，同时保持已确定的父子通信、深度限制和最大深度工具隐藏语义。

## Answer

本票据确定 Pi Subagent 扩展的父会话控制面采用职责单一的工具集合。控制器只允许父会话操作自己的直接子代理；根会话可只读查看整棵树，但任何树视图都不扩大控制权限。

### 共通约定

- 公开工具为 `spawn_agent`、`send_message`、`wait_agent`、`interrupt_agent`、`terminate_agent`、`get_agent_status` 和 `get_agent_tree`，不提供多模式通用工具。
- 定向工具只接受 UUID `agent_id`。控制器以随机 UUID v4 分配新标识，文本值使用 RFC 9562 canonical 小写格式且不带 `agent_` 前缀；标识在当前根会话内唯一、节点生命周期内稳定、终止后不复用。名称只用于展示，不能寻址或推断树结构。非 canonical UUID 文本返回 `invalid_argument`，格式正确但未注册返回 `agent_not_found`。
- 成功结果统一为 `{ "ok": true, "data": ... }`；预期失败以工具错误交给 Pi，使 `isError: true`，错误结构为 `{ "ok": false, "error": { "code", "message", "retryable", "details?" } }`。调用方只依赖稳定错误码，不依赖消息文本或 `details` 的具体结构。
- 公开生命周期状态固定为 `starting`、`idle`、`working`、`interrupting`、`failed`、`terminating`、`terminated`。待处理消息使用计数，不单独建 `queued` 状态；意外进程退出归入 `failed`，终止流程中的预期退出归入 `terminated`。
- 所有时间使用 UTC RFC 3339、固定毫秒精度和 `Z` 后缀；状态新旧顺序由单调 `revision` 判断，不能用时间字符串排序。

### `spawn_agent`

参数只有必填的 `template_id` 和 `name`：

```json
{ "template_id": "researcher", "name": "资料代理" }
```

创建操作不携带首条任务消息，也不允许调用方覆盖工作目录、环境、模型、工具、扩展、技能、系统提示、最大深度等权限字段。创建成功前必须启动 RPC 子进程、完成一次无副作用的 RPC 请求与响应并进入可通信的 `idle`；该就绪确认不证明最终模型、工具或资源快照。首条及后续任务统一由 `send_message` 发送。

成功最小结果为：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "资料代理",
    "template_id": "researcher",
    "depth": 1,
    "state": "idle"
  }
}
```

创建前原子预留父节点名额和登记关系；预留或启动失败必须释放残留资源和名额。达到深度上限返回 `max_depth_reached`；直接子代理名额已满返回 `max_children_reached`；启动阶段失败或 RPC 通信/协议确认失败返回 `spawn_failed`；在启动期限内未进入 `idle` 返回 `spawn_timeout`。

### `send_message`

参数必须包含直接子代理 `agent_id` 和非空文本，可选图片沿用 Pi `ImageContent`：`data` 是不带 `data:` 前缀的原始 Base64，`mimeType` 单独传递。扩展负责长度、Base64 和 MIME 校验。

控制器向子代理发送单条 RPC `prompt`，固定使用 `streamingBehavior: "steer"`：空闲节点开始处理，繁忙节点引导当前处理。消息被 RPC 接受或进入 steering 队列后立即成功，不等待任务完成，也不区分 `started`/`steered`。

成功结果为：

```json
{
  "ok": true,
  "data": { "message_id": "msg_...", "accepted": true }
}
```

`message_id` 由控制器生成，在根会话内唯一且不复用，调用方不能自定义。节点处于 `interrupting` 时消息排在中断之后交付；进入 `failed`、`terminating` 或 `terminated` 时返回 `agent_unavailable`。RPC 在确认接受前失败使用 `message_delivery_failed`；若接受状态未知，不建议自动重试以避免重复。

子代理普通 assistant 回复通过直接父子上行通道到达父控制器，再注入父会话；不新增 `report_progress` 或 `send_parent_message` 工具，也不强制任何固定的“汇报后暂停”提示语。父会话模型自行决定后续是否发送新消息。

### `wait_agent`

参数为一个必填直接子代理 `agent_id`，可选 `timeout_ms`。默认值按单次参数、根启动参数、项目配置、用户配置、内置默认值的优先级解析；默认回退值为 `60000` 毫秒。单次值必须在代码固定的 `10000..600000` 毫秒范围内，越界为 `invalid_argument`；超时只结束本次等待，不改变子代理。

等待边界使用 Pi 的 `agent_settled`，不使用 `agent_end`。返回只含等待结论和最新安全状态元数据，不重复携带 assistant 回复或图片：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "outcome": "settled",
    "state": "idle",
    "revision": 12,
    "observed_at": "2026-08-04T04:34:57.123Z"
  }
}
```

`outcome` 只有 `settled`、`terminal`、`timeout`。调用时已空闲或收到 `agent_settled` 返回 `settled`；目标已处于或等待期间进入终态返回 `terminal`；期限到达返回 `timeout`。`state: "failed"` 时结果附带 `data.error`。

### `interrupt_agent`

这是协作式中断，不是终止。控制器校验并接纳请求后立即返回，不等待 RPC `abort` 响应或 `agent_settled`；完成与失败由状态查询、等待和事件观察。

新中断返回：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "accepted": true,
    "changed": true,
    "state": "interrupting"
  }
}
```

对 `idle`、`interrupting`、`failed`、`terminating`、`terminated` 的调用均幂等成功，`changed: false`，准确状态直接由 `state` 表示；`failed` 另附 `data.error`。中断保留 RPC 节点及上下文，不清除 Pi 已接受的 steering，不自动重建或升级为终止。工具或模型不响应取消时保持可观测的 `interrupting`，父会话可显式调用 `terminate_agent`。

### `terminate_agent`

终止始终递归覆盖目标及其全部后代，不接受 `cascade` 开关或单节点模式。它是不可逆的同步操作，固定先优雅关闭，在代码规定的内部收尾边界后对未退出节点执行平台级进程树强制回收；该边界不复用 `wait_agent.timeout_ms`。

接纳后，目标原子进入 `terminating` 并成为同节点命令通道的终止屏障：拒绝新普通命令，取消尚未写入 RPC 的待处理命令，可抢占无响应中断。已经被 Pi 接受的消息不追溯撤回。并发终止调用合并到同一清理流程；目标已终止时幂等成功，故障节点会重新执行清理确认。

只有目标和整棵子树都进入 `terminated` 并确认资源回收后才返回成功：

```json
{
  "ok": true,
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "state": "terminated",
    "changed": true,
    "forced": true,
    "terminated_count": 4
  }
}
```

`forced` 表示共享终止流程是否使用过强制阶段；`terminated_count` 统计该流程中实际转为 `terminated` 的目标及后代，纯幂等调用为 `0`。优雅阶段失败但强制回收最终成功仍是 `ok: true`；强制后仍无法确认退出返回可重试的 `termination_incomplete`，并在 `details` 列出未确认节点和阶段。

终止节点在当前根会话内保留为终止记录：状态和树查询仍可见，但不占直接子代理名额、不接收消息、不恢复，标识不复用；根会话结束时统一释放。

### `get_agent_status`

只接受一个必填的直接子代理 `agent_id`，立即返回控制器最近确认的安全快照；不等待事件、不触发 Pi 请求、不改变节点或队列状态。快照包含身份字段（`agent_id`、`name`、`template_id`、`depth`）、`state`、`pending_message_count`、单调 `revision` 和 `observed_at`。故障节点成功查询仍为 `ok: true`，在 `data.error` 中提供 `code`、`message`、`retryable` 和故障时间；健康节点省略该字段。

### `get_agent_tree`

无目标参数，控制器根据调用者身份自动裁剪只读视图：根会话查看整棵树，非根父会话查看自身及后代子树。`data.scope` 为 `{ "kind": "root" }` 或 `{ "kind": "subtree", "agent_id": "550e8400-e29b-41d4-a716-446655440000" }`，调用方不能传入任意查询目标。

每次返回一个单一 `tree_revision` 下捕获的完整快照，不暴露增量、游标或事件确认协议。节点用扁平 `nodes` 列表表示，按父节点优先和稳定创建顺序排序：

```json
{
  "ok": true,
  "data": {
    "scope": { "kind": "root" },
    "tree_revision": 42,
    "observed_at": "2026-08-04T04:36:12.004Z",
    "nodes": [
      {
        "agent_id": "550e8400-e29b-41d4-a716-446655440000",
        "name": "资料代理",
        "template_id": "researcher",
        "parent_agent_id": null,
        "depth": 1,
        "state": "working",
        "pending_message_count": 0,
        "revision": 18,
        "observed_at": "2026-08-04T04:36:11.998Z"
      }
    ]
  }
}
```

根会话不伪装成可寻址节点，根的直接子代理使用 `parent_agent_id: null`。非根快照以当前父代理作为隐式根并隐藏真实祖先；其自身记录为作用域根，后代只引用可见父节点，`depth` 仍是整棵树的全局深度。树节点不包含消息/回复正文、图片、进程或 RPC 句柄、环境和配置秘密；故障节点才附带 `error`。

### 稳定错误码

公开错误码采用闭合集合：

| 错误码 | 含义 | 重试规则 |
| --- | --- | --- |
| `invalid_argument` | 参数缺失、类型、范围、长度、Base64 或 MIME 无效 | 不可重试，先修正参数 |
| `agent_not_found` | 标识不在当前根会话注册表或属于其他根会话 | 不可重试 |
| `not_direct_child` | 节点存在但不是调用者的直接子代理 | 不可重试 |
| `template_not_found` | 模板经来源和权限过滤后不可用 | 不可重试 |
| `template_invalid` | 模板存在但格式或字段无效 | 不可重试 |
| `template_capability_unavailable` | 模板有效，但当前父会话的有效授权不能满足其必需能力 | 不可重试；需更换模板或父会话配置 |
| `max_depth_reached` | 当前节点达到根会话深度上限 | 不可重试 |
| `max_children_reached` | 当前父节点直接子代理名额已满 | 完成一个子代理终止清理后可重试 |
| `max_tree_agents_reached` | 当前根会话的全树代理名额已满 | 完成任一节点终止清理并释放全树名额后可重试 |
| `spawn_failed` | 进程启动、提前退出、RPC 通信就绪确认或协议失败 | 按具体原因决定 |
| `spawn_timeout` | 启动期限内未进入可通信 `idle` | 可重试 |
| `agent_unavailable` | 直接子代理存在但其状态不再接受该操作 | 不可重试 |
| `message_delivery_failed` | 消息未获接受确认 | 仅能证明未被接受且目标仍可用时可重试 |
| `termination_incomplete` | 强制清理后仍无法确认全部资源退出 | 可重试幂等终止 |
| `internal_error` | 无法归类的控制器内部异常 | 由具体错误实例决定 |

不提供 `template_not_allowed`、配置文件错误码或底层阶段专用码。`details` 可携带安全诊断信息，例如字段路径、失败阶段和未确认节点，但不能泄露秘密。

### 配置、配额与工具可见性

- 用户级扩展配置固定为 `~/.pi/agent/subagent.json`，项目级配置为 `<cwd>/.pi/subagent.json`。项目级覆盖用户级；根启动参数可覆盖文件配置。
- 配置不设版本字段。文件缺失或某个字段未提供是正常空配置，未提供字段继续按低优先级层解析；已获信任的用户级或项目级配置文件不可读、JSON 无法解析或已知配额字段值无效时，该字段直接采用对应内置默认值，不回退到更低优先级层，并通过根会话 UI-only warning 告知用户。未知字段（包括不支持的 `maxWaitTimeoutMs`）通过同一 UI-only warning 提示后忽略。显式根启动参数非法时直接拒绝根会话启动；这些配置诊断不进入会话消息或模型上下文。
- `wait_agent.timeout_ms` 的单次合法范围由代码固定为 `10000..600000` 毫秒，默认值为 `60000`；等待默认值仍可按既有单次参数、根启动参数、项目配置、用户配置和内置默认值优先级解析，超时只结束本次等待，不改变节点。
- `maxDepth`、`maxChildrenPerAgent` 与 `maxAgentsPerTree` 三个根配额值在根启动时一次确定并传给整棵树，后代不能提高；其默认值、合法范围、硬上限、原子预留和耗尽行为由 06 号票据冻结。每个父会话的直接子代理独立计数；全树名额统计根之外尚未 `terminated` 的节点。
- 创建前原子预留直接子代理名额；除 `terminated` 外的公开状态都占用名额。只有节点及其子树完成资源回收后释放名额，终止记录仍可见但不计数。
- 七个管理工具作为不可拆分的“子代理管理能力”整体暴露或整体移除。节点只有在直接父会话仍具备该能力、模板 `subagents` 未设为 `disabled` 且自身 `depth < maxDepth` 时才完整获得这七个工具；任一条件不满足时整组隐藏。`maxDepth` 仍是不可突破的硬上限，服务端始终重复校验深度，绕过工具发现的创建请求仍返回 `max_depth_reached`。

### 并发与后续边界

每个子代理拥有独立的状态变更命令串行通道；同一目标的消息、中断和终止按控制器顺序协调，不同节点可并行。状态查询、树查询和一个或多个等待者不占该通道。`spawn_agent` 在父节点原子预留名额并登记关系后，可以并行启动不同子进程。状态、配额和树版本更新必须原子化，查询只能看到完整版本。

本票据只冻结公开控制工具契约。完整状态转换表由 03 号票据确定；模板发现与信任由 05 号票据确定；深度/数量默认值、硬上限和其他资源配额由 06 号票据确定；清理失败细节由 08 号票据确定；父子树协议和 RPC 监督器分别由 11、12 号票据验证。后续票据不得改变本票据已冻结的工具名称、直接父子权限边界和成功/错误外壳，除非显式重新打开本票据。

## Comments

- 2026-08-04：用户确认公开控制面采用职责单一的工具，覆盖创建直接子代理、发送父子消息、等待、中断当前处理、终止并级联清理、读取指定状态以及读取代理树视图；不提供多模式通用工具。
- 2026-08-04：用户澄清进度交互：父会话通过 `send_message` 发送 steering 请求，子代理需要通过直接父子上行通道把回复交回父控制器，再由父控制器注入父会话，而不是让子代理越级调用父代理管理工具。
- 2026-08-04：用户确认最终工具名为 `spawn_agent`、`send_message`、`wait_agent`、`interrupt_agent`、`terminate_agent`、`get_agent_status` 与 `get_agent_tree`。
- 2026-08-04：用户确认所有定向控制工具统一使用 `agent_id`；它在代理树内唯一、节点生命周期内稳定、根会话期间不复用，显示名称不参与寻址，调用者不得从其值推断树结构。
- 2026-08-04：用户确认所有控制工具统一返回 JSON：成功为 `{ ok: true, data }`，预期失败通过 `SubagentToolError` 使 Pi 标记 `isError`，其消息为 `{ ok: false, error: { code, message, retryable, details? } }`；调用方只依赖稳定的 `snake_case` 错误码，内部异常统一转换为 `internal_error`。
- 2026-08-04：用户确认 `spawn_agent` 只负责创建并完成握手，不携带首条任务消息；首条及后续父子消息统一通过 `send_message` 发送。
- 2026-08-04：用户将 `spawn_agent` 创建请求收紧为 `template_id` 与 `name` 均必填；不允许省略模板以使用默认值，也不允许创建匿名节点。`name` 仍只是可重复的展示标签，不参与寻址。
- 2026-08-04：用户确认 `spawn_agent` 返回 `agent_id`、`name`、`template_id`、`depth` 和 `state: "idle"` 的最小结构，并新增第七项职责：查询指定直接子代理的运行状态。
- 2026-08-04：用户确认新增工具命名为 `get_agent_status`。
- 2026-08-04：用户确认 `get_agent_status` 只接受一个必填 `agent_id`，立即返回控制器最近已确认的快照；它不等待事件、不触发 Pi 请求、不改变节点或队列状态，等待语义由 `wait_agent` 独占。
- 2026-08-04：用户确认 `get_agent_status` 快照包含身份字段、生命周期 `state`、待处理消息数量、可选安全 `data.error`、单调递增 `revision` 和 `observed_at`；不返回队列正文、进程句柄、环境或后代控制句柄，整棵子树由 `get_agent_tree` 单独提供。
- 2026-08-04：用户确认 `get_agent_status` 成功查询故障节点时仍返回 `ok: true`，并在 `data.error` 中提供当前故障的 `code`、`message`、`retryable` 与时间；健康节点省略该字段。顶层 `error` 仅表示工具调用本身失败，字段不命名为 `last_error`。
- 2026-08-04：用户确认 `observed_at` 使用 UTC RFC 3339 时间，固定毫秒精度和 `Z` 后缀；它只用于新鲜度与诊断，状态顺序由 `revision` 决定，汇聚时间以当前控制器接受更新的时刻为准。
- 2026-08-04：用户确认 `send_message` 支持必填文本和可选图片；图片沿用 Pi `ImageContent`，`data` 为不带 data URL 前缀的原始 Base64，`mimeType` 单独传递，扩展负责额外的编码、大小和 MIME 校验。
- 2026-08-04：用户确认 `send_message` 只在消息被 RPC 接受或进入 steering 队列后立即成功返回 `{ message_id, accepted: true }`；不等待完成、不返回启动/steering 分类，接受后的失败通过状态或事件报告。
- 2026-08-04：用户确认 `message_id` 由控制器生成，调用者不得自定义；它在根会话生命周期内唯一、不复用且对外不透明，后续内部事件用它关联消息，但编码与线协议序号留给协议票据。
- 2026-08-04：用户确认 `wait_agent` 只接受一个必填 `agent_id`，不在单次调用中协调多个子代理。
- 2026-08-04：用户确认 `wait_agent` 的默认超时可通过扩展配置文件配置；未显式配置时默认 60 秒，单次 `timeout_ms` 可覆盖但必须有界，后代不能通过自身配置扩大根会话的有效上限，超时只结束等待而不改变子代理。
- 2026-08-04：用户确认等待默认值配置优先级为单次 `timeout_ms`、根启动参数、项目级 `.pi/subagent.json`、用户级 `~/.pi/agent/subagent.json`、内置 60 秒默认值；项目配置覆盖用户配置。`maxWaitTimeoutMs` 不进入配置，合法等待范围由代码常量固定。
- 2026-08-04：用户确认 `wait_agent` 使用固定的 settle/终态等待语义，以 `agent_settled` 为正常完成边界；用户补充全局配置文件应为 `~/.pi/agent/subagent.json`，且不配置 `maxWaitTimeoutMs`，等待时长范围由代码固定。
- 2026-08-04：用户确认 `wait_agent.timeout_ms` 的固定合法范围为 `10000..600000` 毫秒，未配置默认值为 `60000`；单次值只能在该范围内覆盖默认值，超时只结束等待，不改变子代理。
- 2026-08-04：用户确认上述 `wait_agent` settle/终态等待语义、可选超时和扩展配置文件机制；用户进一步指定全局文件路径为 `~/.pi/agent/subagent.json`，并明确 `maxWaitTimeoutMs` 不可配置，等待范围必须由代码常量固定。
- 2026-08-04：用户确认首版不新增 `report_progress`、`send_parent_message` 等专用工具。父会话通过现有 `send_message` 自行组织询问，子代理用普通 assistant 回复向直接父会话上行汇报；后续是否以及何时继续由父会话模型决定，协议不要求固定提示语，也不强制形成暂停点。
- 2026-08-04：用户确认 `wait_agent` 成功等到 settled 时不重复携带最近一次 assistant 回复正文；正文和图片只经子代理回复通道进入父会话。等待结果仅返回等待结论与最新状态元数据，避免重复内容、竞态及大型工具结果。
- 2026-08-04：用户确认 `wait_agent` 到达等待期限但子代理尚未 settled 时返回正常结果 `{ ok: true, data: { outcome: "timeout", ...状态元数据 } }`；超时只是本轮观察窗口结束，不中断或改变子代理。`timeout_ms` 越界、目标不存在或非直接子代理等情况才属于工具调用错误。
- 2026-08-04：用户确认 `wait_agent.data.outcome` 只表示结束等待的原因，取值为 `settled`、`terminal` 或 `timeout`，节点准确生命周期由独立的 `state` 表示。调用时已空闲或随后收到 `agent_settled` 返回 `settled`；调用时已处于终态或等待中进入终态返回 `terminal`；`state: "failed"` 时必须附带 `data.error`，其他健康或正常终止状态省略该字段。
- 2026-08-04：用户确认 `interrupt_agent` 采用协作式中断语义：只请求中止当前模型或工具运行，保留 RPC 节点及其上下文；不清除 Pi 已接受的 steering，不自动升级为终止，也不重建节点。若执行未响应取消，节点保持中断中的可观测状态，由父会话按需显式调用 `terminate_agent`；保证停止并级联清理子树只属于终止语义。
- 2026-08-04：用户确认 `interrupt_agent` 在控制器校验并接纳中断命令后立即返回 `{ ok: true, data: { agent_id, accepted: true } }`，不等待 RPC `abort` 响应或 `agent_settled`；完成与失败通过 `wait_agent`、`get_agent_status` 和状态事件观察，不返回无独立查询用途的 `interrupt_id`。
- 2026-08-04：用户确认 `interrupt_agent` 对已处于 `idle` 或 `interrupting` 的节点幂等成功，不抛出状态竞态错误；返回 `accepted: true`、`changed: false`，并用准确 `state` 说明没有新发中断请求。
- 2026-08-04：用户确认 `interrupt_agent` 对 `failed`、`terminating` 或 `terminated` 节点同样幂等成功，返回 `accepted: true`、`changed: false`；结果保留准确 `state`，`failed` 节点继续附带 `data.error`。生命周期竞态不作为工具错误，错误仅用于寻址、权限、参数或控制器失败。
- 2026-08-04：用户确认 `terminate_agent(agent_id)` 始终递归终止目标节点及其全部后代子树，不提供 `cascade` 开关或只终止单节点的模式；需要保留节点和上下文时使用 `interrupt_agent`。
- 2026-08-04：用户确认 `terminate_agent` 固定先执行优雅关闭，在代码规定的收尾窗口后对未退出节点升级为平台级进程树强制回收；调用方不能选择立即强杀或仅优雅模式，强制阶段保留可诊断故障信息。
- 2026-08-04：用户确认 `terminate_agent` 只有在目标及其整棵子树完成终止并确认资源回收后才返回成功；无法确认退出时返回顶层终止失败及诊断详情，不能仅返回已接受。终止流程使用独立的内部收尾边界，不复用 `wait_agent.timeout_ms`。
- 2026-08-04：用户确认重复或并发 `terminate_agent` 调用幂等且合并：已 `terminated` 的节点立即成功且不重复操作，`terminating` 的调用等待并复用同一终止流程，`failed` 节点重新执行清理确认；不启动竞争性的第二套回收流程。
- 2026-08-04：用户确认优雅关闭阶段失败但强制回收最终确认整棵子树退出时，`terminate_agent` 仍返回 `ok: true`，并在数据中标记 `forced: true`；只有最终无法确认资源退出才返回顶层终止错误，成功结果不放置 `error`。
- 2026-08-04：用户确认 `get_agent_tree` 按调用者身份自动裁剪只读视图：根会话可查看整棵代理树，非根父会话只能查看自身及其后代子树；不接受任意目标 `agent_id` 作为越级查询入口，视图不包含连接句柄、进程句柄、环境、队列正文或其他控制秘密。
- 2026-08-04：用户确认 `get_agent_tree` 返回带单一 `tree_revision` 与 `observed_at` 的完整点时快照，不暴露增量、游标或事件确认协议；节点只在故障时附带错误信息，健康节点省略 `error`。
- 2026-08-04：用户确认 `get_agent_tree` 的快照使用扁平 `nodes` 列表，以 `parent_agent_id` 与 `depth` 表达拓扑，按父节点优先及稳定创建顺序排序；不递归嵌套 `children`。
- 2026-08-04：用户确认树快照不把根会话伪装成可寻址节点；根作用域的直接子代理以 `parent_agent_id: null` 表示，非根作用域以当前父会话作为隐式锚点并隐藏其作用域外父标识，`depth` 仍是相对整棵树根会话的深度。
- 2026-08-04：用户确认 `get_agent_tree.nodes[]` 复用单节点状态查询的安全字段：身份、父标识、深度、生命周期状态、待处理消息数量、节点 `revision` 与 `observed_at`；故障节点才附带 `data.error`，不携带消息或回复正文、图片、进程/RPC 句柄、环境或配置秘密。
- 2026-08-04：用户确认 `get_agent_tree` 在单一 `tree_revision` 下捕获不可混合的完整视图；顶层 `observed_at` 是快照捕获时间，节点自身 `revision`/`observed_at` 只用于诊断，快照不保证捕获后外部进程状态不变。
- 2026-08-04：用户确认公开错误码采用闭合的稳定 `snake_case` 集合；调用方不依赖错误消息或 `details` 的具体结构，未知内部异常统一映射为 `internal_error`，`retryable` 表示是否值得重试。节点故障中的 `data.error` 可复用同一错误码，但不改变成功状态查询的 `ok: true`。
- 2026-08-04：用户确认目标标识解析错误区分为 `agent_not_found`（当前根会话注册表中不存在或属于其他根会话）与 `not_direct_child`（节点存在但不是调用者的直接子代理）；已终止且仍注册的节点不归入前者。
- 2026-08-04：用户确认调用方提供的字段缺失、类型、范围、长度、Base64 或 MIME 校验失败统一返回不可重试的 `invalid_argument`，稳定诊断字段可放在 `details.field` 与 `details.reason`，不为每种字段问题新增公共错误码。
- 2026-08-04：用户修订模板解析错误码，只保留不可重试的 `template_not_found` 与 `template_invalid`，分别表示模板在完成来源/权限过滤后不可用、模板存在但格式或字段无效；不提供 `template_not_allowed`，无法归类的底层异常映射为 `internal_error`。
- 2026-08-04：用户确认扩展配置不设置版本字段并采用宽松回退：配置文件缺失、不可读或 JSON 无法解析时静默跳过该层；已知字段值无效时静默回退到下一优先级或内置默认值；未知或不支持的字段静默忽略，包括 `maxWaitTimeoutMs`。这些情况不产生 `config_unavailable`、`config_invalid` 工具错误。
- 2026-08-04：用户确认达到深度上限时 `spawn_agent` 返回不可重试的 `max_depth_reached`；子代理管理工具只在节点自身 `depth == maxDepth` 时隐藏，其他 `depth < maxDepth` 的节点仍可使用，不因树中已有更深节点而全局隐藏。
- 2026-08-04：用户确认父代理直接子节点名额耗尽时，`spawn_agent` 返回 `max_children_reached`，并标记 `retryable: true` 表示完成一个直接子代理的终止清理后可重试；它不同于不可重试的 `max_depth_reached`。
- 2026-08-04：用户确认 `spawn_agent` 在进程启动、提前退出、RPC 握手/协议失败时使用 `spawn_failed`，在启动期限内未进入可通信 `idle` 时使用 `spawn_timeout`；失败返回前清理残留进程并释放预留名额，具体阶段放入 `details.phase`。
- 2026-08-04：用户确认 `send_message` 对存在且属于直接子代理、但处于 `failed`、`terminating` 或 `terminated` 的目标返回不可重试的 `agent_unavailable`；`idle`、`working` 和仍可接收消息的 `interrupting` 不使用该错误。
- 2026-08-04：用户确认消息在 RPC 接受前被明确拒绝、写入失败或确认丢失时统一返回 `message_delivery_failed`；只有能证明未被接受且目标仍可用时标记可重试，接受状态未知时不可自动重试以避免重复。一旦返回 `accepted: true`，后续失败只进入节点状态和事件。
- 2026-08-04：用户确认两阶段终止后仍有节点或进程无法确认退出时返回可重试的 `termination_incomplete`，再次调用幂等终止可重做清理确认；平台、节点和失败阶段放入 `details`，不拆分 `termination_failed`、`kill_failed` 或 `cleanup_timeout` 等公共码。
- 2026-08-04：用户确认每个子代理使用独立的状态变更命令串行通道，同一目标的消息、中断和终止按控制器顺序协调，不同节点可并行；状态/树查询与一个或多个等待者不占命令通道。创建在父节点原子预留名额和登记后可并行启动独立进程。
- 2026-08-04：用户确认 `terminate_agent` 是同节点命令通道的终止屏障：接纳后原子进入 `terminating`，拒绝新普通命令，取消尚未写入 RPC 的待处理命令并可抢占无响应中断；已被 Pi 接受的消息不追溯撤回，重复终止合并到同一清理流程。
- 2026-08-04：用户确认节点处于 `interrupting` 时仍可调用 `send_message`；消息在中断命令之后按同节点串行顺序交付，若中断长期不响应则保持待处理，直到父会话改用终止屏障清理。
- 2026-08-04：用户确认仅节点自身 `depth == maxDepth` 时隐藏 `spawn_agent`、`send_message`、`wait_agent`、`interrupt_agent`、`terminate_agent`、`get_agent_status` 与 `get_agent_tree` 整套管理工具；所有更浅层节点仍完整暴露，绕过发现调用创建仍由服务端返回 `max_depth_reached`。
- 2026-08-04：用户确认 `get_agent_tree.data.scope` 区分根作用域 `{ kind: "root" }` 与当前父代理子树作用域 `{ kind: "subtree", agent_id }`；作用域由控制器从调用者身份填充，调用方不能传入任意查询目标，非根快照以当前父代理为隐式根并隐藏其真实祖先。
- 2026-08-04：用户确认节点进入 `terminated` 后以会话内终止记录保留到根会话结束；状态和树查询仍可见、重复终止仍幂等，但不占直接子代理名额、不接受消息、不恢复且标识不复用。根会话结束时统一释放，不跨会话持久化。
- 2026-08-04：用户最终确认 `terminate_agent` 成功摘要保留 `agent_id`、`state: "terminated"`、`changed`、`forced` 与 `terminated_count`；计数仅表示同一共享终止流程中实际转为 `terminated` 的目标及后代数，纯幂等调用为 `0`，不返回后代 ID 列表。
- 2026-08-04：用户确认 `interrupt_agent` 成功结果只包含 `agent_id`、`accepted`、`changed` 与准确 `state`；新中断为 `changed: true, state: "interrupting"`，幂等或无活动节点为 `changed: false`，故障节点另附 `data.error`，不返回重复的 `reason` 字段。
- 2026-08-04：用户确认公开生命周期状态集合固定为 `starting`、`idle`、`working`、`interrupting`、`failed`、`terminating`、`terminated`；`queued` 与 `exited` 不作为公开状态，待处理消息用计数表示，意外进程退出折算为 `failed`，终止流程中的预期退出折算为 `terminated`。
- 2026-08-04：用户在“确定子代理能力与上下文继承规则”中修订管理工具可见性：模板可用 `subagents: disabled` 主动关闭子代理管理能力；此时即使节点尚未达到 `maxDepth`，七个管理工具也整组隐藏，后代不能重新开启。原有 `maxDepth` 规则保留为独立硬上限。
- 2026-08-04：用户在“确定子代理能力与上下文继承规则”中扩展公开错误码闭集，新增不可重试的 `template_capability_unavailable`：模板存在且格式有效，但当前父会话有效授权缺少模板必需工具或其他能力时，在预留名额和启动进程前整体拒绝创建；安全诊断放入 `details`。
- 2026-08-05：用户在“确定深度、并发与资源配额”中扩展公开错误码闭集，新增可重试的 `max_tree_agents_reached`：全树中除根会话外尚未 `terminated` 的节点已达到根配额，完成节点终止与资源回收释放名额后可以重试。
- 2026-08-05：06 号票据最终修订并冻结配置故障语义：已选中的项目或用户配置层不可读、JSON 无法解析或已知配额字段非法时直接采用该字段内置默认值，不回退低优先级层；未知字段通过根 UI-only warning 提示后忽略；非法显式根参数拒绝启动。此前关于坏配置层静默跳过或向下回退的历史记录不再代表最终规范。
- 2026-08-05：用户补充确认 `agent_id` 字段的值使用 UUID。为保持生成不可预测、与树结构及创建顺序无关，控制器采用随机 UUID v4 生成值，并统一使用 RFC 9562 canonical 小写文本格式；输入校验不额外限制 UUID 版本，非 UUID 文本才返回 `invalid_argument`。`message_id`、`request_id`、`stream_id` 和传输序号仍保持独立命名空间。
