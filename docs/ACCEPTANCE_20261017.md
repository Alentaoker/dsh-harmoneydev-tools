# 明早验收入口

配套版本：dshHarmony 0.5.0-rc.5 / dshE2E 0.4.0-rc.4。

## 本机使用

两个 profile 已登记到 `E:\DeepSeekHarness\Sources\dsh-workbench-20261017`，数据仍为 `E:\DeepSeekHarness\Data`。web 已实际启用并验证。运行中的旧桌面需要先从托盘菜单正常退出，再按原 E 盘入口打开；不要只关闭窗口。也可在 PowerShell 执行：

```powershell
& 'E:\DeepSeekHarness\Sources\dsh-workbench-20261017\scripts\start-desktop.ps1' `
 -DshExe 'E:\DeepSeekHarness\App\DeepSeek Harness.exe' `
 -DataHome 'E:\DeepSeekHarness\Data' `
 -E2ENode 'E:\DeepSeekHarness\Tools\REA\runtime\node.exe'
```

若面板仍显示旧版本，先确认旧进程已退出，检查 DataHome/profile 和实际来源目录，不重复安装到 C 盘默认数据目录。

## 建议顺序

1. 当前会话打开 dshE2E 日志工作台：真实导入文件按时间平铺；没有目录/临时区。切换会话后列表隔离，旧目录文件在原会话仍可见。
2. 选中多份日志，点“分析选中”：只加入草稿并保留已有文字，不自动发消息。检查真实清单路径。
3. dshHarmony 日志：确认设备在线，观察新行、暂停/继续、关键词和 TAG 过滤，保存到当前会话。最大 100000 行 / 128 MiB 文本预算，非完整落盘保证。
4. 截图与录屏：只有手动记录，切聊天仍保留；点击缩略图直接大预览，列表旁可以加入原图。
5. 预览内试 R/A/T/B、Ctrl+Z、Ctrl+Shift+Z、0/1/+/-，Ctrl+Enter 加入当前批注图，附件名 -annotated.png；原图保留。文字框中 Ctrl+Enter 同样有效。
6. 录像可播放，取当前帧后批注并加入草稿；后台任务收在更多工具。现有接口、任务和数据保留。

## 已验证与未覆盖

当前手机真实日志、10 万行实际组件回放、手动截图批注附件、实际录屏播放与取帧附件通过；146 项自动检查通过。原厂二进制日志 4 份为 partial，未伪装完整解码。没有发送模型消息，也未编译/安装手机业务应用。

Windows 原生跨窗口拖放、另一台实体电脑与其它系统手机待验；桌面实际冷启动与 web 验证分别记录。完整结果见 WORKBENCH_VALIDATION_20261017.md。

## 发布与回退

本地完整包和 SHA256 已准备。远端仓库当前公开，完整包包含限私用原厂资源，未向公开仓库上传。目标选择确定后再发布。

旧来源 `E:\DeepSeekHarness\Sources\dsh-log-publish-20261016` 保留。desktop 本轮 profile 备份位于 `E:\DeepSeekHarness\Data\backups\dsh-harmony-e2e-20261017-014947-031`。回退先完整退出宿主，使用正式 CLI 依次登记旧 Harmony/E2E 目录并核对 bundle，再同环境启动；不删除整个 DataHome、不覆盖其它插件与模型配置。完整命令与版本限制见 AI_UPGRADE.md。
