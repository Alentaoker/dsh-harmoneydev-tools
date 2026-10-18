# dshVerify / dshE2E 重构独立源码 Review

日期：2026-10-18。审查对象：Harmony `0.5.0-rc.8` / dshVerify `0.5.0-rc.1` 未构建候选。

**第二轮复审入口**：DSH 12:34 交付后的独立检查见 [E2E_RUNNER_REMOVAL_REREVIEW_20261018.md](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/docs/E2E_RUNNER_REMOVAL_REREVIEW_20261018.md)。保留下面初次审查事实；不能仅按 R01–R13 的自述将其视为全部关闭。

## 结论

**当前候选未达到 Plan 的源码交付要求，先修正下面的问题再进入编译安装。**第三方执行底座的删除方向正确，但新记录、证据、日志和现有面板还没有形成可靠闭环。DSH 的“86 项通过”覆盖了一部分纯逻辑，不能证明这些集成契约已接通。

本轮：收集 DSH 实施及改名总结，独立读源码、对比实施前快照、在新建临时目录用 fake manager 做纯源码复现。没有构建、安装依赖、刷新/重启宿主、操作手机或修改业务源码及用户数据。

## 依据与已确认保留项

- 完整实施 Plan 已包含第 12 节改名要求：`dshVerify · 鸿蒙开发验证`；包 ID、storage、API 等兼容标识继续保留。
- 以 `E:\DeepSeekHarness\Backups\e2e-runner-removal-baseline-20261018-111016` 为实施前基线。不是仅比较 HEAD；该备份的 tracked patch 与 DSH 自建 `_e2e-baseline-20261018\tracked.patch` SHA256 相同。
- 26 个既有已跟踪差异片段保持相同，包括日志库/跨文件搜索、LogViewer/LogWorkbench、手动媒体删除/批注、视频与后端；原未跟踪组件中仅 Plan、成对预检脚本发生本轮修改。没有发现此前工作台优化被整体还原。但调用这些组件的新增接口存在以下回归。
- `engine/executor/rpc/verification.mjs` 已从源码删除，扫描未发现活跃第三方 runner import/内层执行循环。锁文件 68 个 packages 条目中没有 `node_modules/e2e`；本轮静态解析未发现已声明必需依赖缺条目，7z/yauzl/sharp/esbuild/react 及 Windows 原生产物条目存在。**尚未做 npm ci 和版本求解验证。**
- 后续构建清理废弃 `.mjs` 产物已有实现；本轮没运行，旧 lib 中的执行器仍属待授权构建时清理范围。

可复现材料：

- [纯源码复现脚本](E:/DeepSeekHarness/Verification/e2e-review-20261018/reproduce.mjs)
- [本轮审查原始复现结果（固定副本）](E:/DeepSeekHarness/Verification/e2e-review-20261018/source-evidence-initial-review.json)

投递时的 `source-evidence.json` 是同一份结果；复现脚本重跑会更新它，固定副本用于保留本次审查事实。请把修复后的结果另存，不覆盖固定副本。

脚本用真实 Node 24 直接 import 源码，不经 esbuild；设备后端完全是夹具。它证明下述服务契约问题，不作为手机效果或 UI 已运行的证据。修复后可调整/复用复现逻辑，但不能把错误输出改成“通过”的期望。

## R01 · P1：新轮次在当前会话列表被过滤，详情也不满足面板契约

**定位**：[presentation.mjs:42](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/presentation.mjs:42)、[records.mjs:19](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/records.mjs:19)、[service.mjs:88](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:88)、[client.jsx:122](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/client.jsx:122)。

- `validationRunView` 没有 `sessionId`，`paginate` 又用该字段过滤归属。复现：磁盘有 1 个 attempt，`listPage({sessionId:'s'})` 返回 `total:0`。
- `report()` 顶层 `run` 返回原始 attempt，缺面板读取的 `id/status/name/createdAt`；独立复现这三项均为 null。只给 `view` 增加字段没有解决顶层契约。新记录的 artifact URL、active/own 判断及 `get_report.passed` 都会用错字段。
- “取消验证”仍调用已退役 `/cancel`，“归档”仍调用已退役 `/archive`。新任务如果还没有 attempt，列表完全不读取它，因此“等待安装”的任务不可见。

