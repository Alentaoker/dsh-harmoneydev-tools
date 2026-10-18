# 候选记录：视频恢复、统一日志工作台与批注提交（2026-10-18）

范围：dshHarmony 0.5.0-rc.6 / dshE2E 0.4.0-rc.5（E2E 只改日志视图层：共用搜索历史、Esc 消费与一次性定位；日志存储、解析与报告未变）。源码工作区 `E:\DeepSeekHarness\Sources\dsh-archive-fix-20261017`，分支 `codex/archive-encoding-fix-20261017`，基线提交 `bc10b2b`。

本轮只做后台开发与无界面检查：未控制键鼠、未抢占窗口焦点、未操作手机、未重启 DSH、未安装到运行中的宿主。需要界面或真机的步骤列在“尚未验证”。

## 0. 审查意见的修正

### 第三轮（本轮）

| 意见 | 处置 |
|---|---|
| P1 会话日志搜索历史缺失 | 历史改为**两个视图共用**：规则实现只有一份（`plugin/dsh-e2e/src/log-search-menu.mjs`），E2E 的 `LogViewer` 过滤框与查找框都接入（`LogSearchHistory.jsx`），本插件构建期引用同一模块；单独构建时用本地回退副本，并有逐例对比测试防漂移。会话日志记录后，实时视图打开历史即可看到 |
| P2 会话日志 Esc 关闭整个工作台 | E2E 查找框的 Esc 现在 `preventDefault` + `stopPropagation`；历史 Esc 也先被内层消费；外层 `HarmonyPanel` 抽屉忽略 `defaultPrevented` 事件 |
| P2 切回会话日志被拉回旧文件 | `查看文件` 改为**一次性定位**：`LogWorkbench` 处理完 `openFileId` 后回调 `onOpenFileConsumed`，外层清除请求；`visible` 不再作为重新定位的依赖 |
| P2 输入法保护未覆盖 React 事件 | `isComposingKey` 同时检查 `event.isComposing`/`keyCode` 与 `event.nativeEvent.*`；两侧调用点统一使用 |
| P2 编辑关键词未取消历史选中 | 两个视图的筛选框与查找框在 `onChange` 时清除 `selected`，之后 Enter 不会再覆盖新输入 |
| 成对打包需完整依赖链 | `scripts/preflight.mjs` 新增校验：E2E 的 `LogWorkbench`/`LogViewer`/`LogTrash`/`LogApplicationFilter`/`log-client`/`log-query`/`client.css`/`log-search-menu` 缺一即失败；同时修正 `package-lock.json` 版本与 `package.json` 不一致（预检本来就会拦，本轮才发现） |

### 第四轮（本轮）

| 意见 | 处置 |
|---|---|
| P2 输入法组合状态下 Esc 仍关闭工作台 | 外层工具面板的 Esc 处理增加 `event.defaultPrevented || isComposingKey(event)` 双重判断；内层组合输入直接返回时外层也不再关闭 |
| P2 一次性定位只补了 Harmony 调用方 | `dshE2E` 原入口（`client.jsx` 的会话日志工作台）同样传入 `onOpenFileConsumed={()=>setOpenFileId(undefined)}`；同一文件连续两次请求也能重新定位 |
| P2 依赖预检漏了 `LogSearchHistory.jsx` | 依赖清单抽到 `scripts/paired-sources.mjs` 并补入该文件（9 项）；新增 `scripts/paired-sources.test.mjs`：真实仓库通过、缺文件时报错并列出全部缺失项、并按实际相对导入链推导清单，防止再次漏项 |
| P2 自动生效的过滤词失焦不入库 | 会话日志过滤框失焦时记录（沿用 `compilePattern` 校验），与实时日志一致，不必按 Enter |
| 安装顺序说明有误 | 更正为 **Harmony → E2E**：Harmony 构建只读 `../dsh-e2e/src` 源码；E2E 构建需要 Harmony 已生成的 `cordis.patch.yml` |
| 回滚说明只覆盖 Harmony 与文档 | 回滚范围扩到**四个根**（`plugin/dsh-harmony`、`plugin/dsh-e2e`、`scripts`、`README.md`+`CHANGELOG.md`+`docs`，共 58 个改动路径 = 33 改 + 25 新），改用**一次**带路径的 `git stash push -u`，记录固定 stash 标识 `rc6-candidate-20261018`，并补齐 `git stash list`/`git stash show --include-untracked` 校验、两插件构建产物备份、回滚后逐项检查（含 E2E 新源码与 `scripts/paired-sources.mjs`、`preflight.mjs` 新校验均已消失）与恢复后的复验。**未实际执行回滚** |
### 第二轮

