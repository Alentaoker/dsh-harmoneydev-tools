# 计划：dsh-log-analysis 正式改名并去除 AI、Harmony 视频按设备复用、界面精简（初稿 v1，供 Codex 实施，之后复审）

本会话没有写文件和退出计划模式的工具，所以计划正文直接写在这里。下文标注说明：【实测】出自 diagnosis-baseline.md 和两张截图；【源码】是已读源码中的事实；【待验】必须实测后才能定论，不能当作已复现。

---

## 0. 背景与结论

**用户的硬要求**
- dshVerify 的真实 package 名改为 `dsh-log-analysis`。
- 去掉 AI 操控手机和验证框架。
- 日志功能全部保留：导入、编码识别、压缩包解析、1/2/8 GiB 预算、Notepad++ 式跨文件查找、直接删除和跨会话管理、加入对话（只追加草稿，不发送）。
- Harmony 的手工投屏和操作、截图批注、实时日志保留。
- 同会话切工具、A→B→A 切会话，都不能重启编码器。
- 日志、截图批注的"加入对话"仍按当前会话隔离。
- 旧数据不自动搬迁、不删除。
- 不靠调大超时来掩盖故障。

**基线【实测】**
- 首个 video 请求到 HTTP 200 用了 9708 ms。这段时间包含初始 JPEG，不是 H.264 首帧。
- `firstPictureMs=2535`、`firstEncodedPictureMs=11266` 都从 videoStarted 起算，不能和 HTTP 时间相减。
- 同会话切到 Verify：video 请求 `ERR_ABORTED`，原生状态变为 closed，并记录了 cleanupPids。
- 另一会话打开 Harmony：先显示"没有设备"，HTTP 200 约 3492 ms。
- 唤醒后重连约 2603 ms；熄屏返回 409 不算慢启动缺陷。
- hidumper 屏幕探测 176–193 ms。

**根因【源码】**
1. 视频由每个会话侧栏里的面板实例持有。`useHarmonyLiveFrame` 主 effect 依赖 active、generation、online、visibilityEpoch，cleanup 时直接 abort。HarmonyPanel 自己持有 profile、devices、selectedSerial，重新挂载就会重新拉取，"没有设备"就是这样出现的。
2. `shared-video.ts` 里，最后一个订阅主动 cancel 时走 `op:'close'`，会立即 `broker.stop()`；只有异常断开才有 750 ms 的 idle。也就是说，HTTP 一断开基本就等于停掉编码器。
3. 原生冷启动是串行的：锁屏检查、孤儿进程和冲突检测的 `ps`、prepareAutomation（连接 Hypium）、发送 .so、start-daemon、轮询 PID、fport、wakeup、RPC 就绪、抓初始 JPEG。每一段各花多少时间没有记录【待验】。

**结论**
1. 只靠"后端 warm 保留 + 重放"满足不了切会话的要求，见 §3.1。必须新增"每个窗口、按设备"的前端视频 Hub 作为主机制，后端 linger 作为补充。
2. 身份按真实改名处理：package、bundle、service、HTTP、客户端模块、侧栏 tab、跳转事件全部改名。
   - 源码目录本轮保留 `plugin/dsh-e2e`。它不是用户可见身份，保留可以避免破坏现有链接和回滚来源；名称到目录的映射集中在一处。
   - 存储根保留 `storages/dshE2E`。已经加入对话的草稿里存有这里的绝对路径，所以不搬也不删。
3. 去 AI 的范围：
   - 删除 e2e_phone 工具和提示词、validation-v1、旧历史 UI 和 API。
   - 删除 Harmony 的验证桥、任务路由、`harmony_control` 工具和提示词。
   - 两个插件的 `cordis.patch.yml` 只保留 host 插入，不再重声明 4 个 preset。
4. 现有故障超时和预算数值全部不动（45 s 建连、15 s 首帧、2 s 关键帧等待、200 ms 和 1.5 MB 积压、10 s 原生首图、12 s RPC、40 s broker、8 s HDC），并用测试钉住。新增的只有资源保持策略和分段计时。

---

## 1. 范围

**移除**
- dsh-e2e：
  - `agent.mjs`（e2e_phone 和系统提示）、`tool-contract`、validation-service/store、capture-session（AI 采集）、evidence、legacy、records、presentation、snapshot。
  - 所有 `/validation/*`、`/status`、`/runs`、`/report`、`/logs`（旧）、`/log-export`、`/capture-file`、`/artifact`、`/cancel`、`/archive` 路由。
  - UI 里的"更多工具 → 开发验证"整套界面。
