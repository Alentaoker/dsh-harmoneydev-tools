# 日志分析与设备视频改版复审：第二轮（只读源码 + 复审包）

## 结论

- **身份、数据与安装层面没有发现阻断问题。**
  - 包名已真正改为 `dsh-log-analysis`，agent 和验证框架已去除，HTTP 只剩新前缀。
  - 日志与"加入对话"仍按会话隔离，旧存储没有搬动，旧验证数据不受影响。
  - 配对构建、安装登记、包清理与源码一致。
  - 测试退役只涉及验证和 agent 相关功能。
- **视频 Hub 有 2 个 P1，建议在最终验收前修复。** 都是显示和状态正确性问题，不涉及数据或安全，各自只需改几行。
- 其余为 P2/P3，见下文。
- **本轮不构成最终验收通过。** 以下都还没有实测：大录屏、冷启动多样本和偶发 RPC 失败、转屏、USB 恢复、窗口最小化超过 10 分钟、双窗口、长期资源占用，以及"测试"工具中语义步骤的可用性。

## 本轮确认正确的部分

- **身份**
  - 两个包都是 0.6.0-rc.1，exports 中没有 `./agent`，两份 patch 只有 host insert。
  - `/api/dsh-e2e` 只出现在测试的否定断言里。收藏组件已改用新前缀。`log-session.ts` 会校验 `plugin==='dshLogAnalysis'`。
- **会话隔离**
  - `requestScope` 不再接受 `scope=all`。
  - Harmony 与媒体的草稿都取自面板自身的 sessionId；Hub 和 device-events 不持有会话信息。
- **旧数据**
  - 存储目录固定为 `LEGACY_STORAGE_DIR='dshE2E'`，删除与管理只作用于 `log-library/`。
  - 旧标签只通过 `tabsIn`/`closeIn` 关闭 `kind==='dshE2E'` 的那一类。
- **视频后端**
  - 订阅端取消时走 detach，保留 15 秒；显式 close 时，若是最后一个订阅仍立即停止。
  - retire 只会停掉本进程内空闲的 broker，有活跃订阅时拒绝（测试 131–133 已覆盖）。
- **视频前端**
  - 隐藏时不解码、不做屏幕探测、不轮询截图和几何。
  - GOP 缓存上限 8 MiB，超出后请求新源。
  - 支持 10 分钟空闲回收、`pagehide` 回收，最多保留 2 台设备。
- **Hypium**
  - 只查看投屏时不会冷初始化语义驱动；活动视频中 `allowConnect=false` 保持不变。
  - 视频在线时，手工点击、拖动、按键走 HDC。实测两次 action 均 200，且没有 worker 进程。
- **录屏预览**
  - ≤16 MiB 的录屏使用有界 blob，字节上限同时按元数据和实际读取量检查。
  - 关闭时取消请求并回收 URL；超限时退回 range 播放（测试 111–114）。
- **共享事件流**：每个窗口只开一个 SSE，最后一个订阅退出即关闭（测试 20）。
- **日志回归 81 项**仍覆盖：分页、跨文件查找、编码、压缩包、1/2/8 GiB 预算、直接删除、跨会话拒读、草稿不自动发送。

---

## P1（最终验收前修复）

### P1-1　窗口长时间隐藏后，重新订阅仍被当成"不可见"，画面停在"连接中"

- **性质**：确认缺陷（代码路径可推出）。
- **位置**：`plugin/dsh-harmony/vendor/hooks/useHarmonyLiveFrame.ts:13-15`。相关代码在 `live-video-hub.tsx:39,45,47`，`useHarmonyLiveFrameEngine.ts:367`、`:559-562`。
- **触发条件**（两种）：
  1. Harmony 标签保持激活，窗口最小化或被遮挡超过 10 分钟，Hub 空闲销毁了该设备的条目。恢复可见时，`visibility()` 发现 `!isAlive()`，用**同一个** subscriber 重新订阅。但这个对象的 `visible` 早在 `setVisible(false)` 时已被置为 false。
  2. 面板在 `document.hidden` 状态下挂载，subscriber 的 `visible` 初值就是 false，首次显示时同样以 false 订阅。
