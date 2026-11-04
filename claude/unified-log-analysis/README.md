# 统一日志分析 · 0.2.0-beta.1

显式调用的独立技能：让当前AI分析本地日志，生成可回查原文的离线链路报告。需要Python 3.9+与浏览器，无第三方依赖，不连接DSH或任何模型服务。

Claude Code 用 `/unified-log-analysis <日志路径> [问题]`，Codex 用 `$unified-log-analysis` 并提供日志路径和问题；其他AI先读取本目录 MANUAL.md（源码目录为 SKILL.md）。例如：

> 使用 unified-log-analysis 分析这份日志，整理消息链路并生成报告。日志：……

默认纯日志；需要代码线索时明确给--project，或用--project-cwd选择当前工作目录。脚本guide返回操作方法和草稿模板：

```text
python -I -B <技能目录>/scripts/ula.py guide
```

AI完成盘点、检索、草稿、check/render后，打开输出的report.html。默认输出~/LogReports，可指定--out；报告含原文，不自动上传。需要追问时保留--keep-work，否则临时索引会清理，原日志不改。

这是beta：真实日志只验证过一份；词表冻结；机械核验不证明语义因果；未针对超大日志优化。不能从日志回调直接推断界面已显示，也不能从零命中断定事件未发生。

结果与实际不符时，显式调用unified-log-feedback，说明实际情况和报告偏差。它只生成脱敏反馈文件，由你检查后自行分享；LOCAL-ONLY映射文件只留本机。
