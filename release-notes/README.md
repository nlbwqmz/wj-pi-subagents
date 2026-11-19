# 发布说明目录

该目录用于存放每个版本对应的 GitHub Release 说明文件。发布工作流 `.github/workflows/release.yml` 会读取这里的 Markdown 文件作为 Release 正文。

## 命名规则

- 文件名必须与发布 tag 完全一致，例如 `release-notes/v0.5.2.md`。
- 发布 tag 必须为 `v${package.json.version}`，且严格符合 `vX.X.X`。
- 文件扩展名统一使用 `.md`，内容不能为空。

## 发布流程

1. 更新 `package.json`（以及 `package-lock.json`）中的版本号。
2. 新增对应版本的发布说明文件，例如 `release-notes/v0.5.2.md`。
3. 创建并推送 `vX.X.X` 形状的 tag。
4. 工作流先校验 tag、包版本与发布说明文件，通过后再发布 npm 包，最后用该 Markdown 文件创建 GitHub Release。

## 包内 `CHANGELOG.md` 的生成源

这些发布说明文件同时是 npm 包根目录 `CHANGELOG.md` 的唯一生成源。`npm run build:package` 是本仓唯一的发布产物构建入口，它依次执行 bridge 构建与 `npm run changelog:generate`，把本目录下的说明按版本降序拼成包根 `CHANGELOG.md`（派生文件，已 gitignore），并随包发布。CI 发布 job 与本地 `prepack` 都只调用该入口：`npm publish` 使用 `--ignore-scripts`，生命周期钩子不会执行，因此发布 job 必须显式先跑 `build:package`；`release-notes/vX.Y.Z.md` 始终是唯一人工维护的源文件，也继续作为 GitHub Release 正文。

Pi 从 `1.5.0` 起会读取包内该文件，在交互模式启动时以 `Extension Updates` 通知块展示版本增量，因此本目录文件的格式不能随意变动：

- 首行必须是 `# vX.Y.Z`。
- 分类使用 `## 分类`；生成时会把这些标题降一级，段内原有层级随之整体下移。
- 除顶级版本标题与 `## 分类` 外，不要写其它结构。
- 本目录中最大的版本号必须等于 `package.json` 的 `version`，否则构建失败。

## 注意事项

- tag 与 `package.json` 版本不一致时工作流直接失败。
- 对应发布说明文件缺失或为空时工作流直接失败，npm 包不会被发布。
- Release 正文不再使用 GitHub 自动生成的发行说明。
- 发布说明按 GitHub Release 的 Markdown 渲染，建议面向使用者说明功能变化，不要堆叠内部实现细节。
