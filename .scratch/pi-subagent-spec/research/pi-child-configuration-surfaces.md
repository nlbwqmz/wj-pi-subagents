# Pi 子进程模型、提示与资源装配面研究

> 研究基线：`D:\\code\\open-source\\pi` 提交 `a96fb984d8c8b065fc5d193309fc812a882adee0`。
>
> 研究范围：仅使用该固定提交中的 Pi 官方文档、源码、公开导出与测试作为依据；本报告不把本扩展尚未实现的约束写成 Pi 原生能力。
>
> 规格取舍更新：后续 04 号决策票选择最小创建校验并保留 Pi 动态 reload。下文关于能力握手、配置哈希和确定资源快照的建议仅说明“若要求严格冻结最终配置”时需要的技术路径，不是首版规范要求。

## 结论摘要

1. **`RpcClient` 是 CLI 子进程包装器，不是配置协议。** `RpcClientOptions` 只有 `cliPath`、`cwd`、`env`、`provider`、`model` 和通用 `args`；`start()` 拼出 `--mode rpc` 后调用 `spawn("node", ...)`，把宿主 `process.env` 全量复制再覆盖同名变量，并只等待 100 ms 检查进程是否已经退出。它没有 ready 握手，也没有证明模型、工具或资源集合已按模板生效。[`rpc-client.ts#L28-L40`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L28-L40)、[`rpc-client.ts#L81-L98`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L81-L98)、[`rpc-client.ts#L127-L139`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L127-L139)

2. **标准 CLI 能在启动参数层控制大部分表面，但动态解析发生在子进程内部。** `--provider/--model/--thinking`、系统提示、工具 allowlist、扩展/技能/提示模板/上下文的 `--no-*` 与显式路径，以及 `--approve/--no-approve` 都是公开入口。[`usage.md#L182-L245`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L182-L245) 模型解析要等设置、资源和扩展注册 provider 后才进行；工具名、动态 provider、认证和 project trust 不能仅凭 `RpcClient.start()` 的返回值判定。

