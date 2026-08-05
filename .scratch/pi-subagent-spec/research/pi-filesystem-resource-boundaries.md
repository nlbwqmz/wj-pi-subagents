# Pi 文件访问与项目资源边界研究

> 研究基线：`D:\code\open-source\pi` 提交 `a96fb984d8c8b065fc5d193309fc812a882adee0`。
>
> 研究范围：仅使用该提交内的官方文档与源码；不以第三方资料或其他上游版本为依据。

## 结论摘要

固定 RPC 子进程的 `cwd` **可以且应该**用来稳定项目身份、相对路径解析和项目资源自动发现，但它**不是文件访问边界**。Pi 官方安全文档明确说明：Pi 以启动用户的权限运行，项目信任不是沙箱，内建工具与扩展都拥有该进程的宿主权限：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:3)、[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:7)、[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:31)。

内建 `read`、`write`、`edit` 都公开接受“相对或绝对路径”。它们把相对路径解析到 `cwd`，但绝对路径直接使用，`..` 也由 Node 正常折叠；实现没有做“结果必须位于 `cwd` 内”的 containment 检查：[path-utils.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/path-utils.ts:44)、[paths.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/paths.ts:81)、[read.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/read.ts:20)、[write.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/write.ts:14)、[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:44)。`bash` 只是把固定 `cwd` 传给宿主 shell 作为启动目录，命令仍可使用绝对路径、`..`、切换目录或启动其他程序：[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:82)、[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:97)。因此，“整棵代理树固定根 `cwd`”与“有时需要读取或操作工作目录外文件”并不冲突：外部文件可通过显式路径访问，无需改变 `cwd`。

项目信任只决定是否加载当前 `cwd` 对应的项目设置、项目扩展、项目技能、提示模板、主题和系统提示文件。它不会在工具访问某个外部路径时再次做信任判断，也不会限制工具访问已信任项目之外的文件：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:20)、[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:27)、[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:37)。固定 `cwd` 的实际收益是：所有子代理看到同一套项目自动发现资源；读取 `cwd` 外文件不会顺带加载该外部目录附近的 `.pi`、扩展或提示资源。

独立扩展可以通过 `tool_call` 在内建工具执行前检查参数并阻止调用，且扩展异常会以失败关闭方式阻止该次工具执行：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:751)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2886)。但在“不替换内建工具”的约束下，它只能形成 **Pi 工具调用层的策略门**，不能形成可靠的宿主文件系统安全边界，主要原因是：

- `bash` 能用任意程序读写任意 OS 允许的路径，无法靠可靠解析 shell 字符串还原全部文件副作用。
- 其他扩展与自定义工具和策略扩展运行在同一进程、拥有相同 OS 权限，可以直接调用文件系统 API，不必经过内建工具。
- `tool_call` 看到的是执行前参数；处理器可以修改参数，后置处理器还可能再次修改。源码明确说明修改后不会重新校验：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:759)、[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:898)。
- 路径检查与实际文件操作分离，若只在钩子中检查字符串或 `realpath`，仍需面对符号链接、非既有目标父目录和检查后替换等竞态。

所以首版规格可以诚实承诺的是：固定根 `cwd`；把“允许访问哪些路径”建模为独立的显式路径授权；对受控扩展集合中的、由模型发起的已知 Pi 工具调用实施失败关闭的路径策略。首版不能声称“固定 `cwd` 即隔离”“project trust 即文件权限”，也不能在保留任意 `bash` 和同权限任意扩展的同时声称逐路径授权是强安全边界。需要强隔离时，必须依赖 OS ACL、容器/VM/微虚机、只读挂载，或把所有文件/命令执行路由到受控后端；Pi 官方也把真实隔离明确交给操作系统或虚拟化边界：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:35)、[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:39)。

## 研究边界与术语

- 研究开始时用 `git rev-parse HEAD` 核实 `D:\code\open-source\pi` 精确位于提交 `a96fb984d8c8b065fc5d193309fc812a882adee0`，且 `git status --short` 无输出。
- 本报告把源码实现作为行为真值，官方仓库文档作为公开契约；没有运行或修改上游实现，也没有以当前工作仓库的拟议规格反推 Pi 行为。
- 本报告中的“可靠”分两层：
  - **工具调用层可靠**：在受控工具集、受控扩展加载顺序和无外部竞态的前提下，模型通过已知 Pi 工具发起的调用会被策略钩子检查并失败关闭。
  - **安全边界可靠**：即使模型、shell 命令、第三方扩展或并发进程尝试绕过，OS 也无法完成越权访问。Pi 的进程内扩展机制不提供这一层保证。

