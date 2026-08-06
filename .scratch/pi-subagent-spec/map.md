# 交付 Pi 分层子代理扩展的 Windows 开发里程碑

Label: wayfinder:map
Status: active

## Destination

在现有冻结规格和 01–23 号基础模块之上，交付可在 Windows 开发环境中运行的 Pi Subagent 独立扩展：完成受管 RPC 节点、代理树控制、TUI 可观测性、本地 package 形态和 Windows 开发验收。代码保留 macOS/Linux 适配方向，但本里程碑不执行其原生测试或支持承诺。

规范入口：[spec.md](spec.md)

## Notes

- 本地图当前明确承载实现工作；实现完成的工单在 `Answer` 或评论中记录代码、测试和证据，规格仍是行为唯一入口。
- 后续按纵向能力分组，不再为单个公开工具、单个 UI 视图或单个平台适配器各拆一张工单；每张工单必须形成可运行、可验证的闭环。
- 受管 RPC 节点是唯一合法的生产装配单位：平台适配器先建立进程树归属，桥接进程内部独占 Pi 公共 `RpcClient`，监督器不能拼接不同进程的客户端和树句柄。
- 当前开发宿主为 Windows。跨平台任务可以先交付代码、类型检查、纯逻辑测试和 fake 测试；原生 macOS/Linux runner、原生进程树证据和跨平台支持结论另立 wayfinder 计划。
- 每次处理决策票时使用 `grilling` 与 `domain-modeling`；状态机、协议或交互形态问题同时使用 `prototype`；内部模块边界使用 `codebase-design`；读取当前仓库之外的事实时使用 `research`。
- Pi 上游源码以 `D:\code\open-source\pi` 当前检出的提交 `a96fb984d8c8b065fc5d193309fc812a882adee0` 为事实基线。
- 子代理是父会话期间常驻的临时实体，与 `pi --mode rpc --no-session` 进程一一对应；父会话结束后不恢复。
- 代理形成可配置深度的树。每个父会话只与直接子代理通信并完全控制直接子代理；终止节点时级联终止其子树。
- 根会话可以只读查看整棵代理树，但不能越级发送任务或控制后代。
- 根会话设定不可突破的 `maxDepth`。达到上限的节点不暴露任何子代理管理工具；绕过能力发现的创建请求仍返回明确的深度限制错误。
- 父会话通过单一 `send_message` 与直接子代理通信；线协议统一发送带 `streamingBehavior: "steer"` 的 RPC `prompt`，使空闲节点启动处理、繁忙节点原子接收执行中引导；首版不提供自动排队的独立后续任务。
- 控制接口采用多个职责单一的工具，而非单个多模式 `subagent` 工具。
- 工作区只是项目资源与信任边界，不拥有或跨父会话共享子代理。
- 所有规划文档使用中文和 UTF-8 编码，领域术语以仓库根目录 `CONTEXT.md` 为准。

## Decisions so far

<!-- 每个已解决决策只在对应票中保存完整答案；此处仅追加摘要与链接。 -->

