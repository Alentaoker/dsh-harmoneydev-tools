# dshVerify 重构第二轮独立源码复审

**后续结论**：F01–F12 修正后的第三轮独立复审见 [E2E_RUNNER_REMOVAL_THIRD_REVIEW_20261018.md](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/docs/E2E_RUNNER_REMOVAL_THIRD_REVIEW_20261018.md)。下面保留第二轮的原始发现，不代表这些项仍全部未修。

2026-10-18；审查 DSH 12:34 交付后的源码，Harmony 0.5.0-rc.8 / dshVerify 0.5.0-rc.1。

## 结论与范围

**仍有阻断项，不能把 R01–R13 标记为全部关闭，也不建议现在编译安装。**本轮发现 F01–F12：8 项 P1、4 项 P2。F01 是确定的 JSX 语法错误；其余主要是实际生产调用链、失败路径与并发生命周期没有被现有测试覆盖。

已独立重跑 4 个明确不含编译/安装的测试文件，33/33 通过（含新增 review-regressions 的 11 项）。随后使用独立临时目录/fake manager 做了下面的反例。因此“现有测试通过”与“这些问题存在”并不矛盾。没有改业务源码、构建、调用 esbuild、安装依赖、重建 lib、修改 profile/用户数据、刷新/重启宿主或操作手机。

JSX 只用本机已安装 Playwright 附带 Babel 的 **babelParse** 解析；没有调用 babelTransform、代码生成或打包。该检查不需要把编译步骤提前。

证据均另存，未覆盖 DSH 自己的 fixed 结果和最初 review 证据：

- [独立反例脚本](E:/DeepSeekHarness/Verification/e2e-review-20261018/re-review-20261018.mjs)
- [独立反例结果](E:/DeepSeekHarness/Verification/e2e-review-20261018/source-evidence-rereview.json)
- [JSX 只解析脚本](E:/DeepSeekHarness/Verification/e2e-review-20261018/parse-jsx-only.cjs)
- [JSX 解析结果](E:/DeepSeekHarness/Verification/e2e-review-20261018/jsx-parse-rereview.json)

最初固定证据 SHA256 仍是 `C370A68686A74700550D54EEC11AAF57AB58851FC003C85AB61D1764F4C894E7`。

## F01 · P1：前端 JSX 无法解析

**位置**：[client.jsx:135](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/client.jsx:135)。

“报告文件与原始数据”的三元表达式中，validation 分支已经 `</>`，随后重复插入 tailGap 表达式和第二个 `</>`，导致 `:` 前不是合法表达式。完整原文件仅解析即报：`Unexpected token, expected ":" (135:368)`，`BABEL_PARSE_ERROR`。

**影响**：E2E 前端无法打包；同时依赖该源码的相关发布不能放行。只检查 mjs/TS 不能覆盖 JSX。

**修正/验证**：修复重复片段，给实际修改的 JSX 增加 parser-only 检查；不要只移除测试或把编译失败留给用户。完整构建仍等用户授权。

## F02 · P1：采集下载必定 404，导出不是合法 JSONL

**位置**：[service.mjs:145](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:145)、[service.mjs:155](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:155)、[index.mjs:89](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/index.mjs:89)、[client.jsx:144](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/client.jsx:144)。

`captureFilePath()` 调用 `validation.captureRecords()`，但这个函数只是 validation-service 的闭包，没有导出到 service 对象。实际调用注册好的 capture-file 路由，返回 **404 / `validation.captureRecords is not a function`**。即使简单导出，现有无 task/attempt 参数的 captureRecords 也只枚举 standalone，找不到报告中的 attempt capture。

`captureExport()` 每条后拼接的是字面反斜线 n（源码 `'\\n'`），不是换行。夹具仅 1 条日志，导出已不能 `JSON.parse`，结果 `exportHasNewline:false`。

**修正/验证**：提供明确按 session/task/attempt/captureId 定位的只读查询，UI 参数也一致；导出真实换行。应测试真实注册路由→Response、attempt/standalone 两种下载、两页以上导出逐行重解析和跨会话拒绝，不能只断言 entries 是数组。

## F03 · P1：人工观察仍不满足现有 Harmony 工具契约

**位置**：[validation-bridge.ts:98](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:98)、[validation-bridge.ts:106](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:106)、[piora-harmony.ts:1521](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/vendor/extensions/piora-harmony.ts:1521)、[device-manager.ts:1073](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/vendor/lib/harmony/device-manager.ts:1073)。