- **影响**：新条目的 `visibleRef=false`，引擎只缓存不解码。`paint` 直接返回，看门狗也被跳过。面板会一直显示"视频流连接中"，没有自动恢复，直到用户切换标签或设备状态变化。
- **证据**：
  - Hub 测试第 35 项每次都新建 `visible:true` 的 subscriber，覆盖不到这条路径。
  - 实机"隐藏回收"样本是切走面板（走 release），不是窗口隐藏。
- **最小修正**：在 `visibility()` 重新订阅之前加一行 `subscriber.visible=true`，或每次重新订阅都新建 subscriber 对象。
- **补充验收**：
  - 自动测试：用真实 hook + Hub，覆盖"隐藏挂载 → 首次可见"和"可见 → 隐藏 → 推进 10 分钟 → 可见"两种情况。断言 `visibleRef=true`、创建了解码器、发生首次绘制、状态进入 live。
  - 实机：最小化超过 10 分钟后恢复。

### P1-2　离开期间手机锁屏，回来后旧画面最长约 30 秒显示为可点击

- **性质**：确认缺陷，正好落在 A→B→A 这条主路径上。
- **位置**：
  - `useHarmonyLiveFrameEngine.ts:659-676`：`renderChange` 可见分支只做重放，第 673 行重取几何后输入随即可用。
  - `:960-963`：隐藏期间屏幕探测循环停在 `waitProbe(30_000)`。
  - `HarmonyPanel.tsx:661-662`：几何有效且状态为 live 时即允许输入。
- **触发条件**：在 B 停留不到 10 分钟，期间手机按自身超时自动熄屏或锁屏，然后回到 A。
- **影响**：回来时显示的是熄屏前缓存的画面，状态为 live 且可以点击。最长约 30 秒后探测才发现锁屏并转入等待解锁；这期间的点按会发往锁屏状态的手机。旧版回来时会重新连接，立刻得到 409 并进入等待（基线已记录）。
- **最小修正**：在 `renderChange` 的可见分支调用 `wakeProbe?.()`，立即探测一次（实测 176–193 ms）。可选：探测结果返回前保持 `geometryId` 为空，不允许输入。
- **补充验收**：
  - 自动测试：隐藏期间屏幕状态返回 locked；恢复可见后应立即发出 screen-state 请求，返回后进入 waiting-unlock。
  - 实机：等手机自动锁屏后返回，记录从返回到出现"等待解锁"的耗时。

---

## P2

### P2-1　设置校验失败会停掉正在使用的视频；dispose 中途失败会跳过后续清理

- **性质**：确认缺陷。
- **位置**：
  - `vendor/lib/harmony/hdc-backend.ts:1167-1169`：`HdcBackend.dispose()` 首先调用 `retireAllSharedVideo()`。
  - 调用方：`device-manager.ts:2033`、`:2041`（候选 backend 校验失败或写配置失败时 dispose）、`hybrid-backend.ts:297-298`。
  - `shared-video.ts:425`：使用 `Promise.all`。
- **影响**：
  - 退役函数作用于整个进程。用户在设置中选了无效的 HDC 路径或投屏来源，候选 backend 被 dispose 时会停掉现用 backend 的全部 broker（包括其它窗口），Hub 随后冷启动，实测约 7 秒。
  - 任意一个 broker stop 失败都会让 dispose 直接抛错，之后关闭连接、丢弃录屏、清理截图临时目录这几步都被跳过。
- **修正**：
  - `HdcBackend.dispose` 不再调用全局退役。
  - 只在两处调用：`HarmonyDeviceManager.dispose()`，以及 `updateConfig` 成功替换旧 backend 之后（`device-manager.ts:2050` 附近）。
  - 改用 `allSettled`，失败记为清理不确定，但不中断其它清理。
