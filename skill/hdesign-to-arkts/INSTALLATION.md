# hdesign-to-arkts 安装指南

## 准备环境

- AI 宿主支持发现/读取 `SKILL.md`，并能读取工程、运行本地 Python。
- Pixso Desktop 已打开目标文件，MCP 服务已启用且已接入该宿主。仅端口可达不代表会话已经注册工具。
- Python 3.10 或以上。精确查询仅使用标准库；重建 SDK 索引需要 `fontTools`。
- 取得目标工程实际 SDK 的 `sysResource.js` 和该 SDK 自带的 `HMSymbolVF.ttf`，用于核对或重建查询库。

Pixso 的 MCP 接入按 [Pixso 官方集成仓库](https://github.com/PixsoLtd/pixso-ai-integration) 与实际宿主工具配置进行。skill 不启动 MCP、不自动修改连接配置，也不需要调用 Pixso 转代码。

## 首次安装

1. 从 `Alentaoker/dsh-harmoneydev-tools` 的明确提交取得 `skill/hdesign-to-arkts/` 整个目录。
2. 确认当前 AI 宿主实际加载 skill 的位置。DSH 以当前版本的技能管理入口、配置或已加载 skill 的来源路径为准；不要猜成 `DSH_HOME/skills`，也不要使用 `dsh plugin add` 安装它。
3. 将整个目录安装到已确认的技能根目录下，使目标结构为 `<技能根目录>/hdesign-to-arkts/SKILL.md`，避免多嵌套一层同名目录。若宿主提供导入功能，按其要求导入；否则复制到实际扫描目录。
4. 按宿主方式重新加载技能或开启新会话，确认能发现 `hdesign-to-arkts`，且实际读取的 SKILL.md 来自新目录。
5. 按下节确认 SDK 索引，再阅读 [使用说明](USAGE.md) 接入需求/plan 流程。

同名旧版已存在时，使用 [AI 覆盖安装指南](AI_INSTALLATION.md)，不要直接合并复制。安装目录与仓库源码目录可以不同；它们都不是鸿蒙应用的资源目录。

## 核对与重建 SDK 索引

随包索引的版本见 [symbol-source.json](resources/symbol-source.json)。它是 API 26 的 SDK 快照，并不自动代表目标工程。索引只含 SDK 正式 symbol 名称，不含社区资源和字体文件。

核对项目使用的 SDK 与索引来源；不同版本或来源无法确认时，使用目标 SDK 重建。先进入安装后的 skill 目录，在已有 fontTools 的 Python 环境执行；若缺依赖，可在专用环境安装 `fonttools`，避免改动用户无关 Python 环境。

```powershell
python scripts/build-symbol-catalog.py `
  --sdk-resource '<目标SDK中sysResource.js的绝对路径>' `
  --font '<同一SDK中HMSymbolVF.ttf的绝对路径>' `
  --sdk-metadata '<该SDK的oh-uni-package.json绝对路径>'
```

`--sdk-metadata` 可省略，但仍需明确两份核心输入属于目标 SDK。默认更新 `resources/symbol-catalog.json` 和 `symbol-source.json`；替换前备份原文件。用于分享的目录可追加 `--portable-provenance`，保留输入文件名、版本及哈希，避免记录本机绝对路径。

有多个工程/SDK 时，为各自索引设置独立位置，通过 `--output`、`--source-output` 生成，并在查询时使用 `--map`，不要反复覆盖唯一共享索引。输出父目录需先创建。

```powershell
python scripts/lookup-symbol.py --codepoint U+F01D5
python scripts/lookup-symbol.py --name bell
python scripts/lookup-symbol.py --codepoint U+F01D5 --map '<目标工程索引绝对路径>'
```

查询结果中的 `sdk_name_present` 仅代表资源在来源 SDK 中存在，不代表设计目标、字体显示或应用运行效果已经确认。正式资源有名称但无 cmap 字码时仍可按名查询。

## 与规划流程衔接

skill 的 description 帮助自动选择；要让已有 grill/plan 工作流稳定记住 UI 取参，还需要把 [规划流程接入约定](references/checklist-template.md#规划流程接入约定) 放到实际使用的上游规则中。只安装本目录不会改写其他 skill 或项目规则。

## 更新与恢复

每次更新记录来源提交，先备份旧目录与项目专用索引，再完整替换本 skill。不要删除整个技能根目录、MCP 配置或其他 skill。出现问题时用保留的备份恢复该目录及本次修改的上游规则，再让宿主重新加载。

[AI 覆盖安装详细步骤](AI_INSTALLATION.md) · [使用说明](USAGE.md)
