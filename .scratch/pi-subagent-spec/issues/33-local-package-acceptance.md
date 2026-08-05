# 33 - 验证隔离环境中的本地 package 安装形态

**What to build:** 让开发者可以在隔离临时目录中以 Pi 支持的本地来源加载和安装扩展，同时证明安装过程不改变模板、配置或非预期用户资源。

**Blocked by:** 32 - 交付 `/agent` 只读代理树遮罩面板

**Status:** ready-for-agent

- [ ] 生产依赖装配后不依赖开发依赖，Pi manifest 仍只发现唯一扩展入口，临时扩展加载、本地用户 scope 持久安装和已信任项目 scope 形态均可运行。
- [ ] 未信任项目无法通过安装或加载绕过 project trust；安装/加载不创建、复制或修改代理模板、`subagent.json`、Pi 用户设置或项目设置。
- [ ] 测试以隔离临时目录执行并在结束时清理临时文件、进程、管道/socket、Job Object/process group 和平台句柄；清理失败会使验收失败。
- [ ] 本地 package 契约测试覆盖安装来源边界，不要求 registry、正式 tarball、release tag、签名或发布报告。（REQ-004、REQ-052；AC-027）

