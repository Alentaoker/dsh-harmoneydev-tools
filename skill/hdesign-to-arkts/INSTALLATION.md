# hdesign-to-arkts 安装

## 准备

- Pixso Desktop 已打开设计文件，Pixso MCP 已接入 DSH（参考 [Pixso 官方集成仓库](https://github.com/PixsoLtd/pixso-ai-integration)）。端口能连通不代表工具已注册，以会话里能看到 Pixso 工具为准。
- Python 3.10 或以上。查询只用标准库；重建 SDK 索引需要 `fontTools`。

## 放到哪里

DSH 从下列目录发现 skill，结构为 `<目录>/hdesign-to-arkts/SKILL.md`。重名时排在前面的生效：

1. 项目内 `.dsh/skills/`
2. 项目内 `.agents/skills/`
3. 配置的自定义 skill 目录（如有）
4. `<DSH_HOME>/skills/`（未设置 `DSH_HOME` 时为 `~/.dsh/skills/`）
5. `~/.agents/skills/`

把仓库里的整个 `skill/hdesign-to-arkts/` 目录复制过去，注意不要多套一层同名目录。新开会话，发一条以 `/hdesign-to-arkts ` 开头（后面带空格）的消息；能看到 skill 内容被加载，就说明安装成功。

## 覆盖旧版

1. 把旧的 `hdesign-to-arkts` 目录整体移到上述目录之外备份。备份留在扫描目录里，会出现两个同名 skill。
2. 复制新目录。旧版的 `match-symbol.ps1`、dHash 或图片索引、社区 symbol 库都不要带过来。
3. 项目专用的 SDK 索引（schema 为 `hdesign-sdk-symbol-catalog-v1`）可以保留，查询时用 `--map` 指定；更早格式的索引，用目标 SDK 重建。
4. 新开会话。

出问题时，把备份目录放回原位置即可恢复。

## SDK 索引

随包索引来自 API 26 SDK，来源见 [symbol-source.json](resources/symbol-source.json)。工程用其他 SDK 时，按 [hmsymbol-index.md](references/hmsymbol-index.md) 的“重建索引”一节重建。

## 让 AI 安装

> 请把 Alentaoker/dsh-harmoneydev-tools 的 skill/hdesign-to-arkts 按其中的 INSTALLATION.md 安装到 DSH：记下来源提交；已有旧版就先整体移出扫描目录备份，再整体替换；保留项目专用的 SDK 索引；不改其他 skill、MCP 配置和工程代码。完成后告诉我安装位置、备份位置，以及是否需要新开会话。
