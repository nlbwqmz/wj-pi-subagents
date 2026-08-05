# 16 - 交付可原子失活的 Pi package 与宿主兼容门禁

**What to build:** 让扩展以标准 Pi package 被本地加载，并在 Node、Pi、必需 API、运行依赖或进程树平台能力不满足时安全地保持未激活。

**Blocked by:** 无，可立即开始

**Status:** needs-info

- [x] package manifest 只声明一个显式扩展入口，宿主 Pi 保持宽 peer dependency，运行依赖可在生产安装中解析。
- [ ] 扩展激活前原子探测最低 Node/Pi 版本、必需宿主 API、依赖加载能力和进程树适配器；任一失败时不注册工具、命令、widget、监督器或生命周期钩子。
- [ ] 支持的宿主可以完成一次空操作激活；不支持的宿主只产生脱敏 UI-only `host_capability_unavailable` 诊断，宿主会话仍可继续。
- [x] 契约测试覆盖最低版本、不可解析版本、缺失 API 和不支持平台，并确认没有子进程、公开面或模型上下文副作用。（REQ-004..006；AC-003、AC-029）

## Comments

- 2026-08-05：实现与双轴审查确认一项上游 API 冲突。固定 Pi `0.83.0` 的扩展 factory 只接收 `ExtensionAPI`，该对象没有 UI；`ctx.ui.notify` 只存在于通过 `pi.on(...)` 注册的事件回调 `ExtensionContext`。Pi 的 `on` 返回 `void`，没有可在门禁失败后撤销回调的公开 API；EventBus 也没有通往宿主 UI 的内建消费者。因此，当前 Pi 公共 API 无法同时满足“失败时不注册任何生命周期钩子”和“失败时显示 UI-only 诊断”。需要确认以下取舍之一后才能关闭票据：严格零注册并在初次加载失败时静默；允许一个仅用于诊断的 `session_start` 钩子；或另行扩展 Pi，使 factory 获得不注册生命周期即可调用的 UI 诊断通道。现有实现暂按严格零注册失败关闭，未将本票据标记完成。
