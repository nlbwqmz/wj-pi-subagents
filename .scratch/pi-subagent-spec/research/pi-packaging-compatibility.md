# Pi 扩展打包与兼容性研究

## 取证范围

本报告只依据 Pi 上游源码和一方文档，基线为仓库
`D:\code\open-source\pi` 的固定提交
`a96fb984d8c8b065fc5d193309fc812a882adee0`。文中的行号以该提交的文件为准；未把当前工作树之外的博客、发行说明或 npm 页面当作证据。

## 结论摘要

1. Pi 的可分发单元是 **Pi package**：它可以通过 npm、git 或本地路径提供 extensions、skills、prompt templates 和 themes。安装命令会把来源写入用户或项目 settings；`-e/--extension` 是当前运行的临时加载入口。
2. `package.json` 的 `pi` 清单只描述四类资源路径（`extensions`、`skills`、`prompts`、`themes`），路径相对包根且支持 glob/排除模式。没有 Pi 最低版本、API 版本或能力约束字段。
3. 扩展可从全局 `~/.pi/agent/extensions`、受信任项目 `.pi/extensions`、settings 中的额外路径以及已安装 Pi package 发现。项目资源在 project trust 通过前不会加载；`/reload` 会重新解析资源并重新加载扩展。
4. 固定提交中 Pi CLI、`pi-coding-agent`、`pi-agent-core` 和 `pi-tui` 的 `engines.node` 都是 `>=22.19.0`。这是运行 Pi 的 Node 下限，不是 Pi package 的最低 Pi 版本声明。
5. Pi 会检查 npm **来源规格** 的版本：精确版本被视为 pinned，范围使用 semver 判断已安装版本是否匹配，并据此安装或更新；git 的 tag/commit ref 也有 pinned 语义。这些检查不等于检查扩展声明的 `engines`、`peerDependencies` 或宿主 Pi API 兼容性。
6. 未发现 Pi 在加载扩展前读取包的 `engines`、`peerDependencies` 或“需要的 Pi 版本”并拒绝加载的代码路径。Pi 文档反而建议把宿主提供的 Pi 包列为 `peerDependencies: {"*"}`；受管 npm 安装还显式关闭 peer 自动解析。若子代理扩展需要最低 Pi 版本，必须由扩展自己的元数据/运行时探针实现门禁。

## 1. 安装与运行入口

### 1.1 用户可用命令

一方包文档给出的安装来源包括 npm、git URL 和本地绝对/相对路径；`pi remove`、`pi list`、`pi update` 管理已登记来源（`packages/coding-agent/docs/packages.md:18-41`）。默认安装和移除写入 `~/.pi/agent/settings.json`，`-l` 写入项目 `.pi/settings.json`，受信任项目启动时会自动安装缺失项目包（`packages/coding-agent/docs/packages.md:41-45`）。

不想持久化时，可用 `pi -e/--extension` 指定 npm 或 git 来源；它安装到本次运行的临时目录（`packages/coding-agent/docs/packages.md:45-50`）。CLI 帮助也明确 `-e` 可重复、可从 path/npm/git 加载，`--no-extensions` 只关闭发现而显式 `-e` 仍可用（`packages/coding-agent/README.md:587-601`）。

Pi README 给出常用命令、全局/项目安装目录、git ref 固定规则和 `pi config` 资源开关（`packages/coding-agent/README.md:405-435`）。实现层的 `PackageManager` 接口把 `installAndPersist`、`removeAndPersist`、`update`、`resolve` 和临时 extension source 解析分开（`packages/coding-agent/src/core/package-manager.ts:102-118`）；CLI `handlePackageCommand` 在 install 分支调用 `installAndPersist`（`packages/coding-agent/src/package-manager-cli.ts:765-781`）。

### 1.2 安装位置和来源解析

受管 npm 根目录为用户 `agentDir/npm`、项目 `cwd/.pi/npm`，临时运行使用 agentDir 下的临时扩展目录；代码在生成 npm 根目录时创建私有的 `pi-extensions` package.json（`packages/coding-agent/src/core/package-manager.ts:1975-2007`）。受管 npm 包最终位于相应根的 `node_modules/<name>`；项目路径访问会再次检查 project trust（`packages/coding-agent/src/core/package-manager.ts:2039-2047`）。

