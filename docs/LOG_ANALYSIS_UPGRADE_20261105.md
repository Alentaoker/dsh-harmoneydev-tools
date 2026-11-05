> 本文保留候选阶段说明；当前发布的完整操作指南见 [安装与AI升级](LOG_ANALYSIS_UPGRADE.md)。发布状态以固定Release为准。

# 安装与升级：dsh-log-analysis 0.6.0-rc.1

本轮为本机候选版，尚未公开发布。与 dshHarmony 0.6.0-rc.1 配套使用。Windows x64、Node.js 24；连接鸿蒙手机需要已获设备授权的 HDC。日志导入和检索可以离线使用。

## 改了什么

- dshVerify 安装标识正式改为 dsh-log-analysis，界面入口为“日志分析”。只保留日志；手机 AI 操控工具、任务验证和验证报告入口已移除。
- 源码目录沿用 plugin/dsh-e2e，只是历史目录名称。package.json 的 name 必须为 dsh-log-analysis。
- 存储继续使用原 DSH_HOME/storages/dshE2E，现有日志、搜索历史和已加入草稿的绝对路径保持有效。不会自动搬迁、清空或改写旧 validation-v1/workflows 历史。
- 投屏以浏览器窗口和设备为单位共享，不再由每个会话侧栏拥有。暂时离开后最多保留10分钟；之后释放，再打开可冷启动。后端无订阅时另有15秒资源保留期。这是资源策略，不是放宽故障超时。
- 只查看投屏不会初始化语义自动化驱动；手工点击、拖动继续走现有 HDC 路径。需要已有语义驱动的高级输入仍遵守原安全限制，不能为输入文字在活动视频中偷偷冷启动驱动。
- 小于等于16 MiB的录屏预览使用有界内存加载；更大的文件保持流式范围播放。关闭预览会中止未完成请求并释放临时URL。

## 安装前

1. 确认宿主实际使用的 DSH_HOME、desktop/web profile、DSH CLI、Node24和npm CLI路径；不要默认当前终端的用户目录就是宿主目录。检查启动脚本和现有profile来源。
2. 保留旧插件的源码与构建产物作为回滚来源，备份目标profile的package.json、pnpm-lock.yaml、cordis.yml、cordis.patch.yml、pnpm-workspace.yaml、compatibility.json。不要删除用户 storages。
3. 本机正在使用 link 来源时，在独立候选目录构建。不要一边刷新旧宿主一边覆盖其来源的 lib。
4. 不得对指向另一来源 node_modules 的 junction 执行 npm ci。先确认目录类型并仅移除那个junction，再在候选目录安装依赖；原来源保持不动。
5. 检查profile自定义cordis配置是否引用 dsh-e2e 或 dsh-harmony/agent；遇到自定义引用停止并人工核对用途，不盲删整个配置。

## 使用安装脚本

使用 scripts/install.ps1，显式提供 -DshCli、-DshExe、-DataHome、-NodeExe、-NpmCli 和 -DshProfile desktop 或 web。首次先加 -PlanOnly，检查输出的路径和 Mutates=false；去掉 -PlanOnly才安装。该脚本会备份profile、校验成对来源、安装依赖、构建、调用宿主正式插件命令更新登记，移除旧包登记并校验。

若系统脚本执行策略不允许运行，不修改全局策略。可由已允许的终端环境执行脚本，或按下面的等价流程使用 Node 与宿主 CLI。

## 等价手工流程

以下为步骤说明；将尖括号路径替换为本机已核实的真实值，不要直接照抄路径占位符。

1. 完整退出目标DSH宿主进程。desktop和web若共享来源，应同时退出；不要结束Codex、HDC、其它开发软件。
2. 设置此次进程的 DSH_HOME 为原用户数据目录，PATH优先使用已核实的Node24。
3. 对 plugin/dsh-harmony 和 plugin/dsh-e2e 分别执行 Node24 + npm CLI 的 ci --legacy-peer-deps，再执行各自 scripts/build.mjs。两者现在只有host补丁，不再依赖旧preset生成顺序。
4. Node24 scripts/preflight.mjs <候选来源> <目标profile> 必须通过。结果应为 dsh-harmony/dsh-log-analysis，版本均为0.6.0-rc.1。
5. 使用宿主正式CLI：plugin --profile <profile> add <候选来源>/plugin/dsh-harmony，然后 add <候选来源>/plugin/dsh-e2e。第二个路径目录名虽然旧，实际登记必须是dsh-log-analysis。
6. 若目标profile仍有dsh-e2e，使用同一CLI的 plugin --profile <profile> remove dsh-e2e。该命令维护profile依赖与pnpm锁；不要手工拼改锁文件。只移除包登记，不删除存储目录。
7. 执行 Node24 scripts/register-bundles.mjs <profile>/package.json，再执行 scripts/verify-install.mjs <profile>。两个新bundle必须存在，旧dsh-e2e不得激活，lib不得残留agent入口。
8. desktop和web都使用时分别重复profile登记。使用原启动器和同一个DSH_HOME冷启动，最后才刷新页面，使前后端一致。

## 验收

打开会话标题栏“日志分析”：原日志数量和名称应保持；导入、跨文件查找、精准行号定位、加入对话、跨会话管理可用。加入对话只追加当前草稿，不发送。删除只在插件日志副本范围，直接删除后不可恢复；测试删除只使用一次性验收副本。

Harmony首次开流记录真实首帧；A→B→A、切日志面板后返回应复用同设备流。唤醒、转屏、手工输入、截图录屏、批注加入对话要用真实手机检查。保持策略超时后应释放资源。未完成的真机项目必须列为未验，不以单元测试替代。

## 回滚

完整退出宿主，使用保留的旧来源和相同官方CLI重新 add 原 dsh-harmony/dsh-e2e；remove dsh-log-analysis。先从目标 profile/package.json 的 dsh.profile.bundles 中仅移除 dsh-log-analysis 登记，保留其它项；用旧来源的register-bundles脚本恢复旧两包bundle，并核对本次备份中的相关字段；保留其它插件和用户设置。用旧来源的verify-install检查后，原启动器冷启动。不要git reset当前候选，也不要git clean或删除 storages。回滚后从会话标题栏重新打开旧 dshVerify 标签（迁移时收起的标签不会自动重开）。旧版能继续读取原验证历史；已直接删除的日志不能靠回滚恢复。

## AI 执行升级的约束

先盘点实际来源与数据目录、版本和进程，再备份；所有命令使用真实绝对路径。不要输出令牌、Cookie或私密日志；不要申请更大权限、改ACL/全局执行策略或把DSH_HOME指向空目录来制造成功。检查命令退出码、profile真实包名和解析路径、前后端版本一致后，再分别报告注册检查、冷启动检查和真实设备验收。任何一步失败，保留备份与日志，停止安装后续步骤，不能宣称已完成。不得擅自公开发布本机候选。