为避免概念混淆，后文统一区分四个维度：

| 维度 | 含义 | Pi 当前实现 |
| --- | --- | --- |
| OS 权限 | 进程令牌、ACL、挂载、容器、VM、凭据和网络等宿主能力 | Pi、内建工具、扩展和 shell 子进程共同受启动用户与外部隔离环境约束；Pi 不降低这些权限。 |
| 工具可见性 | 模型当前能看到和调用哪些工具名 | 可用 allowlist、denylist、`--no-builtin-tools` 或 `setActiveTools()` 调整；这是模型接口面，不是 OS 权限。 |
| 路径授权 | 某个读/写操作的目标路径是否在策略允许范围内 | 内建 `read/write/edit/bash` 没有 cwd containment；需要扩展或外部沙箱另行实现。 |
| 资源自动发现 | 哪些设置、扩展、技能、提示和上下文会自动进入会话 | 主要由 `cwd`、`agentDir`、project trust、显式 CLI/设置路径共同决定。 |

## 详细核查

### 1. 固定 `cwd` 后，内建文件工具仍可访问工作目录外路径

#### 1.1 `cwd` 是工具实例的解析基点，不是根目录监牢

创建会话时，Pi 先把会话 `cwd` 解析为绝对路径，再用同一值构造资源加载器和会话：[agent-session-services.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session-services.ts:130)、[agent-session-services.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session-services.ts:138)、[agent-session-services.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session-services.ts:148)。`AgentSession` 构造所有内建工具定义时也把同一 `_cwd` 传入 `createAllToolDefinitions(...)`：[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:2551)、[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:2566)；工具工厂再把它分别传给 `read`、`bash`、`edit`、`write` 等定义：[tools/index.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/index.ts:156)。

所有路径型内建工具共用的 `resolveToCwd(filePath, cwd)` 仅调用通用 `resolvePath(...)`：[path-utils.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/path-utils.ts:44)。通用解析规则是：

- 可展开 `~` 到用户主目录，也接受 `file://` URL：[paths.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/paths.ts:57)。
- 输入已经是绝对路径时，直接由 `node:path.resolve` 规范化该绝对路径。
- 输入是相对路径时，以 `cwd` 为基点调用 `node:path.resolve(cwd, input)`；`..` 因而会正常越过 `cwd`：[paths.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/paths.ts:81)。

同一文件中确实另有 `getCwdRelativePath(...)` 可判断一个路径是否在 `cwd` 内，但它只用于显示/格式化；`resolveToCwd` 和四个目标工具的执行路径都没有调用它作为授权检查：[paths.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/paths.ts:87)、[paths.ts](D:/code/open-source/pi/packages/coding-agent/src/utils/paths.ts:98)。因此，以下输入在 OS 允许时都可工作：

| 输入形式 | 实际目标 |
| --- | --- |
| `src/app.ts` | `<固定 cwd>/src/app.ts` |
| `../shared/config.json` | `<固定 cwd 的父目录>/shared/config.json` |
| `D:\data\input.csv` | 指定绝对路径 |
| `~/notes.md` | 当前启动用户主目录中的文件 |

访问外部文件不会改变会话 `cwd`，也不会改变后续相对路径解析或资源自动发现基点。

#### 1.2 `read`

`read` 的公开 schema 直接写明路径可相对或绝对：[read.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/read.ts:20)。执行时先用 `resolveReadPathAsync(path, cwd)` 得到目标，再对目标执行可读性检查和读取；不存在“必须在 cwd 内”的分支：[read.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/read.ts:203)、[read.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/read.ts:238)。默认操作只是宿主 `fs.access(..., R_OK)` 与 `fs.readFile(...)`：[read.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/read.ts:39)、[read.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/read.ts:52)。

结论：固定 `cwd` 后，`read` 仍能读取绝对路径、`..` 指向的路径和 `~` 下文件；真正的上限是 Pi 进程的 OS 读权限。

#### 1.3 `write`

`write` 同样接受相对或绝对路径：[write.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/write.ts:14)。执行时用 `resolveToCwd` 得到绝对目标，然后递归创建父目录并直接调用宿主 `fs.writeFile`：[write.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/write.ts:181)、[write.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/write.ts:201)、[write.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/write.ts:212)。默认操作没有路径范围判断：[write.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/write.ts:21)、[write.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/write.ts:32)。