- **补测**：候选校验失败时，现有视频不受影响；某个 broker stop 失败时，录屏 discard 仍会执行。

### P2-2　溢出或重同步时，retire 可能先于 detach 到达服务端

- **性质**：待核对的竞态。
- **位置**：`useHarmonyLiveFrameEngine.ts:881-888`，`shared-video.ts:424`，`video/route.ts:16`。
- **过程**：客户端中止旧流后立即 POST retire。如果服务端还没处理该连接的 detach，`idle()` 为 false，不会退役，客户端随即温连到同一个 broker。溢出场景下服务端的重放同样已失效，新订阅只能等关键帧；静止画面要靠 15 秒首帧看门狗和失败退避才能恢复。
- **修正**（二选一）：
  - retire 在约 1 秒内有界轮询 `idle()`。这只用于消除竞态，不改动任何故障超时。
  - 或者 GET video 返回 viewer id，retire 先精确摘除这个 viewer 再判断是否空闲。
  - 另一窗口仍在观看时维持"不退役"，并在诊断中显示"等待关键帧"。
- **补测**：构造"retire 先于 detach 到达"的夹具，验证只退役一次，后续连接是新源。

### P2-3　代际：更旧的代际也会重建引擎，帧的代际取自最后一个订阅者

- **性质**：代码确认；触发频率取决于宿主是否让非当前会话的面板保持挂载，待核对。
- **位置**：
  - `live-video-hub.tsx:40-42`：只判断代际是否不等，不区分新旧。
  - `useHarmonyLiveFrameEngine.ts:434`：视频帧使用 `options.generation`。
  - `useHarmonyLiveFrame.ts:13,19`：hook 把面板自己的代际盖在状态上。
  - `video/route.ts:43`：服务端已返回真实代际，但引擎没有读取。
- **影响**：A 面板挂着期间发生停止设备、USB 重插等代际变化，回到 A 时会先按旧代际重连一次，A 轮询拿到新代际后再重连一次。期间帧代际与设备不符，输入被禁用；hook 的覆盖又把这种不一致掩盖了。
- **修正**：
  - 视频帧代际以响应头 `X-Harmony-Generation` 为准。
  - 只有订阅代际高于引擎已确认的代际时才重建，较旧的只订阅不重建。
  - hook 不再覆盖状态自身的代际。
- **补测**：用 Hub + 真实引擎验证：gen2 运行时以 gen1 订阅不会重建；以 gen3 订阅只重建一次。

### P2-4　连接阶段切换可见性，会把 45 秒建连预算换成 15 秒

- **性质**：确认缺陷。
- **位置**：`useHarmonyLiveFrameEngine.ts:663-668`，对照 `:857`。
- **触发与影响**：冷启动还在等响应时（实测最长约 20 秒）面板先隐藏再显示，`armWatchdog` 会改用默认的 15 秒，可能在冷启动完成前就中止重来，反而拉长首连。
- **修正**：记录本次连接是否已收到响应。收到之前沿用剩余的 45 秒建连预算，收到之后才切换为 15 秒首帧预算。

### P2-5　视频在线时，"测试"工具的语义步骤失效

- **性质**：确认的行为变化，需要你来决定处理方式。
- **位置**：`hybrid-backend.ts:116-127`（观看时不再预热）、`:281-291`（视频中 `allowConnect=false`），`scenario-executor.ts:257-259`、`:321`。
- **影响**：
  - Hub 让视频在面板打开期间一直在线（离开后还保留最多 10 分钟），而语义驱动不能在视频中冷初始化。
  - 因此"更多工具 → 测试"里的选择器点击、输入文字、清空、等待空闲会失败或退化；旧版因为开流时预热，这些步骤可用。
  - 手工点击和拖动不受影响。
- **修正**（不建议恢复每次开流约 5 秒的预热），二选一：
  - 运行含语义步骤的测试前，提供"暂停投屏并准备驱动"：退役视频源 → 初始化驱动 → 自动恢复投屏。
  - 或者禁用这些步骤，并在测试面板给出一行原因。