1. `humanObserve` 总是请求 `includeScreenshot:false`，然后又仅从该 snapshot 查 screenshot。真实 manager 会按这个参数去掉图像。因此 observe_screen **正常生产路径不会返回图片或图像证据**。现有 mock 无视参数，掩盖了问题。
2. 原 observe_page 的 cursor 是绑定保留观察的字符串，selector 是结构化对象。新实现把 cursor 当数字、selector 做 String 后子串匹配，并且每页都重新 snapshot。独立夹具 `{id:'n2'}` 返回空；不透明 cursor 回到 `[n0,n1]`，不能保证同一观察连续分页。`ancestors` 也未传入。
3. includeTree=true 的 manager.snapshot 仍调用 interruptLiveFrame；“没拿 lease”不能证明“不会打断投屏”。这里是源码调用链事实，未做真机效果测试。

**修正/验证**：复用原 observationPage/稳定观察游标与选择器契约，实现明确的无控制租约观察通道。不要仅把 false 改 true：当前第 164 行会直接把原截图发给模型，必须先完成与落盘一致的脱敏和完整 PNG/双尺寸检查，再输出。测试 mock 必须遵守 includeScreenshot 并覆盖真实形状的 cursor/selector/ancestors，补“观察不终止投屏”的 manager 级行为夹具；真机仍待装好后。

## F04 · P1：证据门仍可被无观察事件满足，工具 schema 又拒绝新引用格式

**位置**：[validation-service.mjs:84](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:84)、[validation-service.mjs:281](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:281)、[agent.mjs:27](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/agent.mjs:27)。

`{eventId}` 分支只检查事件存在，不检查是不是可信观察/结果证据。夹具没有设备观察、没有证据文件，仅引用 `attempt-started`（其 evidence=[]）即可把检查点记 pass，再 finish 得 **passed**。这是服务层反例；不能据此声称当前工具 schema 已允许 AI 这样调用。

当前工具 schema 的 evidence.items 又仍是 `{type:'string'}`，描述仅允许文件名，直接拒绝包装层指导 AI 使用的 `{callId}` / `{eventId}` 对象。语义检查的树证据也未持久化，不能靠“必须提供 PNG 名”取代可信语义证据。

**修正/验证**：统一 agent/schema/service/UI 的文件、事件、调用引用格式；按类型验证来源、轮次、质量及关联证据，拒绝 attempt-started、空 checkpoint 声明等循环自证；调用引用查找不能只扫前 500 条。保留语义/视觉/人工声明的区分，不能要求每个语义检查都必须 PNG。测试从已注册工具参数约束到真实服务，不要用 `store.writeEvidence(Buffer.from('png'))` 代表正常证据生产链。

## F05 · P1：AI 落盘证据不是模型实际看到的观察，缩放元数据也错误

**位置**：[Harmony index.ts:39](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:39)、[Harmony index.ts:133](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:133)、[validation-service.mjs:466](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:466)、[evidence.mjs:18](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/evidence.mjs:18)。

原 `original.execute()` 已观察一次；随后 wrapper 再 snapshot，并另查当前 geometry。保存的是第二次观察，最终发给模型的却是原 result.content，第二张图未进入模型输出。动态页面/转屏时，验证引用的图与模型看到的图可以不一致，且几何并非捕获瞬间绑定。

`maskedEvidence` 会缩成 720×1600 内，saveEvidence 却保留输入 displaySize、写 coordinateSpace=native。独立夹具原图 1000×2000，**实际落盘 720×1440，记录 displaySize 仍 1000×2000，geometryId=null**，也没有 generation/revision/scale。UI 按图批注/取点时无法可靠换算。

**修正/验证**：对一次实际观察建立同源树/图/质量/几何/附件与证据引用；模型看到的必须是引用的同一份受保护内容，避免为“补证据”另拍未呈现的图。记录实际输出尺寸、原生尺寸、比例、geometryId、generation/revision，转屏变更拒绝旧坐标。补静态同源 hash/尺寸夹具和动态两帧反例；真实视觉验收等安装后。

## F06 · P1：结束失败已经中止轮次；cleanup=pending 时却放开设备