结论：`write` 可以在 `cwd` 外创建父目录、创建新文件或覆盖既有文件，只要宿主账户对相关目录和文件具有权限。

#### 1.4 `edit`

`edit` 的 schema 也明确接受相对或绝对路径：[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:44)。执行时解析到绝对目标，检查宿主读写权限，读取、应用文本替换并写回同一路径：[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:287)、[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:308)、[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:323)、[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:334)、[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:346)。默认操作直接使用 `fs.readFile`、`fs.writeFile` 与 `R_OK | W_OK`：[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:70)、[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:83)。

结论：`edit` 对 `cwd` 外既有文件的行为与目录内文件相同，只受 OS 读写权限和文本匹配要求限制。

#### 1.5 `bash`

默认 `bash` 后端只确认传入的 `cwd` 存在，然后把它作为 `child_process.spawn(...)` 的进程启动目录：[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:82)、[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:90)、[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:97)。工具调用本身只有 `command` 和可选 `timeout`，没有路径参数或目录范围字段：[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:21)。

因此，固定 `cwd` 只决定 shell 初始所在目录。命令可以直接引用绝对路径或 `..`，可以执行 `cd`，也可以调用 PowerShell、Python、Node、Git、文件复制工具或任何宿主可执行程序。`bash` 还支持 `spawnHook` 改写命令、`cwd` 和环境，但 Pi 创建默认内建工具时只传入命令前缀与 shell 路径，并没有自动安装路径沙箱 hook：[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:158)、[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:186)、[agent-session.ts](D:/code/open-source/pi/packages/coding-agent/src/core/agent-session.ts:2566)。

#### 1.6 符号链接和并发队列不构成授权

`write` 与 `edit` 使用 `withFileMutationQueue(...)` 串行化同一目标文件的并发修改。该队列会尽量用 `realpath` 为既有目标生成队列键，但用途只是“同一文件串行、不同文件并行”，不是准入检查：[file-mutation-queue.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts:16)、[file-mutation-queue.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts:28)、[file-mutation-queue.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts:32)。实际 `fs.readFile/fs.writeFile` 仍按 OS 文件系统语义跟随路径组件和符号链接。

所以规格不能把路径规范化、队列键规范化或固定 `cwd` 写成防止符号链接越界的安全措施。

### 2. Project trust 的实际边界

#### 2.1 trust 以规范化目录及其祖先记录，不以 Git 仓库身份记录

trust store 会把 `cwd` 解析并尽可能 `realpath` 规范化，然后从当前目录逐级向父目录查找最近的布尔决定：[trust-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/trust-manager.ts:39)、[trust-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/trust-manager.ts:43)。用户可只信任当前目录，也可保存“信任直接父目录”；后者会让该父目录下其他后代 `cwd` 也匹配祖先决定：[trust-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/trust-manager.ts:65)。记录写入 `agentDir/trust.json`：[trust-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/trust-manager.ts:208)。

因此，project trust 的身份键是目录树路径，不是 Git remote、提交、仓库 UUID 或“允许访问的所有文件根”。整棵子代理树固定同一规范化 `cwd` 时，正常会命中同一保存决定；但这个决定只控制该 `cwd` 的项目资源加载。

#### 2.2 哪些发现会触发 trust

当前实现把以下 `cwd/.pi` 条目视为需要 trust：`settings.json`、`extensions`、`skills`、`prompts`、`themes`、`SYSTEM.md`、`APPEND_SYSTEM.md`：[trust-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/trust-manager.ts:29)。它还从 `cwd` 向文件系统根查找祖先 `.agents/skills`，但排除用户自己的 `~/.agents/skills`：[trust-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/trust-manager.ts:177)、[trust-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/trust-manager.ts:184)。官方文档给出的公开含义一致：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:9)。

一个实现细节需要单独记录：trust 触发扫描会一直走到文件系统根，而项目 `.agents/skills` 的实际加载在 Git 仓库内只走到最近 Git 根。也就是说，仓库根以上的 `.agents/skills` 可能触发 trust 检测，但不会作为该仓库项目技能加载；源码中的两条遍历边界并不完全相同：[trust-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/trust-manager.ts:194)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:421)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:435)。首版规格不应自行把两者概括成同一个“项目根算法”。

