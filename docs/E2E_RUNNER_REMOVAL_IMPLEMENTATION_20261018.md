# dshE2E 移除第三方执行底座：源码实施报告

日期：2026-10-18（改名 dshVerify；响应 Codex 第一轮 R01–R13、第二轮 F01–F12、第三轮 G01–G07）。状态：**源码收尾完成，待用户手动编译安装验收**。

本轮未构建、未安装、未刷新/重启宿主、未操作手机、未打包发布，也没有运行 `npm test`/`pretest`/esbuild。
下文把“已做检查”和“未做检查”分开写，夹具测试不等于真机验收。

---

## 1. 结论

- 第三方 `tester-army/e2e`（npm `e2e@0.19.0`）已从源码、manifest、锁文件与预检契约中移除；插件安装身份仍是 `dsh-e2e`。
- 启动链不再 eager import 第三方 engine：`index.mjs` 只加载自有模块，`dshHarmony` 变为可选注入。
- 设备执行/观察回到**当前会话 AI + dshHarmony**；dshE2E 变为被动的任务/验证轮次/追加事件/证据服务，历史改为只读兼容。
- 新增 `validation-v1` 存储与六类职责、独立 `CaptureSession`、只读 legacy 适配器，并有行为测试源码。
- 既有日志工作台源码（`log-library.mjs`、`log-storage.mjs`、`LogWorkbench.jsx`、`LogViewer.jsx`、跨文件搜索、截图批注与投屏相关文件）**未回退**；本轮只改了 `logs.mjs` 的采集适配层与 E2E 服务/工具/路由。
- **对外显示名改为 dshVerify（鸿蒙开发验证）**，紧凑入口显示「开发验证」/「鸿蒙开发验证」；安装标识仍为 `dsh-e2e`，storage `dshE2E`、API 路径与工具名 `e2e_phone` 不变（见第 12 节）。

- **第二轮独立复审 F01–F12 已逐项修正**（JSX 语法、真实下载/导出、观察契约、证据链、清理归属、采集竞争、begin 回滚、gaps、日志预算、全部会话与同任务历史），见第 14 节；仍**未构建、未安装、未真机验收**。
版本：dshHarmony `0.5.0-rc.8` / dshE2E `0.5.0-rc.1`（皆为本地候选，未打 tag）。
基线：分支 `codex/archive-encoding-fix-20261017`，HEAD `bc10b2b` + 工作树未提交改动（77 项）。

---

## 2. 基线与可恢复性（P0）

终端在会话开始时不可用，用户拒绝权限修复；后经运行上下文升级恢复。恢复后立即做了**工作区外**快照：

```text
E:\DeepSeekHarness\Sources\_e2e-baseline-20261018\
  tracked.patch         # git diff HEAD，233213 字节，覆盖本轮前所有已跟踪改动
  untracked\            # 本轮前 77 项未跟踪文件/目录的逐字节副本
  untracked-list.txt
  status.txt / branch.txt / head.txt
  RESTORE.txt           # 恢复步骤（git apply + 复制未跟踪文件）
```

还原方式（**不要**用 `git reset --hard` / `git clean -x`，会丢掉用户先于本轮的未提交优化）：

```powershell
cd E:\DeepSeekHarness\Sources\dsh-archive-fix-20261017
git apply --whitespace=nowarn "E:\DeepSeekHarness\Sources\_e2e-baseline-20261018\tracked.patch"
Copy-Item "E:\DeepSeekHarness\Sources\_e2e-baseline-20261018\untracked\*" . -Recurse -Force
```

本轮没有删除用户 Data/storages、旧报告、截图、日志或 `node_modules`。

---

## 3. 按阶段的源码改动

### P1：先拆启动依赖

| 文件 | 改动 |
|---|---|
| `plugin/dsh-e2e/src/snapshot.mjs` | **新增**。从 `engine.mjs` 抽出纯投影：`roleFor`、`convertSnapshot`、`snapshotQuality`、`geometryRecord`、`assertGeometry`、`toNativePoint`。不 import 第三方 engine，不改证据脱敏语义。 |
| `plugin/dsh-e2e/src/index.mjs` | 注入改为 `{ required: ['connection','sessions'], optional: ['dshHarmony','attachments','llm'] }`；设备路由注册改为条件注册；新增会话关闭清理；新增 validation/evidence 路由与旧执行端点的退役响应。 |
| `plugin/dsh-e2e/src/legacy.mjs` | **新增**。只读扫描 `workflows/<flow>/runs/<id>`，**不调用** `records.ready()`；queued/running 只在展示层解释为 interrupted；缺失字段标 `unknown/not-recorded`。 |
| `plugin/dsh-e2e/src/service.mjs` | **重写**。组合日志库、legacy 只读适配、validation 服务；删除 spawn CLI、bridge server、`ctx.llm.stream`、配置/测试生成、报告解析与 `run/replay/retry/cancel` 执行器。 |
| `plugin/dsh-e2e/src/records.mjs` | 只保留 `paginate`/`assertScope`/`activeStatuses`；删除会改写 `record.json` 的 `createRecordStore`。 |
| `plugin/dsh-e2e/src/verification.mjs` | **删除**（内层模型视觉验收已不存在；视觉由当前会话 AI 依据 Harmony 截图判断）。 |
| `plugin/dsh-e2e/src/engine.mjs` / `executor.mjs` / `rpc.mjs` | **删除**（第三方 engine 适配、内层动作循环、runner RPC bridge）。 |

### P2：任务、轮次、追加事件与 API

| 文件 | 改动 |
|---|---|
| `plugin/dsh-e2e/src/validation-store.mjs` | **新增**。`validation-v1/sessions/<sha256(session)[:32]>/tasks/<taskId>/attempts/<attemptId>/{task.json,attempt.json,events.jsonl,evidence/,logs/}`；原子元数据写、revision 冲突、事件串行追加与 seq 单调、游标分页、崩溃半行“只读+报告缺口”且新事件另起一行、证据文件名白名单与目录包含校验、宿主重启只把 active 轮次标 interrupted。 |
| `plugin/dsh-e2e/src/validation-service.mjs` | **新增**。六个职责：`saveTask`、`beginValidation`、`recordCheckpoint`、`finishValidation`、`readValidation`、`cancelValidation`；另含 `recordHostEvent`（给 Harmony）、`startCapture`/`stopCapture`、`disposeSession`、`dispose`。约束：一会话一 active、同设备跨会话互斥、安装确认与“验现有安装”二选一、AI 模式拒绝人工来源、必验项未完成不能 `passed`、finish/cancel 幂等、结束后 `ATTEMPT_CLOSED`。 |
| `plugin/dsh-e2e/src/presentation.mjs` | 保留 legacy `reportView`/`failureCategory`；新增 `validationRunView`/`validationTimeline`，显式标注“未采集”，不伪造模型调用/Token。 |
| `plugin/dsh-e2e/src/tool-contract.mjs` | **重写**。新操作字段白名单；旧 `run/replay/retry/cancel/archive` 保留字段以便落到**退役错误**而不是 schema 拒绝。 |
| `plugin/dsh-e2e/src/agent.mjs` | **重写**。工具仍名 `e2e_phone`，但契约为任务/轮次/检查点/采集；退役操作抛迁移说明；系统提示删除强制 `e2e_phone.run`、`E2E_REQUIRED`、内层验收说法；工具描述与提示词改用 dshVerify 展示名。 |