**建议**：为新格式完整接入任务/轮次列表、详情和状态控制；若保留现有外壳，顶层也使用明确统一 ViewModel，保留真实 session 与 task/attempt ID。按 format 分流取消/历史只读操作，移除不可用入口。不能以“未构建”为由把源码阶段要求的任务概览/同任务历史继续留空。

**应补检查**：从 `createService`→`listPage/report`→面板消费字段的整链契约；无 attempt 任务可见、当前/全部会话、active/finished、取消、历史只读。不能只测 `validationReportView` 孤立对象。

## R02 · P1：新旧报告日志读取均破坏 LogViewer 契约

**定位**：[service.mjs:101](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:101)、[client.jsx:143](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/client.jsx:143)、[LogViewer.jsx:160](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/LogViewer.jsx:160)、[index.mjs:83](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/index.mjs:83)。

`getLogs` 的新格式只返回 attemptId/logIntegrity/note，旧格式只返回 path/bytes/note。复现两者均没有 entries；而 LogViewer 直接读取 `page.entries.length/slice`，因此报告的日志页会出错。新格式提示去 `list_log_files/get_file_logs` 读取，但 capture 归档既没登记进 logLibrary，这两个工具也不枚举 attempt/logs。

新格式的导出继续用旧 `exportLogStream(job)`，job 没有 directory；artifact 路由只允许 evidence 文件名，无法下载 `logs/app-logs.jsonl`。因此不能以“磁盘有文件”算日志功能保留。

**建议**：保留旧 `archivedLogPage` 的只读分页语义；为新格式提供同等受控分页/筛选/导出和 capture 索引。路径必须来源于同会话 task/attempt/capture 的受控归档，不能让前端直接传本机任意目录。

**应补检查**：有真实夹具日志的 legacy/new 两条完整 API→LogViewer 契约，跨页筛选、原文/导出、重启后读取与权限边界。

## R03 · P1：没有证据生产链，却能零证据甚至零检查点宣告通过

**定位**：[Harmony index.ts:99](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:99)、[validation-bridge.ts:127](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:127)、[validation-service.mjs:122](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:122)、[validation-service.mjs:153](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:153)。

- `writeEvidence`、`maskedEvidence`、几何转换函数没有生产路径调用。Harmony 把 PNG 转成当前聊天附件，写验证事件时却总是 `evidence:[]`；没有树/截图文件或宿主附件引用被登记到 attempt。`record_checkpoint.evidence` 只接受 attempt 下的文件名，正常工具路径无法生产这些文件。
- 复现：不调用一次设备工具，不提供 summary/evidence，直接 `recordCheckpoint(result:'pass')` 后 finish，得到 `semantic:'passed'`。
- `beginValidation(checkpoints:[])` 可覆盖任务已有必验项；复现任务原有 1 项，attempt 变 0 项，finish 仍 passed。

**建议**：建立真正的观察/回执/图像证据登记与引用链，保留内容、捕获时间、观察质量、原始/展示尺寸、geometryId 和关联 callId。按检查点类型验证证据：语义可引用可信事件/树，视觉须引用确实交给当前模型查看的图片，人工确认须单列来源；不要求所有检查都强制 PNG。拒绝空必验集合、重复检查点 ID、绕过既定必验项的覆盖。缺证据应是 unverified。

**应补检查**：从 Harmony 返回观察到 checkpoint 引用再到 UI 阅读；零证据 pass、空集合覆盖、跨轮引用、损坏证据/不完整树以及新 revision 不沿用旧结果。

## R04 · P1：重启采集会覆盖旧日志，独立采集停止后也无法找回

**定位**：[validation-service.mjs:295](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:295)、[validation-service.mjs:317](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:317)、[log-archive.mjs:30](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/log-archive.mjs:30)。

同 attempt 的所有 capture 都写同一个 `logs/app-logs.jsonl`，而 createLogArchive 用 `writeFile(file,'')` 初始化。复现：首轮日志含 `first-only-evidence`，stop 后再次 start/stop，该证据消失；最终 finish 还把已停止的归档算成 `not-collected`，因为 stop 从 captures Map 删除了归属信息。

不绑定 attempt 的独立 capture 根本没有持久目录。复现其 stop 返回 retained=1、persisted=0、integrity=complete，Map 被删除且 root 没有文件；采集过的内容失去读取入口，也没有实现注释所说的“稍后关联任务”。