#### 2.3 trust 允许或跳过的是输入资源

信任后，Pi 才加载项目 `.pi/settings.json`；未信任时 project settings 直接为空：[settings-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/settings-manager.ts:193)、[settings-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/settings-manager.ts:355)。资源加载器在 trust 决定前强制以未信任状态先加载用户/全局和临时 CLI 扩展，决定后再重载设置和完整资源集：[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:379)、[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:387)。官方安全文档明确列出：trust 控制项目设置、扩展、技能、提示模板、主题、系统提示、项目包及项目扩展的加载：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:20)。

没有 UI 的 print、JSON 和 RPC 模式不会弹信任提示；没有适用的保存决定时，`defaultProjectTrust: "ask"` 和 `"never"` 都会拒绝项目资源，只有 `"always"` 自动信任，CLI 还可用一次性 approve/no-approve 覆盖：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:29)、[project-trust.ts](D:/code/open-source/pi/packages/coding-agent/src/core/project-trust.ts:77)、[project-trust.ts](D:/code/open-source/pi/packages/coding-agent/src/core/project-trust.ts:86)。这对 RPC 子代理很重要：若父进程没有显式传递一次性决定，也没有保存决定，不能假定项目资源一定加载。

#### 2.4 trust 明确不控制的内容

`AGENTS.md`/`CLAUDE.md` 在未禁用上下文发现时不受 project trust 限制；官方文档明确说明它们无论项目是否受信任都会加载：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:27)。资源加载器也在完成 trust 流程后无条件按 `noContextFiles` 开关加载上下文，而没有检查 `isProjectTrusted()`：[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:514)。

更关键的是，工具执行过程中没有“目标文件所属目录是否 trusted”的检查。官方文档把 project trust 定义为 input-loading guard，并明确说它不会限制模型启动后要求工具执行的动作：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:7)、[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:37)。所以：

- 信任 `D:\repo` 不等于只允许访问 `D:\repo`。
- 未信任 `D:\external` 也不妨碍固定在 `D:\repo` 的 Pi 通过显式路径读取 `D:\external\file.txt`，只要 OS 允许。
- 读取外部文件不会自动把 `D:\external\.pi`、`D:\external\AGENTS.md` 或其扩展加载进当前会话；资源发现仍围绕固定 `cwd` 进行。

### 3. 四类资源如何依赖 `cwd` 和项目路径发现

#### 3.1 总览

| 资源 | 用户/全局自动位置 | 项目自动位置 | 是否向祖先发现 | Project trust |
| --- | --- | --- | --- | --- |
| 扩展 | `<agentDir>/extensions` | `<cwd>/.pi/extensions` | 否 | 项目位置需要；用户/全局和 CLI `-e` 可在 trust 前加载。 |
| 技能 | `<agentDir>/skills`、`~/.agents/skills` | `<cwd>/.pi/skills`；以及从 `cwd` 到 Git 根或文件系统根的 `.agents/skills` | 仅 `.agents/skills` 会 | 项目位置需要；两个用户位置不需要。 |
| 提示模板 | `<agentDir>/prompts` | `<cwd>/.pi/prompts` | 否 | 项目位置需要。 |
| 上下文文件 | `<agentDir>/AGENTS.md` 或 `CLAUDE.md` | `cwd` 及每一级祖先目录中的 `AGENTS.md` 或 `CLAUDE.md` | 是，直到文件系统根 | 不需要；只能通过 `--no-context-files` 等开关整体关闭。 |

另外，`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` 是受 trust 保护的项目系统提示资源，位置只取当前 `cwd/.pi`，不向祖先寻找；用户回退位置是 `<agentDir>/SYSTEM.md` 与 `<agentDir>/APPEND_SYSTEM.md`：[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:1022)。

#### 3.2 扩展

官方文档列出的自动位置只有用户 `~/.pi/agent/extensions` 与项目 `.pi/extensions`，项目位置仅在 trust 后加载：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:109)。源码把用户目录构造为 `agentDir/extensions`，把项目目录构造为 `cwd/.pi/extensions`，且只有 `projectTrusted` 时才加入项目自动发现项：[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2363)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2369)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2395)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2448)。不存在“从 cwd 向上找祖先 `.pi/extensions`”的实现。

