# 16 - 交付可原子失活的 Pi package 与宿主兼容门禁

**What to build:** 让扩展以标准 Pi package 被本地加载，并在 Node、Pi、必需 API、运行依赖或进程树平台能力不满足时安全地保持未激活。

**Blocked by:** 无，可立即开始

**Status:** resolved

- [x] package manifest 只声明一个显式扩展入口，宿主 Pi 保持宽 peer dependency，运行依赖可在生产安装中解析。
- [x] 扩展激活前原子探测最低 Node/Pi 版本、必需宿主 API、依赖加载能力和进程树适配器；任一失败时不注册工具、命令、widget 或监督器，仅注册一次诊断专用 `session_start` 桥。
- [x] 注入完整平台适配器的支持宿主可以完成一次空操作激活；未提供真实适配器的宿主按失败关闭，通过一次性诊断桥产生脱敏 UI-only `host_capability_unavailable` 诊断，宿主会话仍可继续。
- [x] 契约测试覆盖最低版本、不可解析版本、缺失 API 和不支持平台，并确认没有子进程、公开面或模型上下文副作用。（REQ-004..006；AC-003、AC-029）

## Answer

本票据交付了标准 Pi package 的唯一扩展入口、宿主能力门禁和失败诊断桥。factory 先加载并校验生产 `semver`、Node/Pi 版本、Pi `RpcClient` 与 ExtensionAPI/EventBus 必需方法、受支持平台，以及完整的 `ProcessTreeAdapter` 契约；任一探针失败都返回稳定的 `host_capability_unavailable` 诊断，不启动业务激活回调，不注册工具、命令、widget、监督器或业务生命周期处理器。

失败分支只在 `extensionApi.on` 可用时注册一次 `session_start` 诊断桥。Pi 后续触发事件时，桥检查 `ctx.hasUI === true` 和 `ctx.ui.notify` 是否可用，最多调用一次 `notify(..., "warning")`；无 UI、上下文异常或通知异常均静默处理，不回退到 stderr、EventBus、会话条目或模型消息。通知正文只包含稳定诊断码、短原因和缺失 API 名称，不包含版本输入、路径、异常或堆栈。

本票据只定义并校验适配器边界，不伪造平台能力。默认入口在没有注入真实适配器时保持失败关闭；Issue 17 负责资源确认边界，Issue 22/23 分别交付并注入 Windows Job Object 与 macOS/Linux process group/session 的生产实现。适配器完成后，注入完整实现的支持宿主即可走空操作激活路径；在此之前真实 package 的失活是预期的安全行为，而不是把平台字符串当作能力证明。

验证：`npm run check` 的 TypeScript 检查和全部自动化测试通过；package manifest 测试直接锁定规格要求的 Node `>=22.19.0` 与 Pi `>=0.84.1`，不会从实现常量反向生成期望值。

## Comments

- 2026-08-05：用户确认采用一次诊断专用 `session_start` 桥：门禁失败后不注册工具、命令、widget、监督器或业务生命周期处理器；桥只在 `ctx.hasUI` 且 `ctx.ui.notify` 可用时发送一次脱敏 `host_capability_unavailable` warning，无 UI 时静默，也不回退到 stderr、EventBus 或模型上下文。该桥是明确接受的 UI-only 例外。
