# 明确 Pi 分层子代理扩展规格

Label: wayfinder:map
Status: resolved

## Destination

形成一份可直接交给实现代理的、独立可发布 Pi Subagent 扩展规格，完整定义临时分层代理树的公开工具契约、运行语义、安全边界、交互体验、发布方式与验收标准。

规范入口：[spec.md](spec.md)

## Notes

- 本地图只消除实现前的决策不确定性，不执行扩展实现、发布或安装。
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
- [确定 RPC 监督器与跨平台进程回收架构](issues/12-prototype-rpc-supervisor.md) — 采用封装 Pi `RpcClient` 的专用 `RpcSupervisor`，单节点状态变更串行、终止优先；启动先预留并挂接 OS 进程树监督，再完成父子通道和 RPC 双握手，关闭按 abort/EOF/内部期限/整树强制回收/资源确认推进；`ProcessTreeAdapter` 和 fake 替身隔离 Windows Job Object、Unix process group/session 与测试竞态，运行期通道故障不自动恢复。
- [预构资源确认边界与可注入进程树替身](issues/17-process-tree-resource-boundary.md) — 固定不透明 `ProcessTreeAdapter` 句柄与进程树三态观察；仅退出和整树资源释放同时确认才得到进程树级 `confirmed_exited`，生命周期与配额仍由后续控制器结合监督端点、本节点和全部后代裁决，fake 以场景序列稳定复现优雅超时、孙进程残留、部分回收、重复回收和句柄释放。
- [确定发布、安装与 Pi 兼容性边界](issues/09-define-packaging-and-compatibility.md) — 以只声明唯一扩展入口的标准 Pi package 发布，npm 为规范渠道并支持等版本 git tag 与完整 commit；首版要求 Node `>=22.19.0`、Pi `>=0.83.0`，覆盖 Windows/macOS/Linux，并在版本、平台或必需宿主 API 不满足时原子失活、仅作 UI-only 诊断而不阻断宿主 Pi，会话 reload 失败时清理既有代理树。
- [确定首版验收标准与规格交付结构](issues/10-define-acceptance-and-spec-delivery.md) — 当前交付以 `spec.md` 为唯一开发实现入口；Windows/macOS/Linux 各执行最低与当前两个锁定宿主组合的五层自动化验收和六组合核心旅程，负向/安全/清理矩阵为开发门槛，明确不做性能测试或正式发布证明。
- [统一代理标识值域](issues/02-define-parent-control-tools.md) — `agent_id` 字段值使用 UUID，控制器新分配值采用随机 UUID v4，并使用 RFC 9562 canonical 小写格式且不带 `agent_` 前缀；格式错误返回 `invalid_argument`，格式正确但未注册返回 `agent_not_found`，其他消息/请求/流标识保持独立命名空间。
- [冻结根工作基础、环境、信任与配置](issues/18-root-runtime-context-config.md) — 根会话一次冻结规范化 `cwd`、project trust、环境和逐字段配额配置；后代只能从根环境投影并接收控制器追加的固定元数据，配置只读取可信项目与用户的规范路径，错误仅以脱敏 UI-only 诊断呈现。
- [发布可信代理模板发现快照](issues/19-template-discovery-snapshot.md) — 根模板发现模块以双来源严格扫描、文件名精确身份、项目覆盖和候选/来源诊断建立不可变快照；首次发现与根 `/reload` 通过 UI-only 脱敏通知发布，失败来源不回退旧目录。
- [建立代理树身份、七态生命周期与配额内核](issues/20-tree-lifecycle-quota-core.md) — `TreeController` 在根实例内原子登记不可复用 UUID v4、直接父关系与双重配额，按能力和深度收窄管理权；七态事件必须携带代际并以安全快照、修订、pending 和单调生命周期计时发布，终止屏障及资源确认后才释放名额。

## Fog

- 无。性能测试明确不属于首版开发验收；正式发布运营另立任务。

## Out of scope

- 实现、发布或安装扩展；本地图的终点是可实施规格。
- 子代理跨根会话结束、Pi 会话恢复或设备重启后的持久化与恢复。
- 兄弟代理、非直接祖先与后代之间的直接通信，以及广播或对等代理网络。
- 远程主机、分布式调度或多用户共享代理树。
- 自动排队并在当前处理结束后执行的独立后续任务。
- 修改 Pi 核心以内置 Subagent；目标产物必须是独立扩展。
