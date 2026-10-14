# dsh-harmoneydev-tools

为鸿蒙开发提供配套的 **DeepSeek Harness（DSH）插件与 AI skill**：从设计稿取参、结合工程实现，到设备调试和端到端测试。

| 类型 | 工具 | 用途 | 使用与安装 |
|---|---|---|---|
| plugin | [dshHarmony](plugin/dsh-harmony/README.md) | 鸿蒙设备操作、投屏、截图录像、实时日志和设备工作台 | [使用](plugin/dsh-harmony/USAGE.md) · [安装](plugin/dsh-harmony/INSTALLATION.md) · [AI 安装](plugin/dsh-harmony/AI_INSTALLATION.md) |
| plugin | [dshE2E](plugin/dsh-e2e/README.md) | 有明确验收条件的手机任务、报告、流程复用和会话日志工作台 | [使用](plugin/dsh-e2e/USAGE.md) · [安装](plugin/dsh-e2e/INSTALLATION.md) · [AI 安装](plugin/dsh-e2e/AI_INSTALLATION.md) |
| skill | [hdesign-to-arkts](skill/hdesign-to-arkts/README.md) | 通过 Pixso MCP 确认设计目标、提取属性、映射 SDK 资源，再接续 ArkTS 开发 | [使用](skill/hdesign-to-arkts/USAGE.md) · [安装](skill/hdesign-to-arkts/INSTALLATION.md) · [AI 覆盖安装](skill/hdesign-to-arkts/AI_INSTALLATION.md) · [新旧差异](skill/hdesign-to-arkts/CHANGES.md) |

## 目录

```text
plugin/
  dsh-harmony/             # 设备与调试插件，含自己的使用/安装文档
  dsh-e2e/                 # E2E 与日志插件，含自己的使用/安装文档
skill/
  hdesign-to-arkts/        # SKILL.md、参考规则、查询脚本、SDK 索引和说明文档
scripts/                  # 两插件共用的安装、启动与源码打包工具
docs/                     # 两插件共用的安装步骤、联动说明和维护资料
```

## 如何配合

1. **需求与计划**：涉及新增或调整 UI 时使用 hdesign-to-arkts，确认页面、组件、状态和设计依据。
2. **开发**：AI 根据属性与资源映射，结合项目实现 ArkTS。skill 不调用 Pixso 转代码。
3. **调试**：dshHarmony 提供设备观察、操作与实时日志。
4. **验收**：有结果检查的手机任务通过 dshE2E 执行，读取报告及日志。

两个插件当前按配套版本安装；skill 独立安装，需要宿主能发现 skill 并连接 Pixso Desktop MCP。根目录的插件安装脚本不会安装 skill 或配置 Pixso MCP。各组件的版本、环境要求与详细用法以各自文档为准。

## 旧仓库迁移

原仓库名为 `dsh-harmony-e2e`；新名称为 `dsh-harmoneydev-tools`。插件源码由 `plugins/` 调整为 `plugin/`，包名 `dsh-harmony`、`dsh-e2e` 和数据目录不变。已安装的本地路径依赖需要按 [迁移说明](docs/REPOSITORY_MIGRATION.md) 重新登记，不能只搬文件夹。

这是社区适配项目，非 DeepSeek、华为或上游项目的官方产品。仓库保持私有自用；原厂视频组件及 SDK 派生索引不因仓库源码许可而取得额外再分发许可。来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