### P3：Harmony、人工观察与 CaptureSession

| 文件 | 改动 |
|---|---|
| `plugin/dsh-harmony/src/validation-bridge.ts` | **新增**。tool-start/tool-end 事件桥（未安装 E2E 时明确“未记录”）、结构化错误提取（code/details/dispatchState/effect/verification/retryable/cause）、输入裁剪与脱敏、`humanObserve`（`manager.snapshot` **不带 leaseToken**、`leaseAcquired:false`、`dispatchState:'not-sent'`）。 |
| `plugin/dsh-harmony/src/task-routing.ts` | **重写**。删除 `E2E_REQUIRED` 与强制入口；只做验证上下文协调：无轮次不阻断普通调用，人工模式拒绝控制动作，保留 `activeAttempt` 查询。提示词数组改为 `join('')`（原数组会被拼成逗号串）。 |
| `plugin/dsh-harmony/src/index.ts` | 保留租约/互斥，新增：派发前写 tool-start（有轮次且为控制动作时写不进则不派发）、返回后写结构化结果、错误不再压成纯文本、人工模式只读观察绕过控制租约、未创建验证记录时明确提示。 |
| `plugin/dsh-harmony/src/agent.ts` | 提示词更新为“无 E2E 时不创建验证记录”“操作结果不等于检查点结论”。 |
| `plugin/dsh-e2e/src/capture-session.mjs` | **新增**。自持 AbortController 的独立采集：水位线、进程刷新、PID 复用保护、内存环形上限、磁盘归档、dropped/warnings、`stop`/`cancel` 幂等、integrity 结论。 |
| `plugin/dsh-e2e/src/logs.mjs` | `startLogCollection(manager, job)` 改为 CaptureSession 适配器（保留原签名与页面行为），删除与 runner/lease 的耦合。 |

**采集生命周期修正**：`startCapture` 不再使用调用方 `AbortSignal`，因此 AI 回合结束不会中断采集；只有 `stop_capture`、finish/cancel、会话关闭、宿主 dispose 会停止。有专门测试覆盖。

### P4：切换工具/UI、删除旧底座

- `package.json`：删除 `e2e: 0.19.0`，版本 `0.5.0-rc.1`，描述改为验证记录与证据服务。
- `package-lock.json`：删除根依赖与 `node_modules/e2e`，并按依赖可达性收敛删除 79 个仅被 e2e 引用的条目（147→68），保留 `7z-bin`、`js-yaml`、`sharp`、`yauzl`、`esbuild`、`react`；manifest 与锁文件三组依赖逐一相等（脚本内断言）。
- `scripts/build.mjs`：复制 `src/*.mjs` 到 `lib/` 后**删除已不存在于 src 的旧模块**（下次构建清理 `engine/executor/rpc/verification`），构建日志打印被清理项；删除“built with e2e 0.19.0”文案。
- `scripts/paired-sources.mjs`：`requiredPairedSources` 补 `presentation.mjs`、`version.mjs`；新增 `requiredServerSources`（12 项）与**真实相对 import 闭包**遍历；显式拒绝仍存在 `engine/executor/rpc` 的包。
- `scripts/preflight.mjs`：新增“manifest 或锁文件仍依赖 e2e / 锁文件仍解析 `node_modules/e2e`”失败条件。
- 路由：`/api/dsh-e2e/validation/{tasks,task,attempt,events}`、`/capture/stop`；`/runs` 合并 validation-v1 与 legacy 行；`/cancel`、`/archive` 返回 `OPERATION_RETIRED`。
- UI：保留全部既有日志/历史组件；`/runs` 的合并结果让新轮次出现在既有历史列表中。**未新增**任务编辑器与事件时间线界面（见第 7 节）。

### P5：文档

- `plugin/dsh-e2e/README.md`：重写为验证记录服务定位、工作流、操作表（含退役）、数据目录、两种模式、文档索引。
- `CHANGELOG.md`：新增本轮 0.5.0-rc.8 / 0.5.0-rc.1 条目（含“已知未验证”）。
- `README.md`、`docs/INSTALLATION.md`、`docs/AI_INSTALLATION.md`、`docs/AI_UPGRADE.md`、`docs/UPGRADE.md`、`plugin/dsh-e2e/INSTALLATION.md`：更新当前候选版本号；历史 tag/历史叙述保持原值。
- 本报告。

---

## 4. 新旧契约对照

| 旧 | 新 |
|---|---|
| `run`（spawn CLI + 内层模型 + 缓存 + 报告驱动判定） | `save_task` →（安装）→ `begin_validation` → Harmony 操作/观察 → `record_checkpoint` → `finish_validation` |
| `replay` / `retry` | 已退役；读旧任务后新建验证轮次 |
| `cancel`（运行） | `cancel_validation`（轮次）/ `stop_capture`（采集） |
| `records.ready()` 重写旧记录 | `legacy.mjs` 只读，展示层解释未正常结束 |
| 强制 `e2e_phone.run`、`E2E_REQUIRED` | 验证上下文协调；无轮次也可普通直控，但不产生验证记录 |
| 工具成功即 `passed` | 检查点单独记录；必验项未完成不能 `passed` |

---

## 5. 已执行的检查（源码/夹具级）