- Harmony：
  - `src/agent.ts`、`src/task-routing.ts`、`src/validation-bridge.ts`。
  - `index.ts` 里的工具包装、PromptRun 钩子、`reflect.provide('dshHarmony')`（没有消费者了）。
  - 设置里的"视觉模型"整组，以及"AI 正在录屏"文案。

**保留（只改前缀或文案）**
- 日志库全部模块：log-library/management/storage/worker/package/rar/encoding/parser/limits/query/archive、session-search*、log-search-menu，以及全部日志 JSX。
- Harmony 的设备连接（USB/TCP）、投屏、手工操作、唤醒、截图录屏和媒体历史、批注加入对话、实时日志和保存到会话、会话日志面板。
- "更多工具"里的文件、数据库、命令、测试、语音、后台任务、诊断、校准，本轮不动。如果"测试（scenarios）"也要移除，需另行确认。

---

## 2. 身份与兼容契约

| 维度 | 旧 | 新 |
|---|---|---|
| package / bundle / profile 依赖 | dsh-e2e 0.5.0-rc.3 | **dsh-log-analysis 0.6.0-rc.1**（Harmony 同步为 0.6.0-rc.1；本机候选，不发布） |
| 源码目录 | plugin/dsh-e2e | 保留；新增 `scripts/plugins.mjs` 集中映射 `{name:'dsh-log-analysis', directory:'plugin/dsh-e2e', legacyNames:['dsh-e2e']}` |
| 服务端 name / host 插入 id | dshE2E / dshE2E-host | dshLogAnalysis / dshLogAnalysis-host |
| exports | `.`、`./agent`、`./client` | 删除 `./agent`（Harmony 也删除） |
| HTTP | `/api/dsh-e2e/log-library/*` 加验证类路由 | 只有 `/api/dsh-log-analysis/log-library/*`，不注册旧前缀别名 |
| capabilities | `protocolVersion:2, plugin:'dshE2E'` | `protocolVersion:2, plugin:'dshLogAnalysis'`，Harmony 同时校验两者 |
| 客户端模块 id / style id | dsh-e2e / dsh-e2e-style | dsh-log-analysis / dsh-log-analysis-style |
| 侧栏 tab id / kind / 标题 | dsh-e2e / dshE2E / dshVerify | dsh-log-analysis / dshLogAnalysis / **日志分析**（提示文字为 dsh-log-analysis） |
| 跳转键 / 事件 | `dshE2E:open-log:<sid>` / `dshE2E:open-logs` | `dshLogAnalysis:open-log:<sid>` / `dshLogAnalysis:open-logs` |
| Harmony 构建别名 | `@dsh-e2e-workbench(-css)` | `@dsh-log-workbench(-css)`；sibling 的 `package.json` 名不是 dsh-log-analysis 时直接报错 |
| 存储根 | `<DSH_HOME>/storages/dshE2E` | 不变，用常量 `LEGACY_STORAGE_DIR='dshE2E'` 表示 |
| 内部 CSS 作用域 | `.de2e` | 本轮不改（非身份，P3） |
| 搜索历史键 | `dsh-session-file-search-v2:<sid>` | 不变，用户历史保留 |

**存储策略**
- `log-library/` 照常读写，包括 sessions、trash、preferences 和待归属旧日志。
- `validation-v1/`、`workflows/`、`validation-v1/standalone/` 没有任何读写方，也不再运行 `recover()`。旧版启动时会改写 attempt 和 capture 状态，新版不再改写。
- 全部会话管理只在 `log-library/{sessions,trash}` 内操作，这一点用测试固定。

**API 策略**
- 不保留旧前缀，原因有二：避免新旧服务同时读写同一个库；不成对的版本应该明确报错，而不是静默工作。
- 新 Harmony 配旧插件：会话保存报"需要 dsh-log-analysis"。
- 旧 Harmony 配新插件：旧的嵌入工作台调用旧路径，会报"日志库不可用"。
- 安装脚本只会成对安装。

---

## 3. 视频方案

### 3.1 "后端 warm 保留 + 重放"能做到什么

**能做到**
- 在 linger 窗口内，任何 HTTP 级的重新订阅都复用同一个编码器。包括：刷新页面、重同步后重连、desktop 和 web 跨进程、Hub 释放后的快速回访。这样可以省掉冷启动：基线首开 9.7 s，编码器被销毁后再开 3.5 s。
- 重放内容是 config、最近一个 IDR 和之后的增量帧。即使画面静止，也能立刻拿到真实的 H.264。新编码器在静止画面上要 11.3 s 才出第一个编码帧，之前只能靠 JPEG 过渡。

