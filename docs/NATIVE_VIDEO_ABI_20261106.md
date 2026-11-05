# 原生投屏 protobuf 兼容修复与验收

状态：纳入 main 的源码修复，基于 0.6.0-rc.1；本次未发布新的 tag/Release，没有覆盖原安装包。问题来源：[issue #1](https://github.com/Alentaoker/dsh-harmoneydev-tools/issues/1)。

## 为什么不能统一换成新版

Protobuf 的协议字节兼容与 C++ 二进制兼容不同。[Protobuf 官方说明](https://protobuf.dev/support/cross-version-runtime-guarantee/#c-and-rust-specific-guarantees)不保证不同版本间的 C++ ABI 稳定。设备系统更新改变原生导出符号时，旧组件可以在 dlopen 阶段失败，新组件也可能无法在旧 ABI 上加载。

本机已连接手机读取到 `const.ohos.fullname=OpenHarmony-7.0.0.105`、API 26，设备列表的完整固件显示为 `MRT-AL10 7.0.0.109(SP8C00E105R8P2)`。旧组件所需的 61 个 protobuf 符号全部具备；6.9 组件所需的 50 个符号中缺少两个：`WriteStringMaybeAliasedOutline(...basic_string_view...)` 和 `UntypedMapBase::ClearTableImpl(bool)`。因此，不能按“7.0/API 26”强制使用新组件。

## 改动

- 资源清单 schema 2 支持双组件，schema 1 仍可读取。旧组件保持原 SHA256 `98bbc964fef1c4d17b446ec717102b855d09224b23fc1872bf70e1f928d010dd`，268471 字节，来源 `hosScrcpy-1.0.17.15-java21-SNAPSHOT-shaded.jar` 的 `libscrcpy_server_unix_6.6-20260418.z.so`。
- 新组件为本机官方 DevEco Studio 的 `hosScrcpy-1.0.20-beta.jar` 中 `libscrcpy/libscrcpy_server_unix_6.9-20260801.z.so`，239799 字节，SHA256 `296e3b0f0ba92c176639e946174a0bb9096025f313fa11bcb27628e6aca5612b`。完整提取后改本地文件名，二进制内容未修改。6.8 组件仍使用旧 protobuf 接口，没有把它当作新 ABI 修复。
- 每次实际冷启动用 HDC 读取 `/system/lib64/libprotobuf.z.so` 到独立临时目录，以有界 ELF 动态符号解析比较两个组件的全部强 protobuf 导入。不会启动自制探针，不写系统库；临时副本在成功、失败、取消时均清理。同设备现有视频源复用不重复探测。两者均满足时优先保留已验旧组件；均不满足时不派发组件。
- 系统库禁止读取时，只保留显式标为 `unverified` 的旧组件回退；实际加载若报错，再分类为不可重试的 ABI 或系统完整性拒绝。读到损坏 ELF 不视为兼容成功。旧 schema 1 保持旧行为，不伪装完成了 ABI 探测。
- 启动过程监测本次独占 daemon 的日志。`symbol not found` 与 XPM/加载映射拒绝分别保留结构化原因，避免先等满 12 秒再重复启动。前端立即进入现有兼容预览，在本次观看生命周期内不重复连接已确定不兼容的组件；更新组件后重新建立观看生命周期再检查。
- 构建预检固定两个原厂组件的长度、SHA256、架构与 protobuf 符号；导入脚本支持原有嵌套 JAR 和直接 SDK JAR，合并保留旧资源，最后原子写清单。没有使用 LD_PRELOAD、修改 DT_NEEDED、替换系统库或绕过 XPM。

关键文件：`native-video-resource.ts`（资源/选型）、`native-video-elf.mjs`（符号解析）、`native-video-startup.ts`（启动错误）、`deveco-native-video.ts`（生命周期）、`request-error.ts` 与 `useHarmonyLiveFrameEngine.ts`（兼容预览）、`scripts/native-video-catalog.mjs`（固定原厂组件）。

## 已验证

- Harmony 全量 189/189；安装、配对和发布脚本 7/7；本机完整构建成功；desktop/web 配置预检、注册路径校验通过。没有安装新依赖。
- 新增 17 项回归覆盖：旧 ABI 选旧、新 ABI 选新、双兼容优先旧、均不兼容拒绝、取消/读限制/坏 ELF、路径与未选组件完整性、loader 早退及 RPC 迟到回调、三种永久失败不重连。新 ABI 测试使用按原厂真实导入集合生成的 ELF 导出夹具，绝不标为故障真机测试。
- 两个宿主精确重启加载修复后，当前真实手机自动选择 `protobuf-legacy`，`abi.status=symbols-matched`；一次冷启动真实 H.264 首图 2552ms，已收到 43 个编码画面。没有把兼容 JPEG 预览当作 H.264 成功。
- 第二次视频源的 ABI 文件拉取用时 241ms；B 会话返回 A 后 `startedAt/extension` 相同，页面恢复 636×1430 的实时画面。这里证明 source 复用，没有额外声称完整网络窗口零请求。
- 首次源出现 `8 RESOURCE_EXHAUSTED: Bandwidth exhausted or memory limit exceeded` 后回收并自动重新出 H.264；截至 `real-stream-summary.json` 统计，本轮已有 12 个同类失败归档，当前再次处于 `streaming`、170 个编码画面。修复前状态记录也出现同类错误。本轮没有定位和修复该独立传输问题：原生加载与新旧选型回归成功，长期稳定性不能判为通过，也不能把这些源重建解释成 ABI 不兼容。
- 追加一次系统 Home 键回到桌面以产生画面变化，浏览器实际显示桌面并恢复实时状态；没有打开或发送消息。截图仅保留面板顶部连接状态，不包含手机消息内容。唤醒操作的手工租约已到期，收尾界面没有活动设备操作按钮。

本地证据目录：`E:\DeepSeekHarness\Verification\native-video-abi-20261105`。含 `harmony-regressions.tap`、`scripts-regressions.tap`、构建记录、当前设备库符号对照、真实源状态和切会话前后记录。系统库副本与原始运行日志只保存在本机，不进入源码发布包。

本机预构建文件和旧资源备份在该目录的 `baseline/`。回退需要同时恢复运行构建和旧资源清单，不能只恢复旧 JS 后继续使用 schema 2 清单；原 GitHub v0.6.0-rc.1 下载包不受本次修改影响。

## 候选源码包

本轮另备 `dsh-native-video-abi-fix-20261106-source.zip`，附 SHA256，供转移到故障设备所在电脑验收。它是同版本号的未发布候选，不是原 GitHub v0.6.0-rc.1 下载包。解压到新目录，把[升级指南](LOG_ANALYSIS_UPGRADE.md)中的 `$source` 指向这个候选目录，跳过指南下载旧 release 的步骤，再按本机实际 Node/DSH 路径构建登记；不要覆盖另一台电脑的 Data、凭据或原来源目录。ZIP 不含依赖和编译产物，不能直接用系统解压替代插件构建安装。

## 仍需故障设备验收

Issue 中的 SGT 设备未连接本机，未取得该机完整导出符号集，不能声称新组件已在那台设备成功加载。符号满足只是必要条件，不证明 C++ 内存布局、其它系统库、签名和 RPC 协议都兼容。新组件是未改动原厂文件，也不能据此推断该固件 XPM 一定接受。

在故障设备上检查：自动选择 `protobuf-current`，无 ABI/XPM loader 错误，实际 H.264 编码和浏览器解码成功；确认首图、静止/活动画面、切会话、录屏和收尾。另需读取受限固件的实际回退、其它设备架构、库路径变化和多设备并发验收。本次只更新 main 源码，未发布新 tag/Release；issue 保留待故障设备实测确认。
