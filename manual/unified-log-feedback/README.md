# 日志分析反馈 · 0.2.0-beta.1

当日志报告与实际情况不符时，显式调用 `unified-log-feedback`。AI 收集你的说明并复盘，工具离线生成脱敏反馈，供你检查后自行分享。不联网、不发送。

需要 Python 3.9+。Claude Code 用 `/unified-log-feedback <报告目录>`，Codex 用 `$unified-log-feedback`；其他AI先读取 MANUAL.md（源码目录为 SKILL.md）。也可直接获取模板：

```text
python -I -B <技能目录>/scripts/feedback.py template
python -I -B <技能目录>/scripts/feedback.py build --report <报告目录> --input <反馈输入.json>
```

把 template 输出中的 input 对象保存为输入文件。actual、deviation 填用户所述实际情况和偏差；可填写 expected、aiSelfReview、suggestion、categories、suspectedStage、severity、excerpts，确认原意后设置 userConfirmed=true。

生成前请向AI提供产品、项目、公司、人名、内部模块名及中英文缩写，写入每行一个敏感词的TXT，再用 `--extra-terms <TXT>`；默认规则不识别这些名称。`--no-quotes` 去掉引文、用户摘录和邻域模板文本，仍保留检索词与AI文字。默认每次写入报告旁新的 `feedback/<时间>/`；`--out <新目录>` 可指定输出，拒绝覆盖。

只分享生成的 `.json` 和 `.md`。**同级 `*-LOCAL-ONLY/` 中的映射文件保留原值和完整剩余标识清单，只留本机。** 重做后只分享最新目录。 自动脱敏不保证完整，分享前请检查；控制台列出的剩余标识仅供本地确认。

这是 beta。反馈不会自动进入任何服务，须由你自行传回。对零散误判先积累用例；同类问题至少2例，或1次编造原因/隐瞒反证时，提出下一版调整。
