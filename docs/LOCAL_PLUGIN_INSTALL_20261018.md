# 本机插件安装记录（2026-10-18）

后续运行验收、采集摘要与录屏时长修正、发布检查见 [运行验收报告](RELEASE_ACCEPTANCE_20261018.md)。本文保留首次安装当时的结果。

用户明确要求安装最新插件后，已安装本机候选 dshHarmony 0.5.0-rc.8 与 dshVerify 0.5.0-rc.1。dshVerify 的包名、服务与存储兼容标识仍为 dsh-e2e / dshE2E。

## 部署与备份

- 源码：`E:\DeepSeekHarness\Sources\dsh-archive-fix-20261017`。
- 桌面、网页两个 profile 均使用原有 `link:` 指向上述插件目录，本次没有改为旧的 Plugins 副本。
- 安装前备份：`E:\DeepSeekHarness\Backups\plugin-install-2026-10-18T15-17-21-825Z`。包含原构建产物、worker、配对配置、两份 profile 配置、包清单/锁文件、当前源码补丁与未跟踪文件。
- 完整停止 E 盘 DSH 宿主后，使用 Node 24.21.0，按锁文件执行两个插件的依赖安装（legacy-peer-deps），再按 Harmony → dsh-e2e 构建。
- 已恢复桌面宿主和 `http://127.0.0.1:55117/` 网页宿主，使用原 `E:\DeepSeekHarness\Data`。未操作手机输入，未发布。
- 本轮未删除或迁移用户日志、媒体、数据库与旧历史；宿主冷启动可能按既有恢复逻辑标记上次未完成的轮次。

## 安装时发现并修正的兼容问题

1. 原 `harness-adapter` 测试仍注册旧 busy 路由并要求 E2E_REQUIRED，与框架移除后的契约不符。改为真实 wrapper 检查人工轮次拒绝控制（包括显式 direct），保留非法参数校验和无轮次 help 检查。
2. 当前宿主 Cordis 4.0.4 不接受 `{ required, optional }` 依赖声明，会把 required/optional 当成服务名，导致 dshVerify pending。改为只声明 connection/sessions，Harmony 关联使用 `ctx.inject(['dshHarmony'], ...)` 子上下文，支持后加载及清理。
3. Cordis 禁止直接读取未注入服务。Verify 的可选 Harmony 查询、Harmony 的可选 Verify 查询，均改用 `ctx.reflect.get`；普通源码测试夹具保留原对象回退。

涉及业务文件仅 `plugin/dsh-e2e/src/index.mjs`、`plugin/dsh-e2e/src/service.mjs`、`plugin/dsh-harmony/src/index.ts`；另更新一份旧测试。上述变更之后已重新构建。

## 验证结果

- Harmony 全量：150/150。
- Verify 全量：125 项，124 通过、0 失败、1 跳过（环境不能创建 junction）。
- 仓库脚本测试：7/7。
- 两 profile 配对预检与安装登记检查通过，pairedSources=24。
- 旧 engine/executor/rpc/verification 四个构建模块已清除。
- 使用真实宿主 Cordis 4.0.4，隔离宿主副作用：Verify 单独加载、后加/移除/再加 Harmony、关联清理、状态读取通过；真实 Harmony wrapper 的 help 在无 Verify 时可用，在存在验证上下文时写入 start/end 两条事件，无设备控制。
- 网页冷启动已看到 dshVerify 0.5.0-rc.1，设备状态及当前会话记录列表加载成功，无可选服务错误；Harmony 日志工作台显示 0.5.0-rc.8，实时/会话两个面板均能打开，会话跨文件筛选入口可见。
- 启动日志只有宿主既有 fs.Stats 弃用提示，未再出现 dshVerify pending 警告。

安装日志、测试输出、真实容器验证脚本及结果均保存在上述安装备份目录。截图：`E:\DeepSeekHarness\Verification\dsh-verify-installed-20261018.jpg`。

## 边界

这是构建、安装、加载和工作台冒烟检查完成。尚未进行两模式手机完整流程、控制权释放时序、转屏、截图附件模型收图、录屏、10 万行压力与真实软链攻防验收。没有把这些项目记为通过。

需回退时先完整退出相关宿主，再由备份的两个插件 lib/worker/配对配置恢复运行产物，按需恢复匹配的包清单与依赖；本次未执行回退。不要用 reset/stash/clean 清除包含其他未提交优化的源码工作区，也不要处理 Data 用户数据。