| 检查 | 命令/范围 | 结果 |
|---|---|---|
| 语法检查 | Node 24.21.0 `node --check`，`plugin/dsh-e2e/src/*.mjs` 共 25 个 | 0 错误 |
| 语法检查 | `node --check src/task-routing.ts src/validation-bridge.ts` | 通过 |
| 模块装配 | 逐个 `import` 15 个 E2E 源模块（含 `index.mjs`、`agent.mjs`、`service.mjs`） | 全部成功 |
| E2E 源码测试 | `node --test`（Node 24）15 个非 esbuild 测试文件，含四轮 review 回归 | **108 passed / 0 failed**（另有 1 项 junction 用例受环境限制跳过） |
| Harmony + 配对测试 | `node --test plugin/dsh-harmony/tests/validation-routing.test.mjs scripts/paired-sources.test.mjs` | **10 passed / 0 failed** |`r`n| 修复后独立证据（首轮） | `Verification/e2e-review-20261018/reproduce-fixed.mjs`（fake manager + 临时夹具） | `source-evidence-fixed.json`：R01–R12 按新契约记录 |
| 只读预检 | `node scripts/preflight.mjs .`（Node 24，static） | `preflight: passed`；两包版本一致；`pairedSources: 24`；`mutates: false`；未传 profile，`releaseChecksums: false` |
| 第三方残留扫描 | `grep` 源/测试/scripts：`from 'e2e`、`DSH_E2E_BRIDGE`、`harnessExecutor`、`harmonyEngine`、`engine/executor/rpc/verification.mjs` | 无命中 |
| 旧导出引用扫描 | `validateRun`、`createRecordStore`、`parseDecision` 等 | 仅注释命中，无代码引用 |
| 基线快照 | `git diff HEAD` + 77 项未跟踪副本 | 233213 字节 patch，恢复步骤已写 |

测试覆盖的关键行为：

- 会话隔离与路径安全（会话键、证据路径穿越/绝对路径/未知名字）；
- revision 冲突、重复 begin/finish/cancel、结束后 `ATTEMPT_CLOSED`、必验项未完成拒绝通过；
- 事件 seq 单调、游标分页不重不漏、崩溃半行只读且不重写已提交事件；
- 设备跨会话互斥、脚本设备 busy 释放；
- 人工来源与 AI 来源分离；Harmony 无轮次时 `recorded:false`，有轮次时写回原 attempt；
- 采集不绑定调用方 signal（跨回合继续）、会话关闭停止采集并把轮次标 interrupted、归档元数据写入 attempt；
- 旧记录读取前后内容与 mtime 不变、破损记录不遮挡其他记录；
- 人工模式只读观察不携带 leaseToken、`dispatchState:'not-sent'`；
- 结构化错误保留 code/details/派发/效果/验证字段；
- 退役操作返回迁移说明且不触发任何验证方法。

## 6. 未执行 / 待授权检查

| 项 | 原因 |
|---|---|
| `npm ci` / 干净依赖安装、`npm ls e2e` | 边界禁止安装依赖；锁文件按可达性清理但未做干净安装验证 |
| `npm run build`（Harmony→E2E）、`pretest` | 边界禁止构建；`lib/` 中仍有旧 `engine/executor/rpc/verification`，需下次构建清理 |
| `npm test` | 会触发 `pretest` 构建；另有 `client-lifecycle`、`search-history` 测试使用 esbuild |
| 完整 `preflight`（带 profile、产物校验） | 需要构建产物与安装 profile；本轮只跑了静态部分 |
| Harmony `index.ts` 编译/类型检查 | 需要构建；本轮只做源码检查与 `--check` |
| 宿主冷启动、插件加载顺序、可选注入实测 | 需安装产物与运行宿主 |
| 任何真机行为（AI/human 模式、转屏几何、超时/取消、断连、采集） | 需手机与安装 |
| UI 回归（跨文件搜索、历史浮层/IME/Esc、媒体删除、画布文字、Ctrl+Enter、投屏与 10 万行） | 需构建与桌面/网页运行 |
| 回滚演练 | 只提供快照与步骤，未演练 |

---

## 7. 已知偏差与遗留（按当前状态，不冒充完成）

1. **界面已接到新契约，但未经构建验证**：历史列表包含任务/轮次，详情读取 `validationReportView`（事件、证据、分页、未采集指标），同任务 `related` 已接通，取消走 `validation/cancel`，归档只对旧格式显示；`scope=all` 跨会话只读已接通 task/attempt/日志/证据（当前会话仍拒绝外会话详情）。JSX 已用 parser-only 检查（`scripts/parse-client-jsx.cjs`）通过，但**没有构建/真机界面证据**。
2. **观察通道**：`observe_page` 优先使用 `manager.getLatestSnapshot`（不打断投屏），首屏仅在无保留观察时 snapshot；`observe_screen` 为取截图仍会 snapshot（源码事实）。完整树会另行保存脱敏 JSON 观察证据（`observation-saved`），语义检查可引用 callId。未改 Hypium/hdc 后端。
3. **证据与坐标**：保存的元数据描述实际落盘图片（displaySize/scale/geometryId/generation/revision/hash），图片经 `harnessContent → saveImage` 转为宿主附件后返回；转换失败记为证据缺口。模型/宿主实际收图与真机转屏仍待装后验证。
4. **锁文件依赖图**：按可达性清理，未用 npm 重新求解；`@deepseek-ai/cordis` 仍为 peer、未在锁内（原有状态）。
5. **旧 `lib/` 残留**：本轮按边界不重建；`src` 已无引用，未来构建会清理，清单在 `scripts/build.mjs` 中。
6. **R12 范围**：证据文件（覆盖/软链/越界）、任务/轮次/事件读取的 containment 与 capture 索引校验已实现；目录 junction 用例在受限 Windows 环境被跳过，真实软链攻击演练未做。
7. **控制权回执**：E2E 的 `cleanup` 只代表记录服务侧的设备占位/采集收尾；Harmony 在 turn-stopping/session-disposed 回传真实 `finishPromptRun` 结果（`matched` 与 cleanup 失败数），在 release_control 回传动作结果。释放回执还须匹配当前控制获取的 `runId/acquisitionId`；新的控制获取会使旧释放状态失效，迟到旧回执被拒绝。未匹配、清理失败或未收到回执时 UI 显示“未收到释放回执”。真实租约时序待安装验证。
8. **测试未覆盖**：JSX/TS 构建、真实进程/字节级 UI、Harmony vendor 行为、跨进程事件写并发（当前单写者假设）、真机取消/转屏/断连。

---

## 8. 用户手动编译安装步骤（本轮未执行）

环境：Windows x64、真实 Node 24（`node --version` 应为 24.x）、npm。两个插件**按 Harmony → E2E** 顺序构建。