**建议**：每个 captureId 有唯一、不覆盖的归档与持久化描述；把 active 连接与持久 capture 索引分开。attempt 汇总包括已停止采集；独立采集也可重启后读取并受控关联。禁止重启采集截断旧证据。

**应补检查**：同 attempt 两轮和同时两条采集、stop 后 finish、独立采集停止/重启/后关联，旧文件 hash 不变。

## R05 · P1：取消/结束没有取消在途控制，也无依据写 cleanup=released

**定位**：[validation-service.mjs:185](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:185)、[validation-service.mjs:213](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:213)、[Harmony index.ts:88](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:88)。

新服务 finish/cancel 只停止日志、改元数据/Map，没有调用 Harmony 的控制清理，也没有 attempt AbortController/在途调用注册。Harmony 执行只使用 `exec.signal`，与验证取消无关联；原 PromptRun 清理要到回合停止才触发。停止日志的异常还被吞掉，随后固定写 `cleanup:'released'`。

因此服务层取消不能保证在途动作停下，finish 的“已释放”也不是执行回执。这是源码调用链确认，未做手机取消测试。

**建议**：引入 active→closing/cancelling→terminal 的 admission fence；关联仅属于本 attempt 的在途调用与可取消信号，等待真实清理回执后保存 released/failed/uncertain。只能释放自己的资源，不能对整个设备/他人镜像粗暴清理。未知提交的动作先留 unknown 并观察，不重发。

**应补检查**：延迟 fake 控制动作、排队动作、取消与 finish 并发、清理拒绝/超时，验证取消后不再派发且 cleanup 不假成功。

## R06 · P1：迟到回执串到下一轮；派发后记录失败被静默忽略

**定位**：[validation-bridge.ts:116](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:116)、[validation-service.mjs:235](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:235)、[Harmony index.ts:94](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:94)。

begin/end 没有固定 taskId/attemptId/revision，`recordHostEvent` 每次按 session 查“当前 active”。复现 A 开始 old-call→取消 A→开始 B→old-call 返回，B 的 events 出现 A 的 tool-end，却没有对应 tool-start。

bridge.end 遇写入失败返回 recorded:false，包装层忽略返回值，仍用 `!!decision.attempt` 声称 validationRecorded:true。工具可能已派发但记录丢失，既没有证据缺口，也没警告当前 AI。

**建议**：begin 返回不可变调用上下文，end 必须携带并写回原轮次；关闭轮次的晚回执只按受限尾事件记录，不归入新轮次。记录失败须保留原动作结果和提交不确定性，显式报告 trace-gap，不能返回假 recorded:true 或重发设备动作。

**应补检查**：真实桥+服务组合，而非只存 events 数组的 mock；跨轮迟到、会话关闭、派发后磁盘失败、原错误与记录错误同时发生。

## R07 · P1：单写者进程内也有状态竞争，重复 begin 和检查点更新不可靠

**定位**：[validation-service.mjs:115](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:115)、[validation-service.mjs:167](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:167)、[validation-store.mjs:157](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-store.mjs:157)。

复现并行两次 begin，同一 session/serial 两次都 fulfilled，磁盘存在 2 个 active attempt。校验与 Map 占位之间有 await，没有原子预约。同设备不同会话也存在同类窗口。

并行记录 cp1/cp2 时，先在锁外读取整份 checkpoints，再在 updateAttempt 锁内整体覆盖。复现 events 有两项 fail，但最终 metadata 中一项退回 unverified。finish/cancel 同样在锁外检查 execution；服务没有整体状态事务。串行 append events 不等于事务安全，也不是跨进程问题才会出现。

**建议**：同会话+设备 begin 原子预约、失败回滚，明确幂等请求 ID；对 attempt 的校验、单检查点修改、终结和事件提交采用一致串行/事务边界，锁内以最新值修改。terminal 后不得被晚请求重新写入业务状态。

**应补检查**：Promise.all begin、不同会话争设备、并行 cp、cp 对 finish/cancel、磁盘错误和幂等重试，不只顺序调用。

## R08 · P1：设备绑定和终结状态没有约束采集/实际 Harmony 调用

**定位**：[validation-service.mjs:285](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:285)、[Harmony index.ts:39](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:39)、[task-routing.ts:55](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/task-routing.ts:55)。