| 意见 | 处置 |
|---|---|
| P1-1 积压后可能永久停在旧画面 | 关键帧等待改为**有界**：`KEYFRAME_WAIT_LIMIT_MS = 2000`，超时后强制重连取新 IDR；逐包与定时器双重检查（后台标签页定时器被节流时仍能触发）。新增 `metrics.resyncs` 与“短暂卡顿后画面静止”的隔离测试 |
| P1-2 解锁后仍可能等满兼容窗口 | 兼容预览窗口改为：截图节拍跟随阶段策略、并在**不可用→可用**转换时提前退出。新增“三次普通失败 → 兼容 → 锁屏 → 解锁”测试，锁定解锁后立即重试实时通道 |
| P1-3 会话日志页绕过受限正则 | 该页已删除，改为复用 dshE2E 的 `LogWorkbench`/`LogViewer`（其 `compilePattern` 是既有受限方言）。历史记录侧同样只接受该方言通过的模式 |
| P1-4 “统一工作台”做成第二套简化查看器 | 会话日志页现在**就是** dshE2E 的完整工作台：导入、拖入、删除/回收、改名、压缩包解析与重试、分页、来源排序、应用/TAG 筛选、AI 分析草稿全部复用原实现；日志仍在 E2E 存储，无搬迁 |
| P2-5 Enter 误用旧搜索、输入法未保护 | `historyKeyAction` 增加 `selected` 前置条件；`isComposingKey` 覆盖组合输入；空历史不可应用 |
| P2-6 查找选项改动整份过滤 | 随简化页删除而消失：会话日志用 E2E 自带查找（`findCase`/`findRegex` 与筛选分离），实时日志本来就把查找与筛选分开 |
| P2-7 两个 Tab 的历史不同步 | 打开历史即重新读取；第三轮进一步改为两侧共用同一份历史与同一套规则 |
| P2-8 阅读状态错误（页码、详情残留） | 随简化页删除而消失（E2E 工作台自带 `setOffset(0)` 与选中态管理） |
| 回滚说明会混出“旧主体+新路由” | 重写为 `git stash push -u`（含未跟踪路由目录）+ 重建 + 校验新路由不再出现；明确不要只 `git reset --hard`，也不要 `git clean -x` |

## 1. 需求完成情况

