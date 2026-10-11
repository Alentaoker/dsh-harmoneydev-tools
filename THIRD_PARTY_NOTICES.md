# 第三方来源与许可

- **Piora**：https://github.com/kexijiang/Piora ，MIT。Harmony 的 vendored 来源固定于提交 `69c2f4e1c8b037bbec0dad812d8e8606f880c7f3`（0.5.5-beta.16），保留完整许可。改动在适配源码和 `patches/phone-automation.json` 中。
- **e2e**：https://github.com/tester-army/e2e ，Apache-2.0。版本 0.19.0 通过 npm 安装，未把其依赖或 node_modules 提交进仓库。
- **Harmony mirror**：公开 unsigned HAP 来自 Piora `v0.5.5-beta.15` 提交 `50c1a40398ae6acde8b1284d5170c81cb19dfde6` 的记录构建，来源、源码树哈希和公开验签/验收收据见资源目录。该 HAP 最低 API 26，公开文件不包含私有签名或设备 allow-list。保留其 HongJing 来源及 MIT notice。
- **HDC / libusb**：保留上游来源与许可文件以说明运行时来源；本仓库不发布 `hdc.exe` 或 `libusb_shared.dll`，用户自行安装 DevEco/SDK。
- **DevEco Testing 原生投屏扩展**：只从用户已经安装的本机软件读取，不发布、上传或附带其专有二进制。
- 其他 npm 依赖的版本、来源和完整依赖树由各插件的 `package-lock.json` 记录，其许可由各包保留。