3. **SDK 是精确控制的公开入口，但不是 `RpcClient` 的隐式后门。** `createAgentSession()` 可直接注入 `model`、`thinkingLevel`、`tools`、`resourceLoader`、`modelRuntime`、`settingsManager` 和内存 `sessionManager`；`DefaultResourceLoader` 可显式控制资源路径、全部 `no*` 开关、系统提示和 override 回调。[`sdk.ts#L38-L85`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L38-L85)、[`resource-loader.ts#L158-L193`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L158-L193) 但 SDK 默认 `SettingsManager.create()` 使用 `projectTrusted: true`，不会自动复用 CLI 的非交互 trust 流程；若扩展需要标准 RPC 进程，必须显式传 CLI 参数或提供自定义子进程入口。[`sdk.ts#L169-L183`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L169-L183)、[`settings-manager.ts#L323-L344`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/settings-manager.ts#L323-L344)

4. **`--no-session` 只关闭会话持久化。** 它改用 `SessionManager.inMemory()`，不会关闭设置、认证、模型目录、资源发现、扩展执行、缓存或环境变量读取。[`main.ts#L319-L327`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L319-L327)、[`session-manager.ts#L1567-L1569`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/session-manager.ts#L1567-L1569)

5. **模板要求“必需工具缺一即拒绝”不能依赖 Pi 的 allowlist。** Pi 对未知 allowlist 名称在 `setActiveToolsByName()` 中静默忽略；RPC 没有列出活动工具或全部工具的命令，`get_state` 也不包含工具。[`agent-session.ts#L892-L933`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L892-L933)、[`rpc-types.ts#L20-L73`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L73)、[`rpc.md#L160-L190`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/rpc.md#L160-L190) 本扩展必须在预留名额、登记节点、启动进程前严格比较父会话有效授权与模板必需能力；缺少时返回稳定、不可重试的 `template_capability_unavailable`，不得静默削减工具。

6. **固定 `cwd` 是资源和相对路径基点，不是文件系统边界。** Pi 的 `read`、`write`、`edit` 支持绝对路径和越过 `cwd` 的 `..`，`bash` 只把 `cwd` 作为 shell 初始目录；项目 trust 只控制项目资源输入，不限制工具访问目标。[`security.md#L1-L35`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/security.md#L1-L35) 这与整棵代理树固定根 `cwd`、同时允许经授权工具操作 cwd 外文件相容。

## 入口比较

| 入口 | 能确定的内容 | 不能保证的内容 | 适合本扩展的用途 |
| --- | --- | --- | --- |
| `RpcClient` | 子进程路径、`cwd`、环境覆盖、provider/model 参数和任意 CLI 参数 | 环境白名单、资源/工具能力证明、启动就绪、动态 provider/认证有效性 | 作为传输层；由扩展在外部完成预检和超时监督 |
| `pi --mode rpc` | CLI 公开的模型、提示、工具、资源、trust 和 session 开关 | 未提供模板级原子校验；不少错误只警告或静默降级 | 首版子代理的标准承载进程 |
| SDK `createAgentSession()` | `model`、thinking、工具、custom tools、resource loader、settings/session/model runtime | 不会自动提供 RPC JSON 线协议；默认 trust 与 CLI 不同 | 需要精确、可检查的内嵌子代理或自定义 RPC 入口时使用 |
| SDK `createAgentSessionServices()` / `DefaultResourceLoader` | 资源路径、`no*`、system/append prompt、override、诊断和 provider 注册 | 仍需扩展定义父子权限与能力证明 | 预检、受控加载和自定义握手实现 |

公开包入口同时导出 `ModelRuntime`、`DefaultResourceLoader`、`createAgentSession`、`createAgentSessionServices` 和 `RpcClient`，但这些 API 之间没有自动组成模板协议。[`index.ts#L180-L225`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/index.ts#L180-L225)、[`index.ts#L324-L350`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/index.ts#L324-L350)

## 配置面核查

### 1. 工作目录、agentDir 与项目身份

`RpcClient.cwd` 直接成为 Node 子进程的 `spawn` cwd；若省略，子进程使用宿主当前目录。标准 CLI 随后以 `process.cwd()` 作为 session cwd，并用它解析项目资源、上下文文件、相对 CLI 路径和内建工具路径。SDK 的 `cwd` 同时供 `DefaultResourceLoader` 做项目发现和内建工具做相对路径解析。[`rpc-client.ts#L94-L98`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L94-L98)、[`sdk.md#L335-L365`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L335-L365)

`agentDir` 默认由 `PI_CODING_AGENT_DIR`（应用名大写后拼接 `_CODING_AGENT_DIR`）或用户主目录下 `.pi/agent` 决定；其中有 `settings.json`、`models.json`、`auth.json`、资源目录、trust store 和会话目录。[`config.ts#L494-L521`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/config.ts#L494-L521)、[`sdk.md#L353-L365`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L353-L365)

**规格含义：**整棵树固定根 `cwd`，模板不能覆盖它；需要访问 cwd 外文件时由已授权的工具使用绝对路径或 `..`，不要借改变 cwd 来实现。若要稳定资源集合，还必须固定或隔离 `agentDir`，因为仅固定 cwd 不会阻止读取用户全局设置、模型和凭据。

### 2. 模型、provider 与认证

#### CLI / `RpcClient`

- `RpcClient.provider` 和 `RpcClient.model` 只是被追加为 `--provider`、`--model`；`RpcClient.args` 随后追加在它们之后，因此通用 `args` 可以覆盖同一 CLI 选项的最终解析值（不应允许模板借此绕过父控制器）。[`rpc-client.ts#L81-L92`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L81-L92)
- `--provider` 只有在同时存在 `--model` 时才参与 `resolveCliModel()`；单独传 provider 不构成严格模型选择，子进程仍可能按设置默认值或首个可用模型回退。[`model-resolver.ts#L404-L424`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-resolver.ts#L404-L424)、[`model-resolver.ts#L644-L658`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-resolver.ts#L644-L658)
- `--model` 支持 `provider/id`、模糊匹配以及 `:<thinking>` 后缀。未知 provider、无 provider 时的未知模型和无法消歧的跨 provider 精确匹配会形成 error diagnostic；主 CLI 在 runtime diagnostics 含 error 时退出。[`model-resolver.ts#L392-L440`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-resolver.ts#L392-L440)、[`model-resolver.ts#L463-L502`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-resolver.ts#L463-L502)、[`main.ts#L851-L864`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L851-L864)
- 一个重要例外是：provider 已解析成功但模型 ID 未匹配时，只要该 provider 目录中至少有一个模型，`resolveCliModel()` 就可能复制 provider 的基准模型、替换 `id/name`，构造 custom model，并仅返回 `Using custom model id` warning；warning 不阻止 RPC 启动。[`model-resolver.ts#L173-L187`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-resolver.ts#L173-L187)、[`model-resolver.ts#L568-L603`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-resolver.ts#L568-L603)、[`main.ts#L427-L451`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L427-L451) 严格模板必须用 exact provider/model 目录匹配拒绝这个回退，不能把“子进程仍启动”视为模板模型已满足。
- 解析使用 `ModelRuntime` 的全部模型快照，而不是只使用已配置认证的模型。模型对象能被解析不等于请求一定能发出；真正认证解析和 API key 缺失可能到第一次请求或切换模型时才失败。[`model-resolver.ts#L416-L424`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-resolver.ts#L416-L424)、[`agent-session.ts#L1575-L1580`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L1575-L1580)
- `--api-key` 是本次运行的覆盖值，不应当当作持久化认证；它要求已经解析出模型，否则只加入 error diagnostic。[`main.ts#L767-L775`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L767-L775)

#### SDK

`createAgentSession()` 可直接传入已构造的 `Model`，或传入 `ModelRuntime` 后由调用方使用 `getModel()` / `getAvailable()` 选择；`model` 不传时依次尝试会话模型、设置默认值和首个可用模型。[`sdk.md#L367-L395`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L367-L395)、[`sdk.ts#L192-L222`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L192-L222)

`ModelRuntime.create()` 默认读取 `auth.json` 与 `models.json`，创建时恢复模型/认证快照；`ModelRuntime.getError()` 可报告 models.json、provider 组合或可用性刷新错误，但标准 RPC 启动流程没有把它统一升格为 fatal diagnostic。[`model-runtime.ts#L164-L206`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-runtime.ts#L164-L206)、[`model-runtime.ts#L416-L424`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-runtime.ts#L416-L424)

**预检结论：**父控制器可以静态比较模板的固定 `provider/model` 语法，也可以用同版本 SDK 的 `ModelRuntime` 检查模型存在和已配置认证；但扩展 provider 是在子进程加载扩展后注册，认证环境和文件可能在两次读取间变化。若模板要求“请求必然可用”，仍需要子进程启动后能力证明或首个请求级别的失败回报。

### 3. 思考等级

- CLI 解析器只接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；非法 `--thinking` 只产生 warning，主 CLI 会继续启动，而不是失败关闭。[`args.ts#L59-L63`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/cli/args.ts#L59-L63)、[`args.ts#L132-L141`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/cli/args.ts#L132-L141)
- SDK 的 `thinkingLevel` 和 CLI 的有效等级都会按模型能力 clamp；未提供模型时默认 `medium`，无模型时变为 `off`。[`sdk.ts#L47-L50`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L47-L50)、[`sdk.ts#L224-L243`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L224-L243)
- RPC 有 `set_thinking_level`、`get_available_thinking_levels`；处理器直接调用 `session.setThinkingLevel()` 后返回成功。`AgentSession` 对当前模型不支持的等级静默夹紧，底层 `clampThinkingLevel()` 对运行时未知字符串也会回退到可用等级的首项，因此 RPC `success: true` 不证明请求等级原样生效。[`rpc-mode.ts#L495-L510`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L495-L510)、[`agent-session.ts#L1675-L1722`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L1675-L1722)、[`models.ts#L822-L853`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/ai/src/models.ts#L822-L853)

**预检结论：**模板解析阶段先验证等级枚举；若模板要求具体模型支持该等级，父进程可用同版本模型元数据检查，但仍应在子进程 ready 响应中回读 `get_available_thinking_levels` 或 `get_state.thinkingLevel`，否则必须把“实际等级被 clamp”作为允许的明确回退，而不能隐瞒。

### 4. 系统提示与追加提示

CLI 的 `--system-prompt` 和重复的 `--append-system-prompt` 会传入 `DefaultResourceLoader`；SDK 可通过 `systemPrompt`、`appendSystemPrompt` 或 override 回调控制同一面。[`args.ts#L95-L99`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/cli/args.ts#L95-L99)、[`resource-loader.ts#L173-L192`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L173-L192)

解析规则是源码事实而非一个独立的“纯文本”契约：若输入值在子进程中 `existsSync()` 为真，Pi 尝试把它当文件读；读取失败打印 warning 后把原字符串当作正文；不存在的值直接当作字面提示。[`resource-loader.ts#L53-L68`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L53-L68) 因而模板不能把“恰好等于一个现存路径的提示文本”当作稳定 inline 文本，SDK override 更适合需要字节级确定的场景。

没有专门的 `--no-system-prompt-files`。未显式提供时，项目 `.pi/SYSTEM.md` 优先于全局 `SYSTEM.md`；追加提示同理发现 `APPEND_SYSTEM.md`。显式 `--system-prompt` 会替代发现的基底；显式传一个空的 `--append-system-prompt ""` 会让解析数组非 `undefined`，从而阻断 APPEND 文件发现，但这是源码行为，不是 docs 中承诺的禁用开关。[`resource-loader.ts#L525-L545`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L525-L545)

自定义基底不会移除其他上下文：`AgentSession` 仍把 append prompt、context files、skills、当前活动工具说明拼进系统提示。要获得确定文本，至少同时显式 system prompt、阻断 append 发现，并按需 `--no-context-files`、`--no-skills` 和工具 allowlist。[`agent-session.ts#L1030-L1047`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L1030-L1047)

`--no-context-files` 只关闭 `AGENTS.md`/`CLAUDE.md` 加载，不影响 `SYSTEM.md` 或 `APPEND_SYSTEM.md`；这几类资源由 `DefaultResourceLoader.reload()` 的不同分支处理。[`resource-loader.ts#L514-L545`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L514-L545)

RPC 没有设置或查询系统提示的命令；启动后只能通过自定义扩展事件或自定义 SDK 入口证明最终文本。

### 5. 工具集合

公开 CLI 支持：

- `--tools <list>`：对内建、扩展和 SDK custom tools 统一使用的 allowlist；
- `--exclude-tools <list>`：在 allowlist 或默认集合之后排除名字；
- `--no-builtin-tools`：关闭默认内建工具，但保留扩展/custom tools；
- `--no-tools`：关闭全部工具。

官方 SDK 文档列出的内建名为 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`；默认活动内建只有前四个。[`usage.md#L205-L214`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L205-L214)、[`sdk.md#L509-L538`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L509-L538)、[`sdk.ts#L245-L251`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L245-L251)

提供 `tools` 时，工具注册表和活动集合都按名字过滤，空数组关闭全部工具；回归测试覆盖了内建与动态扩展工具共同 allowlist 的行为。[`2835-tools-allowlist-filters-extension-tools.test.ts#L68-L92`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/test/suite/regressions/2835-tools-allowlist-filters-extension-tools.test.ts#L68-L92) `--no-builtin-tools` 只让默认内建不活动，扩展工具仍可活动；`--no-tools` 才使活动集合为空。[`3592-no-builtin-tools-keeps-extension-tools.test.ts#L73-L95`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/test/suite/regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts#L73-L95)

关键失败语义是：`setActiveToolsByName()` 只加入注册表中存在的名字，未知项被直接忽略，不会产生 diagnostic 或抛错。[`agent-session.ts#L913-L933`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L913-L933) 动态扩展工具只有在扩展执行注册后才完全确定。RPC 协议只有 `get_commands`（extension command、prompt template、skill command），没有 `get_all_tools` 或 `get_active_tools`；`get_state` 也没有 tools 字段。[`rpc.md#L791-L830`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/rpc.md#L791-L830)、[`rpc-types.ts#L20-L73`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L73)

**本扩展必须补足：**

- 模板 `tools` 表示该角色必须完整获得的最终工具集，不是可静默裁剪的上限。
- 先验证每个名字属于受控工具目录；模板声明未知工具名属于 `template_invalid`。
- 再验证父会话有效授权包含模板全部必需工具；缺少任何一项返回 `template_capability_unavailable`，可在 `details.missing_tools` 中列出安全名称。
- 该拒绝必须发生在并发名额预留、节点登记和进程启动之前。
- 若工具来自动态扩展，扩展必须维护受控 extension-to-tool manifest，或为子进程新增加载后能力证明；单靠 `--tools` 和 `RpcClient.start()` 不满足失败关闭要求。

工具可见性只收窄模型接口面，不是 OS 文件权限。只要仍保留 `bash` 或其他具副作用工具，就不能据此承诺工作目录只读或 cwd 外不可访问。

### 6. 扩展

`--extension/-e` 可重复，来源可以是本地路径、npm 或 git；`--no-extensions` 关闭设置、包和自动发现，但显式 `-e` 来源仍加载。官方文档明确允许 `--no-extensions -e ./my-extension.ts` 组合。[`usage.md#L216-L234`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L216-L234)、[`resource-loader.ts#L446-L465`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L446-L465)

标准 CLI 还有一个容易遗漏的例外：`main()` 无条件把 `builtInExtensions` 与调用方 inline factories 传给资源加载器；固定提交中的内建集合含隐藏的 `llama.cpp` provider 扩展。`--no-extensions` 只影响发现路径，不能移除这些 inline factories。[`main.ts#L524-L535`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L524-L535)、[`main.ts#L723-L736`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L723-L736)、[`extensions/index.ts#L1-L4`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/extensions/index.ts#L1-L4) 因此“精确扩展集”在标准 CLI 中应表述为“固定 Pi 版本内建 inline extensions + 显式批准扩展”，而不是零扩展；若必须排除内建扩展，需要自定义 SDK/RPC 入口。

扩展可注册工具、命令、provider，并可贡献 skill/prompt/theme 路径。显式 `-e` 的一个包也不必只产生一份扩展脚本，所以模板预检要验证解析后的资源清单，不应把 CLI 字符串数量当作最终能力数量。扩展加载错误会映射为 runtime error，标准 CLI 在进入 RPC 循环前退出；provider 注册错误也作为 error diagnostic。[`agent-session-services.ts#L135-L183`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session-services.ts#L135-L183)、[`main.ts#L739-L765`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L739-L765)、[`main.ts#L851-L857`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L851-L857)

RPC 启动后没有加载、卸载、列举扩展或查询扩展诊断的命令。

### 7. Skills

`--skill <path>` 可重复；`--no-skills` 关闭设置、包和默认发现，但显式 CLI skill 路径仍保留。[`usage.md#L220-L225`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L220-L225)、[`resource-loader.ts#L467-L480`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L467-L480)

skill 加载不是失败关闭：缺 description 会跳过，非法 name 或解析问题通常形成 warning，重名采取先到者胜并记录 collision。[`skills.ts#L301-L324`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/skills.ts#L301-L324)、[`skills.ts#L387-L486`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/skills.ts#L387-L486) 显式本地路径不存在时 `DefaultResourceLoader` 会记录 `type: "error"`，但标准 `main()` 的 runtime fatal 集合只收集 extension errors、service/settings/model option diagnostics，没有把 `getSkills().diagnostics` 加进去；RPC 子进程仍可能启动。[`resource-loader.ts#L471-L479`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L471-L479)、[`main.ts#L738-L765`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L738-L765)

RPC `get_commands` 能列出最终成功加载的 `skill:<name>`，但不能返回被跳过项和全部 diagnostics。因此，模板要求的 skill 必须由扩展在创建前检查路径、UTF-8 Markdown、frontmatter、名字、description、冲突和期望数量。

### 8. Prompt templates

`--prompt-template <path>` 可重复；`--no-prompt-templates` 关闭发现但保留显式路径。[`resource-loader.ts#L482-L499`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L482-L499)

prompt template 同样不是严格输入：文件读取或 frontmatter 解析异常时直接返回 `null`，目录读取失败也静默返回；显式不存在路径虽在 loader 层记录 `type: "error"`，该 prompt diagnostic 不进入标准 RPC 启动 fatal 集合。[`prompt-templates.ts#L104-L132`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/prompt-templates.ts#L104-L132)、[`prompt-templates.ts#L138-L174`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/prompt-templates.ts#L138-L174)、[`resource-loader.ts#L486-L499`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L486-L499)

RPC `get_commands` 可列出最终加载成功的 prompt command，但不能证明期望文件没有被静默跳过。本扩展的代理模板虽然也采用 `.md` + YAML frontmatter + 正文提示，但它是本扩展自己的严格 schema，不能复用 Pi prompt template 的宽松解析结果作为模板有效性证明。

### 9. Context files

未禁用时，Pi 加载 agentDir 下的 `AGENTS.md`/`CLAUDE.md`，并从文件系统根到 cwd 的祖先链逐级加载同名文件；读取失败仅打印 warning 并跳过。[`resource-loader.ts#L70-L155`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L70-L155) `--no-context-files/-nc` 是 CLI 唯一的 context files 关闭开关，没有显式 context path CLI 选项；SDK 可用 `agentsFilesOverride` 注入精确集合。[`usage.md#L98-L106`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L98-L106)、[`resource-loader.ts#L188-L192`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L188-L192)

Context files 不受 project trust 保护；即使 `--no-approve`，只要没传 `--no-context-files` 仍会加载。[`security.md#L20-L29`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/security.md#L20-L29) RPC 没有查询最终 context files 的命令。

### 10. 环境变量

`RpcClient` 总是使用 `{ ...process.env, ...options.env }`。这里的 `env` 是同名覆盖，不是 allowlist，也没有公开的“删除宿主变量”选项；子代理继承的是创建它的扩展宿主进程在 spawn 时的环境快照，而不是某个抽象父会话对象。[`rpc-client.ts#L94-L98`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L94-L98)

这会影响 provider API key、AWS/Azure/Cloudflare 等配置、`HOME`、代理设置、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、`PI_PACKAGE_DIR` 和 `PI_OFFLINE` 等行为；官方 CLI 帮助列出了主要变量。[`args.ts#L359-L416`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/cli/args.ts#L359-L416)

**规格含义：**若首版只承诺“按父进程环境启动并覆盖模板允许项”，可继续使用 `RpcClient` 并明确该边界。若要求严格环境白名单或删除敏感变量，必须由扩展自行调用 `spawn` 构造最小 env，或给 `RpcClient` 增加包装/上游能力；仅传 `options.env` 做不到。

### 11. Project trust

标准 CLI 的非交互模式（含 RPC）不显示 trust prompt。没有适用保存决定时，全局 `defaultProjectTrust: "ask"` 和 `"never"` 都忽略项目资源，`"always"` 信任；`--approve` / `--no-approve` 覆盖单次运行。[`usage.md#L117-L129`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L117-L129)、[`security.md#L18-L29`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/security.md#L18-L29)

受保护资源包括 cwd 下 `.pi/settings.json`、extensions、skills、prompts、themes、`SYSTEM.md`、`APPEND_SYSTEM.md`，以及 cwd/祖先的项目 `.agents/skills`。[`trust-manager.ts#L29-L37`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/trust-manager.ts#L29-L37)、[`trust-manager.ts#L177-L205`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/trust-manager.ts#L177-L205) context files 不在这组保护内。

trust store 按 canonical cwd/祖先目录查询；子进程不会继承父会话内存里的 trust 判断，而是重新读取全局设置和 `trust.json`，再应用 CLI override。[`trust-manager.ts#L39-L56`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/trust-manager.ts#L39-L56)、[`trust-manager.ts#L208-L224`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/trust-manager.ts#L208-L224) 为得到确定行为，子代理每次启动都应显式传其中一个 override，不能依赖父代理当前 trust 状态。

SDK 路径不同：`createAgentSession()` 默认创建 `SettingsManager`，而 `SettingsManager.fromStorage()` 的 `projectTrusted` 默认值是 `true`；CLI 的 trust store、非交互 fallback 和 `project_trust` 解析不自动应用到裸 SDK 调用。[`sdk.ts#L169-L183`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L169-L183)、[`settings-manager.ts#L313-L344`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/settings-manager.ts#L313-L344) 自定义 SDK 入口必须显式创建带正确 `projectTrusted` 的 SettingsManager，或自行使用 ProjectTrustStore/CLI 同等 resolver。

Project trust 只是资源输入门，不是文件系统权限，也不能代表父会话对模板工具的能力授权。

## 启动失败与诊断

Pi 有三层不同的“失败”概念，不能只看字符串中的 `error`：CLI 参数诊断、runtime diagnostics，以及各资源 loader 自己返回的 `ResourceDiagnostic`。标准 `main()` 在启动 RPC 前只把 project-trust 诊断、service 诊断、settings 诊断、session option 诊断和 extension load errors 合并到 runtime diagnostics；只有其中 `type: "error"` 才会 `process.exit(1)`。[`main.ts#L681-L747`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L681-L747)、[`main.ts#L851-L864`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L851-L864)

| 输入或故障 | Pi 当前行为 | 对模板创建的含义 |
| --- | --- | --- |
| CLI 缺值/互斥参数等 parser error | 打印 `Error` 并退出；parser warning（例如非法 `--thinking`）继续启动 | 扩展应在本地模板解析阶段先拒绝，不要依赖 CLI warning |
| 未知 provider、无 provider 时未知模型，或跨 provider 精确匹配无法消歧 | `buildSessionOptions()` 形成 error diagnostic，RPC 启动前退出 | 可在父进程静态阻止；仍要考虑动态 provider 在子进程才注册 |
| provider 存在但模型 ID 未匹配 | 可能复制该 provider 的基准模型构造 custom model，只产生 warning 并继续启动 | 严格模板必须 exact 匹配 provider/model 并拒绝 custom fallback |
| extension 文件加载失败或 provider 注册抛错 | 进入 runtime error，标准 CLI 退出 | 显式扩展集合可以要求失败关闭，但工具 manifest 仍需父侧预检 |
| `settings.json` JSON 解析失败 | `SettingsManager.tryLoadFromStorage()` 捕获，使用空设置并记录 error；CLI `collectSettingsDiagnostics()` 以 warning 打印 | 不是 Pi 原生的拒绝创建契约；严格模板需自行读取/校验受控设置 |
| `models.json` 不存在 | 当作空配置，使用内建模型/其他来源 | 不代表自定义模型缺失错误 |
| `models.json` 解析/Schema/读取失败 | `ModelConfig` 保存错误字符串，模型集合可能为空；标准 RPC runtime diagnostics 不自动包含 `modelRuntime.getError()` | 请求固定自定义模型时可能后续变成 unknown/no-model；父侧应检查 `getError()` |
| 显式 skill 路径不存在 | loader 返回 `type: "error"`，但 skill diagnostics 未加入 `main()` fatal 集合 | 子进程仍可能启动且缺 skill；必须创建前预检 |
| skill frontmatter 缺字段、非法 name、解析异常或重名 | 多数 warning、跳过、先到者胜或 collision | 不能把“加载函数返回”当作模板完整性证明 |
| 显式 prompt template 路径不存在/读取失败/解析失败 | 不存在路径记录 loader diagnostic；读取/解析异常通常返回 `null` 或静默忽略；prompt diagnostics 未进入 fatal 集合 | 必须自行检查文件、格式、名字和冲突 |
| `trust.json` JSON/Schema 无效 | `ProjectTrustStore.get()` 读取时抛异常；没有显式 override 时可能令主进程异常退出 | 每次启动显式 `--approve` 或 `--no-approve` 可绕开本次 trust store 查询；不能依赖父内存状态 |
| 模型没有有效 API key | 模型对象可先解析；首次请求或 `set_model` 可能抛 `No API key` | “模型存在”与“可用凭据”必须分开检查 |
| allowlist 中未知工具名 | `setActiveToolsByName()` 静默忽略 | **不能**用 `--tools` 作为模板能力校验；缺工具要由扩展返回 `template_capability_unavailable` |
| `RpcClient.start()` 返回成功 | 只表示 100 ms 时进程未退出 | 不是 ready、配置一致性或能力证明；应有扩展握手或 SDK 入口 |

设置解析和 trust 解析的源码证据分别见 [`settings-manager.ts#L355-L383`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/settings-manager.ts#L355-L383)、[`main.ts#L86-L101`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L86-L101)、[`model-config.ts#L245-L283`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-config.ts#L245-L283)、[`trust-manager.ts#L97-L122`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/trust-manager.ts#L97-L122)。

### RPC 启动后可查询的最小事实

标准协议提供 `get_state`、`get_available_models`、`get_available_thinking_levels` 和 `get_commands`，可分别回读当前 model/thinking、模型目录、思考等级和已加载 command/resource 的一部分。[`rpc.md#L160-L193`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/rpc.md#L160-L193)、[`rpc.md#L215-L333`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/rpc.md#L215-L333)、[`rpc.md#L791-L830`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/rpc.md#L791-L830) 但没有以下查询：

- 当前活动工具或全部已注册工具；
- 最终系统提示、append prompt、context files 内容；
- 扩展集合、技能/模板的失败项和 collision 全量；
- 环境变量快照、project trust 决策；
- 子进程是否使用了模板期望的 `agentDir` 或设置覆盖。

所以这些项目若属于模板契约，必须由扩展-owned handshake、受控 SDK 入口或父侧同源预检补足。

## 确定性启动建议

### 标准 RPC CLI 的最小显式参数集

当扩展选择固定提交中现成的 `pi --mode rpc` 作为子进程时，建议在每次创建都显式构造下列等价参数（示例仅展示策略，不是 Pi 新增 CLI）：

```text
--mode rpc
--no-session
--provider <provider>
--model <exact-model-id>
--thinking <validated-level>
--system-prompt <known-inline-text-or-controlled-file>
--append-system-prompt ""
--tools <validated-tool-list>
--no-extensions
--no-skills
--no-prompt-templates
--no-themes
--no-context-files
--no-approve
```

这组参数的意图是：不恢复会话；不接受 project-local 自动资源；阻断默认技能、prompt、theme、context 发现；显式固定模型、思考和工具。若模板确实允许项目资源，应改为显式 `--approve` 并把要加载的路径作为模板清单，不能依赖保存的 trust 状态。`--no-*` 与显式 `--extension`、`--skill`、`--prompt-template` 可组合，因此“禁用发现”不等于禁止模板显式资源。[`usage.md#L216-L245`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L216-L245)

这套 CLI 方案仍有四个已知缺口：

1. `--no-extensions` 不会移除 `main()` 注入的 `llama.cpp` inline extension；严格零扩展或严格固定扩展集需要自定义 SDK/RPC 入口，或把该内建扩展计入清单。[`main.ts#L528-L535`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L528-L535)、[`extensions/index.ts#L1-L4`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/extensions/index.ts#L1-L4)
2. `--append-system-prompt ""` 阻断 APPEND 文件发现是源码事实，不是官方声明的 `--no-append-system-prompt` 契约；需要绝对确定时使用 SDK `appendSystemPromptOverride` 或自定义入口。[`resource-loader.ts#L531-L544`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L531-L544)
3. `--system-prompt` 会按 `existsSync()` 在文件和字面值之间选择；若模板正文恰好是现存路径，语义会改变。SDK `systemPromptOverride` 才能直接提供不经路径判定的字符串。[`resource-loader.ts#L53-L68`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L53-L68)、[`sdk.md#L497-L505`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L497-L505)
4. `RpcClient.env` 不能构造最小环境；要清除宿主变量，扩展需要自行 spawn，或让自定义子进程入口接收明确 env map。[`rpc-client.ts#L94-L98`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L94-L98)

### 创建顺序

扩展控制器应按以下顺序执行，并把任何拒绝放在名额和节点状态变更之前：

1. 读取并严格解析模板 `.md`/frontmatter；拒绝缺字段、非法类型、未知字段策略不一致、未知工具名、重复/冲突和不可读资源，统一使用 `template_invalid`。
2. 计算父会话的**有效授权**，而不是父模板声明或 Pi 默认值；逐级求交根上限、父授权与模板要求。`subagents: disabled` 时整组管理工具对当前节点及后代不可见；`inherit` 不能恢复父级已关闭能力或突破 `maxDepth`。
3. 比较模板必需工具/能力与父有效授权。缺少任一项立即返回 `template_capability_unavailable`，在安全 `details` 中列出缺失项；不得静默从 `--tools` 删除，也不得预留名额、登记节点或启动子进程。
4. 在父侧对静态可验证项做同版本预检：exact provider/model、thinking 枚举、显式文件存在/格式、受控 extension manifest、环境策略和资源路径。动态 provider、扩展注册工具、最终 trust/设置合并标为待子进程证明。
5. 原子预留直接子代理名额并登记 `starting` 节点；只有通过前四步才允许进入这一步。
6. 构造固定 `cwd`、显式 trust override、显式 `--no-*`/资源路径和模型参数，启动 RPC 子进程；记录实际 args、cwd、env policy 摘要（不记录 secret）。
7. 完成能力握手后才把节点公布为 `idle`。标准 RPC 没有 ready/能力握手，因此扩展应加载一个受控 inline/显式 extension，在 `agent_start` 或自定义事件中回报版本、model/provider、effective thinking、active tools、资源摘要和配置哈希；或者改用 SDK 自定义入口直接返回这些值。握手失败应终止该节点并留下可诊断故障，不把未验证进程当作可用子代理。

启动后可以用 `get_state`、`get_available_models` 和 `get_available_thinking_levels` 做部分回读，但这些标准命令不能替代工具/资源/env/trust 能力证明。

### SDK 精确入口建议

如果扩展愿意维护一个很薄的子进程入口，SDK 可以把确定性提高到 CLI 做不到的程度：

```ts
const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
const loader = new DefaultResourceLoader({
  cwd: rootCwd,
  agentDir: controlledAgentDir,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPromptOverride: () => template.systemPrompt,
  appendSystemPromptOverride: () => template.appendSystemPrompt ? [template.appendSystemPrompt] : [],
});
await loader.reload();
const modelRuntime = await ModelRuntime.create({
  authPath: controlledAuthPath,
  modelsPath: controlledModelsPath,
  allowModelNetwork: false,
});
const { session } = await createAgentSession({
  cwd: rootCwd,
  agentDir: controlledAgentDir,
  model: resolvedModel,
  thinkingLevel: template.thinking,
  tools: template.tools,
  resourceLoader: loader,
  modelRuntime,
  settingsManager,
  sessionManager: SessionManager.inMemory(rootCwd),
});
```

示例强调可用 API，不是要求本票据实现 SDK 子进程；真实代码仍需绑定扩展工具、provider 注册和 RPC 线协议。`SettingsManager.inMemory()`、`ResourceLoader` override 和 `ModelRuntime` 让扩展能先取得确定快照，但若再由另一个标准 CLI 子进程启动，仍会发生读取竞态，因此能力握手不可省略。[`sdk.md#L46-L64`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L46-L64)、[`sdk.md#L497-L505`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L497-L505)、[`sdk.md#L509-L621`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L509-L621)

## 严格预检矩阵

| 模板/运行时项目 | 父侧静态可验证 | 可用同版本 SDK 做较强预检 | 只有子进程加载后才能确定 | Pi 原生是否提供查询/失败保证 |
| --- | --- | --- | --- | --- |
| `.md` frontmatter、字段类型、`subagents`、未知工具名 | 是；同一解析器即可拒绝 | 不需要 | 否 | 否；模板格式属于本扩展 |
| 根 `cwd` 不可覆盖、`maxDepth`、父有效授权求交 | 是 | 不需要 | 否 | 否；Pi 只接收 cwd，不知道代理树 |
| 内建工具名 | 是（固定提交目录） | 可从 `getAllTools()` 交叉检查 | 否 | allowlist 未知名静默忽略 |
| 动态扩展/custom 工具 | 只有已有受控 manifest/父 registry 时可验证 | `ResourceLoader` + `AgentSession.getAllTools()` 可核对 | 扩展执行注册后才最终确定 | RPC 无活动工具列表 |
| provider/model 语法与内建模型存在 | 是 | `ModelRuntime.getModel()` | 动态 provider 注册、最终 provider 配置 | `get_available_models` 仅启动后快照 |
| provider 认证可用 | 只能检查父快照/配置 | `ModelRuntime.getAvailable()` 较强 | 子进程 env/auth 读取与请求时认证 | 无启动前保证；请求可失败 |
| thinking 等级枚举 | 是 | 可按 Model 元数据检查 | 实际 clamp 后等级、provider 语义 | RPC 可回读 available，但 set 成功不等于原值 |
| inline system/append prompt | SDK override 可静态确定 | 是 | 标准 CLI 的路径判定、发现和追加合并 | RPC 无提示查询 |
| 显式 extension 路径存在/静态语法 | 是 | 可加载同版本模块 | 执行副作用、provider/tool 注册、包解析 | extension errors 会 fatal；非所有资源如此 |
| skill 文件与 frontmatter | 是（扩展自有严格 parser） | 可复用同版本 loader 后再加严格规则 | trust/设置/包扩展带来的额外 skill、竞态 | diagnostics 不进 RPC fatal |
| prompt template 文件与 frontmatter | 是（扩展自有严格 parser） | 可复用 loader 后再加严格规则 | 目录/包发现与冲突竞态 | 解析失败常静默；diagnostics 不进 fatal |
| context files | 若强制 `--no-context-files` 或 SDK override：是 | 是 | 默认祖先扫描、文件变化 | 无显式列举 RPC |
| env 白名单/敏感变量 | 只有扩展自行构造 spawn env 时是 | SDK 子进程入口可控 | `RpcClient` 标准 spawn 只能 merge，最终快照在 child | 无 env 查询；`env` 不是白名单 |
| project trust | 显式 `--approve`/`--no-approve` 时是 | SDK 要显式 `projectTrusted` | 默认 trust store/全局设置读取 | 非交互不提示；SDK 默认 true |
| `--no-session` 无持久会话 | 是 | `SessionManager.inMemory()` | 否 | 只保证 session，不保证无磁盘读写 |
| 最终全部资源/工具集合与模板一致 | 不能仅静态保证，除非所有来源被锁定 | 可先构造快照 | 需要 child handshake/hash | Pi 没有总能力查询 |

“同版本 SDK 预检”不是跨进程证明：父侧和子侧可能读取不同的 env、auth、trust、设置或文件版本；它的作用是提前给出可解释错误，不是替代启动后证明。对不可查询项目，扩展应将受控清单/配置摘要带入子进程，由子进程回传同一摘要或签名哈希。

## 证据分层与实现结论

### A. Pi 官方公开契约

- CLI 的模型、工具、资源、上下文、trust 和 `--no-session` 选项及组合方式：[`usage.md#L98-L129`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L98-L129)、[`usage.md#L182-L245`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/usage.md#L182-L245)。
- RPC 的模型/thinking/state/commands 命令和响应形状：[`rpc.md#L160-L333`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/rpc.md#L160-L333)、[`rpc.md#L791-L830`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/rpc.md#L791-L830)。
- SDK 的模型、目录、工具、扩展和自定义 prompt 入口：[`sdk.md#L46-L64`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L46-L64)、[`sdk.md#L335-L395`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L335-L395)、[`sdk.md#L497-L621`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/sdk.md#L497-L621)。
- Project trust 不是 sandbox、context files 不受 trust 保护：[`security.md#L1-L35`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/docs/security.md#L1-L35)。

### B. 固定提交的源码事实

- `RpcClient` 的 spawn/env/100 ms 行为：[`rpc-client.ts#L28-L139`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L28-L139)。
- CLI runtime 的资源装配顺序、trust、model resolve 和 fatal diagnostics：[`main.ts#L661-L800`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L661-L800)、[`main.ts#L851-L864`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/main.ts#L851-L864)。
- SDK/loader 的可注入配置：[`sdk.ts#L38-L85`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/sdk.ts#L38-L85)、[`resource-loader.ts#L158-L193`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L158-L193)。
- 工具 allowlist 静默过滤、思考等级 clamp、资源诊断分离：[`agent-session.ts#L913-L933`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L913-L933)、[`agent-session.ts#L1675-L1743`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/agent-session.ts#L1675-L1743)、[`resource-loader.ts#L467-L545`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/resource-loader.ts#L467-L545)。
- `models.json`、`settings.json`、`trust.json` 的具体容错/抛错路径：[`model-config.ts#L245-L296`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/model-config.ts#L245-L296)、[`settings-manager.ts#L355-L383`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/settings-manager.ts#L355-L383)、[`trust-manager.ts#L97-L122`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/core/trust-manager.ts#L97-L122)。

源码事实可能随 Pi 升级改变；扩展启动时应检查 Pi 版本/能力，而不是只比较 CLI 版本字符串。公开包确实导出相关 SDK 和 `RpcClient`，但导出不代表它们之间已有模板、能力握手或父子权限语义。[`index.ts#L180-L225`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/index.ts#L180-L225)、[`index.ts#L324-L350`](https://github.com/earendil-works/pi/blob/a96fb984d8c8b065fc5d193309fc812a882adee0/packages/coding-agent/src/index.ts#L324-L350)

### C. 本扩展必须新增的契约

1. 代理模板使用 `.md`、YAML frontmatter 和正文提示只是第一方示例惯例；本扩展要冻结自己的字段、默认值、未知字段策略、资源来源、`subagents: inherit | disabled` 和覆盖/去重规则。
2. 每个模板必须显式声明 `tools`，显式空集合表示无业务工具，省略字段不能隐式继承父会话工具；该字段是最终必需完整集合，不能被父会话能力静默削减。未知工具名使用 `template_invalid`，父有效授权缺工具使用不可重试的 `template_capability_unavailable`。
3. `template_capability_unavailable` 的拒绝点在名额预留、节点登记、RPC spawn 之前；`details` 只允许安全的缺失能力摘要，不泄露凭据、完整 env 或敏感路径。
4. 管理工具可见性是独立能力：`subagents: disabled` 时七个管理工具整组隐藏，即使距离 `maxDepth` 仍有余量；后代不能重新开启。Pi 本身不认识这个字段。
5. 固定根 `cwd`、工具可见性、资源自动发现、project trust 和 OS 文件权限是不同维度；不应把其中任一维度写成另一个维度的替代品。
6. 每次标准 RPC 启动都显式设置 trust、session、资源 `--no-*`、模型、thinking 和工具参数；若需要环境白名单、准确系统提示或零 inline extension，使用自定义 spawn/SDK 入口。
7. 在节点对父会话报告 `idle` 前完成扩展-owned capability handshake；否则 `RpcClient.start()` 只能证明进程在 100 ms 内没有退出，不能证明模板已经实现。

以上结论只描述固定提交的 Pi 表面和扩展需要补足的边界，不修改 Pi 核心，也不把任何未经实现的父子树控制语义归因于 Pi。