扩展也可来自项目或全局 `settings.json`、包以及显式 CLI `-e`。CLI 本地路径在主进程启动时相对于启动 `cwd` 解析，绝对路径保持绝对，因此可以显式加载 `cwd` 外扩展：[main.ts](D:/code/open-source/pi/packages/coding-agent/src/main.ts:510)、[main.ts](D:/code/open-source/pi/packages/coding-agent/src/main.ts:670)。项目 settings 中的本地资源条目以 `cwd/.pi` 为基目录解析；因为底层仍是普通 `resolvePath`，绝对路径或 `..` 也可以指向项目目录外，但加载资格仍来自“已信任的项目设置”：[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:885)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:903)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2307)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2118)。

固定子代理 `cwd` 的结果是：所有子代理的项目自动扩展目录一致。若模板需要不同扩展集，应通过受控 CLI/加载配置显式选择，而不是通过改变 `cwd` 触发另一套项目扩展。

#### 3.3 技能

官方文档对技能位置给出了最完整的公开契约：用户位置为 `~/.pi/agent/skills` 和 `~/.agents/skills`；项目位置为 `.pi/skills`，以及 `cwd` 和祖先目录的 `.agents/skills`；在 Git 仓库内祖先扫描止于 Git 根，不在仓库时止于文件系统根，项目位置均需 trust：[skills.md](D:/code/open-source/pi/packages/coding-agent/docs/skills.md:20)。源码的目录构造和 trust 分支与此一致：[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:435)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2375)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2395)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2415)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2457)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2466)。

技能还可由包、settings 和显式 `--skill` 路径加入。与扩展一样，显式本地路径可位于 `cwd` 外；这属于“显式资源加载”，不是工作目录自动发现。固定 `cwd` 会让 `.pi/skills` 和祖先 `.agents/skills` 集合稳定，但不会阻止模板额外指定一个外部技能路径。

#### 3.4 提示模板

官方文档列出用户 `~/.pi/agent/prompts/*.md`、项目 `.pi/prompts/*.md`、包、settings 和 CLI `--prompt-template`；项目自动位置需要 trust，默认目录发现不递归：[prompt-templates.md](D:/code/open-source/pi/packages/coding-agent/docs/prompt-templates.md:7)、[prompt-templates.md](D:/code/open-source/pi/packages/coding-agent/docs/prompt-templates.md:93)。源码构造 `agentDir/prompts` 与 `cwd/.pi/prompts`，仅在 `projectTrusted` 时加入项目自动发现项：[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2363)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2369)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2431)、[package-manager.ts](D:/code/open-source/pi/packages/coding-agent/src/core/package-manager.ts:2480)。

它不会从祖先 `.pi/prompts` 自动继承。显式 CLI 路径仍相对于启动 `cwd` 解析并可指向外部；项目 settings 路径以 `cwd/.pi` 为基目录，同样可通过绝对路径或 `..` 指向外部。

#### 3.5 `AGENTS.md` / `CLAUDE.md` 上下文文件