**位置**：[validation-service.mjs:313](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:313)、[validation-service.mjs:334](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:334)、[validation-service.mjs:385](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:385)、[piora-harmony.ts:180](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/vendor/extensions/piora-harmony.ts:180)。

finish 先 abort 和 stop captures，再检查 overall=passed 是否允许。夹具未完成必验项→finish 被正确拒绝，但 attempt 仍 active、signal 却永久 aborted；后续正常设备调用无法继续。本应无副作用的参数/结论拒绝实际破坏了轮次。

另一个夹具：存在未结束 tool-start，cancel 返回 cleanup=pending，却立即移除 active/inFlight/deviceOwner；同设备新一轮立即可 begin，旧回执返回后 cleanup 仍永远 pending。终结也没有确认/释放该 attempt 对应的 Harmony PromptRun 租约；仅 `dispatched=0` 就标 released，仍不能证明真实控制权已释放。

**修正/验证**：在副作用前完成结论校验；closing/cancelling fence 与实际在途收敛、控制清理回执衔接；pending/uncertain 时保留设备占位，晚回执收敛后更新清理状态。只清自己的 lease，不能整体 dispose 设备。补 finish 拒绝后继续调用、旧调用没停时新轮拒绝、清理异常/超时和正常释放的集成夹具。

## F07 · P1：采集启动与结束有竞争；运行中采集关联后没有真正改绑

**位置**：[validation-service.mjs:505](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:505)、[validation-service.mjs:566](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:566)。

startCapture 只在 resolveLogTarget 前检查 attempt，后续异步没有 attempt 锁/终结复查。夹具把 applications 延迟，先 cancel 再放行，结果 **cancelled 轮次成功启动 capturing，capture-started 出现在 attempt-cancelled 后**。

attachCapture 允许运行中的 standalone，只移动目录/改 capture.json，没有更新内存 runtime 的 key/taskId/attemptId/directory、归档 writer 路径或 owner。夹具运行中关联→finish：轮次写 complete/released，但采集仍运行，持久状态仍 starting/collecting；随后 stop 又在旧 standalone 路径重建第二条同 ID 记录，写盘也因旧路径失败。

**修正/验证**：启动预约/提交必须与终结共享 admission fence，失败清理所有已启动资源；关联运行中采集要原子更新 writer/runtime/索引，或明确只允许已停止采集关联并返回正确提示，不能悄悄移动活跃 writer。补延迟 start 对 cancel/finish、活跃/已停 attach、旧文件 hash、finish 后无后台流与无重复索引。

## F08 · P1：begin 写事件失败后留下幽灵 active 与设备占位

**位置**：[validation-service.mjs:248](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:248)。

createAttempt→设置 active/deviceOwner→appendEvent→saveTask 之间没有失败回滚。独立夹具只注入 appendEvent 的“磁盘失败”，begin 向调用方抛错，但 activeAttemptExists=true，磁盘保留一个无正常开始事件的 active。重试会被自身占位阻止，调用方没有获得成功的上下文。

**修正/验证**：为失败的 begin 提供可恢复提交协议；撤销 runtime 预约、把已落盘 attempt 以明确失败/中断事实收尾，并保留原错误。不删除已提交证据，不在磁盘失败后伪称成功。补 create/append/task-handoff 各阶段失败注入、重试与同设备后续 begin。

## F09 · P2：取消/会话关闭未持久保存采集收尾，独立采集重启也未恢复

**位置**：[validation-service.mjs:370](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:370)、[validation-service.mjs:164](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:164)、[validation-service.mjs:622](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:622)。

cancel/disposeSession/dispose 调 capture.cancel 后未像 stopCapture/finish 一样写 capture.json。夹具取消后 attempt.cleanup=released，但 capture.json 仍 starting/collecting，persisted 缺失；重启将它误标为 interrupted，而不是用户已取消且日志已归档。recover 仅遍历 sessions/task，完全没有 standalone 重启恢复。

**修正/验证**：统一所有终止路径的持久收尾，汇总已关闭捕获与日志完整性；recover 同时处理 standalone，并优先尊重已提交的终止事实。补四种终止路径、关闭后重新读、宿主重启与异常停止。

## F10 · P2：证据保存失败的 gap 在桥里生成后丢失

**位置**：[validation-bridge.ts:250](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:250)、[validation-service.mjs:405](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:405)、[validation-store.mjs:206](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-store.mjs:206)、[Harmony index.ts:141](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:141)。

