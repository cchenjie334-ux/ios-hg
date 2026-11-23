# HGhub iOS 定制版云端构建、签名安装与使用指南

本指南适用于 **HGhub iOS 定制版**（基于上游 `Minireel/HGhub` `v0.0.4` 源码适配增强，遵循 [PolyForm Noncommercial 1.0.0](../LICENSE) 非商业许可）。

> **纯净空壳声明**：HGhub 仅作为通用插件播放器载体，**不内置任何内容源、第三方插件或官方源列表**。首次安装后需由用户自行在「插件中心」导入插件使用。

---

## 一、相对官方 v0.0.4 的 iOS 修复清单

官方 `v0.0.4` Release 中提供的 `.ipa` 标注为“尚未验证可用性”，实机存在无法旋转、静音开关无声、画中画异常、文件选不中及自签工具兼容性等问题。本定制版完成了以下系统性修复：

1. **iOS 原生横竖屏旋转**（`src-tauri/src/ios_platform.rs`、`src/orientation.ts`）
   - 打通前端 `set_orientation` 到 iOS 原生层的调用链。
   - iOS 16+ 使用 `UIWindowSceneGeometryPreferencesIOS` 与 `requestGeometryUpdateWithPreferences:errorHandler:`，并通知根视图控制器更新支持方向；iOS 15 自动兜底 `UIDevice` 方向切换与 `UIViewController.attemptRotationToDeviceOrientation`。
   - `Info.plist` 完整声明 `UISupportedInterfaceOrientations`、`~iphone` 与 `~ipad` 三向方向（竖屏、左横屏、右横屏），并设置 `UIRequiresFullScreen = false`。
2. **音频会话与后台播放支持**（`AVFoundation` + `AVAudioSession` + `UIBackgroundModes`）
   - 应用启动时配置 `AVAudioSessionCategoryPlayback` 并激活，解决 **iPhone 侧边静音拨片打开时视频无声** 的问题。
   - `Info.plist` 注入 `UIBackgroundModes = ["audio"]`，保障画中画及后台音频播放不被系统立刻挂起。
3. **iOS 原生 HLS、WebKit 画中画与 AirPlay**（`src/plugins/mediaCapabilities.ts`、`src/components/Feed.tsx`、`src/components/VideoSurface.tsx`）
   - 识别 iOS UA（含 iPadOS 桌面模式 `Macintosh` + 多点触控），优先走系统原生 AVPlayer HLS（`"native"`），避开 iOS 17+ 下 `ManagedMediaSource` + WebWorker 的兼容问题，同时恢复硬件解码、原生控制栏与 AirPlay 隔空播放（`x-webkit-airplay="allow"`）。
   - 画中画按钮优先调用 WebKit 原生 `webkitSupportsPresentationMode("picture-in-picture")` / `webkitSetPresentationMode`。
   - 页面切入后台时若检测到处于系统画中画状态，不再强制暂停播放。
4. **插件文件选择器兼容 iOS「文件」App**（`src-tauri/src/plugins.rs`、`scripts/patch-ios-plist.sh`）
   - iOS 端 `pick_plugin_files` 移除严格扩展名过滤，改用系统通用文件类型（`UTType.item`），解决 `.mjs` 插件或微信/Safari 转发文件在 iOS「文件」选择器中变灰无法勾选的问题。
   - 注入 `UIFileSharingEnabled = true` 与 `LSSupportsOpeningDocumentsInPlace = true`，支持在 iOS「文件」App 的「我的 iPhone → HGhub」中直接存取与就地打开插件文件。
5. **高兼容 IPA 打包与跨平台包体强校验**（`scripts/build-ios-unsigned.sh`、`scripts/verify-ios-ipa.mjs`）
   - 打包前清理 `.DS_Store`、`._*` AppleDouble 隐藏文件、空 `assets` 目录及扩展属性（`xattr -cr`）。
   - 使用 `zip -qrX` 剔除 macOS Unix Extra Fields（`0x5455` / `0x7875`），避免全能签、轻松签、GBox、AltStore、SideStore 等工具解析报错。
   - 输出前自动校验 `Info.plist` 关键键值（`CFBundleDisplayName`、`UIBackgroundModes`、`NSAllowsArbitraryLoads` 等）、ARM64 64-bit Mach-O 可执行头及确保无 `localhost:1420` 开发残留。