| 需求 | 状态 | 实现要点 | 主要文件 |
|---|---|---|---|
| 视频按阶段自动连接与恢复 | 已实现，未真机验收 | 七阶段与策略表；打开设备页自动连，日常无“接入实时视频”，异常保留“立即重试” | `observation/live-view-phase.ts`、`hooks/useHarmonyLiveFrame.ts` |
| 锁屏单独判断、解锁即恢复 | 已实现，未真机验收 | 只读 `GET /api/harmony/screen-state`；锁屏/熄屏独立等待；**普通失败后的兼容窗口也响应解锁** | `app/api/harmony/screen-state/route.ts`、`device-manager.ts`、`hdc-backend.ts` |
| 降低截图兜底开销 | 已实现，未实测功耗 | 兼容 750 ms、锁屏 2 s、占用 1.5 s、隐藏 1 s、暂停 4 s（原 120 ms） | `live-view-phase.ts` |
| 控制预览积压 | 已实现，未真机测延迟 | 字节 1.5 MB + 滞留 200 ms + 队列软上限 8；超预算等关键帧；**2 s 未等到则重连取新 IDR** | `media/video-backlog.ts` |
| 统一日志工作台 | 已实现，未界面验收 | 顶部固定 `[设备][日志工作台]`，内部 `[实时日志][会话日志]`；实时页常驻保留状态，隐藏停刷新不断流 | `harmony/LogWorkbenchShell.tsx`、`HarmonyPanel.tsx`、`HarmonyLogViewer.tsx` |
| 会话日志复用完整视图 | 已实现，未界面验收 | 直接渲染 dshE2E `LogWorkbench`（含共用搜索历史）；`查看文件` 为一次性定位；构建期解析配对源码，缺失时给明确提示而不是简化替代 | `harmony/SessionLogPane.tsx`、`scripts/build.mjs` |
| 搜索历史 | 已实现，未界面验收 | 两个视图共用一份：最近 30 条、含正则与大小写、去重、最近优先、单删/清空；`harmony-log-search-history.json`；打开即刷新；规则实现唯一（E2E） | `log-search-history.ts`、`app/api/harmony/logs/search-history/route.ts`、`harmony/LogSearchHistory.tsx` |
| 快捷键 | 已实现 | Ctrl+F、Enter/Shift+Enter、历史内 ↑↓、Esc 先关历史再关查找；输入法组合输入不触发 | `log-search-menu.ts` |
| 批注加入对话后自动关闭 | 已实现，未界面验收 | 成功后关闭、跳过焦点回夺、保留草稿；失败保留窗口与批注；处理中禁重复 | `harmony/MediaPreview.tsx`、`MediaHistory.tsx` |
| 诊断指标 | 已实现 | 通道/阶段/绘制帧率/跳过依赖帧/首帧/恢复/队列/积压/**重同步**/探测次数/画质建议 | `HarmonyPanel.tsx` |
| Worker+OffscreenCanvas、暂停恢复、H.265 对照 | 未开始 | 计划要求先测基线；本轮无真机性能基线 | — |

保留：原生 H.264 主通道、每设备一路编码、多窗口与录像共享订阅、10 万行 / 128 MiB 缓冲、左右/上下/专注布局、E2E 报告与导出。

## 2. 已执行的测试与结果

环境：Windows x64，Node 24.21.0（宿主自带运行时）。全部无界面。

| 检查 | 结果 |
|---|---|
| 改动前基线 | Harmony 89/90（既有 `media-conversation` 临时目录竞态，单跑 3×4/4 通过）、E2E 59/59 |
| 新增纯逻辑 | 阶段 8、积压 6（含关键帧等待上限）、画质 6、搜索菜单 6（含 Enter/IME）、搜索历史存储 7 |
| 生命周期 | `browser-video-lifecycle` 5→7 项：锁屏 2 s 等待+解锁重连、**积压卡顿有界重同步**、**兼容窗口被解锁提前结束** |
| 源码契约 | `log-workbench-shell` 13 项：固定入口、无日常连接钮、等待文案、指标（含重同步）、双 Tab 常驻、隐藏不断流、查看文件跳转、**会话日志即 E2E 完整视图且不再自建正则/列表**、构建期配对与回退、历史显式应用与打开刷新、批注成功后关闭 |
| **Harmony 全量** | **140/140** |
| **E2E 全量** | **69/69** |
| E2E 新增 | `search-history` 9 项：共用规则、React 原生事件组合状态、两框接入、改动即取消选中、Esc 消费、一次性定位、受限方言校验、404 降级 |\n| 预检 | `scripts/preflight.mjs` 通过（成对依赖链 9 项、版本一致性、原生视频资源）；`scripts/paired-sources.test.mjs` 3 项覆盖“缺文件即失败”与“清单覆盖实际导入链” |\n| 构建 | 成功；harmony `client.js` 含配对工作台、`.de2e` 样式与共用历史（1673→1782 KB）；e2e `client.js` 185.7 KB；两个新路由自动登记 |

