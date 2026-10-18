# dshVerify 使用说明

dshVerify（鸿蒙开发验证，安装标识 `dsh-e2e`）负责开发任务、安装交接、验证轮次、事件与证据；设备操作与观察由 dshHarmony 完成，决策由当前会话 AI 做出。插件内不再有独立执行器、动作回放或内层验证模型。

## 一次完整的开发验证

1. 在对话中描述现象/需求，可附日志地址、代码线索。
2. AI 用 `e2e_phone.save_task` 保存任务：`title`、`kind`、`requirement`、`checkpoints`（至少一项必验），改过代码时附 `installHandoff`（revision/摘要）。状态为「等待安装」，本轮结束。
3. 用户手动编译安装并回复“已装好”。
4. AI 用 `begin_validation` 建轮次，二选一：`installationConfirmed:true`（用户已确认安装）或 `verifyExisting:true`（只验当前已安装功能）；`mode:'ai'` 或 `'human'`。开始后返回 `attemptId` 与 `contextRevision`。
5. AI 模式下用 dshHarmony 操作/观察；人工模式下用户操作、AI 只读观察。实际调用自动写入本轮事件。
6. `record_checkpoint` 逐项记录 `pass/fail/unverified`。**通过项必须引用证据**：观察截图/控件树证据文件，或带证据的调用 `{callId}`；没有证据只能记 `unverified`。
7. `finish_validation` 汇总：存在未验证、缺证据或失败项时不能宣告通过；日志完整性、清理结果分别报告。

## 操作速查

| 操作 | 作用 |
|---|---|
| `status` / `resolve_app` | 只读查询能力、设备、应用候选；不创建验证记录 |
| `save_task` | 创建/更新任务；`revision` 冲突检查；不能出现重复检查点 ID |
| `begin_validation` | 原子预约会话与设备；任务既定必验项不可被空列表缩减 |
| `record_checkpoint` | 记录结论与来源（ai/human）；`pass` 需证据 |
| `finish_validation` / `cancel_validation` | 幂等；结束后拒绝业务写入；取消会中止本轮在途调用信号 |
| `read_validation` | 任务/轮次/事件游标分页；返回 `hasMore/total/nextAfterSeq` |
| `start_capture` / `stop_capture` / `attach_capture` | 每个采集独立目录，停止后仍可读取；可把独立采集关联到进行中的轮次 |
| `list_runs` / `get_report` / `get_logs` | 历史与只读报告；日志按 capture 归档分页 |
| `run` / `replay` / `retry` / `cancel` / `archive` | **已退役**，返回迁移说明，不执行任何动作 |

## 人工模式

- 不获取自动化控制租约，不派发点击/输入/启动应用，不抢投屏。
- 只读观察支持 `cursor/limit` 分页、`selector` 与 `region` 过滤；不完整控件树不转发节点或截图。
- 敏感字段（密码等）文本被遮盖；截图必须是与几何一致的 PNG 才会转发。
- 用户自己操作的变化只能记为“用户声明的动作”，不会伪造成自动派发回执。

## 日志

- 目标用 `resolve_app` 确认；`logAppBundle` 只采集日志、不重启应用；`appBundle` 才会停止并启动。
- 采集跨 AI 回复继续；`stop_capture`、结束/取消验证、会话关闭、宿主退出时停止。
- 每个 capture 写入独立归档（`logs/captures/<captureId>/` 或独立采集目录），重启采集不截断旧证据。
- 日志完整性在归档真正收尾后计算：`complete/partial/interrupted/not-collected`。0 条或 error 级别都不能单独证明应用有/无缺陷。
- 设备控制释放分开记录：E2E 设备占位在 `cleanup` 收敛后释放；Harmony 控制租约只有在收到其自身释放回执后才显示“已确认释放”。

## 报告阅读

- 会话顶部打开 dshVerify；列表包含开发任务与验证轮次。
- 详情：概览、事件与证据、应用日志、验证历史；新轮次展示派发/效果/验证状态、证据与事件分页提示。
- 旧历史只读：显示 `legacy-e2e-v1`，缺派发状态、坐标、日志完整性时标“旧格式未记录”，不补写文件。

## 数据位置

```text
<DSH_HOME>/storages/dshE2E/
  workflows/       旧执行记录：原位只读
  validation-v1/   新任务、轮次、事件、证据、采集归档
```

详细界面见 [面板指南](../../docs/PANEL.md)，日志能力见 [日志指南](../../docs/LOG_WORKBENCH.md)。

[安装指南](INSTALLATION.md) · [返回介绍](README.md)
