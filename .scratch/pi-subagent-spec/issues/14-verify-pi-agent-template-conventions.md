# 核实 Pi 代理模板文件惯例

Type: research
Status: resolved
Blocked by: 01

## Question

以 Pi 上游提交 `a96fb984d8c8b065fc5d193309fc812a882adee0` 的源码和官方仓库文档为一手来源，核实 Pi 核心是否原生定义“代理模板”；官方 Subagent 示例或其他第一方实现是否使用 Markdown 文件、YAML frontmatter 与正文系统提示来描述代理角色；其发现目录、字段、解析校验和覆盖规则是什么。研究必须区分 Pi 的正式公开契约、官方示例的局部惯例和本扩展仍需自行决定的模板格式，为后续“确定代理模板发现与信任策略”提供证据。

## Answer

Pi 核心明确不内置子代理，也没有正式的代理模板 API；代理模板来自第一方 `examples/extensions/subagent` 扩展示例。因此，模板格式可以借鉴该示例，但必须作为本扩展自己的公开契约冻结。

第一方示例使用 `.md` 文件：YAML frontmatter 包含必填 `name`、`description`，可选逗号分隔标量 `tools` 和可选 `model`；正文作为追加系统提示词。用户模板位于 `~/.pi/agent/agents/*.md`，项目模板位于从 `cwd` 向上找到的最近 `.pi/agents/*.md`，项目同名模板覆盖用户模板。

示例解析和工具校验很宽松：未知字段被忽略，缺字段或读取错误多为跳过，模板工具只是传给 Pi `--tools`；Pi 核心会静默忽略未知或未注册工具并继续创建进程。因此，本扩展要求的严格 schema、`subagents: inherit | disabled`、固定根 `cwd`，以及模板任一必需工具不可用时原子拒绝创建，都是需要自行实现并明确记录的新规范。

完整证据与上游/本项目边界见 [Pi 代理模板惯例研究](../research/pi-agent-template-conventions.md)。

## Comments

- 2026-08-04：基于 Pi 上游提交 `a96fb984d8c8b065fc5d193309fc812a882adee0` 完成研究；报告只引用该提交的核心文档、源码和第一方示例，未修改上游工作区。
