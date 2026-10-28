# dshVerify（鸿蒙开发验证）

默认打开会话日志：导入、跨文件查找、加入对话与直接删除。开发验证收在「更多工具」。新版删除没有回收区或撤销，旧回收数据升级保留。

DeepSeek Harness 的**验证记录与证据服务**：保存开发任务与安装交接、创建验证轮次、追加检查点事件、读取历史与证据，并保留完整会话日志工作台。

设备执行与观察由配套的 **dshHarmony** 完成，当前会话 AI 自己做决策。本插件**不再包含**第三方 `e2e@0.19.0` 执行器、内层模型循环、动作缓存或 runner RPC bridge。

当前版本 **0.5.0-rc.3（RC 预发布）**；显示名已由 dshE2E 更新为 dshVerify，安装标识、源码目录、storage `dshE2E` 与既有 API 路径保持不变，无需迁移数据或重装宿主。配套 dshHarmony **0.5.0-rc.10**；运行环境 Windows、DSH **0.2.0-rc.2**、Node **24**。

## 工作流

1. `save_task`：需求/现象、日志引用、代码线索、改动摘要、可观察检查点、安装交接 revision。
2. 若改了代码，本轮结束，等用户手动编译安装并回复“已装好”。
3. `begin_validation`：二选一——`installationConfirmed:true`（用户已确认安装）或 `verifyExisting:true`（只验当前已安装功能）；模式 `ai` 或 `human`。
4. 当前会话用 dshHarmony 操作/观察（`ai`），或用户自己操作、AI 只读观察（`human`）；实际调用自动写入本轮事件。
5. `record_checkpoint` → `finish_validation`：逐项 pass/fail/unverified，工具成功不等于检查通过，必验项未完成不能宣告通过。

日志独立采集：`start_capture` / `stop_capture`。采集跨 AI 回复继续，结束验证、取消、会话关闭或宿主退出时清理；`finish_validation` 单独报告日志完整性。

## 操作

| 操作 | 作用 |
|---|---|
| `status` / `resolve_app` | 只读查询：能力、设备、应用候选；不创建验证记录 |
| `save_task` | 创建/更新任务，revision 冲突检查，保存检查点与安装交接 |
| `begin_validation` / `finish_validation` / `cancel_validation` | 轮次生命周期；finish/cancel 幂等，结束后拒绝新增事实 |
| `record_checkpoint` | 记录检查点结论、来源（ai/human）与证据引用 |
| `read_validation` | 任务/轮次/事件游标分页；legacy 只读 |
| `start_capture` / `stop_capture` | 独立采集设备日志，写入本轮归档 |
| `list_runs` / `get_report` | 历史列表与只读报告视图（新旧格式分开标注） |
| `get_logs` / `list_log_files` / `get_file_logs` | 日志分页与原始行定位 |
| `run` / `replay` / `retry` / `cancel` / `archive` | **已退役**，返回迁移说明，不执行任何动作 |

## 数据

```text
<DSH_HOME>/storages/dshE2E/
  workflows/                     旧执行记录：原位只读，不改写、不迁移
  validation-v1/sessions/<会话键>/tasks/<taskId>/
    task.json
    attempts/<attemptId>/{attempt.json, events.jsonl, evidence/, logs/}
```

- `validation-v1` 是新写入格式；`legacy-e2e-v1` 只读适配，旧格式没记录的派发状态、坐标、日志完整性显示为“旧格式未记录”。
- `events.jsonl` 串行追加、seq 单调；崩溃留下半行时只读完整事件并报告尾部缺口，不重写已提交事件。
- 会话身份取宿主可信上下文并哈希成目录键，不把原始会话字符串拼进路径。

## 两种模式

- `ai`：当前会话调用 dshHarmony 操作，Harmony 在派发前写入 tool-start、返回后写入结构化结果/错误。
- `human`：不获取自动化控制租约，只允许只读观察与日志；用户操作只作为“用户声明的动作”记录，不伪造自动派发回执。

## 文档

| 文档 | 内容 |
|---|---|
| [使用说明](USAGE.md) | 对话触发、操作范围、日志、历史 |
| [安装指南](INSTALLATION.md) | 配套安装、运行时与 profile |
| [AI 安装指南](AI_INSTALLATION.md) | 安装步骤、备份与恢复 |
| [日志指南](../../docs/LOG_WORKBENCH.md) | 会话日志库和分析草稿 |
| [本轮实施报告](../../docs/E2E_RUNNER_REMOVAL_IMPLEMENTATION_20261018.md) | 改动清单、已做/未做检查、编译安装步骤与真机验收清单 |

运行资料保存在 `<DSH_HOME>/storages/dshE2E`，不随源码提交。适配许可为 [Apache-2.0](LICENSE)，完整来源见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。

[返回工具集](../../README.md)