startCapture 只读取 attempt，不校验 active、输入 serial 与 attempt.device.serial，也不检查 active owner。复现 SN1 的 finished attempt 接受 SN2 新采集，并追加 capture-started/stopped 到 attempt-finished 之后。

Harmony 路由只看 operation/mode；人工观察优先接受显式 input.serial，普通 AI 执行原样转交 input，均未把实际 serial 与验证绑定核对。两台在线设备时可能把另一台的结果记入本轮。

**建议**：在任何设备 I/O 前固定/校验 serial、session、attempt 状态；有上下文时省略 serial 则用本轮绑定值，显式不一致拒绝。独立采集走单独明确归属契约；终结 attempt 不得再启动采集。

**应补检查**：两设备 fake manager，错误 serial 不得被调用；终结/跨会话采集、同设备控制冲突、普通无 attempt 调用继续兼容。

## R09 · P1：人工观察绕过证据保护与分页契约，几何元数据也未接入

**定位**：[validation-bridge.ts:62](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:62)、[Harmony index.ts:63](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:63)、[evidence.mjs:2](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/evidence.mjs:2)、[piora-harmony.ts:1520](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/vendor/extensions/piora-harmony.ts:1520)。

humanObserve 直接 JSON.stringify 全部 raw nodes，并把任意 screenshot.data 当 PNG 输出，不检查完整树、脱敏、像素/尺寸。夹具复现：treeStatus=unavailable/scopeComplete=false 且包含密码节点，明文被返回，非 PNG 数据也被作为图片返回。旧 maskedEvidence 的校验/脱敏在新路径根本没有调用。

此外包装层把 observe_page 的 cursor/limit/selector/region 丢掉，每次重新 snapshot 返回全树；take_screenshot 也不再兑现原有“保存 PNG”的语义。工具名相同但契约已变化。新 geometryRecord 等函数未用于生产，humanObserve 缺 geometryId/展示尺寸映射与原观察绑定，不能声称坐标证据链已完成。

**建议**：复用可信且有界的观察/分页逻辑，仅解除不必要的控制租约，保留输入参数、原工具语义、手机文本不可信标记。证据路径执行既有脱敏与尺寸/质量要求；不完整时展示缺口，不能直接输出保护未完成的图片。关联捕获瞬间的几何，避免转屏后另查尺寸配给旧截图。

**应补检查**：人工分页第二页、limit/region、密码节点、不完整树/损坏图、大小限额、截图保存、转屏/旧 geometry/ref、无租约观察。

## R10 · P2：报告在 200 个事件后静默截断，UI 不显示结构化事实

**定位**：[service.mjs:91](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:91)、[presentation.mjs:87](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/presentation.mjs:87)、[client.jsx:138](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/client.jsx:138)。

复现落盘 203 个事件，报告只含 200，返回中不带 hasMore/total/后续游标。真正的 finish/checkpoint 可以被藏掉。新 timeline 转旧 steps 时丢掉详情，`events:[]`，UI 不读取 view.validation，无法展开原始结果、派发/效果、几何/证据。步骤处又用 `metrics?.modelCalls || 0` 把未采集显示成 0，普通开始/检查点事件还被标 running。

**建议**：兑现原计划四类最小视图与事件分页/原始数据阅读，保留终结和缺口提示；未采集指标统一显示未采集。append 当前每次重读/解析全 events 文件，是累计 O(n²) 读量；应维护可恢复序号/有界索引，但不为优化重写已提交事实。

**应补检查**：>500 事件跨页无漏重、末尾 finish 可见、结构化错误/证据可展开、未知指标不假零。

## R11 · P2：CaptureSession 的定时器、容量和完整性状态不正确

**定位**：[capture-session.mjs:108](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/capture-session.mjs:108)、[capture-session.mjs:120](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/capture-session.mjs:120)、[validation-service.mjs:303](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:303)。

- 每次 start 的 setInterval 只 unref，stop/cancel 不清除；闭包持续引用 manager/sink/日志数组。unref 不是释放资源。
- 工具允许传 logMaxBytes，但服务未使用，反而用 memoryBytes 当磁盘上限。复现请求 32 MiB，归档 maxBytes 为 2 MiB。
- 完整性在 archive.close 前计算，最后写盘失败可能未反映；unconfirmed/停止超时也可能被标 complete。finish 吞 stop 错误后按过窄条件算 complete，cleanup 又总 released。

