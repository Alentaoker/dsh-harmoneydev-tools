# dshVerify 第三轮独立源码复审

**后续状态**：G01–G07修正后复核见 [第四轮复审](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/docs/E2E_RUNNER_REMOVAL_FOURTH_REVIEW_20261018.md)。多数项已关闭，仅剩 H01 控制释放回执和 H02 全部会话下载/导出链路；下面保留第三轮原始事实。

审查对象：F01–F12 修正交付后的 Harmony 0.5.0-rc.8 / dshVerify 0.5.0-rc.1 源码。

## 结论

**尚有 2 项 P1、5 项 P2，先完成这些源码收尾，再交给用户构建。**上一轮的多数反例已修正，不能继续沿用“12 项全部未修”的旧结论；但 F05/F06/F11/F12 等生产调用链尚未全部闭合。

独立重跑 `review-regressions.test.mjs` 与 `rereview-regressions.test.mjs`，**23/23 通过**，其中包含实际 JSX parser-only 检查。额外用真实 Harmony `index.ts` 包装层、真实 validation bridge/service 和临时 fake host/device 复现下列剩余问题。

包装层通过 Node 原生 TS 加载与进程内模块钩子隔离设备、宿主和路由依赖，**未做源码转换、生成、打包或构建**。没有改业务源码、安装依赖、修改 lib/profile/用户数据、刷新/重启宿主或操作手机。结果不冒充实际宿主显示/模型视觉/手机验收。

- [独立组合夹具](E:/DeepSeekHarness/Verification/e2e-review-20261018/third-review-20261018.mjs)
- [独立结果](E:/DeepSeekHarness/Verification/e2e-review-20261018/source-evidence-third-review.json)

此前 initial/rereview/fixed 证据均未覆盖；initial SHA256 仍为 `C370A68686A74700550D54EEC11AAF57AB58851FC003C85AB61D1764F4C894E7`。

## 已确认的修正

- F01 的 JSX 语法错误消失；F02 的 attempt/standalone 下载及 NDJSON 导出通过真实注册路由夹具。
- 生命周期事件不能再自证 pass；工具 schema 已接受对象证据引用；callId 查询不再受前 500 条限制。
- 实际保存图片的宽高、缩放与 hash 已能正确记录；下面 G05 是桥漏传字段，不否认存储端修正。
- finish 的结论拒绝已先于 abort；普通未完成调用会保留占位，晚回执后有收敛路径。下面 G02 针对重复回执及真实 lease 的剩余问题。
- 延迟 lookup 的采集启动能被取消；运行中 capture 关联已明确拒绝；begin 提交失败回滚、取消持久化、standalone 重启恢复和 evidence gap 保存均已有针对修正。
- 流式分页/单遍导出与同任务 related 已接入；下面 G03/G04 是分页边界与跨会话归属残留。

## G01 · P1：受保护图片在宿主附件转换之后被追加，返回格式不兼容

**位置**：[Harmony index.ts:93](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:93)、[Harmony index.ts:97](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:97)，对照同文件 [harnessContent:29](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:29) 和 [pi-sdk.ts:28](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/pi-sdk.ts:28)。

代码先 `harnessContent(observed.content)` 转成宿主内容块，之后直接 `content.push({type:'image',data,mimeType})`。新增图片绕过已有的 `ctx.attachments.saveImage → {type:'image',attachment}` 适配，output.render 又直接返回 value.content。

**真实包装层夹具**：图像块 keys 为 `type/data/mimeType`，imageHasAttachment=false，saveImageCalls=0；并非只测 humanObserve 的内部 `_evidence`。已证明返回形状与本插件现有 Harness 适配契约不同。实际宿主如何报错/丢弃/展示本轮未运行，不能据此声称图片已进入当前模型。

**建议**：把同源已脱敏字节追加到待转换块后，统一调用 harnessContent；或显式 saveImage 并返回 attachment。保留 task/attempt/callId、文件 hash 与附件引用的关联；失败须为证据缺口，不能记录“模型已看到”。

**应补验证**：调用已注册 tool.execute，并检查 tool.output.render 的真实形状；fake attachments.saveImage 必须收到与落盘文件一致的受保护字节，返回块必须引用该附件。安装后再核验实际模型收图与 UI 展示。

