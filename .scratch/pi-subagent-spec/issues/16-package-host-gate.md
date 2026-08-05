# 16 - 交付可原子失活的 Pi package 与宿主兼容门禁

**What to build:** 让扩展以标准 Pi package 被本地加载，并在 Node、Pi、必需 API、运行依赖或进程树平台能力不满足时安全地保持未激活。

**Blocked by:** 无，可立即开始

**Status:** ready-for-agent

- [ ] package manifest 只声明一个显式扩展入口，宿主 Pi 保持宽 peer dependency，运行依赖可在生产安装中解析。
- [ ] 扩展激活前原子探测最低 Node/Pi 版本、必需宿主 API、依赖加载能力和进程树适配器；任一失败时不注册工具、命令、widget、监督器或生命周期钩子。
- [ ] 支持的宿主可以完成一次空操作激活；不支持的宿主只产生脱敏 UI-only `host_capability_unavailable` 诊断，宿主会话仍可继续。
- [ ] 契约测试覆盖最低版本、不可解析版本、缺失 API 和不支持平台，并确认没有子进程、公开面或模型上下文副作用。（REQ-004..006；AC-003、AC-029）