```powershell
# 0) 记录源码快照与备份（本轮已提供外部快照，安装前建议再备份运行 profile）
cd E:\DeepSeekHarness\Sources\dsh-archive-fix-20261017

# 1) 两个插件干净安装依赖（需要联网）
npm --prefix plugin/dsh-harmony ci
npm --prefix plugin/dsh-e2e ci

# 2) 构建 Harmony，再构建 E2E（E2E 读取 Harmony 的 cordis.patch.yml）
node plugin/dsh-harmony/scripts/build.mjs
node plugin/dsh-e2e/scripts/build.mjs

# 3) 确认 e2e 运行器确实消失
npm --prefix plugin/dsh-e2e ls e2e          # 期望：empty / not found
Get-ChildItem plugin/dsh-e2e/lib -Filter *.mjs | Select-Object -ExpandProperty Name  # 期望：无 engine/executor/rpc/verification

# 4) 成对预检（需要 Node 24；可加 profile 路径检查安装目标）
node scripts/preflight.mjs . <你的 profile 路径>

# 5) 安装/激活到 DSH profile（按你现有安装流程），然后完整退出并重启宿主
#    不要热刷新；让主进程与前端同时换版
```

安装后检查：`dshE2E` 版本 0.5.0-rc.1、`dshHarmony` 0.5.0-rc.8；日志工作台可打开；`e2e_phone` 工具描述为验证记录服务；旧 `run` 调用返回迁移说明。

---

## 9. 两种模式真机验收清单（等安装后执行）

### A. AI 操作验证（mode: ai）

1. 给一份真实应用日志，指出现象 → 当前 AI 分析并改源码。
2. `save_task`：检查点、改动摘要、安装交接 revision；状态 `awaiting-install`，本轮结束，不后台轮询设备。
3. 用户手动编译安装并回复“已装好”。
4. `begin_validation`（`installationConfirmed:true`）→ 返回 attemptId 与 contextRevision。
5. 用 dshHarmony 操作；核对 `read_validation` 事件：tool-start/tool-end 成对、`callId` 一致、结构化错误未被压平、`dispatchState`/`effect` 分开。
6. 超时/取消一次：确认没有自动重发可能已提交的动作，先出现新的观察。
7. 逐项 `record_checkpoint`（pass/fail/unverified）；故意留一项 unverified，`finish_validation{overall:'passed'}` 必须被拒。
8. 正常结束：`semantic`、`logIntegrity`、`cleanup` 三项分别可见；缺日志时不判应用缺陷。
9. 同一设备另一会话并发：应被拒绝（DEVICE_BUSY），不影响他人投屏。
10. 宿主重启：该 attempt 变 interrupted，不自动继续动作。

### B. 人工操作 + AI 观察（mode: human）

1. `begin_validation{mode:'human', verifyExisting:true}`。
2. 让 AI 观察：返回 `leaseAcquired:false`，事件 `dispatchState:'not-sent'`；设备未被抢控制、应用未被重启、投屏未被打断。
3. 让 AI 尝试 `tap_ref`/`input_text`：必须被拒（`HUMAN_MODE_READ_ONLY`）。
4. 用户自己操作，AI 记录下来源为 human 的检查点；`read_validation` 中不能出现伪造的自动派发回执。
5. 用户继续操作、AI 多次回复：`start_capture` 的采集**跨回复持续**；确认日志条数增长。
6. 结束验证 / 取消 / 关闭会话各一次：采集停止、清理状态 released、已有事实保留。
7. 宿主退出：采集标 interrupted，不自动恢复。

### C. 兼容与既有能力回归

1. 只装 dshE2E：日志工作台、历史可用；设备相关操作提示缺 dshHarmony。
2. 只装 dshHarmony：普通直控可用；结果提示“未创建验证记录”。
3. 旧历史：打开旧报告，核对 `record.json`/`dsh-run.json` 内容与 mtime 未变；queued/running 显示为“历史记录未正常结束”。
4. 旧工具调用 `run/replay/retry/cancel/archive` 返回迁移提示且不执行。
5. 日志工作台回归：跨文件正文搜索、历史浮层/IME/Esc、RAR/ZIP/GZ 与编码、分页与原始行；媒体删除、画布文字批注、Ctrl+Enter 加入后关闭；投屏与 10 万行日志同时使用。

---

## 10. 回滚

