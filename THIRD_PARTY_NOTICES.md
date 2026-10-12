# 第三方来源与许可

- **Piora**：https://github.com/kexijiang/Piora ，MIT。Harmony 的 vendored 来源固定于提交 `69c2f4e1c8b037bbec0dad812d8e8606f880c7f3`（0.5.5-beta.16），保留完整许可。改动在适配源码和 `patches/phone-automation.json` 中。
- **e2e**：https://github.com/tester-army/e2e ，Apache-2.0。版本 0.19.0 通过 npm 安装，未把其依赖或 node_modules 提交进仓库。
- **旧 Harmony mirror HAP**：0.3.0 已退役，插件不再发行、签名、安装或连接该通道。Git 历史保留原来源记录；旧资源有本机归档。
- **HDC / libusb**：保留上游来源与许可文件以说明运行时来源；本仓库不发布 `hdc.exe` 或 `libusb_shared.dll`，用户自行安装 DevEco/SDK。
- **DevEco Testing 原生投屏扩展**：从仓库所有者的已安装资源中一次性导入 `libscrcpy_server_unix_6.6-20260418.z.so`，原字节不修改。仅保存在本人的私有仓库和本机插件中，用于个人安装，不赋予对外再分发许可，也不受本项目 MIT 许可覆盖。版本、哈希与资源来源见 `resources/native-video/manifest.json` 和 `docs/NATIVE_VIDEO.md`。依赖库的开源 notice 不能代替这份组件的许可。
- 其他 npm 依赖的版本、来源和完整依赖树由各插件的 `package-lock.json` 记录，其许可由各包保留。

