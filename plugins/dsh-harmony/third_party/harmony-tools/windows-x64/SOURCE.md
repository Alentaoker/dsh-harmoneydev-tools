# Piora Harmony mirror release resource

This directory was staged by the tagged GitHub Actions run recorded below. The public release-mode HAP was built from `third_party/harmony-mirror` in an isolated workspace and intentionally remains unsigned. The same job created a separate private DevEco-signed copy, verified it with the API 26 SDK, accepted it on the registered HDC phone, and deleted it without uploading or packaging it.

- Repository: `kexijiang/Piora`
- Commit: `50c1a40398ae6acde8b1284d5170c81cb19dfde6`
- Workflow: `kexijiang/Piora/.github/workflows/harmony-preview.yml@refs/tags/v0.5.5-beta.15`
- Run: `37584784712` (attempt `1`)
- Source tree SHA-256: `cb7aa6704c18bc2af1077a88562a952f225edf1c19b7a1541a5508e4c54bed0f`
- Public unsigned HAP SHA-256: `de3760e93312cc84cd38ec2e194524a673249f10e30b0e86f52a231c2e082cb9`
- Public unsigned HAP size: `1429701` bytes
- Private acceptance HAP SHA-256: `373c0987dcc0203ac313c70922225f32fa58837ae5dae0f59cba7c1285fa60bf`
- Component: `com.ohos.scrcpy.server` `1.1.27` (`1000127`)
- SDK: `26.0.0.23`
- Signing receipt: `harmony-mirror-signature-verification.json`
- Device accepted: `2026-10-07T07:04:26.136Z`
- Native H.264 video evidence: `1080x2386@30`, `1` configuration packet(s), `15` frame(s), `1` IDR frame(s), `85371` bytes
- Screenshot evidence: `1216x2688`, `224289` bytes, SHA-256 `db21e45237cf8a8fb8ab873703dca23fb1184c1b9281e248cd9d931a31f89e57`

The public HAP contains no signing profile or device allow-list. Piora signs a private local copy with the user's DevEco-managed profile before installation and keeps that copy in the user data directory. The CI private acceptance HAP, profile extraction, signing descriptor, keystore, passwords, raw developer id, device ids, device serial and runner paths are never staged or uploaded. The receipt contains only certificate fingerprints, hashes, bounded metadata, counts and hashed device identity.

The retained HongJing-derived editable source and MIT notice are in `third_party/harmony-mirror`. The same-run provenance manifest binds the exact source, artifact, repository, commit, workflow, run and attempt; it does not infer provenance for any previously bundled binary.