**做不到**
1. 面板照样会 abort。新面板实例要重新拉 profile 和设备（"没有设备"闪现）、新建 HTTP 请求（其中 hidumper 约 180 ms）、新建 VideoDecoder、解码重放的 GOP，几何校验通过后才能点击。用户看到的仍然是一次重连。
2. 服务端只能按时间猜测用户意图。B 停留超过 linger 就会冷启动；把服务端 linger 调长，等于用超时掩盖问题，而且服务端不知道窗口是否还在用。
3. 重放是一次突发，会触发 200 ms 积压预算，进入等待关键帧状态，2 s 后强制重连。在 warm attach 下这可能形成循环【推断】，必须给追帧阶段加豁免。

**结论**：要满足切会话不重连，必须做前端设备级共享。Hub 是主机制；后端 linger 15 s 加显式退役作为补充，负责刷新、重同步和跨窗口场景。

### 3.2 前端设备级 Hub（新增）

**位置与归属**
- 新文件 `vendor/lib/harmony/media/live-video-hub.ts`，作为浏览器模块单例。Harmony 的 `client.js` 每个窗口只加载一次，跨会话面板共享。
- 以 serial 为键。每个条目包含：1 条 `/api/harmony/video` 流、1 个解码器、状态机（现有 connect、pollFrames、probe、backlog、geometry 逻辑基本原样迁入）、GOP 缓存、lastFrame 位图、订阅者集合。
- Hub 里**不存 sessionId**。会话归属仍由面板的 LogSessionContext 和 MediaSessionContext 决定。

**订阅接口**
- `useHarmonyLiveFrame` 改成薄适配层，返回值形状不变：`acquire(serial)` 返回 handle，handle 提供 `attachCanvas`、`setVisible(active && !document.hidden)`、`release()`、`refresh()`。

**可见与隐藏**
- 有可见订阅者时：解码并绘制到所有可见 canvas，刷新几何，按策略探测屏幕，必要时轮询兼容截图。
- 没有可见订阅者时（文档隐藏、tab 切走、面板卸载）：只读流并维护 GOP 缓存。关闭解码器，不绘制，不做几何、截图、屏幕轮询，**不 abort**。

**恢复显示**
- 先把 lastFrame 同步画到新的 canvas 上，同一帧内即可显示。
- 再用追帧模式解码 GOP 缓存：在队列降到 ≤2 或满 3 s 之前，豁免 200 ms 的年龄预算；8 MiB 的字节预算仍然生效。
- 然后切回实时；几何立即刷新一次。

**generation 变化**
- 可见时重连一次（后端 warm，代价小）。
- 不可见时只标记，等下次可见再处理。

**屏幕不可用（熄屏或锁屏）**
- 保持现有的断流行为。
- 同时调用 `POST /api/harmony/video {action:'retire'}`：只有在没有其它订阅者时才让 broker 立即退役，和旧行为一致。唤醒后冷启动约 2.6 s，用户已接受。

**设备状态共享**
- 新文件 `vendor/lib/harmony/device-store-client.ts`，单例，通过 `useSyncExternalStore` 提供 profile、devices、managerState、selectedSerial。
- 新面板直接用缓存渲染。首次加载显示"读取中"，而不是"没有设备"。
- 轮询和 SSE 每个窗口一份，只在有可见面板时运行。

### 3.3 生命周期与资源上限

| 层 | 资源 | 上限或策略 |
|---|---|---|
| 浏览器 Hub | 条目数（每窗口） | ≤2，按设备计；第 3 个按 LRU 释放不可见的条目 |
| | 流 / 解码器 | 每条目 1 条流；解码器只在可见时存在，最多 1 个 |
| | GOP 缓存 | ≤8 MiB（与服务端重放上限一致）；超限时丢弃并标记需要关键帧 |
| | lastFrame | 1 张位图（约宽×高×4，636×1430 ≈ 3.6 MB，最坏 1272×2800 ≈ 14 MB） |
| | 无可见订阅时的保持 | **10 分钟**后释放；`pagehide` 时立即释放 |
| 服务端 broker | 最后一个订阅 detach 后 | linger **15 s**；显式 stop、dispose、后端重建（改画质或 HDC）、设备离线、retire 时立即退役 |
| | 重放 / 每订阅队列 / 订阅数 | 8 MiB / 16 MiB / 16（现值不变） |
| 设备 | 编码器 | 每台设备 1 个（不变）；画面静止时不出帧 |