失败与限制：唯一失败是改动前就存在的并发临时目录竞态。源码契约类用例属于“结构断言”，不能替代行为验证；两处关键行为（积压重同步、兼容窗口解锁退出）另有隔离行为测试。

## 3. 尚未验证的项目与已知问题

真机与界面（本轮按约定未做）：

1. 首次打开 5 秒内自动出画面；锁屏唤醒连续三轮；USB 重连、转屏、双窗口与单窗口退出。
2. 量产系统 `hidumper -s ScreenlockService -a -all` 输出差异；读不到锁屏状态时按未知处理并保留“立即重试”。
3. 750 ms 兼容预览与 2 s 锁屏预览的实际 CPU、传输量与延迟；2 s 重同步上限在真机上的观感。
4. 日志 Tab 连切 20 次、切换会话与设备后的归属、10 万行日志同时投屏。
5. 配对的 E2E 工作台嵌在 Harmony 抽屉里的布局与滚动；`.de2e` 全局样式的观感。
6. 搜索历史重启后保留；方向键+Enter 与输入法行为。
7. 批注按钮与 Ctrl+Enter 均关闭预览、失败保留批注、连续触发不重复。

已知边界：

- 两个视图共用历史，但写入后另一侧不会实时推送：需要重新打开历史列表（聚焦或点「历史」）才看到最新记录。
- 共用历史文件的同步以“打开即刷新”实现，两个页面同时打开时不会实时推送。
- 会话日志视图与共用历史规则在构建期依赖同仓库的 `plugin/dsh-e2e/src`（含完整依赖链，`scripts/preflight.mjs` 会校验）；单独构建本插件时会话日志显示配对提示，搜索历史规则用本地回退副本。
- 画质建议只提示，不自动切档。
- 实时出帧中途熄屏靠 15 s 心跳发现（H.264 源只在画面变化时出帧）。
- 混合回滚风险已由新流程规避，但任何“只改源码不重建”的操作都会让磁盘 `lib/` 与源码不一致。

## 4. 安装、重启与回滚

安装来源（已核实）：桌面与网页 profile 都用 `link:` 指向源码工作区，运行时加载那里的 `lib/`；`E:\DeepSeekHarness\Plugins\dshHarmony`(rc.3)、`dshE2E`(rc.2) 是旧独立副本，不在加载路径。

```text
Data\profiles\desktop\package.json  "dsh-harmony": "link:E:/…/plugin/dsh-harmony"
Data\profiles\web\package.json      同上
```

安装（需你确认后执行）：

```powershell
$node = 'E:\DeepSeekHarness\App\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
cd E:\DeepSeekHarness\Sources\dsh-archive-fix-20261017\plugin\dsh-harmony
& $node scripts/build.mjs        # 读取同仓库的 ../dsh-e2e/src 源码，不依赖 E2E 的构建产物
cd ..\dsh-e2e; & $node scripts/build.mjs   # E2E 的构建需要 Harmony 的 cordis.patch.yml，因此放后面
# 完整退出 DSH 桌面进程后重新启动
```

顺序说明：Harmony 构建读取的是 **E2E 源码**（同仓库内始终存在），不需要先构建 E2E；反过来 **E2E 构建需要 Harmony 已生成的 `cordis.patch.yml`**，所以正确顺序是 Harmony → E2E。发布前可运行 `& $node scripts/preflight.mjs .` 校验成对依赖链（`pairedSources` 项）、版本一致性与原生视频资源。

数据保留：`Data\storages\dshHarmony`、`Data\storages\dshE2E\log-library` 不在构建范围，重装与回滚都不清理。