---

## 二、推送代码到 GitHub 并触发 Actions 构建 `.ipa`

由于 iOS 交叉编译和 Xcode 打包依赖 macOS 环境，本仓库提供了开箱即用的 `.github/workflows/build-ios-ipa.yml`（**Build iOS IPA** 工作流），利用 GitHub 免费的 `macos-latest` Runner 自动构建并校验产物。

### 1. 准备与推送代码
1. 将本仓库推送（或 Fork 后推送）到你自己的 GitHub 仓库。
2. 打开 GitHub 仓库主页，进入顶部的 **Actions** 标签页；如果是首次在 Fork 仓库使用，点击 **I understand my workflows, go ahead and enable them** 启用工作流。

### 2. 触发构建的两种方式
- **方式 A：自动触发**
  - 向 `main` 分支推送代码且改动涉及 `src/**`、`src-tauri/**`、`scripts/**`、`package.json` 或 `.github/workflows/build-ios-ipa.yml`；
  - 或推送 `v*` 版本标签（例如 `v0.0.4-ios.1`）。
- **方式 B：手动触发（推荐自定义 Bundle ID 与签名模式）**
  1. 在 GitHub 仓库点击 **Actions → Build iOS IPA → Run workflow**。
  2. 按需填写表单参数：
     - **version**：应用版本号；留空则自动读取 `package.json` 中的 `version`。
     - **bundle_id**：iOS 应用包名，默认 `com.hghub.player`；如需同一台手机多开或适配特定个人描述文件，可改为例如 `com.yourname.hghub`。
     - **display_name**：桌面显示名称，默认 `HGhub`。
     - **signing_mode**：签名模式，可选 `unsigned`（默认）或 `adhoc`。
  3. 点击绿色 **Run workflow** 按钮开始构建。

### 3. 下载 `.ipa` 产物
1. 等待工作流中的两个任务 `前端构建与 iOS 兼容自检` 和 `编译并校验 iOS IPA` 全部变为绿色对勾（通常首次无缓存需数分钟，后续有 Rust 缓存会更快）。
2. 点进本次运行详情页，滑到底部 **Artifacts** 区域。
3. 点击下载 **`hghub-ios-ipa`** 压缩包（保留 30 天），解压即可得到 `.ipa` 安装包。

---

## 三、`unsigned` 与 `adhoc` 模式选择建议

| 模式 | 输出文件名 | 特征与适用场景 | 选择建议 |
| --- | --- | --- | --- |
| **`unsigned`**（默认） | `HGhub_<版本>_ios.ipa` | 完全剔除 `_CodeSignature` 目录与签名残留，包体最纯净 | **绝大多数用户首选**。适合交给 **全能签、轻松签、GBox、AltStore、SideStore、Sideloadly** 重签安装，也支持 **TrollStore** |
| **`adhoc`** | `HGhub_<版本>_ios_adhoc.ipa` | 使用 `codesign --force --sign - --deep` 进行本地 Ad-Hoc 临时签名 | 仅推荐给 **TrollStore（巨魔商店）** 直接安装或越狱设备（装有 AppSync Unified）使用；普通未越狱设备无法直接安装 Ad-Hoc 包 |

> 若不确定自己将用哪种方式安装，直接选默认 **`unsigned`** 即可。

---

## 四、常见签名与安装工具说明

### 1. TrollStore（巨魔商店，永久免重签）
适用系统：支持 TrollStore 的 iOS 版本（如 iOS 14.0–16.6.1、16.7 RC、17.0 等，具体以设备芯片与 TrollStore 支持列表为准）。
1. 在 iPhone Safari 中下载（或通过隔空投送传入）`HGhub_<版本>_ios.ipa` 或 `_ios_adhoc.ipa`。
2. 在「文件」App 中找到该 `.ipa`，点击左下角 **分享** 按钮，选择 **TrollStore**。
3. 在弹出提示中点击 **Install**，数秒后即可完成安装，无需 Apple ID、无 7 天过期限制。

