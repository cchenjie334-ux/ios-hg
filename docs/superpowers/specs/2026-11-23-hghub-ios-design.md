# HGhub iOS 定制版设计文档（B1 路线）

- **日期**：2026-11-23
- **上游基线**：`Minireel/HGhub` `v0.0.4`（许可证：`PolyForm Noncommercial 1.0.0`）
- **目标工作区**：`C:\Users\32269\.gemini\antigravity\scratch\HGhub-iOS`

## 1. 背景与目标

`Minireel/HGhub` 是基于 Rust + Tauri 2 + React + TypeScript 的跨平台插件播放器。官方 `v0.0.4` Release 虽产出过未签名 `HGhub_0.0.4_ios.ipa`，但标注“尚未验证可用性”，在实机安装与体验上存在多项缺失与兼容问题（无 iOS 原生横竖屏旋转、缺音频会话与后台音频声明、iOS 17+ 走 `hls.js` 导致失去硬件 PiP 与 AirPlay、文档选择器 `.mjs` 过滤限制、macOS `zip` 额外字段导致全能签等工具导入失败）。

本定制版采用 **B1 路线（基于 HGhub v0.0.4 源码深度修复与增强）**，目标如下：
1. 保持 **100% 完整兼容 HPP 1.0 插件协议** 与 **纯净空壳**（不内置任何内容源或第三方插件）。
2. 在 Rust 原生层、前端播放器层、Info.plist 配置与 IPA 打包/CI 链路系统性解决 iOS 已知短板。
3. 提供可直接推送至个人 GitHub 仓库触发 `macos-latest` 自动编译并校验 `.ipa` 的 GitHub Actions 工作流及中文安装指南。

## 2. 非目标

- 不做任何商业化、VIP、卡密或广告逻辑，严格遵守上游 `PolyForm Noncommercial 1.0.0`。
- 不在本地 Windows 环境下强行编译 iOS Rust/Xcode 目标（本地无 Xcode/macOS）；本地负责前端构建、单元测试、Shell 语法检查及静态代码/Rust 审查。
- 首期不新增第三方 iOS 原生 WebView 登录插件，聚焦播放、横竖屏、画中画、文件导入与打包兼容稳定性。

## 3. 五项核心改造模块

### 模块 1：iOS 原生横竖屏与音频会话（Rust 原生层）
- `src-tauri/Cargo.toml`：在 `[target.'cfg(target_os = "ios")'.dependencies]` 复用 `Cargo.lock` 已锁定的 `objc2 = "0.6"` 与 `objc2-foundation = "0.3"`（仅启用 `std`、`NSString`）。
- `src-tauri/build.rs`：iOS 目标下链接 `AVFoundation` 框架。
- `src-tauri/src/ios_platform.rs`（新建，仅 `#[cfg(target_os = "ios")]` 编译）：
  - `configure_audio_session()`：启动时将 `AVAudioSession` 设为 `AVAudioSessionCategoryPlayback` 并激活，保证 iPhone 静音开关开启时视频仍可出声并支持后台/画中画音频。
  - `request_orientation(landscape: bool)`：主线程执行。iOS 16+ 使用 `UIWindowSceneGeometryPreferencesIOS` 配合 `requestGeometryUpdateWithPreferences:errorHandler:` 并通知 `rootViewController` 刷新支持方向；iOS 15 兜底使用 `UIDevice` `setValue:forKey:` 与 `[UIViewController attemptRotationToDeviceOrientation]`。
- `src-tauri/src/lib.rs` / `src-tauri/src/commands.rs`：接入 `ios_platform`，为 iOS 实现 `set_orientation` 命令。

### 模块 2：iOS 插件文件选择器适配
- `src-tauri/src/plugins.rs`：在 `pick_plugin_files` 中，针对 iOS 跳过 `.add_filter("HPP 插件或列表", &["js", "mjs", "json"])`，使 `tauri-plugin-dialog` 使用通用 `UTType.item`，避免非标准 `.mjs` UTType 或分享转发文件的类型差异导致无法选中插件文件。

### 模块 3：iOS 原生 HLS、WebKit 画中画与 AirPlay（前端层）
- `src/orientation.ts`：扩展原生方向切换路由至 `platform === "android" || platform === "ios"`。
- `src/plugins/mediaCapabilities.ts`：新增 `isIosUserAgent()` 辅助函数；在 iOS 设备且原生支持 `application/vnd.apple.mpegurl` / `application/x-mpegURL` 时，`hlsPlaybackPath()` 优先返回 `"native"`，利用 iOS 系统硬件 AVPlayer 解码与原生 PiP/AirPlay，规避 iOS 17+ 下 `ManagedMediaSource` + WebWorker 兼容问题。
- `src/components/Feed.tsx`：升级 `togglePip`，优先支持 WebKit 专属 `webkitSupportsPresentationMode("picture-in-picture")` 与 `webkitSetPresentationMode`，同时保留标准 PiP API 路径。
- `src/components/VideoSurface.tsx`：检测标准 PiP 与 `webkitPresentationMode === "picture-in-picture"`；当页面隐藏但处于画中画模式时不暂停视频与加载，并添加 `x-webkit-airplay="allow"`。

### 模块 4：iOS Info.plist 权限与系统能力补全
- `scripts/patch-ios-plist.sh`（新建）：幂等注入 `CFBundleDisplayName`、三向 `UISupportedInterfaceOrientations*`、`NSAllowsArbitraryLoads`、`UIBackgroundModes: ["audio"]`、`UIFileSharingEnabled`、`LSSupportsOpeningDocumentsInPlace`、`UIRequiresFullScreen: false`。

### 模块 5：高兼容 IPA 打包、强校验与一键云构建
- `scripts/build-ios-unsigned.sh`（升级）：动态发现 `.app`、调用 `patch-ios-plist.sh`、清理 `.DS_Store`/`._*`/空 `assets` 目录及扩展属性 `xattr -cr`、支持 `unsigned` 与 `adhoc` 两种签名模式、使用 `zip -qrX` 剔除 macOS Unix Extra Fields（提升全能签/轻松签/AltStore/SideStore/TrollStore 兼容性），并执行校验脚本。
- `scripts/verify-ios-ipa.mjs`（新建）：跨平台检验 `.ipa` ZIP 头无 `__MACOSX`/`.DS_Store`/`._*`/Unix Extra Fields (`0x5455`/`0x7875`)、存在浅层 `Payload/*.app/Info.plist` 关键字段、ARM64 64-bit Mach-O 合法且无 `localhost:1420` 开发残留。
- `.github/workflows/build-ios-ipa.yml`（新建）：`frontend-check`（`ubuntu-latest`）+ `ios-ipa`（`macos-latest`，支持 `workflow_dispatch` 自定义版本号、Bundle ID、显示名及签名模式）。
- `docs/IOS_BUILD_AND_INSTALL.md`（新建）：推送构建、各工具签名安装与插件导入中文指南。

## 4. 验证边界

- **本机（Windows）可验证项**：`pnpm build`（TS 类型检查 + Vite 打包）、`node scripts/test-media-capabilities.mjs`、`node scripts/test-ios-compat.mjs`（含旋转、WebKit PiP、防误暂停、`verify-ios-ipa.mjs` 正反样本测试）、`node scripts/test-app-updates.mjs`、Bash 语法检查及工作流/JSON 校验、ECC `rust-reviewer` 与 `code-reviewer` 静态审查。
- **云端（macOS GitHub Actions）验证项**：`cargo` iOS 交叉编译、`tauri ios init`、`xcodebuild`、`patch-ios-plist.sh` 与实包 `.ipa` 校验。
