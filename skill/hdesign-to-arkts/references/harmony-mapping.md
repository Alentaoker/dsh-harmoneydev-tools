# 设计值到 ArkTS

## 先看工程

先读本次组件的现有实现和引用的资源，再扩展到相关模块，跳过 build、oh_modules 等生成和依赖目录。语义和显示效果都合适的已有组件、资源优先复用。设计值与工程封装或系统资源的表现冲突时，说明差异，请用户选择。

## 对照表

| 设计（Pixso） | ArkTS |
|---|---|
| 自动布局：横向 / 纵向，子项间距 | `Row({ space })` / `Column({ space })` |
| 主轴、交叉轴对齐 | 主轴 `.justifyContent(FlexAlign.*)`；交叉轴 `Row` 用 `.alignItems(VerticalAlign.*)`，`Column` 用 `.alignItems(HorizontalAlign.*)` |
| 子项尺寸：填充 / 固定 / 适应内容 | 主轴方向 `.layoutWeight(1)`，交叉轴方向 `.width('100%')` 或 `.height('100%')` / 固定宽高 / 不设 |
| 自动换行 | `Flex({ wrap: FlexWrap.Wrap })` |
| 没有自动布局的 frame | 用相邻节点的相对坐标之差算间距和边距 |
| 内边距 | `.padding({ top, right, bottom, left })` |
| 圆角、描边 | `.borderRadius()`、`.border({ width, color })` |
| 填充色 | `.backgroundColor()`；颜色变量与 `sys.color` 同名时用 `$r('sys.color.名')` |
| 不透明度 | 节点不透明度用 `.opacity()`；填充色自带的 alpha 写进颜色值 |
| 投影 | `.shadow({ radius, color, offsetX, offsetY })`；设计里的扩展（spread）没有同名参数 |
| 图层模糊、背景模糊 | `.blur()`、`.backdropBlur()`，或按效果选 `.backgroundBlurStyle()` |
| 文字 | `.fontSize()`、`.fontWeight()`、`.fontColor()`、`.lineHeight()`、`.letterSpacing()`、`.textAlign()`；百分比行高 = 字号 × 百分比；一段文字里混合样式用 `Span` |
| 文字截断 | `.maxLines()` 加 `.textOverflow({ overflow: TextOverflow.Ellipsis })` |
| 交互态变体（按下、禁用等） | `.stateStyles({ pressed: {...}, disabled: {...} })` |
| HM Symbol 图标 | 独立图标 `SymbolGlyph($r('sys.symbol.名'))`；文字中用 `SymbolSpan`；组件的 symbol 图标参数用 `SymbolGlyphModifier`；大小、颜色用 `.fontSize()`、`.fontColor([...])` |
| 导出的 SVG / PNG | `Image($r('app.media.名'))`；SVG 可用 `.fillColor()` 改色 |

组件实例以实例上的最终生效值为准；变体、实例覆盖和变量的读取方法见 [pixso-select.md](pixso-select.md)。

## 图标

按 [hmsymbol-index.md](hmsymbol-index.md) 处理；需要用户决定或导出时，按 [resource-arbitration.md](resource-arbitration.md)。