### 2. 全能签 / 轻松签（ESign） / GBox（手机端证书自签）
适用系统：未越狱 iOS 设备（需自备个人开发者 P12 证书及对应的 `.mobileprovision` 描述文件）。
1. 确保工具内已导入有效的 P12 证书与描述文件。
2. 将 `unsigned` 版 `.ipa` 分享导入至 **全能签 / 轻松签 / GBox** 的「文件」管理页。
3. 点击 `.ipa` → **导入应用库 → 签名**，确认 Bundle ID 与描述文件匹配（如使用固定单包名证书，可在工作流 `bundle_id` 参数预先填好或签名时改写 Bundle ID），签名完成后点击 **安装**。
4. 若工具提示开启安装权限或信任证书，前往系统 **设置 → 通用 → VPN 与设备管理** 信任对应开发者证书（iOS 16+ 如需打开 **开发者模式**，请按系统提示在 **设置 → 隐私与安全性 → 开发者模式** 开启并重启）。

### 3. AltStore / SideStore（免费 Apple ID 自签，7 天有效）
适用系统：任意未越狱 iPhone / iPad，无需付费开发者账号，7 天内刷新一次即可续期。
1. **AltStore**：在电脑安装并启动 AltServer，用数据线连接 iPhone（或开启同一 Wi-Fi 无线同步），确保手机已安装 AltStore。
   **SideStore**：在设备配置好配对文件与本地 VPN（如 StosVPN / WireGuard）并保持连接。
2. 将 `unsigned` 版 `.ipa` 保存到 iPhone **「文件」App** 中。
3. 打开 **AltStore / SideStore**，切换到 **My Apps** 标签页，点击左上角 **`+`**，选择刚才保存的 `.ipa`。
4. 按提示输入登录该工具的 Apple ID 签名并安装（注意免费个人 Apple ID 同时最多激活 3 个自签应用，且占用 App ID 数量上限）。
5. 首次安装后前往 **设置 → 通用 → VPN 与设备管理** 信任你的 Apple ID，并按需开启 **设置 → 隐私与安全性 → 开发者模式**。

### 4. Sideloadly（Windows / macOS 电脑端安装）
适用系统：有电脑但不想在手机端部署 AltStore/SideStore 的用户。
1. 电脑下载安装最新版 **Sideloadly**，并用数据线连接 iPhone，在手机上点击 **信任此电脑**。
2. 打开 Sideloadly，将 `unsigned` 版 `.ipa` 拖入窗口左上角 IPA 图标区域，填写你的 Apple ID。
3. 一般保持默认选项直接点击 **Start**（如需修改安装后的包名或名称，可在展开 **Advanced Options** 后调整，或在触发 GitHub Actions 时提前传入 `bundle_id` / `display_name`）。
4. 进度条显示 `Done.` 后，同样在手机 **设置 → 通用 → VPN 与设备管理** 中信任证书并在 **开发者模式**（iOS 16+）启用即可运行。

---

## 五、首次打开与在「插件中心」导入插件

安装并首次打开 HGhub 后，由于应用本身是纯净空壳，界面会提示还没有安装插件。请按以下任意方式导入符合 HPP 1.0 协议的插件或插件列表：

### 进入「插件中心」
- 手机端点击底部导航栏最右侧的 **「我的」**，进入 **「插件中心」**（或直接点击空白首页上的引导按钮），随后点击右上角 **`+`** 或切换顶部分栏至 **「导入与订阅」**。