git 包的全局/项目根分别为 `~/.pi/agent/git` 和 `.pi/git`；克隆后若有 `package.json`，安装依赖，失败时删除目标目录回滚（`packages/coding-agent/src/core/package-manager.ts:1804-1835`、`2078-2086`）。文档还说明 git checkout 变更后会 reset/clean 并执行 npm install（`packages/coding-agent/docs/packages.md:85-93`）。

### 1.3 自动安装和信任边界

解析已配置 package source 时，如果 npm 包不存在或已安装版本不满足配置范围，会触发安装；git 包不存在时也会安装，临时未固定 git source 还会刷新 checkout（`packages/coding-agent/src/core/package-manager.ts:1224-1281`）。项目 scope 的 install/remove/storage 入口统一调用 `assertProjectTrustedForScope`，未信任时拒绝访问项目 package storage（`packages/coding-agent/src/core/package-manager.ts:1714-1717`）。

因此，子代理扩展如果要通过项目 `.pi` 发布，不能把“能读到目录”当作“会加载”；需要把 project trust 和 `-l` 项目 settings 纳入安装/发现验收。

## 2. Pi package 格式和扩展打包

### 2.1 package.json 清单

文档推荐在 `package.json` 增加 `pi` 对象，并用 `pi-package` keyword 便于发现；各资源数组的路径相对包根，支持 glob 和 `!exclusions`（`packages/coding-agent/docs/packages.md:116-133`）。没有 `pi` 清单时，Pi 按约定目录发现：`extensions/` 的 `.ts/.js`、`skills/` 下的 `SKILL.md`、`prompts/` 的 `.md`、`themes/` 的 `.json`（`packages/coding-agent/docs/packages.md:156-165`）。

实现的 `PiManifest` 接口只包含四个可选字符串数组字段；`readPiManifest` 只读取这些字段，JSON 解析失败、`pi` 非对象或字段不是“全为字符串的数组”时忽略该字段/清单并返回可用结果（`packages/coding-agent/src/core/pi-manifest.ts:3-33`）。这意味着当前 Pi 清单没有可声明 `minPiVersion`、`piRange`、协议版本或运行时能力的标准字段。

包资源收集顺序是：settings 对象过滤器（如有）→ `package.json.pi` 清单 → 约定目录。清单存在时按每一类路径收集；没有清单时扫描四类同名目录（`packages/coding-agent/src/core/package-manager.ts:2126-2175`）。清单条目可为文件、目录或 glob；`!`、`+`、`-` 是排除/强制包含/强制排除模式，具体模式解析在（`packages/coding-agent/src/core/package-manager.ts:2243-2304`）。

### 2.2 extension 入口形态

对于扩展目录，Pi 先看目录自己的 `package.json.pi.extensions`，再看 `index.ts`/`index.js`；父目录扫描直接 `.ts/.js` 文件并检查子目录入口，跳过隐藏项和 `node_modules`（`packages/coding-agent/src/core/package-manager.ts:530-611`）。这支持三种常见包布局：单文件、目录 `index.ts`、以及带独立 `package.json`/`node_modules` 的多文件扩展。

扩展模块由 jiti 加载，TypeScript 无需预编译；loader 会关闭模块缓存（缓存只在显式 cached reload 路径使用），并使用 Pi 的虚拟模块/别名解析宿主 API（`packages/coding-agent/src/core/extensions/loader.ts:412-439`）。扩展必须导出默认 factory，加载时执行 factory；没有有效 factory 或执行抛错会记录加载错误，不会把错误内容写进 package manifest（`packages/coding-agent/src/core/extensions/loader.ts:466-492`）。

### 2.3 依赖打包

Pi 文档要求第三方运行时依赖放在 `dependencies`；npm/git 安装会执行 npm install。Pi 自带的 `@earendil-works/pi-*` 和 `typebox` 应放在 `peerDependencies` 且用 `"*"`，不要把宿主包打进扩展；其它 Pi package 需要放入 `dependencies` 和 `bundledDependencies`，并从 `node_modules` 路径引用资源（`packages/coding-agent/docs/packages.md:167-187`）。

