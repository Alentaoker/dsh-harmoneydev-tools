# 图标识别与 SDK 索引

## 索引是什么

`resources/symbol-catalog.json` 由同一个 SDK 的两份文件按名称连接生成：`sysResource.js` 里 `sys.symbol` 的正式成员，以及 `HMSymbolVF.ttf` 的 cmap（码点 → 名称）。来源和 SDK 版本见 `resources/symbol-source.json`（当前为 API 26）。字体里有、正式成员里没有的名称不收录；没有码点的正式成员仍保留，可以按名称查。

名称在索引里，说明该 SDK 有这个系统资源，可以写成 `$r('sys.symbol.名')`；是否选对了图形，看设计节点、用途和截图。工程用的 SDK 与索引不同时，按文末方法重建。项目要求兼容更低系统版本时，再按项目要求核对所用资源。

## 查询

在 skill 根目录执行，只需 Python 标准库：

```text
python scripts/lookup-symbol.py --codepoint U+F01D5
python scripts/lookup-symbol.py --text "<设计节点里的字符，或 \uXXXX\uXXXX 转义形式>"
python scripts/lookup-symbol.py --name bell
```

`--name` 也可以直接传 `sys.symbol.bell` 或 `$r('sys.symbol.bell')`。查询其他索引时加 `--map <catalog.json>`。

HM Symbol 字符位于补充私用区。一个字符在 UTF-16 或 JSON 转义中占两个码元（如 `\udb80\uddd5`），按码点算仍是单个字符。

## 每个图标怎么处理

| 设计节点 | 处理 |
|---|---|
| 字体为 HM Symbol，且有单个字符 | 读当前实例的实际文本，按码点查；唯一命中直接使用。字号、字重、颜色按样式属性实现 |
| 只有 `icon_font` 分类，没有实际文字或字体字段 | 按节点的实际数据判断，不走码点查询 |
| 矢量、SVG、PNG、转曲轮廓 | 不自动匹配；和其他待定图标一起列给用户，见 [resource-arbitration.md](resource-arbitration.md) |
| 用户给了 symbol 名称 | 用 `--name` 查，存在就用 |
| 工程里已有对应资源，本次没改 | 直接复用 |
| 码点查不到、缺字占位、多个候选，或方向、含义明显不对 | 截图给用户，说明情况，请用户决定 |

## 重建索引

需要 `fontTools`，两份输入文件取自同一个 SDK；`--sdk-metadata` 可省略：

```text
python scripts/build-symbol-catalog.py --sdk-resource "<SDK>/sysResource.js" --font "<SDK>/HMSymbolVF.ttf" --sdk-metadata "<SDK>/oh-uni-package.json"
```

默认覆盖 `resources/` 下的两个 JSON，先备份。多个工程用不同 SDK 时，用 `--output`、`--source-output` 分别生成，查询时用 `--map` 指定；用于分享的索引可加 `--portable-provenance`，不记录本机绝对路径。