### 三种导入方式
1. **方式一：通过网址（URL）导入插件或订阅列表（最省事）**
   - 在 **「从网址导入插件或订阅列表」** 输入框中粘贴插件脚本（`.js` / `.mjs`）或插件列表（`manifest.json`）的 HTTPS 链接。
   - 点击 **「读取列表或插件」**，在预览弹窗中勾选需要安装的插件，点击 **「导入所选插件」**。
   - 如果导入的是远程插件列表，还可点击 **「保存订阅」**，以后可在「插件订阅」卡片中一键刷新获取更新。
2. **方式二：粘贴代码导入**
   - 向下滚动至 **「本地文件与开发调试」** 区域，点击展开 **「粘贴代码导入」**。
   - 将完整的插件 JavaScript 代码粘贴到文本框，点击 **「导入代码」** 即可完成本地安装与启用。
3. **方式三：通过 iOS「文件」App 导入本地文件**
   - 先通过 Safari 下载、隔空投送（AirDrop）或微信「用其他应用打开 → 存储到“文件”」将插件 `.js` / `.mjs` / `manifest.json` 保存到 iPhone 的 **「文件」App**（推荐放到 **「我的 iPhone → HGhub」** 文件夹，也可放在 iCloud 云盘任意目录）。
   - 回到 HGhub **「插件中心 → 导入与订阅」**，点击 **「选择插件文件」**，在弹出的系统文件选择器中选中目标文件并确认预览导入即可。

---

## 六、常见问题排查（FAQ）

1. **GitHub Actions 构建失败或找不到 Artifact？**
   - 检查个人仓库 **Settings → Actions → General** 是否允许运行 Actions。
   - 如果手动触发时修改了 `signing_mode`，请确认仅选择 `unsigned` 或 `adhoc`。
   - 构建日志中的 `verify-ios-ipa.mjs` 会输出具体校验步骤，若因上游改动触发校验失败，可在对应 Job 日志末尾查看具体报错信息。
2. **自签工具导入 `.ipa` 时提示压缩包损坏或包含异常文件？**
   - 本定制版的 `build-ios-unsigned.sh` 已默认使用 `zip -qrX` 剔除 macOS Unix 扩展字段并清除 `.DS_Store` / `._*` 文件，且经过 `verify-ios-ipa.mjs` 自动校验。
   - 如果你是在下载 `.ipa` 后自己用 macOS 访达重新解压再压缩过，会重新混入 `__MACOSX` 与扩展字段导致自签工具报错；请使用 GitHub Actions 直接产出的原始 `.ipa`，或在电脑上执行 `node scripts/verify-ios-ipa.mjs <你的.ipa路径>` 进行排查。
3. **点击「选择插件文件」后，`.mjs` 或 `.js` 文件在「文件」App 中呈灰色不可点选？**
   - 请确认安装的是本定制版而非上游官方 `v0.0.4`（本版已在 Rust 层移除了 iOS 的严格扩展名过滤器）。
   - 如果文件仍在 iCloud 云盘显示“云朵”图标未下载到本地，先在系统的「文件」App 中点一下触发下载完成后再选；或者改用「粘贴代码导入」直接粘贴源码。
4. **打开后播放无声音或屏幕不跟随旋转？**
   - 首先确认 iOS 控制中心没有锁定 **「竖排方向锁定」**。
   - 在视频全屏播放界面点击旋转按钮即可触发原生横竖屏切换。
   - 静音拨片开启时仍无声音：请尝试关闭后重新开启播放或检查插件返回的流媒体地址是否本身无音轨。
5. **部分视频源开启画中画（PiP）无效？**
   - 只有在使用系统原生视频解码（例如 HLS `.m3u8` 原生流或原生 MP4/MOV 等）时才支持系统级 WebKit 画中画与 AirPlay。若某些插件返回了不支持原生播放的特殊流格式或视频尚未加载出首帧，需等待首帧起播后再点击画中画按钮。
6. **使用 AltStore / SideStore / Sideloadly 安装 7 天后打不开了怎么办？**
   - 这是苹果免费个人签名的 7 天有效期限制。**切勿卸载重装**（卸载会清空本地插件和片库记录），只需直接用原工具重新签名覆盖安装或点击 Refresh 续签即可保留所有本地数据继续使用。
