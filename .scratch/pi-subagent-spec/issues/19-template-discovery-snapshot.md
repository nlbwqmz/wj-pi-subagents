# 19 - 发布可信代理模板发现快照

**What to build:** 让根控制器发现并发布可创建的代理模板目录，同时以稳定身份、严格 schema、来源覆盖和脱敏诊断处理所有模板候选。

**Blocked by:** 18 - 冻结根工作基础、环境、信任与配置

**Status:** resolved

- [x] 只扫描用户级和受信项目级来源的直属 UTF-8 `*.md`，正确处理普通文件、有效符号链接、缺失目录和来源枚举故障。
- [x] `template_id` 精确取文件名去掉末尾 `.md`，frontmatter 严格校验 `tools`、提示模式、上下文策略、模型和 thinking；正文可为空，未知字段静默忽略。
- [x] 同名项目候选在有效性判断前整体遮蔽用户候选；有效模板目录、无效候选诊断索引和来源诊断彼此隔离。
- [x] 首次发现和根 `/reload` 原子替换快照，只向根 UI 汇总一次安全 warning；无 UI 模式不增加其他输出，模板正文和底层路径不泄露。（REQ-011..014、REQ-017；AC-006、AC-007、AC-008）

## Answer

新增 `src/template-discovery-snapshot.ts`，提供根控制器使用的 `discoverTemplateSnapshot(...)` 与 `TemplateSnapshotController`。发现器只读取固定的用户级和受信项目级直属 Markdown 目录，以 fatal UTF-8、严格 YAML frontmatter 和已注册业务工具集独立校验每个候选项；有效模板、候选诊断与来源诊断分别保存。文件名派生的 `template_id` 保留原始大小写、空白和 Unicode 形式，项目候选在校验结果选择前覆盖同名用户候选。

模板快照以不可变目录和精确解析接口发布。序列化投影、诊断索引与 UI warning 不包含正文、底层路径、异常或堆栈；诊断仅在根 UI 存在时通过一次 `ui.notify(..., "warning")` 汇总。`reload()` 先完成整轮扫描，再原子替换快照，因此失败来源不会回退到旧目录，既有快照保持不变。

测试位于 `test/template-discovery-snapshot.test.ts`，覆盖 schema、模型格式、文件名身份、用户/项目覆盖、符号链接与读取故障、无信任项目、无 UI、脱敏和 reload 替换。验证：`npm run check` 与 `npm audit --omit=dev --json` 通过。
