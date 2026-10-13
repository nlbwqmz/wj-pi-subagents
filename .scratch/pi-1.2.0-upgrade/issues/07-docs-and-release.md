# 07: 文档、注释与发布说明

**What to build:** 全部面向用户的文档与内部注释与新基线一致：README/README.zh-CN 更新版本要求与 0.7.0 迁移说明（升级 pi、无工具名变化、错误处理可选用结构化字段）、正式支持模板通配语法（去掉"需 pi 1.1.0"条件）、说明"模板声明 extensions 后内置扩展被屏蔽，要内置扩展需 builtin:<name> 且列入 tools"；CONTEXT 版本表述同步；release notes 列出最低版本、isError 行为变化、新增结构化输出/annotations/namespace/耗时显示；在 before_agent_start 处加注释说明"有意不检查 messageType"。

**Blocked by:** 01、02、03、04、05、06

**Status:** ready-for-agent

- [ ] README 与 README.zh-CN：版本要求、迁移说明、模板语法、内置扩展隔离说明全部更新
- [ ] CONTEXT 版本表述同步为 1.2.0 基线
- [ ] release notes（0.7.0）列出最低版本、错误路径改为 isError（模型可见文本不变）、新增能力、无工具名变化
- [ ] before_agent_start 处注释说明"有意不检查 messageType"（custom run 同样需要准则）
- [ ] 文档审阅通过，无遗留旧版本表述