10 分钟和 15 s 是新定义的资源策略，不是故障超时。写进文档，用测试钉住，在诊断里可见。

### 3.4 首连慢和断线：先计时取证，不调超时

**新增计时（只加测量，不改行为）**
- 原生 `stats.phases`：resource、locks、orphan、conflict、prepareAutomation、send、daemonStart、pid、forward、wakeup、rpcReady、firstPreview、firstEncoded。另记 `endReason` 和 `endStage`。
- GET video 响应头：
  - `X-Harmony-Video-Timing`：onlineDevice、screenshotTails、requireUnlocked、locate/attach、ack，只含数字。
  - `X-Harmony-Video-Attach`：`warm` 或 `cold`。
- Hub 指标：openCount、warm/cold 次数、resumeMs（从可见到首次绘制）、最近 20 次断流原因、gopCacheBytes、lastFrameBytes。
- device-manager：generation 变化环形记录（最多 20 条，含原因）。
- 以上全部在诊断抽屉显示，提供"复制诊断"，内容不含设备数据和日志。

**断线假设（只对有证据的动手）【待验】**

| 编号 | 假设 | 证据 |
|---|---|---|
| H1 | gRPC keepalive（10 s/3 s）在静止画面下触发设备端 ping 策略（如 GOAWAY/too_many_pings） | 原生 `stats.error` 和静止时长 |
| H2 | 每 15 s 一次的 `ps -ef` 健康检查在 HDC 繁忙时失败 | `endStage=health` 及并发操作记录 |
| H3 | `hdc list` 状态抖动导致 generation 变化 | generation 环形记录 |
| H4 | 积压 → 等待关键帧 → 重连形成循环 | resyncs、dropped 计数 |
| H5 | 熄屏探测触发断流 | `endReason=screen-unusable` |

**首连优化候选（数据驱动）**
- C1：若 prepareAutomation 是最大的一段，就把它和不依赖它的步骤并行，但必须在 start-daemon 之前完成。不能挪到开流之后，因为 Hypium 连接可能重启 uitest。
- C2（P2）：本地 broker 在推流时，warm attach 跳过 `requireUnlockedScreen`（约 180 ms）。

---

## 4. 分阶段实施与文件清单

**提交顺序**：c1 日志插件 → c2 Harmony 去 AI → c3 脚本和安装 → c4 后端视频 → c5 Hub 和 store → c6 UI → c7 文档。每个提交单独通过测试。

**明早时间不够时的取舍**
- 必须完成：P0–P4、P6，以及 P5 里删除验证入口和压缩头部两项。
- 如果 Hub 没有通过 M2/M3：退回只交付后端 linger 加重放（体验为 warm 重连），并在验收说明里如实写明"切换无重连"未达成。

**P0 安全准备（不改产品）**
1. 只读确认两个 profile 里 dsh-harmony 和 dsh-e2e 的实际来源，用 verify-install 输出的 directory，或基线备份里的 profile package.json；不读日志和凭据。
   - 如果指向本工作树，实现、构建和测试都改在新 worktree 里进行（例如 `E:\DeepSeekHarness\Sources\dsh-log-analysis-20261105`）。原因是 `npm test` 的 pretest 会重建 lib。
   - 本工作树和它已构建的 lib 原样保留，作为回滚来源。
2. 只读执行 `dsh.cmd plugin --help`，确认有没有正式的卸载命令。
3. 用全新的临时 DSH_HOME 演练"旧配对安装 → 迁移 → 冷启动 → 回滚"；时间不够时至少完成第 1–2 步。
4. 记录改动前的测试数：Harmony 151，Verify 155（154 通过、1 跳过），scripts 7。

**P1 日志插件（目录 `plugin/dsh-e2e`）**
- `package.json`：name、version、description、exports（删除 `./agent`）；依赖本轮不动，避免需要联网改锁。
- `package-lock.json`：只改根 name 和 version，两处。
- `scripts/build.mjs`：
  - patch 只写 host insert，不再读取 Harmony 的 patch。
  - ModuleLoader id 和 style id 改为新名。
  - 保留现有的 lib 过期文件清理。
- `src/index.mjs`：
  - `name='dshLogAnalysis'`，`inject=['connection','sessions']`。
  - 只注册 `/api/dsh-log-analysis/log-library/*`：现有全部日志路由，加上 export 和 source 两个流式路由。
  - 删除 dshHarmony 的路由注册、`session/disposed` 中的验证处理、`reflect.provide`。
  - `requestScope` 的报错文案改为"请在会话中打开日志分析"。
