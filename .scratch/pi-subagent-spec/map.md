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
- 父会话通过单一 `send_message` 与直接子代理通信；插件 mailbox 先分配 `message_id/task_id` 并接纳，监督器再按 task assignment、Pi prompt/steer 和 `task_started` 顺序交付。中断栅栏后的消息进入单一后继任务；无法证明的交付进入 `suspended`，不自动重发。
- 控制接口采用多个职责单一的工具，而非单个多模式 `subagent` 工具。
- 工作区只是项目资源与信任边界，不拥有或跨父会话共享子代理。
- 所有规划文档使用中文和 UTF-8 编码，领域术语以仓库根目录 `CONTEXT.md` 为准。

## Decisions so far

<!-- 每个已解决决策只在对应票中保存完整答案；此处仅追加摘要与链接。 -->

- [核实 Pi 原生子代理承载能力](issues/01-verify-pi-native-capabilities.md) — Pi 可直接承载长期无持久化 RPC 节点，但代理树控制面、强中断和跨平台进程树回收必须由扩展补足。
- [确定父会话控制工具契约](issues/02-define-parent-control-tools.md) — 公开控制面固定为八个直接父子工具；v6 的 `send_message` 返回 mailbox 接纳身份，`wait_agent` 使用多目标 first-event 与批次协同 outcome，协作式中断与同步级联终止保持独立。
- [建模子代理生命周期与状态转换](issues/03-model-agent-lifecycle.md) — 当前 v5 生命周期为八态，新增 `suspended`；`idle` 严格静止，状态与 activity、三类队列和 `last_task` 由任务 mailbox 原子投影，raw settlement 不再等于完成。
- [核实 Pi 文件访问与项目资源边界](issues/13-verify-pi-filesystem-and-resource-boundaries.md) — 固定 `cwd` 不阻止外部路径访问；project trust 只约束资源加载，逐路径策略若要成为强边界必须同时限制 shell、扩展或依赖 OS 隔离。
- [核实 Pi 代理模板文件惯例](issues/14-verify-pi-agent-template-conventions.md) — Pi 核心没有代理模板 API；第一方 Subagent 示例采用 Markdown、YAML frontmatter 与正文提示，但严格校验和能力不足即拒绝创建须由本扩展新增。
- [核实 Pi 子进程模型、提示与资源装配入口](issues/15-verify-pi-child-configuration-surfaces.md) — Pi 提供所需 CLI/SDK 装配面和动态 reload，但 `RpcClient.start()` 不证明最终配置；规格只保留创建时静态预检与 RPC 可通信确认。
- [确定子代理能力与上下文继承规则](issues/04-define-capability-and-context-inheritance.md) — 固定根 `cwd`、环境和项目资源信任，严格控制子代理管理能力；模板业务工具只在创建时完整预检，运行后保留 Pi 动态 reload，不做全量能力握手或持续复核。
- [确定代理模板发现与信任策略](issues/05-define-agent-template-discovery-and-trust.md) — 根控制器在可信用户/项目 Markdown 来源中建立原子模板发现快照，以严格 schema、项目覆盖和精确错误码决定后续创建；无效模板与来源问题只通过根 UI 诊断展示、不进入模型上下文，根 `/reload` 仅刷新未来创建。
- [确定深度、并发与资源配额](issues/06-define-depth-concurrency-and-budgets.md) — 根启动时一次确定 `maxDepth`、`maxChildrenPerAgent` 与 `maxAgentsPerTree`，分别以默认值 `2/4/16` 和硬上限 `8/16/64` 约束深度、每个父会话直接子代理数及整棵树未终止节点数；创建前原子预留，完整终止回收后释放，耗尽立即返回稳定错误码且不自动等待或回收。不同节点可并行，但不增加同时运行数、模型成本、空闲超时或创建速率控制；配置问题仅 UI-only 警告，非法根参数拒绝启动。
- [确定父子控制与代理树状态上报协议](issues/11-prototype-parent-child-tree-protocol.md) — 当前监督协议为 `pi-subagent/6`，在既有可靠帧、快照和逐跳控制上保留 task assignment/start；reply 第 4 版删除模型唤醒开关，协议生成 outbound 必须先于 listener 重入应用发送。
- [确定代理树可观测性与流式交互](issues/07-prototype-tree-observability.md) — v6 行与摘要使用生命周期、activity phase、三类队列、`last_task`、时长和稳定故障；常驻 widget 与 `/agent` 只显示调用者可见作用域，不暴露正文或内部 transport 身份。
- [确定中断、失败与级联清理语义](issues/08-define-failure-cancellation-and-cleanup.md) — 中断先建立 mailbox 栅栏，后继消息不能进入正在取消的 task；raw settlement 只准备 interrupted final，commit 后才可复用。终止仍不可逆、后代优先，suspended/failed 节点继续占名额直到显式回收。
- [确定 RPC 监督器与跨平台进程回收架构](issues/12-prototype-rpc-supervisor.md) — `ManagedRpcNode` 继续独占 Pi RPC 与平台树；`RpcSupervisor` 以 `AgentTaskMailbox` 线性化接纳、assignment、Pi command、压缩、settlement、final/ACK 和终止，不拼接客户端、不猜测不确定交付。
- [预构资源确认边界与可注入进程树替身](issues/17-process-tree-resource-boundary.md) — 固定不透明 `ProcessTreeAdapter` 句柄与进程树三态观察；仅退出和整树资源释放同时确认才得到进程树级 `confirmed_exited`，生命周期与配额仍由后续控制器结合监督端点、本节点和全部后代裁决，fake 以场景序列稳定复现优雅超时、孙进程残留、部分回收、重复回收和句柄释放。
- [确定发布、安装与 Pi 兼容性边界](issues/09-define-packaging-and-compatibility.md) — 以只声明唯一扩展入口的标准 Pi package 发布，npm 为规范渠道并支持等版本 git tag 与完整 commit；代码目标覆盖 Windows/macOS/Linux，当前里程碑只验证 Windows，版本、平台或必需宿主 API 不满足时原子失活、仅作 UI-only 诊断而不阻断宿主 Pi，会话 reload 失败时清理既有代理树。
- [确定首版验收标准与规格交付结构](issues/10-define-acceptance-and-spec-delivery.md) — `spec.md` 仍是唯一行为入口；当前里程碑收敛为 Windows 最低/当前两个宿主组合，跨平台代码可先写但 macOS/Linux 原生验收与支持证据延期到独立计划，性能和正式发布证明仍不在本轮。
- [统一代理标识值域](issues/02-define-parent-control-tools.md) — `agent_id` 字段值使用 UUID，控制器新分配值采用随机 UUID v4，并使用 RFC 9562 canonical 小写格式且不带 `agent_` 前缀；格式错误返回 `invalid_argument`，格式正确但未注册返回 `agent_not_found`，其他消息/请求/流标识保持独立命名空间。
- [冻结根工作基础、环境、信任与配置](issues/18-root-runtime-context-config.md) — 根会话一次冻结规范化 `cwd`、project trust、环境和逐字段配额配置；后代只能从根环境投影并接收控制器追加的固定元数据，配置只读取可信项目与用户的规范路径，错误仅以脱敏 UI-only 诊断呈现。
- [发布可信代理模板发现快照](issues/19-template-discovery-snapshot.md) — 根模板发现模块以双来源严格扫描、文件名精确身份、项目覆盖和候选/来源诊断建立不可变快照；首次发现与根 `/reload` 通过 UI-only 脱敏通知发布，失败来源不回退旧目录。
- [建立代理树身份、八态生命周期与配额内核](issues/20-tree-lifecycle-quota-core.md) — `TreeController` 保持身份、所有权与配额权威，并通过原子 `applyTaskProjection` 接纳 mailbox 的状态、activity、三类队列和 `last_task`；只有 `terminated` 释放名额。
- [实现父子监督协议与安全子树汇聚](issues/21-supervisor-channel-protocol.md) — v6 保留隔离帧、认证握手、完整快照、assignment/start 顺序事实和有界窗口，reply v4 删除唤醒配置并继续使用 task/turn/commit 身份；同版本 reload 保留未确认回复，跨主版本拒绝接管。
- [采用多目标等待与 assistant 批次协调](../../docs/adr/0006-multi-target-wait-batches.md) — `wait_agent` 以 `agent_ids` 建立单 timer first-event waiter；同一最终 assistant session entry 中的重复 wait 合并合法目标，顺序 sibling 读取缓存，工作中 reply 固定唤醒父代理。
- [采用任务 mailbox 与延迟 final 提交](../../docs/adr/0005-task-mailbox-and-delayed-final-commit.md) — 稳定 `task_id` 与 Pi `turn_id` 分离；raw settlement 形成 provisional candidate，父会话接纳与 settlement 双条件 commit；第三方 mid-run compact 无 lease 时以撤销候选、恢复新 turn 和 `suspended` 保守表达。
- [实现 Windows Job Object 进程树适配器](issues/22-windows-job-object-adapter.md) — Windows 启动路径使用 `CREATE_SUSPENDED`，先完成节点专用 Job Object 分配并正确写入 `KILL_ON_JOB_CLOSE` 的 native 结构布局，再恢复目标线程；强制回收只调用 Job Object，资源确认使用进程 ID 列表的 `present`/`released`/`unknown` 三态。原生测试以 `detached`/`unref` 孙进程证明后代仍在 Job 内并可整树回收；句柄释放或观察失败时保留 `unknown`，不伪造终止确认。宿主门禁已在 Windows 标准入口加载该适配器，Unix 平台在对应适配器交付前继续失败关闭。
- [实现 macOS/Linux process group 进程树适配器](issues/23-unix-process-tree-adapter.md) — Unix 代码和宿主接入已保留，但本里程碑只在 Windows 做平台原生验证；macOS/Linux 原生 runner、资源回收证据和支持结论延期到独立计划。

## Fog

- 无。性能测试明确不属于本里程碑开发验收；macOS/Linux 原生验证已经明确成另一项未来工作，不作为本地图的隐性前沿。

## Out of scope

- 子代理跨根会话结束、Pi 会话恢复或设备重启后的持久化与恢复。
- 兄弟代理、非直接祖先与后代之间的直接通信，以及广播或对等代理网络。
- 远程主机、分布式调度或多用户共享代理树。
- 通用优先级队列、多个并行逻辑任务或自动调度；只保留同一 task 消息与中断后单一 successor task 的 mailbox 顺序。
- 修改 Pi 核心以内置 Subagent；目标产物必须是独立扩展。
- macOS/Linux 原生 runner、真实进程树回收验收、跨平台支持声明和相关发布证据；这些内容在后续独立 wayfinder 计划中处理。
- npm registry、正式 tarball、release tag/commit 对应证明和正式发布运营。