扩展文档再次强调，分发包的运行时依赖必须在 `dependencies`；默认生产安装使用 `npm install --omit=dev`，所以 `devDependencies` 在运行时不可用（`packages/coding-agent/docs/extensions.md:139-152`）。实现默认 git 依赖安装参数是 `install --omit=dev`；若配置了 `npmCommand` wrapper，则改用普通 `install`（`packages/coding-agent/src/core/package-manager.ts:1745-1751`）。受管 npm 安装对 npm 使用 `--legacy-peer-deps`，pnpm/bun 使用等价的关闭 peer 自动安装配置（`packages/coding-agent/src/core/package-manager.ts:1758-1779`）。

## 3. 扩展发现、信任与热重载

### 3.1 发现位置

官方扩展文档列出全局 `~/.pi/agent/extensions/*.ts` 和其子目录 `index.ts`，以及项目 `.pi/extensions/*.ts` 和子目录 `index.ts`；项目路径只有 trust 通过后才加载。settings 还可以追加 package source 或本地 extension path（`packages/coding-agent/docs/extensions.md:109-137`）。

package manager 的自动资源发现实现了相同边界：当 `projectTrusted` 为真时才收集 `.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes`；全局 `~/.pi/agent` 资源始终参与，`.agents/skills` 另按祖先目录规则收集（`packages/coding-agent/src/core/package-manager.ts:2330-2455`）。

`--no-extensions`/对应 settings 开关只影响自动发现；`ResourceLoader` 仍会合并临时 CLI extension paths，然后加载最终集合（`packages/coding-agent/src/core/resource-loader.ts:450-465`）。这与 CLI 文档所说“显式 `-e` 仍可工作”一致。

### 3.2 `/reload`

扩展文档明确：自动发现位置中的扩展可以通过 `/reload` 热重载（`packages/coding-agent/docs/extensions.md:5-8`）。实现的 `ResourceLoader.reload()` 会清理已加载扩展缓存（已有会话时）、重新加载 settings、重新解析 package manager 资源和临时 extension source，再加载最终扩展集合（`packages/coding-agent/src/core/resource-loader.ts:387-465`）。

因此子代理扩展的动态配置文件可以依赖 Pi 的 reload 入口重新发现，但不能假设 reload 会保留扩展 factory 的进程内状态；扩展自己的 `session_shutdown`/初始化应保持幂等（长生命周期资源的文档约束见 `packages/coding-agent/docs/extensions.md:220-224`）。

## 4. 版本和兼容性能力

### 4.1 Pi/Node 运行时下限

固定提交的 root `package.json` 声明 Node `>=22.19.0`（`package.json:63-65`）；`@earendil-works/pi-coding-agent` 当前版本是 `0.83.0` 且同样声明 Node `>=22.19.0`（`packages/coding-agent/package.json:1-5`、`104-106`）。`pi-agent-core` 和 `pi-tui` 的 package.json 也声明相同 Node 下限（`packages/agent/package.json:52-54`、`packages/tui/package.json:35-37`）。

CLI 的显示版本来自运行时 package.json 的 `version` 字段，缺失时才退回 `0.0.0`（`packages/coding-agent/src/config.ts:466-492`）；固定提交的 CLI 包版本因此是 `0.83.0`（`packages/coding-agent/package.json:1-3`）。这能作为当前构建的 Pi 版本基线，但不是扩展清单提供的兼容约束。

### 4.2 已实现的 npm/git 版本检查

Pi 解析 npm source 时把精确 semver 标成 `pinned`，其它合法 semver/range 生成 `range`（`packages/coding-agent/src/core/package-manager.ts:49-55`、`1419-1430`）。解析已安装 npm package 只读取其 `package.json.version`；若配置了 range，使用 `semver.satisfies` 判断是否匹配（`packages/coding-agent/src/core/package-manager.ts:1446-1452`、`1472-1482`）。这只回答“当前安装是否满足 settings 中的 npm source”，不是“扩展是否兼容当前 Pi”。