- `src/service.mjs` 改为 `createLogService(ctx, root=dataRoot)`，里面只有 logLibrary 和 dispose，并定义 `LEGACY_STORAGE_DIR`。
- `src/logs.mjs` 只保留 `redactLog`。
- `src/log-client.mjs` 改前缀和报错文案。
- `src/client.jsx` 重写：注册 tab，加 header 入口"日志分析"；面板只放 LogWorkbench；消费新的跳转键；"实时日志"跳转到 Harmony；删除 TestForm、记录、报告、draftText。
- 删除 src 下 10 个文件：agent、tool-contract、validation-service、validation-store、capture-session、evidence、legacy、records、presentation、snapshot。
- 插件目录内的 README、USAGE、INSTALLATION、AI_INSTALLATION 重写。

**P2 Harmony 去 AI**
- 删除 `src/agent.ts`、`src/task-routing.ts`、`src/validation-bridge.ts`。
- `src/index.ts` 只保留 dataRoot、setHost、routes 和 dispose。
- `package.json`：exports 去掉 `./agent`；version 改为 0.6.0-rc.1；description 不再写"测试工作台/AI"。
- `scripts/build.mjs`：
  - entry 只保留 `index.ts`。
  - patch 只写 host insert；`compat/*.patch.yml` 保留但不再参与构建。
  - 改别名，并校验 sibling 的 package 名。
- `src/client.tsx`：新的跳转键和 tab kind，删除 `onGuideAgent` 和 guide。
- `src/log-session.ts`：改前缀，校验 `plugin==='dshLogAnalysis'`。
- 以下文件改文案或前缀：
  - `src/session-log-workbench-unpaired.tsx/.css`
  - `src/log-search-menu-unpaired.ts`
  - `vendor/components/workspace/LogApplicationPicker.tsx`
  - `vendor/components/workspace/harmony/SessionLogPane.tsx`
  - `vendor/components/workspace/harmony/LogWorkbenchShell.tsx`
- `HarmonyPanel.tsx`：
  - 删除"视觉模型"组和"AI 正在录屏"。
  - 保存设置时不改写 `vision` 配置：原样回传，或按 config 路由的合并语义不发送这个字段；加测试。
- Harmony 文档 4 份。
- vendor 文件的改动按现有 `patches/phone-automation.json` / UPSTREAM 来源记录的做法登记（如果有校验）。

**P3 后端视频**
- `vendor/lib/harmony/shared-video.ts`：
  - 拆分两种结束方式：流 `cancel` 时走 `detach`，发 `op:'detach'`，不等待清理；显式 `close()` 时，若是最后一个订阅就停止并等待清理，与现在相同。
  - `lingerMs` 默认 15000，测试仍可用 `idleMs` 注入。
  - 新增导出 `retireSharedVideo(serial)`（只在无订阅时停止）、`retireAllSharedVideo()`、`sharedVideoState(serial)`。
- `device-manager.ts`：`stopDeviceResources`（非仅输入的情况）和 `dispose` 时调用 retire；打 openVideoStream 计时；加 generation 环形记录。
- `hdc-backend.ts`：`dispose` 时调用 `retireAll`（防止改画质或 HDC 后复用旧编码器）；打计时；C2 放到 P2 优先级。
- `deveco-native-video.ts`：记录 phases 和 endReason/endStage。
- `vendor/app/api/harmony/video/route.ts`：
  - POST 新增 `action:'retire'`，沿用现有的鉴权、Content-Type 和体积限制。
  - GET 增加两个计时响应头。
- `types.ts`：连接对象增加可选的 timing 和 attach 字段。

**P4 前端 Hub**
- 新建 `live-video-hub.ts`、`device-store-client.ts`。
- `vendor/hooks/useHarmonyLiveFrame.ts` 改成薄适配层。
- `HarmonyPanel.tsx`：改用 store，删除面板本地的轮询和 profile 状态；区分"读取中"和"没有设备"。
- `src/client.tsx`：插件 dispose 时调用 `hub.releaseAll()`。

**P5 UI**
- 日志插件：`LogWorkbench.jsx`、`LogViewer.jsx`、`client.css`、`client.jsx`。
- Harmony：`HarmonyPanel.tsx/.module.css`、`LogWorkbenchShell.tsx`。
- `HarmonyLogViewer.tsx` 工具栏放到 P2 优先级。