### P2-6　没有视频时，第一次手工操作会冷初始化语义驱动（待验）

- **位置**：`hybrid-backend.ts:146-151`（`allowConnect=!video`）。
- **触发与影响**：在兼容截图模式、外部投屏占用或视频尚未建立时，第一次点击或拖动可能等待约 5 秒。旧版在开流时已预热，没有这段等待。
- **修正**：驱动尚未就绪时，手工指针和按键一律走 HDC（`allowConnect=false`）；只有输入文字和语义调用才冷初始化驱动。

### P2-7　detach 后可能留下半开连接

- **性质**：确认缺陷。
- **位置**：`shared-video.ts:383-387`（客户端 cancel 只调用 `socket.end`，背压暂停时不 resume），`:137-138`（服务端只 `end`）。
- **影响**：如果取消发生在背压暂停期间，两端 socket 及缓冲（服务端写队列最多 16 MiB）可能一直滞留；重同步、刷新等重连次数越多，累积越多。
- **修正**：
  - 客户端先 `resume()` 再 `end(line)`，写完后 `destroy()`。
  - 服务端 detach 后在写完时销毁 socket。

### P2-8　日志"加入对话"缺少会话存在校验

- **性质**：待核对，但建议直接改。
- **位置**：`plugin/dsh-e2e/src/client.jsx:13`。
- **风险**：`ctx.sessions.scope(sessionId)` 为空时会被直接传给 `conversation.input.for`。如果宿主对空值回退到当前会话，草稿可能写进别的会话。旧代码和 Harmony 侧都有这道校验。
- **修正**：先取 `session`，为空时报错"会话已关闭"，不调用 `input.for`。

### P2-9　Harmony 单独构建会直接失败

- **性质**：确认缺陷。
- **位置**：`plugin/dsh-harmony/scripts/build.mjs:35`。
- **问题**：没有同级 `plugin/dsh-e2e` 目录时直接抛 ENOENT，与上方注释和第 37 行起的 unpaired 回退相矛盾。
- **修正**：只在同级 `package.json` 存在时校验包名，否则走 unpaired 提示。

### P2-10　文档与当前行为不一致

- **性质**：确认。
- `docs/LOG_WORKBENCH.md`：
  - 第 5 行版本仍写 0.5.0-rc.3。
  - 第 14 行仍写"更多工具 → 开发验证"。
  - 第 60 行提到"开发验证/采集记录"。
  - 第 122 行仍写 e2e_phone 工具。
- `docs/PANEL.md:1-3`：仍描述已移除的 dshVerify 面板，应标为历史文档或撤出导航。
- `docs/LOG_ANALYSIS_UPGRADE_20261105.md:49`，回滚步骤缺两点：
  - `plugin remove` 不会清理 bundles（安装时还需要 register-bundles 过滤 dsh-e2e，就是证据），旧版 register-bundles 也不会移除 dsh-log-analysis。回滚时应写明从 `dsh.profile.bundles` 移除 dsh-log-analysis。
  - 被关闭的旧"dshVerify"标签需要手动重新打开。

### P2-11　界面

- **性质**：确认。
- **日志分析面板**：
  - `LogWorkbench.jsx:127`：顶部的"查找"与阅读器里的"查找 · Ctrl+F"同屏同名但范围不同，建议改为"跨文件查找"。
  - `LogWorkbench.jsx:141`：压缩包状态直接显示内部英文值，LOG_UI.png 中可见 "partial"。应映射为中文，细节放到 tooltip。
  - 阅读器 `LogViewer.jsx` 的工具栏没有改动，仍是基线的 4 行控件。"正文首行距顶部 ≤200 px"这个目标既没有达成，也没有测量。
