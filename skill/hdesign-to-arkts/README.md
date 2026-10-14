# hdesign-to-arkts

为鸿蒙 UI 开发取得可信的设计依据：通过 **Pixso Desktop MCP** 找到正确页面和组件，读取生效属性，核对工程资源，再由当前 AI 结合需求继续规划或实现 ArkTS。

当前版本：**v2.3-sdk**。适用于 DSH 等支持加载 `SKILL.md`、调用 MCP 和读取本地工程的 AI 开发环境。skill 是工作规则与查询工具，不是 DSH 运行插件，也不内置 Pixso MCP 服务。

| 文档 | 用途 |
|---|---|
| [使用说明](USAGE.md) | 触发场景、完整流程、对话示例和常见问题 |
| [安装指南](INSTALLATION.md) | 首次安装、依赖、目标 SDK 索引与更新 |
| [AI 覆盖安装指南](AI_INSTALLATION.md) | 可直接交给 AI 的安装指令，含备份、旧文件清理和恢复 |
| [新旧版本差异](CHANGES.md) | 从只读取参、dHash 到开发衔接、SDK 字码查询的变化 |
| [SKILL.md](SKILL.md) | AI 实际执行的入口规则 |

## 核心约定

- 先确认设计目标，再取属性；有歧义时给候选截图或询问位置。
- HM Symbol 文字按实际字码查询目标 SDK 正式资源，不做 dHash，不引入社区库。
- 矢量、SVG、PNG 和转曲图标不自动匹配，交给用户选择素材导出或确认具体 symbol。
- 新素材先展示目标与方案，确认后导出。
- 不调用 Pixso 转代码；AI 根据设计依据与项目规范实现。仅查属性或写 plan 时保持该任务范围。

## 文件组织

```text
SKILL.md                 # AI 入口和触发范围
references/              # 定位、属性映射、图标规则、交接和资源决策
scripts/                 # SDK 索引构建与精确查询
resources/               # SDK 索引 JSON 及来源信息，不含字体二进制
README.md                # 人工阅读入口
USAGE.md                 # 使用说明
INSTALLATION.md          # 首次安装与依赖
AI_INSTALLATION.md       # AI 覆盖安装流程
CHANGES.md               # 新旧差异
```

[返回工具集](../../README.md)
