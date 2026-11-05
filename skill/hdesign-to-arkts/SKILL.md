---
name: hdesign-to-arkts
description: 在 HarmonyOS/ArkTS 项目中按 hdesign/Pixso 设计稿做界面时使用：新增或调整页面、控件、可见状态、颜色、布局、间距、字体、尺寸、图标，修复与设计稿或视觉稿不一致的走查问题，或查询设计参数、某个图标对应的 sys.symbol。需求澄清、写 plan、直接开发都适用；给了 Pixso 链接或只描述功能都适用。界面呈现不变的纯逻辑修改不用；用户已给出具体数值或明确不按设计稿时也不用。
---

# hdesign-to-arkts

从 Pixso 设计稿读取实现 UI 所需的设计值和图标资源，然后继续当前的开发任务。设计数据只通过 Pixso Desktop MCP 的只读接口读取；ArkTS 代码由你按工程规范编写，不使用 Pixso 的 `design_to_code` 等转代码能力。

## 先判断模式

| 模式 | 做到哪一步 |
|---|---|
| 仅查参数或图标 | 给出取到的值和资源，到此为止 |
| 需求澄清、写 plan | 定目标、定图标处理方式，把设计依据写进 plan，不提前实现 |
| 直接开发（没有 plan） | 定目标、取值，然后实现 |
| 按 plan 开发 | 先用 plan 里已取到的设计值，只补缺的，再实现 |
| 修视觉走查问题 | 读当前实现值和设计值，只改两者不一致的地方 |

只覆盖本次改动影响的区域和状态；设计稿里还有别的页面或状态，不据此扩大需求。

## 不取参的情况

- 用户已给出具体数值，或说不用看设计稿、按现有风格做：照用户说的实现。
- 当前会话没有 Pixso MCP，用户也没提设计稿：说明一句“未对照设计稿”，然后按工程现有规范继续。
- 用户提到了设计稿，但 Pixso MCP 不可用：问一次“等接上 Pixso，还是先按现有规范实现、之后再对照？”，按回答继续。

## 最短路径

1. **定目标**：有链接时用其中的 page-id、item-id。没有链接时，按需求里的页面名、业务文案，从页面和顶层 frame 缩小范围；需要用户帮忙时问页面、区域或附近文字，不要求用户提供 GUID。候选唯一，且页面、设备形态（手机、平板、横屏）和状态与需求吻合，就继续；有多个候选时给候选截图请用户选，或请用户在 Pixso 里选中目标。
2. **取值**：新区域对目标 frame 取一次 DSL（simplify）加一张截图；局部改动用 `query_nodes` 只取要改的字段。数值以设计模型为准，截图用来核对目标和观感。
3. **图标**：新区域列齐区域内可见图标（含组件实例内部），局部改动只看受影响的图标。HM Symbol 文字按码点查 SDK 索引，唯一命中直接用；矢量、SVG、PNG 图标和查不到的图标集中列出，每个附默认方案，请用户一轮确认，确认后再导出。
4. **写 ArkTS**：按 [harmony-mapping.md](references/harmony-mapping.md) 的对照表实现，优先复用工程已有的组件和资源。
5. **收尾**：分别说明设计取参、编译、运行核对做到了哪一步，并列出待定项。

写 plan 时完成第 1 步和第 3 步里需要用户决定的部分，结果写进 plan；执行时做第 2、4、5 步，不再为这些问题打断用户。

## 参考资料

- 定位与取参：[pixso-select.md](references/pixso-select.md)
- 设计值到 ArkTS：[harmony-mapping.md](references/harmony-mapping.md)
- 图标与 SDK 索引：[hmsymbol-index.md](references/hmsymbol-index.md)
- 待定图标与导出：[resource-arbitration.md](references/resource-arbitration.md)
- plan 与交接记录：[checklist-template.md](references/checklist-template.md)

## 少走弯路

- 已读到的子树、组件和变量不重复读取；同一调用失败且没有新线索时，问用户，不原样重试。
- 取不到的值标“未知”，并说明是没有该属性、工具没返回还是解析失败。
- 某个区域或图标待定时，只暂停依赖它的部分，其余继续。
- 按当前环境实际的工具名和 schema 调用 Pixso MCP，`mcp__pixso__*` 只是常见命名。