saveEvidence 失败被转为 `gaps`；但 recordToolEvent/store 不保存该字段，wrapper 也只读取 ended.recorded/evidence，不输出 ended.gaps。独立夹具坏 PNG：bridge.recorded=true、bridge.gaps 有真实失败，最终持久事件无 gaps、attempt.evidenceGaps=[]，正常工具输出也没有缺口提示。

**修正/验证**：将证据缺口持久写入原轮次，并在工具输出/报告展示，区分“工具事件已记录”与“证据未保存”。错误分支 validation.end 失败也应保留原动作错误并明确 trace gap；不能因工具动作已执行而重发。补非 PNG、脱敏失败、磁盘失败、派发错误与记录错误并存。

## F11 · P2：新日志分页丢失原有内存/响应预算

**位置**：[validation-service.mjs:583](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:583)、对照 [log-archive.mjs:67](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/log-archive.mjs:67)。

captureLogPage 对每个归档 readFile→split→把所有匹配对象放进 entries，最后才 slice；多个 128 MiB capture 可同时放大宿主内存。没有旧 archivedLogPage 的流式有界扫描、响应约 24 KB 预算、publicLog 截断、损坏行 warning、真实 total/filteredTotal 分离。正常分页/刷新/导出都反复全量解析，导出每页还重读全档。

独立小夹具 101 行，筛选命中 100，接口却 total=100（应101），单页100行响应 **818368 bytes**。不是 10 万行压力测试，但足以证明预算契约已丢。

**修正/验证**：复用原有界 archive 读取或共享流式实现，跨 capture 累计分页而非全部留内存；统计全量与命中分别计算，受损行显式标 gap，导出一次流扫。补长行、多 capture、损坏尾行、过滤 total 和响应预算夹具；真机性能另验。

## F12 · P2：“全部会话历史”和“同任务验证历史”仍没有接通

**位置**：[service.mjs:75](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:75)、[service.mjs:114](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:114)、[client.jsx:147](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/client.jsx:147)。

listPage 即使 options.all=true 也只遍历当前 session 的 validation tasks；新格式 report 仍恒 `related:[]`，UI“验证历史”只读 related，不用已有的 attempts 数据。独立两会话夹具：预期两项，all.total=1，外会话任务缺失；新格式 relatedCount=0。当前会话的基本列表已修好，不代表“全部”与同任务历史可用。

**修正/验证**：提供受控全部会话只读枚举，传递真实归属并在只读详情中正确解析；为同任务轮次提供可点击历史，别以 API 可单独读任务替代 UI 接线。补两会话、同任务多轮及等待下一次安装 revision 的列表/详情/ViewModel 契约。

## 文档与剩余核对

- 实施报告第 7 节仍说 USAGE 未改/独立视图未实现，第 11 节仍笼统声明本轮没运行 esbuild，而第 13 节承认误触转换。请整体重写成当前状态，避免不同段落互相否定。未授权编译/安装边界继续保留。
- R12 的 final evidence 防覆盖/软链检查确实比原版加强；但 readTask/readAttempt/list/readEvents 仍未做同等实际路径 containment，captureRecords 也直接信任目录/JSON。不能把证据文件的两项通过扩成所有存储读路径已完成安全核验。本轮未做真实软链攻击演练，需补隔离夹具再判完成。
- R06 的“迟到回执不串新轮次”、普通 begin 并发互斥、检查点并行不丢更新、capture 分目录、预算传入和事件分页显式字段确实已改，保留它们；不要回退既有工作台/日志导入/媒体/投屏功能来消除问题。
- 本轮只重跑上述 33 项，不冒称重新验证全部 97 项、依赖安装、真实宿主加载或手机效果。

## 交回 DSH 的修正顺序

先修 F01 解析与 F02 真实路由；再修 F03–F05 同源观察/证据契约；F06–F09 状态、并发和收尾；最后 F10–F12 缺口、预算与历史接线。用真实契约形状的 fake manager/注册工具与路由做组合检查，不以“内部函数返回了字段”替代消费者可用。

仍只允许源码、测试源码、文档及明确无编译副作用的纯源码夹具。禁止 build/esbuild/npm test/pretest、安装依赖、重建 lib、改变 profile、刷新/重启宿主、操作手机和发布。修正后逐项写真实位置/反例变为正确的结果/未验边界，等用户手动编译安装。