## G02 · P1：重复回执会提前清空在途计数；cleanup 仍被误用为租约已释放

**位置**：[validation-service.mjs:542](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:542)、[validation-service.mjs:239](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:239)、[validation-service.mjs:461](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:461)、[presentation.mjs:66](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/presentation.mjs:66)。

inFlight 只是数值；每次 tool-end 都减一，没有按 callId 匹配并幂等结算。真实桥夹具：start A/B → end A 两次 → B 仍 open → cancel，**cleanup=released，下一轮同设备成功开始**。这不是“未知回执没有 context”的旧问题；两次都带原 context。观察路径先 bridge.end，再附件/内容处理，后处理抛错时 catch 又 end 一次，也存在正常错误路径产生重复尾回执的来源。

此外 `leaseCleanup:'harmony-managed'` 只是标签。没有实际 Harmony release 回执时仍以 inFlight=0 写 cleanup=released；presentation 把它映射成 leaseReleased=true，UI 显示“设备控制释放：已确认”。真实 Piora 控制 lease 在 [piora-harmony.ts:137](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/vendor/extensions/piora-harmony.ts:137) 注册 PromptRun 清理，通常等 turn-stopping 才 finishPromptRun。finish_validation 没有调用或读取该清理结果。

独立包装层 fixture 的 fake control 保留 lease 标志，finish 后没有释放通知，但 report.run.checks.leaseReleased=true。此项是协议夹具和生产源码调用链证据，未操作真实手机租约。

**建议**：以 attempt/callId 管理未完成集合，重复 end 不得影响其他 call；start 失败、end 落盘失败和二次结算也有明确协议。记录服务清理与实际 Harmony 控制清理分开；拿不到自己 lease 的明确释放回执，就不能给 leaseReleased=true。收敛/释放只针对本轮所有者，不整体清理他人设备或手动投屏。

**应补验证**：A/B 重复回执、未知 callId 的 end、保存附件失败后的第二次 end、晚回执与 cancel 并发；在真实包装层测试 register/finish/turn-stopping 的租约清理回执，未确认时保留占位或明确待确认。

## G03 · P2：响应预算导致日志分页漏行、重复，中文又会突破字节上限

**位置**：[validation-service.mjs:823](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:823)、[validation-service.mjs:833](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:833)。

预算放不下某一行就 continue，后面的短行仍可插进本页；nextOffset 却按返回条数推进，已不是原匹配序列的连续页。21 行不同正文的独立夹具：第一页 `[0..10,20]`，第二页 `[12..20]`，**第11行丢失，第20行重复**。

另用 JSON.stringify(value).length 当“字节”，中文每字符多字节，reportedResponseBytes=23309 时实际 JSON 响应 **67834 bytes**。返回的 captureId 等包装字段也没有进入计数。

**建议**：预算到达后冻结当前连续页，不再捞取后续短行；继续流扫只用于 total/filteredTotal。使用 UTF-8 Buffer.byteLength，并给完整响应预留元数据预算。不要把 nextOffset 改成任意跳过行的偏移来掩盖漏行。

**应补验证**：大小交替行跨页串接后与原匹配列表完全一致且无重复；中文/emoji/fullMessage/空匹配/多 capture 的字节预算。已有 ASCII 等长行用例不足以覆盖此问题。

## G04 · P2：全部会话仍用当前会话读外部轮次，列表和详情不一致

**位置**：[service.mjs:83](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:83)、[service.mjs:128](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:128)、[service.mjs:142](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:142)。

listAllTasks 已列出外会话任务，但遍历 listAttempts 仍传 options.sessionId；外会话已有的轮次被当成“没有轮次”，只显示 task/draft。task ID 的 report 分支也没有使用支持 scope.all 的 findTask；getLogs 仍按当前会话读取。

独立夹具：other 会话完成一轮，all 列表却显示其 draft task；点击列表的 task ID，**scope.all=true 仍“找不到该任务”**。手动传真实 attempt ID 的报告可以读取，但同样 scope.all 的日志报“找不到该验证目录”。现有 F12 测试仅创建外会话“无轮次任务”，因此没有覆盖。

**建议**：全部只读模式贯穿任务、轮次、详情、日志、证据/下载等消费者，按实际记录所属 session 定位；当前会话模式和写操作继续严格隔离。不能通过允许跨会话写入来修正只读列表。