**P6 脚本和文档**
- 新建 `scripts/plugins.mjs`。
- 修改：`preflight.mjs`、`verify-install.mjs`、`register-bundles.mjs`（及其测试）、`install.ps1`、`paired-sources.mjs`（及其测试）、`prepare-release.mjs`（及其测试）、`package-release.ps1`（包名改为 `dsh-harmony-<v>-log-analysis-<v>-windows-source`，本轮不执行发布）、`.github/workflows/checks.yml` 里的步骤名。
- paired 文件清单删除 presentation 和各验证模块，增加全部日志服务端模块，并新增"已删除模块必须不存在"的清单。
- 根目录 README、CHANGELOG；docs 下的 UPGRADE、AI_UPGRADE、AI_INSTALLATION、INSTALLATION、LOG_WORKBENCH、LIVE_VIEW_PHASES。
- 新增 `docs/LOG_ANALYSIS_UPGRADE_20261105.md`，写迁移、回滚和验收记录。
- 带日期的历史文档不改。

---

## 5. UI 方案

**日志分析面板（截图基线：标题区两行、工具行带说明文字、文件行重复显示文件名、打开文件后正文起点在 >300 px 处）**

删除：
- "dshVerify"大标题和"会话日志 · 版本"副标题（版本挪到 ⋯ 菜单底部）。
- "当前会话 · 按导入时间排序"。
- "无需连接手机，阅读日志不会调用模型。"
- "更多管理"里的说明句。
- 空列表里的容量长句：挪到"导入日志"按钮的提示文字里；超限时的报错仍给出精确上限。
- "更多工具 → 开发验证"。

工具栏合并成一行：
- [导入日志] 加编码下拉、[查找]（原"跨文件筛选"，快捷键 Ctrl+Shift+F）、[实时日志]、[⋯]。
- ⋯ 菜单里放：全部会话管理、刷新、清空当前会话、待归属旧日志、hilogtool 路径、版本。

文件列表：
- 搜索、来源、排序放在同一行，全选框放在最左。
- 只有选中至少一项时才显示"已选 N · 加入对话 · 删除"这一行。
- 每个文件行：名称一行，元信息一行（"N 条 · X MiB"）。来源不是"导入"时才显示小标签；`relativePath` 与名称不同时才显示。

打开文件后：
- 文件头一行："名称 · 条数 · 编码"，右侧 [加入对话] [⋯]（专注阅读、下载原文件、返回列表）。"解析/原文"计数移到"范围与完整性"里。
- LogViewer 两行：
  - 第 1 行：应用、关键词、级别、Aa、.*、查找、⋯（TAG/DOMAIN/PID/TID/时间、历史、列/行距、导出、重置）。
  - 第 2 行：计数、每页、翻页、完整性提示。
- 快捷键、Notepad++ 式查找交互、删除行为、加入对话行为都不变。

**Harmony 面板（基于源码，没有截图基线）**
- 头部：设备下拉加状态点。序列号、USB、"响应 N ms"挪到提示文字和诊断里。按钮全部用图标：唤醒、刷新、设置、最大化。
- 画面状态：直播中不显示文字；只在连接中、等待解锁、占用、重连时显示一行短状态。初始预览只显示"预览"小标签。分辨率挪到诊断里。
- 设置：删除各组副标题、"通常只需设置一次"和视觉模型组。
- 底栏用短状态。工具抽屉标题"日志"不带版本号；内页签改为"实时 / 会话"。
- 视图记忆：设备/日志视图和日志布局按窗口记住，切会话时保持不变。第一次打开默认设备视图，因为明早验收以操控为主。

**UI 验收**
- 在 679×956 下截 4 张图：日志列表、打开文件、Harmony 直播、Harmony 日志。
- 正文首行距面板顶部 ≤200 px。
- 默认视图里没有灰色说明句；报错、进度和完整性警告除外。
- 构建产物里不再包含被删除的文案（做静态检查）。

---

## 6. 安装登记、迁移与回滚

**迁移步骤**（desktop 和 web 分别执行，全程宿主完全退出，从新的长期来源目录安装）