- [核实 Pi 原生子代理承载能力](issues/01-verify-pi-native-capabilities.md) — Pi 可直接承载长期无持久化 RPC 节点，但代理树控制面、强中断和跨平台进程树回收必须由扩展补足。
- [确定父会话控制工具契约](issues/02-define-parent-control-tools.md) — 公开控制面固定为七个直接父子工具，区分协作式中断与同步级联终止，并统一了状态快照、树视图、配置回退、并发串行化和闭合错误码。
- [建模子代理生命周期与状态转换](issues/03-model-agent-lifecycle.md) — 七态生命周期由控制器意图和 Pi/监督器确认事件共同驱动，明确了等待、消息计数、故障留痕、迟到事件、原子级联终止和所有者失效语义，并由 throwaway 逻辑原型验证关键竞态。
- [核实 Pi 文件访问与项目资源边界](issues/13-verify-pi-filesystem-and-resource-boundaries.md) — 固定 `cwd` 不阻止外部路径访问；project trust 只约束资源加载，逐路径策略若要成为强边界必须同时限制 shell、扩展或依赖 OS 隔离。
- [核实 Pi 代理模板文件惯例](issues/14-verify-pi-agent-template-conventions.md) — Pi 核心没有代理模板 API；第一方 Subagent 示例采用 Markdown、YAML frontmatter 与正文提示，但严格校验和能力不足即拒绝创建须由本扩展新增。
- [核实 Pi 子进程模型、提示与资源装配入口](issues/15-verify-pi-child-configuration-surfaces.md) — Pi 提供所需 CLI/SDK 装配面和动态 reload，但 `RpcClient.start()` 不证明最终配置；规格只保留创建时静态预检与 RPC 可通信确认。
- [确定子代理能力与上下文继承规则](issues/04-define-capability-and-context-inheritance.md) — 固定根 `cwd`、环境和项目资源信任，严格控制子代理管理能力；模板业务工具只在创建时完整预检，运行后保留 Pi 动态 reload，不做全量能力握手或持续复核。
- [确定代理模板发现与信任策略](issues/05-define-agent-template-discovery-and-trust.md) — 根控制器在可信用户/项目 Markdown 来源中建立原子模板发现快照，以严格 schema、项目覆盖和精确错误码决定后续创建；无效模板与来源问题只通过根 UI 诊断展示、不进入模型上下文，根 `/reload` 仅刷新未来创建。
- [确定深度、并发与资源配额](issues/06-define-depth-concurrency-and-budgets.md) — 根启动时一次确定 `maxDepth`、`maxChildrenPerAgent` 与 `maxAgentsPerTree`，分别以默认值 `2/4/16` 和硬上限 `8/16/64` 约束深度、每个父会话直接子代理数及整棵树未终止节点数；创建前原子预留，完整终止回收后释放，耗尽立即返回稳定错误码且不自动等待或回收。不同节点可并行，但不增加同时运行数、模型成本、空闲超时或创建速率控制；配置问题仅 UI-only 警告，非法根参数拒绝启动。
- [确定父子控制与代理树状态上报协议](issues/11-prototype-parent-child-tree-protocol.md) — 任务正文和普通回复继续走 Pi RPC，生命周期与子树状态走独立的本地直接父子监督通道；帧使用 `stream_id`、单向 `seq`、请求号和本地 `subtree_revision`，重复安全丢弃、断序用带 `reset` 的最新完整快照重同步，根侧原子合并并分配 `tree_revision`；只保留最新快照和有界 ACK/回复水位，不使用 `entry_appended` 作为权威控制载体。
- [确定代理树可观测性与流式交互](issues/07-prototype-tree-observability.md) — 常驻 `Agents` widget 只显示当前会话直接子代理；`/agent` 打开只读 TUI 遮罩面板查看根整树或普通父会话自身子树，默认展开直接子代理、折叠后代并支持滚动、左右展开/折叠和 `Esc` 关闭；行显示 `template_id`、名称、生命周期、安全活动摘要、创建成功后的冻结/累计时长、非零 pending 与稳定故障码，终止记录归入折叠的 `finished`；所有 UI 与通知不进入模型上下文。
- [确定中断、失败与级联清理语义](issues/08-define-failure-cancellation-and-cleanup.md) — 中断只保留节点并等待 `agent_settled`，终止先建立不可逆屏障、后代优先清理；根退出使用独立内部清理期限，Windows 优先 Job Object、Unix 优先进程组/session，部分失败保留 `terminating`/`termination_incomplete`，中间父代理故障自动防孤儿清理且不自动重启，不新增公开错误码。
- [确定 RPC 监督器与跨平台进程回收架构](issues/12-prototype-rpc-supervisor.md) — 采用承载公共 `RpcClient` 的 `ManagedRpcNode` 与专用 `RpcSupervisor`；平台适配器先启动受管桥接进程并绑定 OS 进程树，单节点状态变更串行、终止优先，父子通道和 RPC 双握手后才就绪，运行期通道故障不自动恢复。
- [预构资源确认边界与可注入进程树替身](issues/17-process-tree-resource-boundary.md) — 固定不透明 `ProcessTreeAdapter` 句柄与进程树三态观察；仅退出和整树资源释放同时确认才得到进程树级 `confirmed_exited`，生命周期与配额仍由后续控制器结合监督端点、本节点和全部后代裁决，fake 以场景序列稳定复现优雅超时、孙进程残留、部分回收、重复回收和句柄释放。
- [确定发布、安装与 Pi 兼容性边界](issues/09-define-packaging-and-compatibility.md) — 以只声明唯一扩展入口的标准 Pi package 发布，npm 为规范渠道并支持等版本 git tag 与完整 commit；代码目标覆盖 Windows/macOS/Linux，当前里程碑只验证 Windows，版本、平台或必需宿主 API 不满足时原子失活、仅作 UI-only 诊断而不阻断宿主 Pi，会话 reload 失败时清理既有代理树。
- [确定首版验收标准与规格交付结构](issues/10-define-acceptance-and-spec-delivery.md) — `spec.md` 仍是唯一行为入口；当前里程碑收敛为 Windows 最低/当前两个宿主组合，跨平台代码可先写但 macOS/Linux 原生验收与支持证据延期到独立计划，性能和正式发布证明仍不在本轮。
- [统一代理标识值域](issues/02-define-parent-control-tools.md) — `agent_id` 字段值使用 UUID，控制器新分配值采用随机 UUID v4，并使用 RFC 9562 canonical 小写格式且不带 `agent_` 前缀；格式错误返回 `invalid_argument`，格式正确但未注册返回 `agent_not_found`，其他消息/请求/流标识保持独立命名空间。
- [冻结根工作基础、环境、信任与配置](issues/18-root-runtime-context-config.md) — 根会话一次冻结规范化 `cwd`、project trust、环境和逐字段配额配置；后代只能从根环境投影并接收控制器追加的固定元数据，配置只读取可信项目与用户的规范路径，错误仅以脱敏 UI-only 诊断呈现。
- [发布可信代理模板发现快照](issues/19-template-discovery-snapshot.md) — 根模板发现模块以双来源严格扫描、文件名精确身份、项目覆盖和候选/来源诊断建立不可变快照；首次发现与根 `/reload` 通过 UI-only 脱敏通知发布，失败来源不回退旧目录。
- [建立代理树身份、七态生命周期与配额内核](issues/20-tree-lifecycle-quota-core.md) — `TreeController` 在根实例内原子登记不可复用 UUID v4、直接父关系与双重配额，按能力和深度收窄管理权；七态事件必须携带代际并以安全快照、修订、pending 和单调生命周期计时发布，终止屏障及资源确认后才释放名额。
- [实现父子监督协议与安全子树汇聚](issues/21-supervisor-channel-protocol.md) — 每条直接父子关系使用隔离的长度边界监督帧、认证握手、完整安全子树快照和有界回复确认；父端原子替换子树并分配根修订。断序请求 reset 快照，EOF 在固定重连窗口内使用新流、首快照确认后重放未确认回复；根级请求号分配器保证同一活动根会话内不复用。
- [实现 Windows Job Object 进程树适配器](issues/22-windows-job-object-adapter.md) — Windows 启动路径使用 `CREATE_SUSPENDED`，先完成节点专用 Job Object 分配并正确写入 `KILL_ON_JOB_CLOSE` 的 native 结构布局，再恢复目标线程；强制回收只调用 Job Object，资源确认使用进程 ID 列表的 `present`/`released`/`unknown` 三态。原生测试以 `detached`/`unref` 孙进程证明后代仍在 Job 内并可整树回收；句柄释放或观察失败时保留 `unknown`，不伪造终止确认。宿主门禁已在 Windows 标准入口加载该适配器，Unix 平台在对应适配器交付前继续失败关闭。
- [实现 macOS/Linux process group 进程树适配器](issues/23-unix-process-tree-adapter.md) — Unix 代码和宿主接入已保留，但本里程碑只在 Windows 做平台原生验证；macOS/Linux 原生 runner、资源回收证据和支持结论延期到独立计划。

## Fog

- 无。性能测试明确不属于本里程碑开发验收；macOS/Linux 原生验证已经明确成另一项未来工作，不作为本地图的隐性前沿。

## Out of scope

- 子代理跨根会话结束、Pi 会话恢复或设备重启后的持久化与恢复。
- 兄弟代理、非直接祖先与后代之间的直接通信，以及广播或对等代理网络。
- 远程主机、分布式调度或多用户共享代理树。
- 自动排队并在当前处理结束后执行的独立后续任务。
- 修改 Pi 核心以内置 Subagent；目标产物必须是独立扩展。
- macOS/Linux 原生 runner、真实进程树回收验收、跨平台支持声明和相关发布证据；这些内容在后续独立 wayfinder 计划中处理。
- npm registry、正式 tarball、release tag/commit 对应证明和正式发布运营。
