# hdesign-to-arkts

为鸿蒙 UI 开发取得可信的设计依据：通过 **Pixso Desktop MCP** 找到正确的页面和组件，读取生效属性，核对图标资源，再由当前 AI 结合需求继续规划或实现 ArkTS。

当前版本：**v2.4**。适用于 DSH 等能加载 `SKILL.md`、调用 MCP 和读取本地工程的 AI 开发环境。skill 是工作规则与查询工具，不是 DSH 运行插件，也不内置 Pixso MCP 服务。

| 文档 | 用途 |
|---|---|
| [使用说明](USAGE.md) | 何时使用、调用方式、流程和常见问题 |
| [安装说明](INSTALLATION.md) | 安装位置、覆盖旧版、SDK 索引 |
| [版本变化](CHANGES.md) | 各版本的改动 |
| [SKILL.md](SKILL.md) | AI 实际执行的入口规则 |

## 核心约定

- 先确认设计目标再取值；有歧义时给候选截图或询问位置。
- HM Symbol 文字按码点查 SDK 索引；矢量、SVG、PNG 图标由用户决定导出素材或给出 symbol 名。
- 导出新素材前先由用户确认方案。
- 不使用 Pixso 转代码；AI 根据设计值和工程规范编写 ArkTS。

## 文件组织

```text
SKILL.md          # AI 入口和触发范围
references/       # 定位取参、ArkTS 对照、图标、导出、plan 记录
scripts/          # SDK 索引构建与查询
resources/        # SDK 索引 JSON 及来源信息，不含字体文件
README.md         # 人工阅读入口
USAGE.md          # 使用说明
INSTALLATION.md   # 安装说明
CHANGES.md        # 版本变化
```

[返回工具集](../../README.md)