1. `install.ps1 -PlanOnly`。新版 preflight 会检查：名称和目录映射、锁文件身份、paired 文件、两个插件都没有 `/agent`、patch 只有 insert；报告旧 `dsh-e2e` 登记；扫描 profile 的 `cordis.yml` 和 `cordis.patch.yml` 里是否引用 `dsh-e2e` 或 `dsh-harmony/agent`。**发现引用就停止并给出说明，不自动修改。**
2. 按 Harmony、日志插件的顺序构建。
3. `plugin --profile X add <new>\plugin\dsh-harmony`，再 `add <new>\plugin\dsh-e2e`（此时目录里的包已是 dsh-log-analysis）。
4. 移除旧的 dsh-e2e：
   - 有 CLI 卸载命令就用它。
   - 没有的话，`register-bundles` 只把它从 bundles 里移出，并保留备份。
   - **不手改 pnpm 锁。**
   - 冷启动后如果旧插件仍被加载，停止并回报【待验】。
5. `register-bundles`：加入两个新 bundle，移出旧 bundle，其它字段保留。
6. `verify-install` 检查：
   - 新名字已登记，dsh-e2e 不在 bundles 中。
   - 日志插件的 lib 有 log-worker、storage、package、parser、client 和 patch，没有 `lib/agent.mjs`。
   - Harmony 没有 `lib/agent.js`，有 worker。
7. 使用同一个 DSH_HOME 冷启动。

**升级指南需写明**
- 包名为 dsh-log-analysis，界面名为"日志分析"。
- 源码目录沿用历史名称 `plugin/dsh-e2e`，存储沿用历史名称 `storages/dshE2E`，都没有搬迁。
- 旧会话里已经打开的 dshVerify 标签会消失，需要从会话标题栏"日志分析"重新打开。

**回滚**
1. 宿主退出。
2. 从未改动的旧来源目录执行 `plugin add` 两个旧插件，然后移除 dsh-log-analysis（用 CLI 或从 bundles 移出），并只按备份恢复本次涉及的字段。
3. 用旧来源里的 verify-install 校验，然后冷启动。

数据两个方向都兼容：日志格式没变；旧版本能看到的验证历史原样还在。已经被直接删除的日志副本，回滚也恢复不了（与现行说明一致）。

备份位置：
- `E:\DeepSeekHarness\Backups\log-analysis-20261104-234711`
- 安装脚本自动生成的备份。

---

## 7. 测试与验收

**7.1 自动化测试**

日志插件：
- 保留并改前缀：session-log-library、session-search、session-search-client、search-history、log-management、log-packages、log-workbench。
- 重写：client-lifecycle。
- 删除：validation-service、validation-store、task-routing、integration、legacy-readonly、records、logs（其中 redactLog 的用例迁走）。
- 拆分：review、rereview、third、fourth（保留其中日志库相关的用例）。
- 新增：
  - `identity.test`：包名、exports、patch 只有 insert、ModuleLoader id、`LEGACY_STORAGE_DIR`。
  - `routes-contract.test`：路由集合精确匹配，没有任何 `/api/dsh-e2e`，没有注册工具。
  - `legacy-data-untouched.test`：用夹具执行导入、删除、跨会话删除和 dispose 后，`validation-v1/` 和 `workflows/` 的文件树哈希不变。
  - `ui-strings.test`：被删文案不存在，关键控件仍在。

Harmony：
- 删除 validation-routing。
- 更新：log-workbench-shell、harness-adapter（不再注册工具）、browser-video-lifecycle（隐藏时不再 abort；初始隐藏时仍不开流）、shared-video（覆盖 detach 后 linger 复用、重放、linger 到期只关闭一次并删除记录、显式 close 立即停、retire 和 dispose、跨进程不受影响）、native-video（记录 phases）。
- 新增：
  - `live-video-hub.test`：A→B→A 整个过程只有 1 次请求、1 个解码器，lastFrame 同步绘制；10 分钟后精确释放一次；隐藏时不解码，缓存不超上限；恢复时追帧不触发重同步；generation 变化时只重连一次；`pagehide` 释放；第 3 台设备按 LRU 淘汰；会话 B 的加入对话只进入 B。
  - `device-store-client.test`：新面板不闪"没有设备"；每个窗口只有一个轮询。
  - `video-route-timing.test`。
  - `timeouts-pinned.test`：§0 列出的数值全部不变。

脚本：paired-sources、register-bundles、preflight（能检测旧登记和 cordis 引用）、prepare-release。

**测试台账（必须提交）**：逐个文件列出删除、更新、新增；每个删除的测试写明名称和理由；日志旧回归 47 项和视频旧回归 30 项中，凡是契约改变的，逐条写出新契约。

