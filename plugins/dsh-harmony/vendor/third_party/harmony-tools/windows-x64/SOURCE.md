# Bundled Harmony tools (Windows x64)

These files are shipped so Piora's desktop application can connect to an
OpenHarmony device and render a real-time video stream without requiring a
separate DevEco Studio installation.

## Provenance

- `hdc.exe` (`Ver: 3.2.0c`) and `libusb_shared.dll` were obtained from the
  `bundled_tools` directory of HongJing commit
  `1d470ea8f571f19fcbb6883cc6118fafed6fe14f`. HongJing documents these files
  as OpenHarmony SDK toolchain artifacts.
- `OHScrcpyServer.hap` was obtained from `release_packages/1.0.3` at the same
  HongJing commit. Its corresponding source is the `scrcpy_server` directory
  in that repository.
- HongJing source: https://github.com/guoxiucai/ohos-scrcpy-app
- OpenHarmony HDC source: https://gitee.com/openharmony/developtools_hdc
- OpenHarmony libusb source: https://gitee.com/openharmony/third_party_libusb

## Integrity

| File | SHA-256 |
| --- | --- |
| `hdc.exe` | `EBC15568FD7FC1C92E904AB09927EA810B1A569CF87DC8EB18551A4207D44418` |
| `libusb_shared.dll` | `5B31B0EB5F634C7522CD524E30267E9BD575FBC3DB169EB3C6E80630A60196D6` |
| `OHScrcpyServer.hap` | `A65A99F1222F8FC13C8D7AD33D01390A00FFD227A438840231F3860C69EDD0C7` |

## Licenses

- The HongJing device service is licensed under MIT; see
  `LICENSE-HONGJING-MIT.txt`.
- OpenHarmony HDC is licensed under Apache-2.0; see
  `LICENSE-OPENHARMONY-HDC-APACHE-2.0.txt`.
- libusb is licensed under LGPL-2.1-or-later; see
  `LICENSE-LIBUSB-LGPL-2.1.txt`.

The prebuilt HAP requires OpenHarmony screen-capture privileges. A target
device can reject installation or capture when its signing or permission
policy does not trust the bundled service.
