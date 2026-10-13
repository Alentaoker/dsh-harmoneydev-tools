# DevEco HiLog 静态研究与日志面板设计

研究日期：2026-10-14。范围为本机 DevEco Studio 26.0.0.851 的 HiLog 插件；用于借鉴交互和有限缓冲设计。没有复制 DevEco 代码、JAR、图标或其它二进制到插件，也没有执行被分析的类。

## 证据与范围

- 对象：`plugins/openharmony/lib/ohos_hilog-26.0.0.851.jar`，SHA-256 `97aeff9ef7c8279981a88aaabb0f45262612e990817ee321166ceb6282837b65`。
- 实际使用已安装的 REA 6.4.0 CLI、已有 Node 24.19.0，调用 `inspect-artifact`。未改 Codex 注册，未新增分析引擎。
- REA Evidence：`ev_1e1c3bac155d8b5934db76a477fa9d7dd5f0770bfa1b6573de54121e96917cd2`。
- 库存 Evidence：`ev_0d3db9e12c267c514af5f565e0d6c425e4bbcceb15f370cdd3fc0fe36f0cb998`；manifest：`agm_1a519f94db276f96962b1bd47ae456b424572e3142c3674c9601804ffb3f1da7`。
- REA 确认 ZIP 容器身份及中央目录中的类/资源成员，不提供 Java 方法语义。本次没有将 JAR 当作 .NET PE/CLI managed assembly 分析；Java 字节码部分使用已安装 JDK 的 `javap -p -c -constants`，这是普通静态工具证据，不能称作 REA 反编译结果。
- 完整 REA JSON、类库存、关注类的字节码输出及其哈希仅保存在本机 `artifacts/hilog-rea-2026-10-14/`，该目录已被 Git 忽略。研究文档不包含手机日志、密钥或设备标识。

## 已核对的实现行为

| 问题 | 静态观察 | 对 DSH 的启示 |
| --- | --- | --- |
| 结构化列 | `HiLogHeader`、`HiLogPattern`、格式化类区分时间、PID、TID、级别、domain/tag 和消息。`BaseConsole` 实际使用 IntelliJ `EditorEx` 和 `DocumentEx`，外观为对齐文本列，不是 Swing JTable。 | 独立解析 HiLog 字段，DSH 用轻量虚拟列表/分页实现对齐列；不引入整个 IDE 编辑器。原始行需保留，解析失败仍可查看。 |
| 级别 | `HiLogLevelFilter.isAcceptable` 比较日志优先级与所选优先级，日志级别大于等于所选级别时通过。 | 清楚标明“最低级别”，例如 Warning 表示 Warning/Error/Fatal，避免让用户误以为仅显示 Warning。 |
| 内容过滤 | `HiLogFilterModel` 普通模式是包含匹配，关闭大小写敏感时使用 `Locale.ROOT` 小写比较；正则使用 `Matcher.find`，不是全字符串匹配。多个条件依次拒绝，形成 AND 组合。 | 过滤栏区分正文、TAG、PID/TID、级别；正则/大小写开关与作用字段明确。默认普通包含匹配；高级条件可组合。 |
| 正则编译 | `prepareCustomPattern` 在条件或开关变化时编译并缓存 Pattern，捕获语法错误；非法正则会回到普通匹配路径。 | 条件变更时仅编译一次。DSH 应显示错误并保留旧结果，避免静默改变匹配语义；不能照搬非法表达式的回退。复杂表达式还需独立计算或保守约束。 |
| TAG 输入 | `HiLogFiltersBar` 有单独 TAG 输入；`CharacterUtil.formatTagInput` 做输入规范化与最多 10 个逗号分隔项限制；`OpenHarmonyDevice.startGetLogBySocket` 将 TAG 附加到发给 HDC 库的日志命令。 | 普通查看过滤与设备采集过滤要分开。E2E 应先留存任务所需证据，再按 TAG 筛选查看，不能因更改查看条件丢失原始日志。 |
| 自定义过滤 | `CustomFilter` 支持消息、包名、PID 和级别；消息/包名各有正则与大小写选项。 | 可以保存常用过滤条件，但 P0 先做好基础字段和明确语义。 |
| 查找高亮 | `HiLogConsole.notifySearchTextChanged` 操作 `EditorSearchSession`，可设置大小写和正则；查找/高亮和日志接受过滤为不同调用链。 | Ctrl+F 打开面板内查找，不改变已采集数据或过滤条件；显示命中数与上一项/下一项。高亮仅对当前渲染行计算，不为整份日志建成千上万个 DOM 标记。 |
| 暂停/跟随 | `HiLogPauseOutputAction` 修改 `isOutputPaused`，打印循环暂停消费；`HiLogScrollToEndAction` 操作编辑器滚到底部。 | DSH 的“暂停显示”和“停止采集”应使用不同按钮。用户向上滚动时暂停跟随，新日志继续有限采集或落盘，显示待看条数。 |
| 有限输入队列 | `HiLogLineReceiver` 使用容量 5000 的 `ArrayBlockingQueue`，有独立接收/打印流程。 | 有界队列和明确拥塞处理；不要为每条日志立即更新 React。停止、切换设备和关闭面板应可靠清理连接和计时器。 |
| 环形缓存 | `HiLogLineReceiver` 使用队列保存消息，根据 `HiLogMessage.getLen` 淘汰最旧消息。其默认限制值为 4194304，或使用 IDE ConsoleBuffer 的配置。`getLen` 是格式化字符串的 UTF-16 字符数，不是实测堆内存字节数。 | 同时限制条数和字符/字节量，显示已淘汰数量；不能把 4M 字符限额宣称为 4 MiB 内存占用。完整历史用磁盘存储与分页读取。 |
| 显示文档裁剪 | `DocumentAppender.trimToSize` 在文档超过限额时删除头部并按换行边界裁剪，失效的 RangeMarker 也被清理。 | 可视区域只留有限行；筛选结果与查找索引也要限制，避免原始缓存有限而高亮/索引无限增长。 |
| 合批刷新 | `HiLogConsole` 将内容、颜色和链接范围合并到 `TextAccumulator`；约 100 ms 或累计文本超过阈值时输出。阈值从 1000 开始自适应，上限 262144；比较量实际是文本长度，不能当作“每批 262144 条日志”。 | 收到日志按批刷新，隐藏时降低 UI 更新，虚拟列表只渲染可见区；这些是 DSH 设计选择，需在 DSH 实测性能。 |