**建议**：保存并明确清理 timer/监听器；区分磁盘/内存/队列预算；归档真正收尾后汇总 complete/partial/interrupted/unconfirmed，保留错误。已停止采集的汇总与 R04 一起持久化。

**应补检查**：多次 start/stop 不留 timer/闭包，容量参数边界、最后一批落盘失败、流未就绪、关闭超时。

## R12 · P2：证据路径防护只校验父目录，文件软链和读路径仍可越界

**定位**：[validation-store.mjs:60](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-store.mjs:60)、[validation-store.mjs:100](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-store.mjs:100)、[validation-store.mjs:233](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-store.mjs:233)。

evidencePath realpath 的是 directory，再 stat(directory/name)；stat 会跟随文件软链，返回的 path 没校验最终 realpath。writeEvidence 同样会跟随已有同名链接。readTask/readAttempt/list/recover 路径也不复用 contained；contained 对 rel='..' 缺少单独拒绝（只检查 '..'+sep）。

这是源码路径审查发现，未在真实 storage 建立软链或做攻击演练。

**建议**：校验最终读写目标/父链实际路径，拒绝文件软链/越界父链并覆盖 '..' 等于父级的情况。读接口不应为“找文件”顺便创建目录；新增证据文件也避免覆盖已有事实。参考已有 legacy artifact 路由对最终文件 realpath 的检查。

**应补检查**：隔离夹具里的目录 junction/文件 symlink、缺文件读取、已有文件覆盖、跨会话引用；不使用用户目录作样本。

## R13 · P2：回滚命令不能还原当前工作树，改名后的使用指南仍教已删除入口

**定位**：[实施报告:37](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/docs/E2E_RUNNER_REMOVAL_IMPLEMENTATION_20261018.md:37)、[USAGE.md:7](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/USAGE.md:7)、[AI_UPGRADE.md:5](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/docs/AI_UPGRADE.md:5)。

回滚直接 `git apply` 实施前 `git diff HEAD`，但当前树已经包含该差异，既不能撤销本次改动，也不会恢复本次删除的旧 runner 文件。只读执行 `git apply --check` 返回 exit 1、多个 patch does not apply。复制旧 untracked 也不会移走新 validation 模块，容易产生混合版本。

USAGE 只改了标题，正文仍要求 e2e_phone.run、replay/retry/cancel、动作/模型预算和独立视觉模型；AI_UPGRADE 仍说“后台任务/测试接口继续可用”、候选旧版本和 pairedSources=10，与本轮 24 相矛盾。这些是当前操作指南，不是应该保留的历史报告。实施报告第 7 节也承认 UI/使用说明未完成，却指导直接进入安装。

**建议**：先保存当前候选，在独立空目录基于准确 HEAD 应用实施前 patch 并复制其 untracked，得到完整基线，再按明确 manifest 提供恢复步骤；在临时目录验证，不对当前树执行破坏性还原。源码、产物和数据分别说明，新增 validation 数据原位保留。重写当前指南为真实新契约；历史记录只加历史标识，不改写过去事实。安装步骤显式使用已核对的 Node24 和既有 profile/link 激活流程。

**应补检查**：隔离目录可重建实施前基线、保留候选、新增/删除路径范围正确；文档里的每个当前工具与字段均在实际 schema 存在。

## 修正顺序与下一次交付

1. 先修 R04（数据覆盖）、R05–R09（生命周期、归属、并发与观察保护），建立 R03 的真实证据链。
2. 再把 R01/R02/R10 的任务/报告/日志/分页 UI 契约补完整，不用只改文案或再造简化日志页。
3. 补齐 R11/R12、文档和可执行回滚步骤。保留已经正确的框架删除、现有工作台能力和 dshVerify 显示名/兼容键。
4. 请逐项在本文件对应编号回应：修正位置、行为测试、实际检查结果、仍待编译/安装/真机的项；更新实施报告，不继续称未完成项为已完成。
5. 仍只做源码、测试源码和文档修正。禁止 npm test/pretest/esbuild/build、安装依赖、重建 lib、刷新/重启宿主、编辑运行 profile、操作手机、发布及改用户数据。明确没有这些副作用的纯源码夹具测试可执行。

本 Review 未证明：干净依赖安装、JSX/TypeScript 构建、宿主可选服务加载顺序、真实 UI/手机、投屏性能或回滚实机演练。修复后需再次源码复查，再由用户决定编译安装和真机验收。
