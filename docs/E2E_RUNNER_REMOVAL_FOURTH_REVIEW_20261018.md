# dshVerify 第四轮源码复审：剩余两项

**收尾状态**：H01/H02 修正后的独立复核已关闭这两项，见 [源码审查收尾结论](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/docs/E2E_RUNNER_REMOVAL_SOURCE_ACCEPTANCE_20261018.md)。下文保留第四轮原始发现，不代表当前仍有这两个阻断。

审查 G01–G07 修正交付后的候选。**G01/G03/G05/G06/G07 可以关闭；G02 的重复回执与 G04 的 service 层读取已修正，但各有一段生产调用链仍未闭合。**本轮不增加新的功能要求。

独立重跑三个回归文件：**28/28 通过**（11+12+5），不是交付说明中的35项。本轮没有独立重跑全部115项。包含的 parser-only 检查通过；未构建、安装、修改 lib/profile/用户数据、刷新/重启宿主或操作手机。

为避免重复使用空实现的 mock，本轮使用真实 `Harmony index.ts`、真实 `prompt-run-registry.ts`、真实 validation bridge/service 与实际注册的 HTTP handler；只隔离设备、控制清理副作用及宿主边界。Node 原生 TS 加载，无源码转换/代码生成/打包。独立结果为：

- [聚焦组合夹具](E:/DeepSeekHarness/Verification/e2e-review-20261018/fourth-review-20261018.mjs)
- [独立结果](E:/DeepSeekHarness/Verification/e2e-review-20261018/source-evidence-fourth-review.json)

所有此前的 initial/third-review/fixed 证据保持原样。

## H01 · P1：控制释放回执仍可能假成功，且下一轮回复会沿用过期回执

**位置**：[Harmony index.ts:204](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:204)、[Harmony index.ts:213](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/src/index.ts:213)、[prompt-run-registry.ts:125](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-harmony/vendor/lib/prompt-run-registry.ts:125)、[validation-service.mjs:604](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/validation-service.mjs:604)、[presentation.mjs:66](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/presentation.mjs:66)。

### A. 实际清理失败也确认 released=true

turn-stopping/session-disposed 中 await finishPromptRun 后，直接 confirmControlRelease(released:true)。但真实 finishPromptRun 的合同是：先移除 run，再逐项执行 cleanup；异常会收集并打印，**函数不抛错、不返回成功/失败回执**。因此 await 正常返回不代表释放成功。

独立夹具通过真实 registry 注册会抛错的控制清理，再调用真实 wrapper 注册的 turn-stopping handler：

```
promptRunRemoved: true
fakeControlStillHeld: true
controlRelease.released: true
controlRelease.source: prompt-run-idle
viewClaimsLeaseReleased: true
```

真实 registry 同时输出1条 cleanup failure。这里的“控制仍持有”是 fake control，不是手机实测，但异常吞掉→包装层写成功的生产代码链已直接执行。

### B. 同一验证轮次的后续 AI 回复重新获取控制后，旧 released 仍有效

验证允许跨多次 AI 回复。第一次回复结束，真实 cleanup 成功，receipt=true；下一次回复调用控制动作并重新获得 lease，代码没有撤销/失效上一轮 controlRelease。独立夹具：

```
heldAfterFirstStop: false
fakeControlHeldAfterNextCall: true
nextCallLeaseReleased: true
sameReceiptTime: true
```

这不是“没创建回执”的旧问题，而是回执缺少实际清理结果与本次获取控制身份/时期的关联。现在 G02 测试直接调用 service.confirmControlRelease(true)，没有执行真实 registry 的失败清理，也没有覆盖跨回复重新获取。

**修正建议**：

- finishPromptRun 提供可判定的清理结果，或由控制拥有者提供实际释放回执；错误/超时/没有可匹配 run 时不要写 released=true。保留原动作/验证结论，单独记录清理失败或未确认。
- 回执与 task/attempt、owner/runId、控制获取身份关联；新的控制获取开始后，之前的“已释放”不能继续描述当前状态。迟到的旧释放回执也不能覆盖新控制获取状态。
- 只释放自己拥有的资源；不能用整体 manager.dispose 或释放他人投屏来换取“成功”。

**必须补的源夹具**：真实 wrapper→真实 registry 的成功/异常清理，session-disposed 同类路径，缺失 run，跨 AI 回复同一 attempt 的获取→释放→再获取；正常路径依然能确认释放。真实手机时序和界面留待安装后，不要求本轮越权运行。

## H02 · P2：全部会话日志能分页读，但实际下载404、导出空文件

**位置**：[index.mjs:84](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/index.mjs:84)、[index.mjs:91](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/index.mjs:91)、[service.mjs:163](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/service.mjs:163)、[client.jsx:116](E:/DeepSeekHarness/Sources/dsh-archive-fix-20261017/plugin/dsh-e2e/src/client.jsx:116)。

service.captureFilePath 已支持 scope.all，但实际 capture-file GET 仍用 requestScope(request, **true**)，把 scope.all 去掉。导出 GET 同样强制当前 session，并且 captureExport 仍只接受 sessionId，没有按 scope.all 解析记录实际所属会话。

用真实注册路由读取 other 会话的一条已落盘日志，相同 `sessionId=s&scope=all`、同 task/attempt/capture 参数：

| 调用 | 结果 |
|---|---|
| `/api/dsh-e2e/logs` | 200，entries=1 |
| `/api/dsh-e2e/validation/capture-file` | **404**，找不到该任务 |
| `/api/dsh-e2e/log-export` | **200，0 bytes**，应有的正文消失 |

UI 的下载/导出按钮正是这些 endpoint，不能以 service 方法直接传 all 成功代替 HTTP 消费端成功。现有 G04 测试只覆盖 service 方法；旧 F02 路由用例则只有当前会话场景。

**修正建议**：仅在有意支持全部历史的这些只读 GET 中保留 scope.all，再按记录真实所属 session 解析归档；导出采用与报告/日志分页同样的归属解析。原会话日志库的独立存储规则、所有写操作和当前会话模式继续隔离，不能顺手放宽其他接口。

**应补验证**：真实注册路由→完整 Response，覆盖当前/全部模式、attempt/standalone、下载/导出正文；全部模式访问外会话已保存文件成功，当前模式仍拒绝；无记录/损坏档案不得静默返回看似成功的空导出。

## 可以关闭的旧项与交付口径

- 图片已进入现有宿主 attachment 转换，且有落盘文件同源字节断言；G01关闭，实际宿主收图仍需安装验收。
- 重复 A 的 end 不再结算 B，普通在途结束后可收敛；保留该修正。H01仅针对实际控制释放回执。
- 日志连续分页不漏不重，UTF-8预算正确；G03关闭。
- 外会话列表/报告/分页日志/证据的 service 归属已修正；H02只针对遗漏的下载/导出 HTTP链。
- 观察 generation/revision 正确透传，树证据可跨服务实例回读，取消完整性一致；G05/G06/G07关闭。
- 三个回归文件本轮实际28项（11/12/5）。请核对总测试115/114/1的来源，按真实测试输出重写“35项，11+12+12”，不要将检查点数当成测试数。

仍只修源码、测试源码、文档及明确无编译副作用的隔离夹具。禁止 build/esbuild/npm test/pretest、安装依赖、重建lib、修改profile、刷新/重启宿主、手机操作和发布。完成H01/H02后提供逐项证据，再进入用户手动构建安装；本轮没有运行验收结论。