## 本轮建议采用的交互

1. 顶部显示设备/任务、采集状态、已采集与当前命中数量、留存范围和截断信息。
2. 使用最低级别、TAG、PID/TID、正文条件；提供正文正则和大小写开关；给非法表达式即时错误说明。
3. 日志区域使用固定行高、水平滚动的列；多行详情放在选中行详情区域，避免高峰时不断改变所有行高度。
4. Ctrl+F 提供独立查找、高亮、命中导航与 Escape 关闭；明确当前搜索范围为全部留存记录、筛选结果或当前页。
5. 暂停显示、继续跟随、清空视图、导出分别操作；清空视图不删除 E2E 已保存的任务证据。
6. Harmony 实时查看与 E2E 历史报告使用一致的字段和过滤语义；E2E 通过页式 API 读取磁盘记录，AI 读取同样的筛选结果与前后上下文。
7. 控制内存：有界采集缓冲、有限解析缓存、分页响应、虚拟渲染、合批刷新、任务日志流式写盘。性能验收包括长文本、高峰日志、反复切换面板、关闭采集后资源释放。

## 局限与未验证项

- 本轮是静态分析与用户提供界面图的交互参考，没有测量 DevEco JVM 的实时内存、CPU 或极端负载表现，不声称已证明它的整体内存占用低。
- 没有在 DevEco 实际按 Ctrl+F 进行键盘验收；静态证据确认其使用 IDE 查找机制，DSH 的 Ctrl+F 行为需由自己的 UI 测试验证。
- 没有追入 HDC 库验证多 TAG 的精确匹配/排除语法，不能直接宣称 TAG 支持任意正则；DSH 的 TAG 多值与正则规则应自行定义并测试。
- REA archive 结果中部分 Java class 被通用魔数探测标作 `mach-o-universal`，这是 `CAFEBABE` 魔数重合，不能据此认为本 JAR 包含可执行 Mach-O。分析以 ZIP 路径与 Java 字节码结构为准。
- `HiLogCustomPersistenceOptions` 管理格式选项，不证明日志正文自动落盘、轮转或无限保留；本轮磁盘分段留存建议是 DSH 自己的设计。
- Java 与 JavaScript 的正则方言有差异；安装或使用文档必须以 DSH 实际支持的正则语法为准。
