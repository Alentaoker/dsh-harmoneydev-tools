# dsh-harmoneydev-tools

为鸿蒙开发提供配套的 **DeepSeek Harness（DSH）插件与 AI skill**：从设计稿取参、结合工程实现，到设备调试和端到端测试。

| 类型 | 工具 | 用途 | 使用与安装 |
|---|---|---|---|
| plugin | [dshHarmony](plugin/dsh-harmony/README.md) | 鸿蒙设备操作、投屏、截图录像、实时日志和设备工作台 | [使用](plugin/dsh-harmony/USAGE.md) · [安装](plugin/dsh-harmony/INSTALLATION.md) · [AI 安装](plugin/dsh-harmony/AI_INSTALLATION.md) |
| plugin | [dshE2E](plugin/dsh-e2e/README.md) | 有明确验收条件的手机任务、报告、流程复用和会话日志工作台 | [使用](plugin/dsh-e2e/USAGE.md) · [安装](plugin/dsh-e2e/INSTALLATION.md) · [AI 安装](plugin/dsh-e2e/AI_INSTALLATION.md) |
| skill | [hdesign-to-arkts](skill/hdesign-to-arkts/README.md) | 通过 Pixso MCP 确认设计目标、提取属性、映射 SDK 资源，再接续 ArkTS 开发 | [使用](skill/hdesign-to-arkts/USAGE.md) · [安装](skill/hdesign-to-arkts/INSTALLATION.md) · [AI 覆盖安装](skill/hdesign-to-arkts/AI_INSTALLATION.md) · [新旧差异](skill/hdesign-to-arkts/CHANGES.md) |

当前候选配套版本：**dshHarmony 0.5.0-rc.5 + dshE2E 0.4.0-rc.5**；Windows x64、DSH 0.2.0-rc.2、Node24。日志只按会话隔离，文件、多选、拖放、ZIP/GZ/RAR 统一进入按导入时间排列的列表，无需新建目录。实时缓冲提升到最近 100000 行并设 128 MiB 文本预算，采用增量环形存储与虚拟渲染。

新增 RAR4/RAR5 解包及 UTF-16、GB18030/GBK 编码识别，可指定编码重试；[修复与验证记录](docs/ARCHIVE_ENCODING_FIX_20261017.md)。

手动截图与录屏跨会话保留，AI/测试产物不混入手动列表；点击截图可预览、缩放、批注，并把当前标注图加入当前对话。预览内支持 V/R/A/T/B、撤销重做、缩放与 Ctrl+Enter。旧来源不明媒体可单独查看，不擅自归为手动。任务、文件、数据库、命令、测试、语音等收进更多工具，原接口和数据保留。

[下载本候选版](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.5.0-rc.5-e2e-0.4.0-rc.5) · [实施计划与验收](docs/WORKBENCH_PLAN.md) · [日志指南](docs/LOG_WORKBENCH.md) · [截图快捷键](docs/MEDIA_WORKBENCH.md) · [AI 安装](docs/AI_INSTALLATION.md) · [AI 升级和回退](docs/AI_UPGRADE.md) · [验证记录](docs/VALIDATION.md)

## 配套版本与进度

| 配套版本 | 主要变化 | 验证记录 |
|---|---|---|
| Harmony rc.5 / E2E rc.5 | RAR4/5、UTF-16/GB18030、异常字节警告 | [真实日志与编码验收](docs/ARCHIVE_ENCODING_FIX_20261017.md) |
| Harmony rc.5 / E2E rc.4 | 会话平铺、10 万行、手动媒体预览批注与对话附件、任务收纳 | [本轮真实设备与宿主验收](docs/WORKBENCH_VALIDATION_20261017.md) |
| Harmony rc.4 / E2E rc.3 r2 | 补齐发行源码、独立目录安装与指南 | [可移植性](docs/PORTABILITY.md) |
| Harmony rc.4 / E2E rc.3 | 压缩日志、字典、索引、布局、HDC 保存修复 | [历史验证](docs/VALIDATION.md) |

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

这是社区适配项目，非 DeepSeek、华为或上游项目的官方产品。仓库所有者已确认本候选版公开发布；发布前核验目标与文件范围。原厂视频组件及 SDK 派生索引不因仓库源码许可而取得额外再分发许可。来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
