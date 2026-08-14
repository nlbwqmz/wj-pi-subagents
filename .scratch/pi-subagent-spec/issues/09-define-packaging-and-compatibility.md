# 确定发布、安装与 Pi 兼容性边界

Type: grilling
Status: resolved
Blocked by: 01, 04, 05, 12

## Question

扩展应采用什么 Pi 包结构和安装入口，支持哪些操作系统与最低 Pi/Node 版本，如何声明配置、模板和运行依赖，并在所需 RPC 或扩展能力缺失时进行版本检查和可理解的失败，而不要求修改 Pi 核心？

## Answer

本扩展以不修改 Pi 核心的标准 Pi package 交付。包只负责提供子代理控制扩展，不拥有代理模板或根配置；安装、发现、项目 scope 和 project trust 均复用 Pi 的原生 package 机制。事实依据与 Pi 当前未提供的兼容门禁见 [Pi 扩展打包与兼容性研究](../research/pi-packaging-compatibility.md)。

### 包结构与依赖边界

`package.json` 使用 Pi 标准 manifest，并只显式声明一个扩展入口。首版不依赖约定目录扫描，也不通过 package manifest 注册 skills、prompt templates 或 themes。下面是必须字段的示意片段，实际包名和第三方运行依赖由实现与发布元数据确定：

```json
{
  "engines": {
    "node": ">=22.19.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./extensions/pi-subagents-wj.ts"]
  },
  "piSubagent": {
    "requiresPi": ">=0.84.1"
  }
}
```

- 第三方运行期依赖必须放在 `dependencies`，不能只放在 `devDependencies`。扩展实际导入的宿主 Pi 包使用宽 `peerDependencies: "*"`，不把宿主实现打入分发包，也不依赖 peer 解析充当兼容门禁。
- Pi 只加载 `pi.extensions` 指定的唯一入口。包内可以包含该入口所需的内部模块和静态资源，但它们不作为独立 Pi 资源被发现。
- 包不携带或安装代理模板，不创建、复制或修改用户级/项目级模板文件，也不创建或修改 `subagent.json`、Pi 用户设置或项目设置。模板继续只按 05 号票据从用户级和已信任项目级目录发现。
- package 自有 `piSubagent.requiresPi` 不是 Pi 标准 manifest 字段，只供本扩展兼容门禁读取；Pi 当前不会替扩展强制执行该字段。

### 安装与可复现发布来源

npm 是规范发布渠道，正式发布采用 SemVer。git tag 是等价的可安装发行来源，使用 `v<package.json version>` 命名，并必须指向与相同版本 npm 包相同的源码。完整 git commit 可用于精确固定、预发布验证和问题复现。

- npm、git tag 和完整 git commit 均须支持 Pi 的临时 `-e/--extension` 加载，以及持久的 `pi install`。
- 持久安装默认使用用户 scope；项目 scope 使用 Pi 原生 `-l` 规则，并继续受 project trust 控制。扩展不绕过信任，也不自行复制安装文件。
- 可变 branch、未固定 git URL 和浮动 npm 标签不属于首版的可复现安装承诺，正式安装说明不以它们作为示例。完整本地路径只用于开发和验收，不算发布渠道。
- 不要求用户手工复制扩展文件，不修改 Pi 核心，也不维护独立于 Pi package manager 的安装器或自动更新器。

### 最低运行环境与平台范围

当前最低运行环境为 Node `>=22.19.0`、Pi `>=0.84.1`。Node 下限由 `engines.node` 声明；Pi 下限由 `piSubagent.requiresPi` 声明并由扩展自行检查。若 Node 版本低到宿主 Pi 本身无法启动，则由 Pi/Node 的既有启动路径失败；只要扩展 factory 能执行，兼容问题都按下述扩展门禁处理。

首版支持 Windows、macOS 和 Linux：

- Windows 必须提供基于 Job Object 的 `ProcessTreeAdapter`；
- macOS 和 Linux 必须提供基于 process group 或 session 的适配器；
- 不单独限制 CPU 架构，但宿主架构必须能运行满足版本门槛的 Node 与 Pi，并能通过对应进程树适配器验收；
- 浏览器、移动系统、远程分布式宿主及未验证的其他 Unix 变体不属于首版支持范围。

没有对应进程树适配器的平台不得退化为只终止直接子进程，也不得伪造资源确认或 `terminated`；它统一按宿主不兼容处理。

### 宿主兼容门禁与失败行为

扩展激活是全有或全无的事务。扩展在注册七个管理工具、`/agent`、常驻 widget、监督器或业务生命周期处理器之前，必须完成以下静态探针：

1. 当前 Node 和 Pi 版本满足声明范围；
2. 当前操作系统存在受支持的 `ProcessTreeAdapter`；
3. Pi 提供实现七个工具、命令、UI、会话生命周期和 RPC 监督所需的必需 API；
4. 必需模块和运行期依赖能够加载。

任一探针失败都采用失败关闭：不注册任何公开面，不进行部分工具降级，不启动监督器或子进程。由于 Pi factory 没有 UI 上下文，允许最多注册一次仅用于诊断的 `session_start` 桥；桥不执行扩展业务逻辑，只在 UI 可用时通过 UI-only 诊断显示安全的缺失项和稳定诊断标识 `host_capability_unavailable`，重复事件不重复通知。该标识不是 02 号票据公开工具错误码，因为失败时没有可调用的子代理工具。诊断不创建消息、会话条目或模型上下文；无 UI 模式不增加 stderr、结构化事件或模型消息回退。宿主 Pi 会话保持可用。

Pi `/reload` 重新实例化扩展时同样执行完整门禁。若新实例不能激活，旧控制器必须按 08/12 号票据的既有终止和资源确认语义清理全部子代理，不能留下旧工具、旧 widget、监督端点或孤儿进程；失败后不自动恢复、重启或回退到旧扩展实例。