回滚（**不要**只 `git reset --hard`：它丢弃已跟踪文件的修改，却留下新增的未跟踪文件——包括本插件的两个新路由目录和 E2E 的新源码、脚本的新模块；构建脚本会把它们重新扫进旧代码，得到“旧主体+新文件”的混合结果）。

本轮改动分布在 **四个根**：`plugin/dsh-harmony`、`plugin/dsh-e2e`、`scripts`、`README.md`+`CHANGELOG.md`+`docs`。已核对全部 58 个改动路径（33 个已跟踪修改 + 25 个未跟踪新增）都落在这四个根内，所以一次带路径的 `git stash push -u` 就能完整收起，`git status --porcelain` 会真的为空。

```powershell
$node = 'E:\DeepSeekHarness\App\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
cd E:\DeepSeekHarness\Sources\dsh-archive-fix-20261017
$stash = 'rc6-candidate-20261018'      # 本次回滚使用的 stash 标识

# 0) 先记录现状；本文档本身也在 docs/ 下，会被一起收起，先留一份副本
git status --porcelain
Copy-Item docs\LIVE_WORKBENCH_20261018.md E:\DeepSeekHarness\Backups\ -Force
# 构建产物被 gitignore，stash 不会带走，因此两个插件都要先备份再重建
Copy-Item plugin\dsh-harmony\lib E:\DeepSeekHarness\Backups\harmony-lib-rc6 -Recurse -Force
Copy-Item plugin\dsh-e2e\lib     E:\DeepSeekHarness\Backups\e2e-lib-rc6     -Recurse -Force

# 1) 一次收起四个根的全部改动（-u 同时收起未跟踪的新源码、新测试、新路由、新脚本）
git stash push -u -m $stash -- plugin/dsh-harmony plugin/dsh-e2e scripts README.md CHANGELOG.md docs
# 校验 stash 标识与收起的范围
git stash list                 # 首行应为 stash@{0}: On codex/archive-encoding-fix-20261017: rc6-candidate-20261018
git stash show --include-untracked --stat 'stash@{0}'   # 仅此历史快照为 58 项；PowerShell 引用必须加引号
git status --porcelain         # 期望为空

# 2) 用旧源码重建（顺序 Harmony → E2E）
& $node plugin\dsh-harmony\scripts\build.mjs
& $node plugin\dsh-e2e\scripts\build.mjs

# 3) 校验回滚真的彻底（每一项都应有标注的结果）
Select-String plugin\dsh-harmony\src\routes.ts -Pattern 'screen-state|search-history'   # 无输出
Select-String plugin\dsh-harmony\lib\index.js  -Pattern 'screen-state|search-history'   # 无输出
Test-Path plugin\dsh-e2e\src\LogSearchHistory.jsx                                     # False
Test-Path plugin\dsh-e2e\src\log-search-menu.mjs                                      # False
Test-Path scripts\paired-sources.mjs                                                  # False
Select-String scripts\preflight.mjs -Pattern 'paired-sources|pairedSources'            # 无输出
Test-Path docs\LIVE_VIEW_PHASES.md                                                    # False
git status --porcelain                                                                # 期望仍为空

# 4) 完整退出 DSH 并重启
```

恢复候选版（同一个 stash 一次恢复，含全部未跟踪文件）：

```powershell
$node = 'E:\DeepSeekHarness\App\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
cd E:\DeepSeekHarness\Sources\dsh-archive-fix-20261017
git stash list                          # 确认 stash@{0} 仍是 rc6-candidate-20261018
git stash apply 'stash@{0}'               # 保留备份条目；恢复和构建验证完成前不删除
git status --porcelain                  # 期望回到本轮的 58 个改动路径（33 改 + 25 新，见第 5 节清单）

# 重建两个插件（Harmony → E2E），并复核候选版特征
& $node plugin\dsh-harmony\scripts\build.mjs
& $node plugin\dsh-e2e\scripts\build.mjs
Test-Path scripts\paired-sources.mjs                                                    # True
Select-String plugin\dsh-harmony\src\routes.ts -Pattern 'screen-state|search-history'   # 命中 2 行
& $node scripts/preflight.mjs .                                                          # preflight: passed，pairedSources: 9
```

