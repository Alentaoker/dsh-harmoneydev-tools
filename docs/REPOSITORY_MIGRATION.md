# 仓库名称与目录迁移

仓库由 `Alentaoker/dsh-harmony-e2e` 更名为 `Alentaoker/dsh-harmoneydev-tools`，用于收纳鸿蒙开发配套的 DSH 插件与 skill。

| 原位置 | 新位置 |
|---|---|
| `plugins/dsh-harmony` | `plugin/dsh-harmony` |
| `plugins/dsh-e2e` | `plugin/dsh-e2e` |
| 外部维护的 hdesign-to-arkts | `skill/hdesign-to-arkts` |

插件包名、DSH bundle 名、存储目录、版本配对和宿主要求不变。旧 Git tag 与 Release 仍表示各自原版本，不能把旧压缩包当作新目录布局；本次仓库整理不升级插件运行版本。

## 已有克隆

先检查未提交改动，再更新远端 URL；这不会修改工作区文件：

```powershell
git remote set-url origin https://github.com/Alentaoker/dsh-harmoneydev-tools.git
git fetch origin
```

干净工作区才可按团队流程更新分支。有未提交改动时保留现场，先在新目录取得目标提交；不要 reset、clean 或把其他开发内容混入目录迁移。旧路径中的未提交文件需要后续按相对路径迁入 `plugin/` 并检查冲突。

## 已安装插件

DSH 可能引用安装来源的本地路径。升级前结束相关任务并退出目标宿主，备份 profile 登记，保留旧来源。

1. 将新版本准备在长期保留的新目录，确认里面是 `plugin/`。
2. 从新目录按 [AI 安装指南](AI_INSTALLATION.md) 预检、构建并登记两个插件。
3. 用相同 DSH_HOME/profile 冷启动，核对实际加载目录与版本。
4. 如需恢复，使用正式 plugin add 登记回保留的旧来源，只恢复本次涉及字段。

安装脚本仍使用历史 `backups/dsh-harmony-e2e-*` 前缀，便于保留原有备份习惯；这不是旧源码目录。不要删除运行数据或用户配置。

## Skill 安装

skill 不走插件 CLI，单独按照 [hdesign-to-arkts 安装指南](../skill/hdesign-to-arkts/INSTALLATION.md) 安装。覆盖旧版按其 [AI 覆盖安装指南](../skill/hdesign-to-arkts/AI_INSTALLATION.md) 处理，不能在旧目录叠加新文件后留下过期识别脚本。

## 后续新增工具

运行插件放 `plugin/<包名>/`，skill 放 `skill/<skill-name>/`；每项提供自己的 README、USAGE、INSTALLATION，必要时增加 AI_INSTALLATION。根 README 仅维护导航和工具之间的关系，共用安装逻辑放 scripts/ 和 docs/。