1. **先保存当前候选**（源码 + 两个 `lib/` 产物 + `cordis.patch.yml`），不要原地覆盖。
2. **在独立空目录重建实施前基线**（替代原来不可执行的“对当前树 `git apply`”）：
   - 用实施前快照 `E:\DeepSeekHarness\Sources\_e2e-baseline-20261018\` 的 `head.txt` 取准确 HEAD（`bc10b2b`），在空目录执行 `git worktree add <空目录> bc10b2b` 或 `git clone --no-checkout` 后检出该提交；
   - 对该目录应用 `tracked.patch`：`git apply --check tracked.patch`（**只在空目录验证**），再 `git apply`；
   - 把 `untracked\` 下的文件按清单复制回该目录；
   - 记录该基线目录的 `git status` 与文件清单，作为可回滚基线。
3. 源码回滚：从该基线目录取需要恢复的路径（按 manifest 逐文件），**不要**对当前工作树执行 `reset --hard`/`clean -x`；当前候选与基线冲突时先保留候选分支再替换。
4. 产物回滚：恢复安装前备份的两插件 `lib/`、`cordis.patch.yml` 与 profile 的插件版本登记，按 Harmony→E2E 顺序重建并完整退出/重启。
5. 数据回滚：`validation-v1/` 原位保留；旧版不会读取它，也不会恢复旧 runner。`workflows/` 始终只读。删除新数据不在回滚步骤内。

回滚演练状态：**未执行**（需要空目录与构建环境，本轮边界禁止构建）。以上步骤需在用户授权的安装阶段实际演练后才算验证。

---

## 11. 边界声明

本轮**没有**：构建、安装依赖、运行 `npm test`/`pretest`、调用 esbuild/打包、重建 `lib`、刷新或重启宿主、编辑运行 profile、操作手机、打包发布、修改 `Data/storages`、删除 `node_modules` 或旧证据。允许并实际执行了纯源码夹具测试与 Babel **parser-only** 语法解析（不生成代码）；此前一次误触 esbuild `write:false` 已在第 13.2 节如实记录。
因此本报告只能证明“源码与夹具测试”，不能证明“已构建/已安装/真机通过”。请按第 8 节手动编译安装，安装完成并回复“已装好”后，再按第 9 节做真机验收。

---

## 13. 对 Codex review 问题单（R01–R13）的逐项修正

固定证据：实施前 `Verification/e2e-review-20261018/source-evidence-initial-review.json`（未覆盖）；修复后
`Verification/e2e-review-20261018/reproduce-fixed.mjs` → `source-evidence-fixed.json`。测试源码：
`plugin/dsh-e2e/tests/review-regressions.test.mjs`（11 项）与既有测试。

| 编号 | 修正位置 | 行为测试 / 证据 | 检查结果 | 仍待验 |
|---|---|---|---|---|
| R01 | `service.mjs`：`listPage` 增加无轮次任务行、`report`/`get` 顶层统一 `validationRunView`（含 id/status/name/sessionId/createdAt）、任务 ID 报告；`presentation.mjs`：`validationTaskView`、状态标签；`client.jsx`：取消走 `validation/cancel`、新格式隐藏归档 | review R01；`report-contract` | 列表 total=1（轮次行）、report run 三项非空、跨会话拒绝；通过 | 构建后界面实际渲染 |
| R02 | `service.mjs`：新格式 `captureLogPage`、旧格式 `archivedLogPage` 分页；`index.mjs`：capture 文件下载、新格式导出；`client.jsx`：capture 下载链接 | review R02；`legacy-log-page-contract` | 新旧均返回 `entries[]`，新格式 1 条 fixture 日志 | UI 分页/导出实际点击 |
| R03 | `validation-service.mjs`：`recordCheckpoint` 的 pass 证据门、`evidenceRefs`（file/eventId/callId）、`saveEvidence`（脱敏+几何+质量）、`beginValidation` 合并必验项；`validation-bridge.ts` 证据保存；`index.ts` AI 观察补证据；`client.jsx` 证据画廊 | review R03；`evidence-gate` | 无证据 pass 被拒；有证据 passed；空列表不缩减（仍 2 项） | 真机观察→检查点→截图阅读全链 |
| R04 | `validation-service.mjs`：每 capture 独立目录 `logs/captures/<id>/`、`capture.json` 持久索引、独立采集 `standalone/<session>/captures`、`stopCapture` 幂等、`finish` 汇总已停采集；`capture-session.mjs` 不再截断 | review R04/R08/R11；`capture-lifecycle` | 首轮证据保留、`logIntegrity=complete`、独立采集 persisted=2 且停止后仍可索引 | 宿主重启后的采集恢复展示 |
| R05 | `validation-service.mjs`：attempt AbortController、`attemptSignal`、inFlight 计数、finish/cancel 中止并写 `cleanup=pending/failed/released`；`index.ts` 合并取消信号到设备调用 | review R05、R05/R11 | 取消后 signal.aborted=true；有在途时 cleanup=pending 且有说明 | 真机延迟动作/取消并发 |
| R06 | `validation-bridge.ts`：begin 返回固定 context、end 必须带 context、无 context 仅接受 `openCall` 未闭合调用、失败返回 recorded:false；`validation-service.mjs`：`recordToolEvent(context)`、`tool-end-late`、`openCall`；`index.ts`：TRACE_GAP 文本与 details | review R06；`late-event-binding` | 旧调用只落原轮次 `tool-end-late`；新轮次无该 callId；无上下文回执 recorded=false | 宿主磁盘失败场景（无法在纯源码稳定模拟） |
| R07 | `validation-service.mjs`：`withLocks` 原子预约（session+device）、attempt 级互斥、`updateAttempt` 内复查 execution；store 串行化 | review R07；`concurrency` | 并发 begin 一成一败、active=1；并行 cp1/cp2 均 fail 且事件两条 | 跨进程写（当前单写者假设） |
| R08 | `validation-service.mjs`：`startCapture` 校验 attempt active/设备一致；`index.ts`/`task-routing.ts`：有轮次时 serial 固定、显式不一致拒绝、信号合并 | review R04/R08/R11 | SN2 采集被拒、结束后采集被拒、serial 不一致被拒 | 两真机设备同时在线 |
| R09 | `validation-bridge.ts`：`humanObserve` 完整树门、敏感字段遮盖、分页/selector/region、PNG 签名+尺寸+几何；`humanScreenshot` 保留存档语义；`index.ts` 人工路径 | review R09；`human-observation` | 不完整树 0 节点/0 图片；敏感文本不泄漏；第 2 页 [n2,n3]、nextCursor=4；无租约 | 真机转屏/旧 ref/损坏图 |
| R10 | `service.mjs`：报告返回 `events.loaded/total/hasMore/nextAfterSeq`；`presentation.mjs`：结构化步骤、未采集指标、分页字段；`validation-store.mjs`：seq 缓存避免 O(n²)；`client.jsx`：分页提示、原始数据、派发/效果/验证、未采集显示 | review R10；`report-pagination` | 203 事件→显示 200、hasMore=true、c-201 可续读 | UI 实际展开与长报告性能 |
| R11 | `capture-session.mjs`：stop/cancel 清 interval 与 abort 监听、`logMaxBytes` 磁盘预算、归档 close 后计算 integrity、unconfirmed→partial；`validation-service.mjs`：stop 异常记入 cleanup | review R05/R11；`capture-lifecycle` | 磁盘预算 33554432、未确认流 integrity=partial | 最后一批写盘失败注入 |
| R12 | `validation-store.mjs`：`contained` 拒绝 `rel='..'`、evidence 用 lstat+final realpath 拒绝软链、`writeEvidence` 用 `wx` 拒绝覆盖、读路径不建目录 | review R12；`path-safety` | 覆盖/穿越/缺失均被拒 | Windows 真实文件软链（需权限） |
| R13 | `USAGE.md` 重写为新契约；`AI_UPGRADE.md` 退役/候选说明；`README.md` 候选说明；第 10 节改为“空目录重建基线”的可执行回滚；错误文档声明修正 | 文档逐条对照 schema/操作；`git apply --check` 只在空目录演练（未执行） | 当前指南不再出现 run/replay/retry 操作教学；回滚不再要求对当前树 apply | 回滚演练、构建后 UI 文案核对 |

### 13.1 本轮新增/更新的测试

- 新增 `plugin/dsh-e2e/tests/review-regressions.test.mjs`（11 项，R01–R12）与 `plugin/dsh-e2e/tests/rereview-regressions.test.mjs`（12 项，F01–F12）。
- 新增 `Verification/e2e-review-20261018/reproduce-fixed.mjs` 与 `source-evidence-fixed.json`（另存，不改初始证据）。
- 更新 `validation-service.test.mjs`（证据门、capture 目录布局）、`validation-routing.test.mjs`（绑定上下文、人工观察保护）。

### 13.2 明确未执行 / 仍待验

- JSX（`client.jsx`）与 TypeScript（`index.ts`）构建/类型检查：本轮禁止 build/esbuild；改动为文本级与局部对象映射，需构建确认。
- `search-history.test.mjs` 依赖 esbuild，本轮未纳入运行；其 `client.jsx` 文本断言已手工核对 `onOpenFileConsumed` 仍存在。**过程说明**：一轮全目录测试命令意外包含了该文件，触发了一次 esbuild 的 `write:false` 转换（未产生任何构建产物、不写 lib/profile），此后已从测试集合排除并改用显式文件列表。
- 干净依赖安装、preflight 全量（带 profile）、宿主冷启动、真实设备、投屏/长日志并发、回滚演练。
- 事件/采集在真实磁盘满、进程被杀、跨进程并发下的行为（本轮只用夹具覆盖到 close 失败与未确认流）。

---

## 12. 追加需求（第二轮）：对外改名 dshVerify

### 12.1 改名范围（仅显示层）

| 入口 | 改动 |
|---|---|
| 侧栏标签/引导 | 标题 `dshE2E` → `dshVerify`；说明改为“鸿蒙开发验证：开发任务、安装交接、验证记录与证据” |
| 面板标题 | `dshVerify` + “鸿蒙开发验证 · <版本>”；紧凑入口与 header 按钮显示「鸿蒙开发验证」/`dshVerify` |
| 日志入口 | 仍显示「会话日志」（按内容命名，不冠产品名）；返回按钮“测试工作台”→“开发验证” |
| 按钮/空状态 | “新建测试”→“新建开发任务”；“调整后复测/复用通过流程”→“沿用检查点新建验证/按通过项新建验证”；“停止测试”→“取消验证”；空状态改为开发任务/验证记录措辞；“搜索测试记录”→“搜索验证记录” |
| 旧动作引导 | 会话草稿由 `run/retry` 改为 `save_task` + 安装确认 + `begin_validation`；“复用通过流程”改为 `read_validation` + `save_task`，并明确 `replay/retry` 已退役 |
| 工具/提示词 | 工具描述改为“dshVerify（鸿蒙开发验证）验证记录服务…”；E2E 系统提示与 Harmony 的无 E2E 提示改用 dshVerify 展示名 |
| 状态接口 | 新增 `displayName: 'dshVerify'`、`displayNameZh: '鸿蒙开发验证'`；`plugin` 仍为 `dshE2E` 兼容键 |
| 包描述 | `package.json.description` 改为 dshVerify 定位（`name` 不变） |
| 文档 | 根 README（表格行/版本行/验收步骤）、插件 README/USAGE/INSTALLATION、docs/INSTALLATION、AI_INSTALLATION、AI_UPGRADE、UPGRADE、PANEL、CHANGELOG 均加“显示名已更新，安装标识沿用 dsh-e2e”说明 |

### 12.2 明确保留的兼容标识（未改名）

| 标识 | 值 | 原因 |
|---|---|---|
| npm/包 ID | `dsh-e2e` | 安装身份、profile 登记与配对构建依赖它 |
| 源码目录 | `plugin/dsh-e2e/` | 配对源码清单与构建路径 |
| storage | `<DSH_HOME>/storages/dshE2E` | 不迁移用户数据 |
| HTTP API | `/api/dsh-e2e/*` | 前端、Harmony 配对与已有链接 |
| 插件服务键 | `ctx.dshE2E`、`dshE2E` reflect 名 | 内部契约；Harmony 通过它读取验证服务 |
| 工具名 | `e2e_phone` | 工具发现与既有提示词兼容 |
| bundle 补丁 id | `dshE2E-host` / `dsh-e2e` | 已有 profile 引用 |
| 事件/effect 标签 | `dshE2E: ...` | 运行时标识，非用户文案 |
| 历史格式 | `legacy-e2e-v1` | 历史来源如实标注，不抹掉旧 dshE2E/第三方来源 |
| sessionStorage/事件名 | `dshE2E:open-log:*`、`dshE2E:open-logs` | Harmony 工作台跨插件事件契约 |

### 12.3 同时修正的兼容问题

新 validation-v1 轮次已并入既有历史列表，但旧面板会读取 `view.totals` / `view.cache` / `view.steps`。新增 `validationReportView()` 把新轮次映射为旧视图形状：事件转时间线步骤、检查点转验收条件、`modelCalls` 明确显示「未采集」而不是 0、日志完整性映射为采集状态；原始时间线保留在 `view.validation` 与 `diagnostics.timeline`。这样无需在未构建验证的情况下重构 JSX。

### 12.4 改名相关检查

| 检查 | 结果 |
|---|---|
| `node --check` 全部 E2E mjs + Harmony TS | 通过（0 语法错误） |
| 全套允许的源码测试（119 项：E2E 109 + Harmony/配对 10；排除 esbuild 用例） | 118 passed / 0 failed / 1 skipped |
| 修复后独立证据（首轮） | `source-evidence-fixed.json`，R01–R12 契约按第 13 节记录 |
| 修复后独立证据（二轮） | `rereview-tests-fixed.tap` + `jsx-parse-fixed.json`（二轮当时 109 passed / 1 skipped；JSX parsed） | F01–F12 反例已由 `rereview-regressions.test.mjs` 覆盖 |
| 修复后独立证据（三轮） | `source-evidence-third-review-fixed.json`（复审脚本副本）+ `third-review-tests-fixed.tap`（三轮当时 115 tests / 114 passed / 1 skipped）+ `jsx-parse-third-fixed.json` | G01–G07 由 `third-review-regressions.test.mjs` 与复审副本共同覆盖 |
| 修复后独立证据（四轮） | `source-evidence-fourth-review-fixed.json`（复审脚本副本）+ `fourth-review-tests-fixed.tap` | 全量 119 tests / 118 passed / 1 skipped；H01/H02 由 `fourth-review-regressions.test.mjs` 与复审副本共同覆盖 |
| 只读预检 | passed；两包 0.5.0-rc.8 / 0.5.0-rc.1；`pairedSources: 24` |
| 用户文案扫描 | 面板/按钮/空状态/工具描述无残留 `dshE2E` 展示名；保留项仅第 12.2 节清单 |
| 文档一致性 | README/安装/升级/AI 指南均含“安装标识沿用 dsh-e2e”，当前指南不再教 run/replay/retry |

### 12.5 改名相关风险与待验

1. `client.jsx` 已通过 **parser-only**（Babel parse，无生成/打包）检查；本轮禁止 esbuild，**未做打包校验**。下次构建必须优先确认前端可打包、面板文案正确。
2. 侧栏 `register({ id, kind, title })` 的 `id/kind` 仍为 `dsh-e2e`/`dshE2E`；若宿主按包名而非 `title()` 展示，需要构建后用实际界面确认（不擅自改包或改宿主）。
3. Harmony 侧仍以 `dshE2E` 服务键读取验证服务；改名没有触碰该契约，配对加载行为需安装后确认。
4. 旧历史仍显示 `legacy-e2e-v1`，未做任何字符串美化替换。
5. 文档中的历史 tag 与旧版本叙述（如 `v0.5.0-rc.5-e2e-0.4.0-rc.6`）保持原样。

---

## 14. 第二轮 review（F01–F12）逐项修正

固定证据：最初 review `source-evidence-initial-review.json`（SHA256 `C370A686…C894E7`，未覆盖）；第一轮修复 `source-evidence-fixed.json`；第二轮独立反例 `source-evidence-rereview.json` 由复审方保留。本轮自己的证据另存为
`rereview-tests-fixed.tap`（109 passed / 1 skipped）与 `jsx-parse-fixed.json`（parser-only，parsed）。

| 编号 | 修正位置 | 做法 | 反例现状 | 仍待验 |
|---|---|---|---|---|
| F01 | `client.jsx` 135/145 | 删除重复 tailGap 片段；将日志页三元改为预计算 `captureLinks`/`logStatus`，避免相邻 JSX；新增 `scripts/parse-client-jsx.cjs` 与 F01 测试 | parser-only `parsed: true`；测试通过 | 构建打包 |
| F02 | `validation-service.mjs`（`captureRecords`/`captureFilePath`/流式 `captureLogPage`/`captureExport`）、`service.mjs`、`index.mjs` 路由、`client.jsx` 链接 | 导出按 session/task/attempt/captureId 定位并校验归属；真实换行；导出一次流扫 | 真实路由 200（attempt/独立）与跨会话 404；导出逐行 JSON.parse 通过 | 浏览器下载 |
| F03 | `validation-bridge.ts` `humanObserve`、`index.ts` 观察路径 | 按操作请求真实截图；游标为 `generation:revision:offset:hash` 不透明串；selector 结构化；ancestors/region 保留；`observe_page` 优先保留观察 | 首屏/翻页不触发新 snapshot；selector `{id:'n2'}` 命中；敏感文本脱敏 | 真机投屏/转屏 |
| F04 | `validation-service.mjs` 证据门、`validation-store.mjs` 全量 callId 查询、`agent.mjs` schema | 只接受 `evidence-saved` 或带证据/完整质量/已记录验证的观察事件；生命周期事件拒绝；schema 支持字符串与对象引用 | attempt-started 引用被拒；`{callId}` 通过；schema `items.anyOf` 存在 | 无 |
| F05 | `validation-service.mjs` `saveEvidence`/`readEvidence`、`validation-bridge.ts`、`index.ts` | 元数据取自实际落盘 PNG（displaySize/scale/geometryId/generation/revision/hash/maskedRegions）；模型只收到脱敏后的同一文件 | 1000×2000 输入落盘 720×1440 时元数据一致；回读字节与文件相同 | 真机转屏坐标 |
| F06 | `validation-service.mjs` finish/cancel/cleanup | 结论校验先于任何副作用；有在途时 `cleanup=pending` 且保留设备占位；迟到回执收敛后释放；显式 `leaseCleanup: harmony-managed` | 被拒 finish 后 signal 未中止、attempt 仍 active；pending 期间新轮被拒 | 真实 Harmony 租约回执 |
| F07 | `validation-service.mjs` startCapture/attachCapture | 启动使用 admission token，finish/cancel 中止未提交启动；结束后不得提交；仅允许已停止采集关联 | 延迟启动在 cancel 后失败且无 capture-started；运行中 attach 被拒；停止后可关联 | 真机取消 |
| F08 | `validation-service.mjs` begin 提交 | appendEvent/saveTask 失败时撤销 active/deviceOwner，把 attempt 标 interrupted 并保留原错误 | begin 抛错后无 active；磁盘 attempt 为 interrupted；重试可开始 | 磁盘满/权限异常 |
| F09 | `validation-service.mjs` 四种终止路径、recover | cancel/disposeSession/dispose 统一持久化 capture.json；recover 扫描 standalone 并尊重已提交终止状态 | cancel 后状态 cancelled/persisted；重启不改写；standalone 重启可见；disposeSession 持久化 | 宿主强杀 |
| F10 | `validation-bridge.ts`、`validation-service.mjs` recordToolEvent | 事件保存 `data.gaps` 并合并 `attempt.evidenceGaps`；工具输出显示 EVIDENCE_GAP；错误+记录失败保留 traceGap | 坏 PNG 证据缺口写入事件与 attempt，桥返回 gaps | 磁盘写失败 |
| F11 | `validation-service.mjs` 流式分页/导出 | 逐行流式扫描，total/filteredTotal 分开，响应约 24KB 预算，损坏行为 gap，导出单遍真实换行 | 101 行→total 101/filtered 100、响应受限、末行可续页；损坏行 gap=1 | 10 万行性能 |
| F12 | `validation-store.mjs` listAllTasks、`service.mjs` listPage/report/related、`client.jsx` 历史 Tab | `scope=all` 跨会话只读枚举；报告顶层归属真实 session；同任务 related 由 attempts 生成 | 两会话 all.total 含外会话；同任务第二轮 related=1；跨会话详情拒绝 | 浏览器 UI 实际点击 |

### 14.1 本轮保留的正确项

普通 begin 并发互斥、检查点并行不丢更新、迟到回执不串轮次、capture 分目录、日志预算参数、事件分页显式字段均保留并有测试；未回退日志工作台、跨文件搜索、媒体删除/批注、投屏源码能力。

### 14.2 仍未验证（不声称通过）

- JSX/TS 构建、打包后界面、宿主可选服务加载顺序。
- 干净依赖安装、全量 preflight（带 profile）、lib 清理。
- 真机：观察不打断投屏、取消/超时/断连、转屏几何、证据人工核对、10 万行日志性能。
- 目录 junction/真实软链攻击演练（当前环境跳过）；跨进程并发写（单写者假设）。
---

## 15. 第三轮 review（G01–G07）逐项修正

复审方独立证据 `source-evidence-third-review.json` 未覆盖。修复后用其脚本的**本地副本**
`Verification/e2e-review-20261018/third-review-fixed-run.mjs` 复跑，另存
`source-evidence-third-review-fixed.json`；同时保存 `third-review-tests-fixed.tap` 与
`jsx-parse-third-fixed.json`。该副本仍使用 Node 原生源码加载与进程内模块钩子，无构建/转换/安装。

| 编号 | 修正位置 | 做法 | 复验结果 | 仍待验 |
|---|---|---|---|---|
| G01 | Harmony `index.ts` 观察分支；`validation-bridge.ts`/`validation-service.mjs` 附件回执 | 受保护图片先保存，再以同源字节进入待转换块，统一走 `harnessContent → ctx.attachments.saveImage`；不再直接追加原始 image 块；附件 id/证据名写入 `evidence-attached`；转换失败记录证据缺口 | wrapper 夹具：`imageKeys=[type,attachment]`、`imageHasAttachment=true`、`saveImageCalls=1`，附件字节与落盘文件一致 | 真实宿主渲染/模型收图 |
| G02 | `validation-service.mjs`（openCalls/settled/recentAttempt、recordToolEvent、finish/cancel、confirmControlRelease）、`index.ts` 的 turn-stopping/session-disposed/release_control 回执、`presentation.mjs`、`client.jsx` | inFlight 改为按 callId 的未完成集合；重复 end 记 `tool-end-duplicate` 且不影响其他调用；cancel 在仍有未完成调用时 `cleanup=pending` 并拒绝新轮；Harmony 实际释放 PromptRun 时回传 `controlRelease`，`leaseReleased` 只认该回执 | 复审副本：`otherCallUnresolved=true`、`cancelCleanup=pending`、`nextAttemptAdmitted=false`；无回执时 `leaseReleased=false` | 真实设备租约时序 |
| G03 | `validation-service.mjs` captureLogPage | 达页上限或字节预算后冻结页面（后续短行不再挤入），仍继续扫描只做总量统计；预算与上报均用 `Buffer.byteLength(JSON.stringify(...))` 的实际 UTF-8 字节 | 21 长行跨页为 0..20、无缺无重；中文 30 行 `reported==actual` 且响应受限 | 10 万行性能 |
| G04 | `service.mjs`（listPage/report/getLogs/captureFilePath/evidenceFileFor）、`index.mjs` 路由 | 全部历史按任务自身 `sessionId` 读取 attempts；task/attempt/日志/证据均经 scope-aware `findTask(scope)`；`scope=all` 允许外会话只读详情，当前会话仍拒绝 | 复审副本：外会话显示为 attempt 行，task/attempt 详情与日志可读，当前会话拒绝 | 浏览器全部会话 UI |
| G05 | `validation-bridge.ts` humanObserve/`end` | `_evidence` 顶层带 generation/revision，保存时透传；geometryId 用真实代次生成 | 复审副本：`7/3`、`g-7-3`，不再是 null/g-unknown-unknown | 无 |
| G06 | `validation-service.mjs` `saveTreeEvidence`、`validation-bridge.ts` end、信任证据规则 | 完整树以脱敏、限 200 节点/256 KiB 的 JSON 证据落盘（`observation-saved`），事件保留 `nodeRefs/treeSha256/generation/revision/geometryId`；语义检查可引用该 callId | 复审副本：`persistedHasNodeText=true`；证据文件可回读并含真实节点 | 真实宿主消息引用 |
| G07 | `validation-service.mjs` `captureIntegrity` | 汇总读取 capture 的 `integrity`（中断/部分/关闭失败/丢盘），不再只看 status；取消按中断边界一致记录 | 复审副本：attempt 与 capture 均为 `interrupted` | 写盘/close 失败注入 |

### 15.1 保留

F01–F12 已通过项、四轮回归 32 项（11+12+5+4；前三轮复审实测 28 项）、日志工作台/跨文件搜索/媒体删除与批注/投屏源码能力未回退；控制释放只认与当前控制获取匹配的 Harmony 清理回执。

### 15.2 仍未验证

JSX/TS 构建与打包、宿主附件/模型实际收图与 UI、干净依赖安装、全量 preflight（带 profile）、真实设备租约与取消时序、10 万行压力、真实软链攻击、`observe_screen` 的 `manager.snapshot(includeTree=true)` 对兼容帧的潜在影响（源码事实，未做投屏实测，不新增未复现阻断项）。

---

## 16. 第四轮 review（H01–H02）逐项修正

复审方证据 `source-evidence-fourth-review.json` 保持原样。修复后用其脚本的本地副本
`Verification/e2e-review-20261018/fourth-review-fixed-run.mjs` 复跑（真实 PromptRun registry、真实 wrapper 事件处理器、真实注册 HTTP handler；仅设备/宿主副作用为夹具），另存
`source-evidence-fourth-review-fixed.json`，并保存 `fourth-review-tests-fixed.tap`。

| 编号 | 修正位置 | 做法 | 复验结果 | 仍待验 |
|---|---|---|---|---|
| H01-A | `vendor/lib/prompt-run-registry.ts`、Harmony `index.ts` turn-stopping/session-disposed、`validation-service.mjs` | `finishPromptRun` 返回 `{matched, runId, cleanupCount, cleanupFailures, errorMessages}`；包装层只在 `matched && cleanupFailures===0` 时确认 released，否则写 `released:false` + 失败数/错误摘要；缺失 run 不确认 | 复审副本：`promptRunRemoved=true`、`fakeControlStillHeld=true`、`releaseReceipt.released=false`、`cleanupFailures=1`、`leaseReleased=false` | 真实手机租约时序 |
| H01-B | `validation-service.mjs` `beginControlAcquisition`/`confirmControlRelease`、Harmony 控制派发前 | 每次控制调用记录 `acquisitionId + runId + ownerId`，并立即把旧释放状态置为失效；释放回执必须匹配当前 `runId/acquisitionId`，迟到旧回执被拒绝且不覆盖新状态 | 复审副本：首次成功 `released=true`；下一回复重新控制后 `nextCallLeaseReleased=false`、`sameReceiptTime=false`；删旧回执不能复活 | 真实跨回合（宿主调度） |
| H02 | `index.mjs` capture-file/log-export、`service.mjs` `captureExport/ensureCaptureExportable`、`Readable.toWeb` 字节桥 | 仅这两个全历史只读 GET 使用读作用域；按记录真实所属 session 解析归档；导出无记录返回 404 而不是空 200；生成器输出统一转 Buffer，避免 Web stream 字符串块错误 | 复审副本：`logs=200/1`、`capture-file=200` 且正文含 fixture 行、`log-export=200` 234 bytes 且含同一行；当前会话访问外会话 404 | 浏览器下载/UI |

### 16.1 测试数口径更正

- 三个回归文件实测 **28 项**：review 11 + rereview 12 + third 5（此前“35 项”为误把检查项当测试数）。
- 加入第四轮 `fourth-review-regressions.test.mjs` 4 项后，回归共 **32 项**；全量允许测试为
  **119 项 = E2E 109 + Harmony/配对 10**，其中 **118 passed / 0 failed / 1 skipped**（skip 为受限 Windows junction 用例）。
- 本文档旧章节中的“二轮 109/1”“三轮 115/114/1”均标注为当轮历史数据，不是当前总数。

### 16.2 仍未验证

真实宿主 PromptRun 调度与租约时序、真实设备控制释放、浏览器下载/导出与全部会话 UI、构建/安装、干净依赖安装、10 万行压力、真实软链攻击。本轮未新增投屏阻断项，`observe_screen` 对兼容帧的影响仍按源码事实列为待验。