**应补验证**：外会话有轮次及无轮次各一项，经列表提供的 ID 实际打开报告、日志和证据；同任务 related 切换；当前会话模式仍拒绝跨会话。

## G05 · P2：bridge 漏传捕获 generation/revision，证据仍变成 unknown

**位置**：[validation-bridge.ts:206](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:206)、[validation-bridge.ts:301](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:301)、[validation-service.mjs:618](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:618)。

humanObserve 的 `_evidence` 顶层带 generation/revision，但 bridge.end 调 saveEvidence 时没有传这两个字段；真实 manager.getDisplayGeometry 只返回 backend.displayGeometry，不会自动补上观察 revision。

独立真实 wrapper：观察 generation=7/revision=3，保存事件却 generation=null/revision=null、geometryId=`g-unknown-unknown`。DSH 的 F05 测试直接调用 saveEvidence，并没有验证桥的传参完整性。nativeWidth/实际 PNG 宽高已修好，这里是观察身份关联还未接全。

**建议/验证**：透传捕获瞬间的 generation/revision 和与之绑定的 geometry；不要另查“当前”几何冒充旧帧几何。wrapper→bridge→saveEvidence 端到端断言这些字段等于原 snapshot，并覆盖翻页使用保留观察、断连 generation 变化、转屏失配。

## G06 · P2：语义检查能引用树观察通过，但验证档案不保留实际树

**位置**：[validation-bridge.ts:314](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/validation-bridge.ts:314)、[validation-service.mjs:102](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:102)。

observe_page 把节点返回当前 AI；bridge 只持久 summary/quality/pagination，既没有保存该页受保护节点/树，也没有可解引用的宿主工具消息位置。trustedEvidenceEvent 仅凭 verification=observation-recorded 即允许该 callId 支持 pass。

独立真实 wrapper：模型输出里有节点 `g7-r3-n0`，引用 tree-only 的检查点成功 pass，但该 callId 的持久事件里没有该 ref/节点内容，evidence 数组也全空。**这不是“没有观察也 passed”**，而是本机验证档案缺少用于事后 review 的实际观察。当前聊天可能保留原工具内容，但当前 evidence 引用没有提供稳定回读链；不能把它当作档案已保存的树。

**建议/验证**：保存脱敏、有界的观察页/树及 hash/quality/capture identity，或实现确实可回读的宿主工具消息引用；语义检查可用树证据，不要求强制 PNG。新服务实例读取归档后应能展示原页、验证引用并区分视觉检查，不依赖仍在内存中的 manager snapshot。

## G07 · P2：采集完整性与轮次汇总仍互相矛盾

**位置**：[validation-service.mjs:224](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:224)。

汇总只看 record.status 是否 failed/interrupted/partial/empty/unconfirmed，没有读取 record.integrity。正常取消夹具：capture.status=cancelled、capture.integrity=interrupted，**attempt.logIntegrity 却 complete**。同理，closeError 产生 captured+integrity=partial 时，轮次也可能被汇总成 complete。

**建议/验证**：以真实完整性与落盘/关闭回执汇总，明确“用户指定结束边界”和“中断缺口”的政策，使 capture 与 attempt 不矛盾。若取消按中断记录，就不能直接按 status 省略它；若取消被设计为完整结束边界，则捕获自身也必须有相应证据与一致状态。补取消、写盘/close 失败、多个 capture 部分成功和已停止后 finish。

## 边界与后续

本轮未重跑全部109项、未干净安装/构建/宿主运行验收、未真机/10万行压力测试、未真实软链攻击。普通 observe_screen 仍经 manager.snapshot(includeTree=true)，其源码会中止兼容截图的在途 frame；observe_page 复用短时保留观察只覆盖部分情况。镜像实际影响还需独立 manager 行为或安装后真机确认，不能把“未拿控制租约”等同于“所有投屏通道都不会受影响”。本轮不新增一个未复现的投屏阻断项。

修正只限原授权源码/测试/文档及纯源码夹具，继续禁止 build/esbuild/npm test/pretest、安装依赖、修改 lib/profile、刷新/重启宿主、手机操作和发布。先修 G01/G02，再收尾 G03–G07；保留已经通过的23项，不删除正确的消费端断言来让测试变绿。完成后给逐项证据与未验边界，等待用户手动构建安装。
