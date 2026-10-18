# dshVerify 重构源码审查收尾结论

**本次审查提出的 R/F/G/H 系列源码问题已关闭，可以进入用户手动构建安装阶段。**这是源码与隔离夹具层面的放行，不代表已构建、已安装、实际宿主/手机验收通过。

候选：dshHarmony 0.5.0-rc.8 / dshVerify（安装标识 dsh-e2e）0.5.0-rc.1。

## 本轮独立核验

- 阅读最终 H01/H02 代码与真实消费者，四个回归文件独立重跑 **32/32 通过（11+12+5+4）**，包含 JSX parser-only 检查。未冒称独立复跑全部119项。
- 原第四轮审查脚本另存为 [closure-review-20261018.mjs](E:/DeepSeekHarness/Verification/e2e-review-20261018/closure-review-20261018.mjs)，仅改变结果文件名后运行；未覆盖原始审查或 DSH fixed 证据。
- [独立复核结果](E:/DeepSeekHarness/Verification/e2e-review-20261018/source-evidence-closure-review.json)使用真实 wrapper、真实 PromptRun registry、真实注册 HTTP handler，仅设备/宿主副作用为隔离夹具。

| 旧阻断项 | 独立复核事实 | 结论 |
|---|---|---|
| H01-A 清理失败假释放 | 实际 registry 记录 cleanupFailures=1；fake 控制仍持有；releaseReceipt.released=false、leaseReleased=false | 关闭 |
| H01-B 跨回复旧回执 | 首次成功释放；下次获取后 nextCallLeaseReleased=false，旧 confirmedAt 不沿用；回归另覆盖旧 run 迟到回执拒绝 | 关闭 |
| H01-C 关闭会话/缺失 run | 新增回归通过，使用清理结果和匹配身份，不默认确认释放 | 关闭 |
| H02 全部历史下载/导出 | 相同外会话归档：分页200/1条，文件下载200含正文，导出200/234 bytes含正文；回归覆盖当前会话拒绝与无记录404 | 关闭 |

此前修正的附件同源/宿主转换、树证据持久化、观察身份、重复回执、分页连续性/字节预算、跨会话归属与取消完整性等，相关回归本轮全部通过。第三方 runner 删除、兼容 ID、历史只读与工作台保留沿用前几轮源码审查结论，本轮没有重新做整个仓库的全量审计。

最初固定证据 SHA256 仍为 `C370A68686A74700550D54EEC11AAF57AB58851FC003C85AB61D1764F4C894E7`。

## 安装交接

本轮没有构建、安装依赖、重建lib、修改运行profile/用户数据、刷新/重启宿主或操作手机；运行中的宿主仍加载此前部署的产物。

本机 desktop/web profile 使用 link 指向源码工作区。用户开始手动依赖安装/构建前，应先保存对话并完整退出相关 DSH 宿主，再备份源码、两插件产物与 profile。构建顺序仍为 **Harmony → dsh-e2e**，完成配对预检后完整启动宿主，让前后端同时换版；不要在旧后端仍运行时刷新新产物页面。此段是已有部署方式的安装交接提醒，不要求 DSH 或 Codex 现在执行。

下阶段仍需：干净依赖安装与正式构建/打包、带目标profile的预检、可选插件加载/宿主冷启动、真实模型收图与浏览器下载、两种验证模式、真实租约/取消/转屏/重连、投屏与10万行日志并发、Windows junction/软链及回滚演练。相关源码夹具不能替代这些运行结果。

DSH 到此停止自动源码修改和检查，等待用户手动构建安装。用户明确回复“已装好”后，再按实施报告第9节开始运行验收。