补充：

- `lib/` 与 `src/routes.ts` 被 gitignore，stash 不会带走构建产物，所以回滚与恢复都必须重建，`git status` 也不会因此变脏。
- 若 stash 应用报错，先停止并查看 `git status`：应用前因本地修改受阻，与已部分应用并产生 unmerged 冲突是不同状态。前者仅在确认生成文件差异可丢弃后再处理；后者逐文件解决当前冲突并 `git add`，不要再次 apply/pop，也不要对未合并文件直接 `git checkout -- 文件`。stash 始终保留，全部验证完成后再确认并删除对应条目。
- 恢复后如需重新回滚，用新的 stash 标识（不要复用 `rc6-candidate-20261018`），以免与旧条目混淆。
- 不要使用 `git clean -x`：它会连 `node_modules` 一起删除。
- 用户数据（日志、截图、数据库、搜索历史）不在上述任一步骤中；`Data\storages\*` 全程不被触碰。

## 5. 本轮改动清单

新增：

- `vendor/lib/harmony/observation/live-view-phase.ts`、`media/video-backlog.ts`、`media/video-quality.ts`
- `vendor/lib/harmony/log-search-history.ts`（搜索历史的服务端存储）
- `vendor/app/api/harmony/screen-state/route.ts`、`logs/search-history/route.ts`
- `vendor/components/workspace/harmony/LogWorkbenchShell.tsx`、`SessionLogPane.tsx`、`LogSearchHistory.tsx`
- `src/session-log-workbench-unpaired.tsx` / `.css`、`src/log-search-menu-unpaired.ts`（配对缺失时的构建回退）
- `plugin/dsh-e2e/src/log-search-menu.mjs`、`plugin/dsh-e2e/src/LogSearchHistory.jsx`（共用搜索历史的唯一实现）
- 测试：`live-view-phase`、`video-backlog`、`video-quality`、`log-search-menu`、`log-search-history`、`log-workbench-shell`、`dsh-e2e/tests/search-history`
- 文档：本文件、`docs/LIVE_VIEW_PHASES.md`

修改：

- `vendor/hooks/useHarmonyLiveFrame.ts`、`vendor/components/workspace/HarmonyPanel.tsx`、`HarmonyLogViewer.tsx`
- `vendor/components/workspace/harmony/MediaPreview.tsx`、`MediaHistory.tsx`
- `vendor/lib/harmony/types.ts`、`hdc-backend.ts`、`hybrid-backend.ts`、`device-manager.ts`、`observation/screen-state.ts`
- `HarmonyPanel.module.css`、`scripts/build.mjs`
- `plugin/dsh-e2e/src/LogViewer.jsx`、`LogWorkbench.jsx`、`client.css`（接入共用历史、Esc 消费、一次性定位、菜单样式）
- `package.json`（0.5.0-rc.6）、`package-lock.json`（版本对齐，预检要求）、`USAGE.md`
- `scripts/preflight.mjs`（成对依赖链校验）
- `README.md`、`CHANGELOG.md`、`docs/LOG_WORKBENCH.md`、`docs/MEDIA_WORKBENCH.md`

未改动：宿主版本、原厂视频组件与资源哈希、用户数据目录。`plugin/dsh-e2e` 本轮被改动（会话日志视图接入共用搜索历史、Esc 消费、一次性定位、样式），改动点均为该插件的日志视图，存储与解析未变。
# 历史记录说明

本文记录 rc.6 / E2E rc.5 的实现与当时 58 项工作树快照。当前交互更新为 rc.7 / E2E rc.6，见 [工作台交互优化](WORKBENCH_UX_20261018.md)；不要用本文固定路径数量校验后续版本的回滚范围。