`resolvePackageSources` 在缺包或版本不匹配时安装；`update` 对未 pinned 的 npm source 使用 `npm view ... version --json`，按配置范围选最新版本；精确版本跳过常规扩展更新（`packages/coding-agent/src/core/package-manager.ts:105-116`、`1064-1157`、`1484-1503`）。git ref 作为 checkout 目标处理，固定 ref 不随常规 update 移动但会被 reconcile（`packages/coding-agent/src/core/package-manager.ts:1072-1083`；文档 `packages/coding-agent/docs/packages.md:85-93`）。

### 4.3 Pi 自身更新检查不是扩展兼容检查

`utils/version-check.ts` 只访问 `https://pi.dev/api/latest-version`，比较当前 CLI 版本和最新 Pi release，供 Pi 自更新/通知使用（`packages/coding-agent/src/utils/version-check.ts:4-11`、`30-80`）。它不读取已安装扩展的 manifest，也不检查 package 的 `engines` 或 peer range。

在固定提交的可读 package manifest 类型和安装路径中，没有宿主 Pi 版本字段或扩展兼容校验分支：`PiManifest` 仅有四类资源字段（`packages/coding-agent/src/core/pi-manifest.ts:3-8`），settings 中的 `PackageSource` 仅有 source、autoload 和四类资源过滤器（`packages/coding-agent/src/core/settings-manager.ts:69-84`）。扩展资源被收集后直接交给 loader；受管 npm 安装还主动使用 `--legacy-peer-deps`/关闭 peer 自动安装（`packages/coding-agent/src/core/package-manager.ts:1758-1779`）。因此不能把 npm 的外部 engine warning 或 peer 解析行为当成 Pi 层面的可靠兼容门禁。

## 5. 对子代理扩展规格的直接影响

### 推荐的可发行包

```json
{
  "name": "pi-subagents-wj",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "dependencies": {
    "some-runtime": "^1.0.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

上述结构只使用 Pi 当前已证明的清单和依赖约定；runtime 依赖放 `dependencies`，宿主 API 不打包。若需要声明“至少某个 Pi 版本”，当前 manifest 没有标准字段，建议额外采用扩展自有字段（例如 `piSubagent.requiresPi`）并在扩展 factory 的最早阶段读取 `VERSION`/能力探针，失败时不注册工具；不要期待 `pi install` 自动拒绝不兼容包。

### 对当前子代理项目的约束建议

- 交付包应同时支持 `pi -e <source>` 临时验证和 `pi install <source>` 持久安装；验收时分别覆盖用户 scope、`-l` 项目 scope、未信任项目拒绝和信任后自动安装。
- 扩展入口使用 `pi.extensions` 明确列出实现文件；不要依赖深层目录的偶然扫描。需要多个资源时一并列出 `skills`/`prompts`/`themes`，并用包过滤器控制不同安装场景。
- 运行时依赖放 `dependencies`，不要只放 `devDependencies`；宿主 Pi 包按官方建议放 `peerDependencies: "*"`，但兼容门禁和错误提示由子代理扩展自行完成。
- 把 Node `>=22.19.0` 作为当前 Pi 构建的最低运行时前提；若扩展要兼容更老 Node，应在自己的发布矩阵中单独验证，不能从 Pi 文档推断可用。
- `/reload` 会重建扩展集合；常驻子代理控制器、widget 和监督器资源应在 `session_shutdown` 关闭，并让初始化/关闭重复执行安全。

## 6. 未提供的能力清单

以下能力在固定提交的 Pi package manifest、settings `PackageSource` 和 package manager 中没有标准声明或门禁：

- 扩展要求的最低 Pi CLI 版本或 Pi API 版本；
- 扩展要求的最小/最大 `@earendil-works/pi-*` peer 版本；
- 按能力名（例如 RPC、`ctx.ui.custom`、动态 reload）进行安装前探测并拒绝；
- 对未知 `pi` 清单字段的 UI 诊断或兼容策略；
- 安装后自动判断“扩展加载成功但运行期 API 不兼容”的专门错误码。

因此，子代理扩展如需这些语义，应在自身包元数据、factory 启动检查和 UI-only 诊断中实现；Pi 原生安装/发现层只能负责文件、资源路径、npm/git 来源和其来源版本。