**7.2 静态检查**
- 在 src、scripts、tests、vendor（components、hooks、lib/harmony）和当前文档里搜索 `dshVerify|e2e_phone|/api/dsh-e2e|dshE2E|dsh-e2e/agent|dsh-harmony/agent|harmony_control`。只允许出现在：存储常量、迁移代码中的 `legacyNames`、升级指南的迁移段落、带日期的历史文档和 CHANGELOG 历史、`plugin/dsh-e2e` 路径字符串。
- 构建产物不含被删文案，也没有 agent 入口。
- 本轮 diff 里不出现任何故障超时数值的改动。

**7.3 本机真机验收**

| 编号 | 场景 | 通过标准 |
|---|---|---|
| M1 | 冷启动首开 | 功能正常；提交分段计时（不新增时间门槛，用于决定 C1/C2） |
| M2 | 同会话切工具 ×5 | 0 次新 video 请求；原生 extension 和 startedAt 不变，没有新的 cleanupPids；resumeMs p95 ≤300 ms【目标，待实测确认】；1 s 内可以点击 |
| M3 | A→B→A ×5（B 也开 Harmony）和 ×3（B 不开 Harmony，停留 10 s/60 s/5 min） | 全程同一个原生 extension；不闪"没有设备"；显示和输入同 M2；日志、截图批注的加入对话只进当前会话草稿 |
| M4 | 静止画面 3 分钟 | 不断流；断流时提交 endReason |
| M5 | 连续滚动 60 s | 没有"重连 → 重同步"循环（resyncs ≤1 次/分钟，否则提交证据） |
| M6 | 所有面板不可见超过 10 分钟 | 原生 closed；再打开时冷启动正常 |
| M7 | 熄屏、锁屏、唤醒 | 与旧版一致，记录耗时 |
| M8 | 手工操作 | 点按、拖动、按键、截图、录屏、批注后加入对话（只进草稿）都正常 |
| M9 | 日志功能 | TXT/ZIP/GZ/RAR 和 UTF-16/GB18030 导入；查找（普通、正则、F4、双击定位）；加入对话不发送；实时日志保存到会话；全部会话管理（只用一次性测试副本做删除）；旧日志数量和名称不变；`validation-v1` 和 `workflows` 前后元数据一致（文件数、总字节、最新 mtime，不读内容） |
| M10 | 去 AI | 插件列表没有 dsh-e2e；新会话可用工具里没有 harmony_control 和 e2e_phone，也没有对应的系统提示段（用宿主界面核对，不为此调用模型）；desktop 和 web 分别验证 |

---

## 8. 风险与待验

**P1**
- CLI 能不能卸载、只从 bundles 移出后宿主是否仍加载旧插件【待验】。不能确认时停止，不手改锁。
- profile 里的 cordis 引用了已删除的 agent，可能导致宿主无法加载；由 preflight 检测并停止。
- 在已登记的来源目录里构建会破坏当前安装；由 P0 规避。
- 去掉 preset 重声明后，如果宿主默认 preset 和 compat 副本不一致：退回"复刻 preset 但不含 agent"的写法【待验】。
- Hub 重构可能影响几何和输入（frameMatchesDevice、geometryId）、等待解锁、占用、兼容截图这些流程：逻辑尽量原样迁移，并覆盖 M8 测试。
- warm attach 的重放突发可能引起循环：加追帧豁免，并用测试覆盖。
- linger 和显式停止的语义（录屏、停止设备、改画质、DevEco 交接）：通过 retire 路径和测试保证。

**P2**
- H1–H5 的根因归属，只按证据修。
- C1/C2 由计时数据决定做不做。
- vision 配置在保存设置时要原样保留。
- LogViewer 是共用组件，同时影响 Harmony 的会话日志面板。
- 实时日志面板同样随面板重建：本轮不改，验收时有问题再另立项（P3）。

---

## 9. 复审时请 Codex 提交的材料

- 按 c1–c7 分开的 diff。
- 测试台账，以及三套测试的完整 TAP 输出。
- 静态检查输出。
- preflight 和 verify-install 的 JSON。
- 迁移日志：profile 改前改后的 bundles 和 dependencies，不含其它内容。
- 演练和回滚结果。
- M1–M10 指标 JSON（脱敏，不含请求头和正文）。
- 4 张 679×956 截图。
- 原生分段计时。
- A→B→A 请求轨迹。

复审会重点核对：身份是否处处一致；有没有任何会删除或改写旧数据的路径；detach 和 close 的语义；Hub 的计时器、解码器、位图是否都释放；会话隔离；超时数值是否未变；台账是否完整；迁移能否回退。
