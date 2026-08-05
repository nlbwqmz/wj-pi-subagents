# 23 - 实现 macOS/Linux process group 进程树适配器

**What to build:** 在 macOS 和 Linux 上让每个子代理运行于专用 process group 或 session，并以平台原语可靠观察和回收整棵进程树。

**Blocked by:** 17 - 预构资源确认边界与可注入进程树替身

**Status:** ready-for-agent

- [ ] 启动阶段建立专用 process group 或 session，再启动子进程，后代属于同一受监督树。
- [ ] 优雅关闭、内部期限升级、整树强制回收、退出观察、资源检查和释放遵守统一适配器契约，不以直接子进程 `kill` 代替树回收。
- [ ] macOS/Linux 原生 helper 测试覆盖后代残留、部分回收、重复终止和无法确认结果，并证明平台能力缺失时由兼容门禁拒绝激活。（REQ-006、REQ-041..043；AC-022、AC-029）