- **Harmony 面板仍有次级说明**：
  - `HarmonyPanel.tsx:735`、`:740`、`:763`：设置区的副标题。
  - `HarmonyPanel.tsx:780`：写着"投屏不会自动唤醒"，与界面上的"唤醒设备"按钮矛盾。
  - `HarmonyPanel.tsx:826`：正常直播时仍显示"实时视频流"字样。
  - `useHarmonyLiveFrameEngine.ts:444`：初始预览时的长句提示。
- **其它**：`LogSessionManager.jsx:36` 的说明句仍提到"开发验证记录"。

### P2-12　冷启动首图约 4.8 秒没有分段计时

- **性质**：确认。
- **证据**：`native-cold-no-warmup.json` 中已记录的各段合计约 2.6 秒，而 `totalFirstPictureMs=7402`。
- **位置**：`deveco-native-video.ts:242-257`，初始预览截图（定时 1.2 秒 + 设备截图、拉取、缩放）这一段没有计时。
- **修正**：补记初始预览等待、截图耗时、等首个编码帧的时间，用来判断"首图 5 秒内"能否达到。不调整任何超时。

## P3

- `legacy-tabs.mjs:4-5`：先复制数组再逐个关闭；`tabsIn`/`closeIn` 的异常应吞掉。这段代码在会话标题栏的 effect 里运行，抛错会影响宿主 header。
- `live-video-hub.tsx:43,45`：同一设备已有其它可见订阅时，再有订阅加入或退出也会触发一次重放，画面会闪一下。可见状态没变时应跳过。
- `device-events.ts`：给每个监听器单独加 try/catch。
- `runtime/worker-client.ts:68`：还没上报状态的 worker 被当作 connecting，开流时会把它 reset。建议与 P2-5 一起处理。
- 测试缺口：
  - 旧数据保护测试只覆盖 `remove`，可补跨会话管理删除、purge、清理分析缓存。
  - Hub 测试使用假引擎和同步 React，没有覆盖真实引擎下可见性与代际的组合。

## 可以立即实施的修改清单（按优先级）

1. `useHarmonyLiveFrame.ts:14`：重新订阅前把 visible 置为 true，并补测试（P1-1）。
2. `renderChange` 可见分支调用 `wakeProbe?.()`，并补测试（P1-2）。
3. 全局退役从 `HdcBackend.dispose` 移到 manager dispose 和配置替换成功之后，改用 `allSettled`（P2-1）。
4. `renderChange` 在连接阶段沿用剩余建连预算（P2-4）。
5. `client.jsx:13` 补会话校验（P2-8）。
6. `build.mjs:35` 只在同级包存在时校验（P2-9）。
7. detach 时 socket 的收尾（P2-7）。
8. 代际只升不降，并以服务端代际为准（P2-3）。
9. retire 与 detach 的竞态（P2-2）。
10. 驱动未就绪时手工指针走 HDC（P2-6，需你确认）。
11. "测试"工具语义步骤的处理方式（P2-5，需你决定）。
12. 文档、界面文案和冷启动计时（P2-10、P2-11、P2-12）。

## 需要补的验收

- 窗口最小化超过 10 分钟后恢复；面板在后台标签挂载后首次查看。
- 切到别的会话期间手机自动锁屏，返回后记录到"等待解锁"的耗时。
- 设置中选择无效的 HDC 路径时，视频不应中断。
- A 面板保持挂载期间发生代际变化（停止设备、USB 重插），回到 A 后统计新 video 请求次数。
- 冷启动至少 5 个样本，记录首图与首个 H.264 的分布、RPC 偶发失败率。正常退出后再冷启，不应再出现孤儿清理阶段。
- 大于 16 MiB 的录屏预览；转屏；USB 拔插恢复；desktop 与 web 同时观看时的退役与重同步；长时间运行下的内存与 socket 数量。
- 视频在线时运行含语义步骤的测试，结果必须明确（成功，或给出明确提示）。
- 回滚演练，包括 bundles 清理。

修正和重验完成后，请把 diff、TAP 以及上面几项实测结果一起交回，我再做下一轮复审。