### 验收边界

09 号票据至少要求后续验收覆盖：

1. npm、匹配版本的 git tag 和完整 commit 能以临时与持久方式加载同一唯一扩展入口；
2. 用户 scope 与已信任项目 scope 正常安装，未信任项目不能绕过 Pi 的 project trust；
3. 生产安装缺少 `devDependencies` 时仍能加载全部运行依赖；
4. 包安装和加载不会写入模板目录、`subagent.json` 或 Pi settings 之外的隐式资源；
5. Pi 版本、必需 API 或平台适配器缺失时不出现部分工具或运行资源，宿主会话仍可使用；
6. reload 激活失败时既有代理树按既有清理语义收敛，不遗留可用工具或孤儿进程；
7. 代码目标保留 Windows、macOS 和 Linux 的整树回收实现；当前开发里程碑只验证 Windows，Unix 原生验证与支持证据延期到独立计划，信号发送本身不能冒充资源确认。

## Comments

<!-- 追加讨论历史。 -->

> 2026-08-06 说明：以下 2026-08-05 的“首版三平台”内容保留为目标平台历史记录，当前开发验收范围以 Windows 里程碑和后续独立跨平台计划为准。
>
> 2026-08-08 说明：Pi 最低版本已升级为 `>=0.84.1`，用于依赖当前压缩、EventBus 与宿主生命周期契约；以下 2026-08-05 的 `0.83.0` 决策保留为历史记录，不再是当前门禁。

- 2026-08-05：用户确认采用标准 Pi package 作为发布单元。包提供 `package.json`、Pi `pi` manifest 和唯一的子代理扩展入口；运行期依赖放在 `dependencies`，宿主 Pi 依赖不打包。首版通过 Pi 原生 npm/git package 安装入口（用户级安装为默认，项目级遵循 Pi 的 `-l` scope）加载，不要求用户手工复制扩展，也不修改 Pi 核心。包只提供扩展及其明确声明的资源，不偷偷写入模板目录或 `subagent.json`；代理模板仍由既定的用户级/项目级目录发现规则负责。
- 2026-08-05：用户确认首版最低运行环境为 Node `>=22.19.0`、Pi `>=0.83.0`。扩展使用自有兼容元数据和加载时的版本/能力探针执行门禁；任一门槛不满足时只通过 UI-only 诊断提示，扩展不注册七个管理工具、`/agent`、常驻 widget 或监督器，宿主 Pi 会话仍可继续使用，诊断不进入模型上下文。宿主 Pi 依赖不声明窄 peer 版本范围，以免 Pi 安装器的 peer 解析阻断安装。
- 2026-08-05：用户确认首版支持 Windows、macOS 和 Linux。Windows 进程树回收使用 Job Object，macOS/Linux 使用 process group 或 session；没有对应 `ProcessTreeAdapter` 的平台按不兼容处理，仅显示 UI-only 诊断并保持扩展未激活，不伪造 `terminated`，宿主 Pi 会话继续运行。浏览器、移动系统、远程分布式宿主和未验证 Unix 变体不属于首版支持承诺；不另设 CPU 架构限制，但必须能运行满足版本门槛的 Node 与 Pi。
- 2026-08-05：用户确认 `package.json` 的标准 `pi` manifest 首版只声明一个明确的扩展入口，不依赖约定目录扫描，也不通过 `skills`、`prompts` 或 `themes` 字段注册额外资源。Node 下限由 `engines.node` 声明，Pi 下限由扩展自有 `piSubagent.requiresPi` 声明；运行依赖放在 `dependencies`，宿主 Pi 依赖保持宽 peer。模板不作为 package 资源发现，不由安装过程复制或写入；包不创建或修改 `subagent.json`、模板文件、项目配置或用户配置，只有显式扩展入口被 Pi 加载。
- 2026-08-05：用户确认扩展激活采用全有或全无事务：注册任何工具、`/agent`、widget、监督器或生命周期钩子前，先完成宿主版本、平台和必需 Pi 控制/监督 API 探针；缺少任一必需能力时不注册任何公开面，不做部分降级。UI-only 诊断使用 `host_capability_unavailable` 标识，但不扩展 02 号票据的公开工具错误码闭集，也不进入模型上下文。初次加载失败只让扩展失活；`/reload` 时新实例探针失败，则旧控制器先按既有终止语义清理全部子代理，不能留下旧工具或孤儿进程，且不自动恢复或重启。无 UI 模式不增加 stderr、消息或模型提示回退。
- 2026-08-05：用户确认 npm 是规范发布渠道，正式版本采用 SemVer；git tag 使用 `v<package.json version>` 并指向与同版本 npm 包相同的源码，完整 git commit 可用于精确固定、预发布验证和复现。npm、tag 和 commit 都支持 Pi 临时 `-e` 与持久 `pi install`，项目级遵循 project trust 和 `-l`；可变 branch、未固定 git URL、浮动 npm 标签不属于可复现安装承诺，本地路径只用于开发与验收。
- 2026-08-05：用户确认门禁失败后允许注册一个诊断专用 `session_start` 桥，以适配 Pi factory 不提供 UI 上下文的现实。该桥只在 `ctx.hasUI` 且 `ctx.ui.notify` 可用时发送一次脱敏 `host_capability_unavailable` warning，不注册公开能力、不启动业务生命周期、监督器或子进程；无 UI 时静默，通知失败也不回退到其他通道。
- 2026-08-06：当前执行计划只安排 Windows 原生测试；macOS/Linux 适配代码可以先交付，但其原生 runner、真实回收证据和支持结论另立计划。该范围调整不删除三平台代码契约，只收窄本轮开发验收。