资源加载器在每个目录按 `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 的优先顺序选取第一个既有普通文件：[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:70)。加载顺序是：先读取全局 `agentDir` 上下文；再从 `cwd` 一直向文件系统根遍历，把祖先结果按“更高层在前、cwd 在后”的顺序追加：[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:118)、[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:128)、[resource-loader.ts](D:/code/open-source/pi/packages/coding-agent/src/core/resource-loader.ts:134)。官方 README 也公开说明从父目录和当前目录加载并拼接：[README.md](D:/code/open-source/pi/packages/coding-agent/README.md:320)。

这意味着固定 `cwd` 本身就可能自动读取 `cwd` 外的祖先上下文文件；这一点不是路径越权，而是 Pi 明确的上下文继承规则。相反，仅读取一个任意外部数据文件不会使该文件所在目录的上下文进入会话，因为遍历链只由固定 `cwd` 决定。

#### 3.6 固定 `cwd` 后可以诚实描述的资源语义

首版可把固定 `cwd` 定义为：

> 整棵代理树共享同一项目解析基点。相对工具路径、项目 `.pi` 资源、项目 trust 键、项目 settings 和从该目录出发的祖先资源发现都以根会话 `cwd` 为准；访问其他路径不会切换项目身份，也不会自动加载目标路径附近的项目资源。

这一定义既保留项目配置稳定性，也允许显式访问工作目录外数据。它不应再附加“因此不能访问 cwd 外文件”之类的推论。

### 4. 独立扩展能否在不替换内建工具时实施逐路径授权

#### 4.1 Pi 提供的可组合机制

扩展的 `tool_call` 事件发生在工具真正执行之前，可以读取工具名和已校验的输入参数、原地修改输入，或返回 `{ block: true, reason }` 阻止执行：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:751)、[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:853)、[types.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/types.ts:1071)。Agent 核心在收到 `block` 后直接生成错误工具结果而不调用工具；钩子抛错也会被转换为错误结果，因此是失败关闭：[agent-loop.ts](D:/code/open-source/pi/packages/agent/src/agent-loop.ts:600)、[agent-loop.ts](D:/code/open-source/pi/packages/agent/src/agent-loop.ts:636)、[agent-loop.ts](D:/code/open-source/pi/packages/agent/src/agent-loop.ts:657)。官方仓库还提供了用 `tool_call` 阻止 `write/edit` 写入保护路径的示例，证明这是预期用法：[protected-paths.ts](D:/code/open-source/pi/packages/coding-agent/examples/extensions/protected-paths.ts:1)。

扩展也能按会话调整 active tools；官方文档明确说 `getActiveTools/setActiveTools` 同时适用于内建和动态工具，并示例把会话切到只启用 `read`、`bash`：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:1645)。因此，不同 RPC 子进程可以由控制层装配不同工具可见集合和不同策略数据。

对直接路径型工具，独立策略扩展可以做以下应用层检查而不替换执行实现：

- 把 `read`、`grep`、`find`、`ls` 归为读操作。
- 把 `write` 归为写操作，把 `edit` 归为同时要求读与写的操作。
- 将输入相对于固定 `cwd` 解析；对既有目标取规范化真实路径，对新目标至少规范化最深既有父目录；然后与有效只读/读写授权根比较。
- 对不在授权内的调用返回 `block`，对格式错误、无法规范化或策略加载失败的调用同样阻止。

这足以实现“受控工具调用层”的逐路径授权，并可让某些显式外部目录只读、另一些目录读写，而无需改变会话 `cwd`。

#### 4.2 为什么它不是完整可靠的文件系统边界

第一，`bash` 没有结构化路径参数。任何看似安全的命令都可能通过变量展开、重定向、子命令、脚本、解释器、符号链接、Git 配置、构建工具或被调用程序间接访问文件。官方 permission gate 示例也只把 shell 正则检查描述为针对若干“潜在危险命令”的提示门，并没有声称沙箱：[permission-gate.ts](D:/code/open-source/pi/packages/coding-agent/examples/extensions/permission-gate.ts:1)。只要允许任意 `bash`，独立扩展就无法仅靠命令字符串可靠证明所有读写都落在授权路径内。

第二，扩展本身不是受限代码。官方文档明确说扩展以用户完整系统权限运行、可执行任意代码，Node 内建模块也可直接导入：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:109)、[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:139)。另一个扩展或自定义工具可以直接使用 `node:fs`，完全不触发内建 `read/write/edit/bash` 的路径策略。

第三，`tool_call` 处理器按扩展加载顺序串行运行；遇到 `block` 才提前返回：[runner.ts](D:/code/open-source/pi/packages/coding-agent/src/core/extensions/runner.ts:932)。文档保证后置处理器能看到前置处理器的参数修改，同时明确说修改后不重新做 schema 校验：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:759)。如果路径策略处理器之后还有可修改输入的处理器，后者可以在检查后改变目标。因此策略扩展必须处于最终检查位置，或加载集必须禁止其他处理器修改受保护工具参数；它不能对不受控扩展集合自证不可绕过。

第四，检查和使用不是一个原子文件系统操作。即使策略扩展自己正确处理大小写、路径分隔符、`..` 和现有符号链接，其他进程仍可能在检查后、内建工具使用前替换符号链接或目录项。Pi 的工具调用钩子没有提供“在同一个受 OS 保证的目录句柄下检查并打开”的能力。

第五，工具可见性不是权限撤销。隐藏或禁用 `write` 能减少模型接口面，但如果仍有 `bash`、文件型自定义工具或拥有同权限的扩展，进程并没有失去写能力。Pi 官方安全文档明确把内建工具、扩展、包安装和普通开发工具都归为同一宿主权限边界：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:31)。

#### 4.3 条件判定

| 目标 | 不替换内建工具的独立扩展能否做到 | 前提 |
| --- | --- | --- |
| 阻止模型直接用 `read/write/edit/grep/find/ls` 越过路径授权 | 可以，属于工具调用层策略 | 策略处理器最终检查；路径规范化正确；扩展集受控；失败关闭。 |
| 为不同子代理配置不同外部目录只读/读写 | 可以组合实现 | 每个独立进程获得自己的有效授权数据和 active tool 集；授权不通过 `cwd` 表达。 |
| 在保留任意 `bash` 时证明所有文件副作用均未越权 | 不可以 | shell 和被调用程序无法由通用字符串检查完整建模。 |
| 防止同权限扩展或自定义工具绕过 | 不可以 | 扩展可直接调用宿主 API。 |
| 对抗符号链接竞态、恶意并发进程和进程内任意代码 | 不可以 | 需要 OS/虚拟化边界或完全受控执行后端。 |

如果产品要求“强路径边界”同时又要 shell，现实选项只有两类：

1. 在 OS 层运行整个子代理进程，并用 ACL、容器/VM、微虚机、只读/读写挂载和最小凭据限制真实能力。
2. 覆盖/替换内建工具的执行后端，把 `read/write/edit/bash` 全部路由到同一个受控文件系统或沙箱。Pi 官方文档明确支持扩展以同名工具覆盖内建工具，也支持自定义 operations 后端；但这已经不满足“不替换内建工具”的限定：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2046)、[read.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/read.ts:39)、[write.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/write.ts:21)、[edit.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/edit.ts:70)、[bash.ts](D:/code/open-source/pi/packages/coding-agent/src/core/tools/bash.ts:63)。

## 对首版规格的约束

### 1. 保留“整棵树固定根 `cwd`”，但改正它的定义

建议保留已经确认的固定继承规则，并把其目的限定为：

- 固定所有相对工具路径的默认解析基点。
- 固定 project trust 的目录键。
- 固定 `.pi/settings.json`、`.pi/extensions`、`.pi/skills`、`.pi/prompts`、系统提示与祖先上下文/技能的发现链。
- 防止模板通过更换 `cwd` 悄然切换项目身份和自动资源集合。

规格应同时明确：固定 `cwd` 不限制绝对路径、`..`、`~` 或 shell 所能触达的文件。外部路径访问是一项独立能力，不需要也不允许通过更换 `cwd` 实现。

可直接采用的表述是：

> 所有子代理进程使用根会话的规范化工作目录作为唯一项目上下文与相对路径基点。子代理不得覆盖进程 `cwd`。需要访问项目目录外资源时，控制层通过独立的显式路径授权授予相应只读或读写能力；授予外部路径不会改变项目身份、project trust 或资源自动发现范围。

### 2. 路径授权必须与 project trust、工具可见性分开建模

首版至少需要三个独立字段或概念，不能复用一个布尔量：

- `projectTrusted`：是否允许加载固定根 `cwd` 的项目配置和可执行项目资源。
- `activeTools` / 工具能力：模型能否调用 `read`、`write`、`edit`、`bash` 等工具。
- `pathGrants`：哪些规范化路径允许读、哪些允许写。

其中 `pathGrants` 建议以绝对路径根和模式表达，例如“`D:\data\reference` 只读”“`D:\output\job-42` 读写”，而不是用“是否位于 cwd 内”推导。读写授权至少要覆盖以下语义：

- `read`、`grep`、`find`、`ls` 都是读能力，不能只检查名为 `read` 的工具。
- `edit` 同时需要读和写；`write` 需要写，并可能创建父目录。
- 新建目标应按其最深既有父目录规范化；既有目标应按实际路径规范化。
- Windows 上应按平台路径规则处理盘符、分隔符和大小写，不能用字符串 `startsWith` 直接判定子路径。
- 任何解析失败、授权配置缺失或未知文件型工具默认拒绝。

这些要求能提高工具调用层策略质量，但仍不把它升级为 OS 沙箱。

### 3. 对 `bash` 必须做显式产品选择

首版不能同时写下“`bash` 可任意执行宿主命令”和“逐路径授权不可绕过”。建议在规格中二选一或分级：

- **受限代理**：禁用 `bash`，并禁用未纳入审计的文件型自定义工具；策略扩展检查全部已知路径型工具。可以承诺“模型通过启用的 Pi 工具进行的文件访问受路径授权约束”。
- **非受限代理**：允许 `bash`；只能把路径授权描述为对结构化文件工具的防误操作策略，不能承诺完整文件副作用隔离。
- **强化隔离代理**：允许 shell，但整个进程或执行后端位于 OS/容器/VM 沙箱中；此时强边界由挂载、ACL 和进程隔离提供，扩展策略只负责更友好的拒绝信息与审计。

Pi 已支持通过 `--no-builtin-tools`、显式 allowlist 和 active tools 缩小工具面；官方资源选项也支持用 `--no-*` 配合显式资源路径得到确定的加载集：[extensions.md](D:/code/open-source/pi/packages/coding-agent/docs/extensions.md:2046)、[README.md](D:/code/open-source/pi/packages/coding-agent/README.md:587)。这些机制适合构造“受限代理”，但仍要在规格中明确它们是工具面控制。

### 4. RPC 子进程必须显式解决 project trust

RPC 模式没有信任提示 UI。控制层应为每个子进程明确选择以下一种来源，而不是依赖交互：

- 继承并验证固定 `cwd` 已有的保存 trust 决定。
- 由根会话在创建整棵树时确定一次性 approve/no-approve，并把结果作为不可放大的上限传入。
- 对确定性最强的受限模板，禁用项目自动扩展/技能/提示发现，只显式加载批准资源；但 `AGENTS.md/CLAUDE.md` 仍需单独决定是否通过 `--no-context-files` 关闭。

尤其不能把“允许读取某个外部文件”解释为“信任该外部目录的项目资源”。两者必须保持正交。

### 5. 固定 `cwd` 下的资源加载承诺

首版可以承诺：

- 在相同 project trust 与资源发现开关下，所有子代理以同一个 `cwd/.pi` 项目资源集合，以及同一条祖先上下文和 `.agents/skills` 链作为自动发现候选。
- 模板不能通过更换 `cwd` 加载相邻仓库或子目录中的另一套 `.pi` 配置。
- 显式授权访问工作目录外文件，不会自动加载目标所在目录的 `AGENTS.md`、`.pi`、技能、提示或扩展。
- 若模板显式配置外部扩展/技能/提示路径，这属于模板资源授权，必须受根与父级有效授权裁剪；它与普通数据文件路径授权不是同一类能力。

### 6. 首版可承诺与不可承诺的边界

| 可诚实承诺 | 不能诚实承诺 |
| --- | --- |
| `cwd` 在整棵代理树中固定，统一项目上下文与相对路径基点。 | `cwd` 是 chroot、沙箱或文件访问根。 |
| 通过绝对路径或 `..` 可以访问明确授权的工作目录外资源。 | Pi 内建工具天然只访问 cwd。 |
| Project trust 控制项目输入资源加载。 | Project trust 控制工具读写目标或使不受信任文件安全。 |
| 受控扩展可对已知 Pi 工具调用做失败关闭的路径检查。 | 不替换工具、保留任意 bash 和任意同权限扩展时仍有不可绕过的逐路径安全边界。 |
| 工具 allowlist/active tools 能缩小模型调用面。 | 隐藏 `write` 就撤销了进程写权限。 |
| OS 沙箱/只读挂载能提供真正的路径边界。 | 单个进程内 TypeScript 扩展能隔离同进程其他任意代码。 |

## 最终判定

针对“有时需要读取或者操作工作目录之外的文件”这一问题，结论是：**无需推翻固定 `cwd` 决策。** Pi 原生路径工具本来就支持绝对路径和 `..`，所以固定 `cwd` 与访问外部文件可同时成立。规格应把 `cwd` 定义为稳定的项目/资源解析基点，再增加与之正交的显式路径授权模型。

对“独立扩展、不替换内建工具”方案的最终判定是：

- 用于防误操作和约束模型经由结构化 Pi 工具进行的访问：**可行**。
- 用于在受限工具集、受控扩展集下提供工具调用层的逐路径只读/读写策略：**可行，但必须明确前提**。
- 用于在保留任意 `bash`、任意同权限扩展和宿主用户权限的同时形成不可绕过的文件系统安全边界：**不可行**。

因此，首版最稳妥的规格落点是：固定根 `cwd`；显式路径授权；受限代理禁用或完全阻止 `bash` 与未知文件型工具；把扩展路径门描述为应用层策略；需要强隔离的模板由 OS/容器/VM 或受控工具后端提供真实边界。Pi 官方建议的强隔离方式也正是运行整个 Pi 于容器/沙箱、只挂载必要路径并按需使用只读挂载：[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:39)、[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:45)、[security.md](D:/code/open-source/pi/packages/coding-agent/docs/security.md:53)。
