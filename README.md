# dsh-harmoneydev-tools

为鸿蒙开发提供配套的 **DeepSeek Harness（DSH）插件与 AI skill**：从设计稿取参、结合工程实现，到设备调试和端到端测试。

| 类型 | 工具 | 用途 | 使用与安装 |
|---|---|---|---|
| plugin | [dshHarmony](plugin/dsh-harmony/README.md) | 鸿蒙设备操作、投屏、截图录像、实时日志和设备工作台 | [使用](plugin/dsh-harmony/USAGE.md) · [安装](plugin/dsh-harmony/INSTALLATION.md) · [AI 安装](plugin/dsh-harmony/AI_INSTALLATION.md) |
| plugin | [dshE2E](plugin/dsh-e2e/README.md) | 有明确验收条件的手机任务、报告、流程复用和会话日志工作台 | [使用](plugin/dsh-e2e/USAGE.md) · [安装](plugin/dsh-e2e/INSTALLATION.md) · [AI 安装](plugin/dsh-e2e/AI_INSTALLATION.md) |
| skill | [hdesign-to-arkts](skill/hdesign-to-arkts/README.md) | 通过 Pixso MCP 确认设计目标、提取属性、映射 SDK 资源，再接续 ArkTS 开发 | [使用](skill/hdesign-to-arkts/USAGE.md) · [安装](skill/hdesign-to-arkts/INSTALLATION.md) · [AI 覆盖安装](skill/hdesign-to-arkts/AI_INSTALLATION.md) · [新旧差异](skill/hdesign-to-arkts/CHANGES.md) |

当前候选配套版本：**dshHarmony 0.5.0-rc.4 + dshE2E 0.4.0-rc.3**，宿主保持 Windows x64 / DSH 0.2.0-rc.2 / Node24。新增临时区、批量导入目录、ZIP/GZ/原厂 HiLog 解析、包名过滤与收藏、路径明确的 AI 分析草稿，以及分块压缩的大文件浏览。实时与离线日志可双向跳转，使用见 [日志工作台](docs/LOG_WORKBENCH.md)。手机端投屏进程可能在 DevEco 退出后遗留；面板提供明确确认的“释放占用并重连”，不会自动抢占外部投屏。已实测恢复 H.264 与双订阅共享，范围及遗留见 [验证记录](docs/VALIDATION.md) 和 [恢复计划](docs/VIDEO_RECOVERY_PLAN.md)。

本版同时修复设备设置保存返回 404 和 HDC 初始化失败后无法恢复的问题；日志工作台采用左侧目录、紧凑筛选、可选列及行距，正文自动填满剩余空间。[下载当前候选版（r2 安装与文档修订）](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.5.0-rc.4-e2e-0.4.0-rc.3-r2) · [交给 AI 安装](docs/AI_INSTALLATION.md) · [升级与回退](docs/AI_UPGRADE.md) · [可移植性验证](docs/PORTABILITY.md)。私有发行文件需要使用有权访问仓库的账号下载，源码包仍需 Node24 与联网安装依赖。

## 版本进度

H / E 分别表示 dshHarmony / dshE2E；记录日期来自变更记录。r2 是同一插件版本的发行修订，补齐源码包、更新说明与可移植性证据，插件运行源码与 rc.4 原版一致。

| 记录日期 | 配套版本 H / E | 新增特性 | 修复与调整 | 验收进度 |
|---|---|---|---|---|
| 2026-10-16 | **0.5.0-rc.4 / 0.4.0-rc.3 · r2（当前）** | README 版本进度表、可移植性验证记录 | 修复打包器误删 `session-*.ts` 源码；统一安装/升级指南，保留原标签 | 独立目录/数据安装与冷启动通过；完整回归及验收边界见 [PORTABILITY](docs/PORTABILITY.md)，实机待验项沿用 rc.4 |
| 2026-10-16 | [0.5.0-rc.4 / 0.4.0-rc.3](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.5.0-rc.4-e2e-0.4.0-rc.3) | 会话目录、ZIP/GZ 与原厂 HiLog 导入、包名收藏、带路径的 AI 分析；分块压缩与后台查询；紧凑布局、可选列及行距 | HDC 设置保存 404、失败后重新发现；实时/离线双向入口；明文 256 MiB、压缩包 512 MiB、每页最多 1000 条 | Windows CI、84/52/2 项回归及 26 项浏览器检查通过；冷启动设备识别/锁屏预览恢复；真实 PUT 保存及解锁后 H.264 待复验 |
| 2026-10-15 | [0.5.0-rc.3 / 0.4.0-rc.2](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.5.0-rc.3-e2e-0.4.0-rc.2) | 明确确认后释放手机端遗留投屏并重连 | 复核 PID、扩展名和进程启动时间；兼容手机缺少部分 shell 工具及权限拒绝 | 真实 H.264、双订阅共享与最终清理通过；候选版 |
| 2026-10-15 | [0.5.0-rc.2 / 0.4.0-rc.2](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.5.0-rc.2-e2e-0.4.0-rc.2) | 视频占用来源/PID 提示、日志文件与行分析简洁模板 | 共享订阅释放竞态、状态接口版本号；完善 AI 安装与升级说明 | 本机安装/冷启动及关键日志场景通过；候选版 |
| 2026-10-15 | [0.5.0-rc.1 / 0.4.0-rc.1](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.5.0-rc.1-e2e-0.4.0-rc.1) | 会话日志隔离、多文件队列、批量管理/回收区、AI 分析草稿、实时保存到会话、应用搜索、详情调整 | 跨分页选择固定 ID，迟到响应隔离；旧日志明确归属；保存协议检测 | 构建与自动化通过，发布时桌面/实机验收保留 |
| 2026-10-14 | [0.4.3 / 0.3.1](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.4.3-e2e-0.3.1) | 默认 E2E 测试入口、当前页补验、独立视觉验收、同会话控制交接 | 明确直控与查询范围，阻止测试中插入动作；参数别名和未知字段校验 | 发布版；具体实机范围见验证记录，不代表全部应用流程通过 |
| 2026-10-14 | [0.4.2 / 0.3.0](https://github.com/Alentaoker/dsh-harmoneydev-tools/releases/tag/v0.4.2-e2e-0.3.0) | 实时结构化 HiLog、TAG/正则/Ctrl+F、可调布局；独立离线日志库；流式落盘 | 有界缓存与虚拟列表；默认最大测试预算；源码 ZIP、SHA256 与安装预检 | Windows x64 / DSH 0.2.0-rc.2 为验证目标 |

详细变更见 [CHANGELOG](CHANGELOG.md)，证据与待验范围见 [VALIDATION](docs/VALIDATION.md)。另一台实体电脑、其它操作系统及任意未来宿主版本不因本表而自动视为兼容。

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
