# 原生视频组件与低开销改造

0.5.0-rc.2 补充外部投屏来源/PID 提示、低频等待与自动重连，并修复共享服务释放时的订阅竞态。DSH 自己的多个窗口复用一路编码，外部 DevEco 投屏不接管。恢复边界与验收见 [视频恢复计划](VIDEO_RECOVERY_PLAN.md) 和 [验证记录](VALIDATION.md)。

这个仓库是所有者的私有自用仓库。dshHarmony 0.3.0 的安装包包含视频组件，投屏启动不再读取 DevEco Testing 安装目录，不需要运行 Testing 或 Java。仍需要独立的 HDC、有效设备连接，以及手机系统提供的原生库。

## 组件身份

| 项目 | 值 |
|---|---|
| 来源 | 所有者已安装的 `screenCastingResource.jar`，资源包版本 `26.0.0.432` |
| SDK | `hosScrcpy-1.0.17.15-java21-SNAPSHOT-shaded.jar` |
| 原成员 | `libscrcpy/libscrcpy_server_unix_6.6-20260418.z.so` |
| 插件内位置 | `plugin/dsh-harmony/resources/native-video/libdsh-native-video.z.so` |
| 字节数 | 268,471，约 262 KiB |
| SHA-256 | `98bbc964fef1c4d17b446ec717102b855d09224b23fc1872bf70e1f928d010dd` |
| 格式 | ELF64、little-endian、AArch64、共享库 |

原字节不修改。组件保留原厂权利，**不适用源码的 MIT 许可**，没有确认对外分发授权。依赖库的 Apache/MIT notice 不能代替这份组件的许可；保持仓库和包含该组件的安装包为本人自用。

## 分析证据与原理

按 REA skill 的产物优先工作流，实际运行 `rea-agents@6.4.0 inspect-artifact`。资源包 Evidence ID：`ev_b2ba61cc7ae4a7f1a7cd0fa7696f70d06027c81959341a54b62af30cb8bf70be`。完整清单仅保存在本机，未把整包或分析缓存提交。

REA 的 `inspect-binary-layout` 在当前 Windows/AArch64 组合返回不支持，其 provider 的已验证范围是 Linux x64。没有声称获得了完整原生伪代码。后续使用本机 SDK 的 LLVM 读取 ELF 依赖、符号和初始化函数汇编，使用现有 `javap` 核对 Java SDK 的参数格式；这些是常规静态工具的证据。

观察到组件导入手机端 `OH_VideoEncoder_*`、虚拟屏幕/Surface 和 gRPC 接口。插件发送这份小组件到手机，在独占的 `uitest` 扩展会话中加载，通过 HDC 的 Unix socket 转发接收 H.264，再封装为浏览器协议。浏览器用 WebCodecs 解码，并释放 VideoFrame；偏好硬件解码不等于每台电脑都实际使用硬件。

组件依赖手机已有的 gRPC/protobuf、render/display、媒体编码、Surface、hilog 等库。因此不需要打包整个 DevEco/Java，也不能保证所有系统版本、模拟器或架构兼容。当前验收设备为 API 24 的 ARM64 手机。

## 参数修复

旧桥接使用 `-scale2 -frameRate30 -bitRate6291456` 等连写形式，组件忽略了这些选项。实机三档均输出 1272×2860，说明参数未生效。

SDK 的格式是独立标记和数值。改为 `-scale 2 -frameRate 24 -bitRate 3145728` 等形式后，均衡/流畅输出 636×1430，低开销输出 424×954。

| 档位 | 尺寸除数 | 请求 fps | 请求码率 |
|---|---:|---:|---:|
| 低开销 | 3 | 15 | 1,572,864 bps |
| 均衡（默认） | 2 | 24 | 3,145,728 bps |
| 流畅 | 2 | 30 | 6,291,456 bps |

请求参数不是实际显示帧率保证。原生回调可能包含片段；picture packet 计数不是浏览器 decoded/displayed fps。验证使用传输字节和真实画面尺寸，不据此夸大帧率。

## 插件侧优化

- 导入时校验固定版本，启动时核对大小、ELF 架构和哈希；同一未改文件复用校验，不保留双层 JAR 解压的大块缓冲。
- 不再启动前主动捕获 PNG，只在没有视频画面时获取明确标记的 JPEG 预览。
- 原生 protobuf 使用视图，视频封装少一次完整复制；浏览器连续包直接读取视图，跨片包只分配一次，保留大小上限和解码背压。
- 页面/面板隐藏取消自身预览，恢复后重连；不调用设备全局停止或录像停止。
- 缓存不透明画布上下文；静止视频每 5 秒检查几何，实际点击前服务端仍核验。
- 状态落盘每 10 秒，串行写入；结束保存最终状态，继续保留进程健康检查。
- 只清理自身扩展、PID、临时文件和精确转发；确认旧宿主退出后才回收其残留，不杀其他软件的进程。

旧 HAP 的发行、签名、初始化和回退连接已退役，旧 `bundled` 配置迁移为 `native`。组件损坏或系统不兼容时明确报告并回退截图。

## 维护资源

私有仓库已经包含组件，普通安装不需要导入。维护者核对原来源时可以运行：

```powershell
npm --prefix plugin/dsh-harmony run import:video -- --jar '本机 screenCastingResource.jar 的绝对路径'
```

未知版本或哈希不符会拒绝导入。升级组件需重新检查依赖、协议并实机验收，构建也会再次校验资源。
