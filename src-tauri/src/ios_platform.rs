//! iOS 平台原生能力桥接：音频会话配置与屏幕方向切换。
//!
//! 仅在 `target_os = "ios"` 下编译。所有 Objective-C 类与选择器均通过运行时动态解析，
//! 并结合类检查与 `respondsToSelector:` 做安全防御，避免在旧版本或受限环境中崩溃。
//! 注意：不修改 `WKWebView.configuration` 的副本（`wry 0.57.1` 已在初始化时开启内联播放与画中画）。

use std::panic::AssertUnwindSafe;

use block2::Block;
use objc2::rc::{autoreleasepool, Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{exception, msg_send, sel, MainThreadMarker};
use objc2_foundation::NSString;

/// 检查 Objective-C 实例是否响应指定选择器。
fn responds_to_instance(obj: &AnyObject, selector: Sel) -> bool {
    if obj.class().responds_to(selector) {
        return true;
    }
    if obj.class().responds_to(sel!(respondsToSelector:)) {
        // SAFETY: `obj` 为有效 Objective-C 实例且其类支持 `respondsToSelector:`，
        // 传入合法 `Sel` 并以 `Bool` 接收返回值。
        let ok: Bool = unsafe { msg_send![obj, respondsToSelector: selector] };
        return ok.as_bool();
    }
    false
}

/// 检查 Objective-C 类是否响应指定类方法选择器。
fn responds_to_class(cls: &AnyClass, selector: Sel) -> bool {
    if cls.metaclass().responds_to(selector) {
        return true;
    }
    if cls.metaclass().responds_to(sel!(respondsToSelector:)) {
        // SAFETY: `cls` 为有效 Objective-C 类对象且其元类支持 `respondsToSelector:`，
        // 传入合法 `Sel` 并以 `Bool` 接收返回值。
        let ok: Bool = unsafe { msg_send![cls, respondsToSelector: selector] };
        return ok.as_bool();
    }
    false
}

/// 配置 iOS 音频会话类别为 `AVAudioSessionCategoryPlayback`。
///
/// 仅设置音频类别而不在启动时抢占激活会话，避免打断其他应用正在播放的音频；
/// 当网页视频开始播放时由 WebKit/AVPlayer 激活会话，从而在静音开关开启或切入画中画时正常出声。
pub fn configure_audio_session() {
    autoreleasepool(|_| {
        let Some(av_audio_session_cls) = AnyClass::get(c"AVAudioSession") else {
            return;
        };
        if !responds_to_class(av_audio_session_cls, sel!(sharedInstance)) {
            return;
        }
        // SAFETY: `AVAudioSession` 类已通过运行时解析且响应 `+sharedInstance`，返回值可能为 nil。
        let session: Option<Retained<AnyObject>> =
            unsafe { msg_send![av_audio_session_cls, sharedInstance] };
        let Some(session) = session else {
            return;
        };

        let category = NSString::from_str("AVAudioSessionCategoryPlayback");
        if responds_to_instance(&session, sel!(setCategory:error:)) {
            let mut err: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: `session` 为有效的 `AVAudioSession` 实例，`&*category` 为有效 `NSString` 引用，
            // `&mut err` 指向可空 `NSError*` 栈变量（由方法按 Cocoa 约定写入 autoreleased 错误对象）。
            let ok: Bool = unsafe {
                msg_send![&*session, setCategory: &*category, error: &mut err]
            };
            let _ = (ok.as_bool(), err);
        }
    });
}

/// 若 `UIWindowScene` 响应 `keyWindow`，通知其 `rootViewController` 刷新支持方向（iOS 16+）。
fn notify_root_view_controller_orientation(scene: &AnyObject) {
    if !responds_to_instance(scene, sel!(keyWindow)) {
        return;
    }
    // SAFETY: 已确认 `scene` 响应 `keyWindow`，返回值可能为 nil。
    let key_window: Option<Retained<AnyObject>> = unsafe { msg_send![scene, keyWindow] };
    let Some(key_window) = key_window else {
        return;
    };
    if !responds_to_instance(&key_window, sel!(rootViewController)) {
        return;
    }
    // SAFETY: 已确认 `key_window` 响应 `rootViewController`，返回值可能为 nil。
    let root_vc: Option<Retained<AnyObject>> = unsafe { msg_send![&*key_window, rootViewController] };
    let Some(root_vc) = root_vc else {
        return;
    };
    if responds_to_instance(&root_vc, sel!(setNeedsUpdateOfSupportedInterfaceOrientations)) {
        // SAFETY: 已确认 `root_vc` 响应 `setNeedsUpdateOfSupportedInterfaceOrientations`。
        let _: () = unsafe { msg_send![&*root_vc, setNeedsUpdateOfSupportedInterfaceOrientations] };
    }
}

/// 构造 iOS 16+ `UIWindowSceneGeometryPreferencesIOS` 方向偏好对象。
fn create_geometry_preferences(prefs_cls: &AnyClass, landscape: bool) -> Result<Retained<AnyObject>, String> {
    if !responds_to_class(prefs_cls, sel!(alloc))
        || !prefs_cls.responds_to(sel!(initWithInterfaceOrientations:))
    {
        return Err("当前系统不支持 UIWindowScene 方向偏好初始化".into());
    }
    // `UIInterfaceOrientationMaskLandscape` = (1 << 3) | (1 << 4) = 24（兼容左右横屏）；
    // `UIInterfaceOrientationMaskPortrait` = 1 << 1 = 2。
    let mask: usize = if landscape { (1 << 3) | (1 << 4) } else { 1 << 1 };
    // SAFETY: `prefs_cls` 已解析且同时响应 `+alloc` 与 `-initWithInterfaceOrientations:`，
    // 分配后立即初始化并由 `Retained` 托管内存生命周期。
    let prefs: Option<Retained<AnyObject>> = unsafe {
        let alloc: Allocated<AnyObject> = msg_send![prefs_cls, alloc];
        msg_send![alloc, initWithInterfaceOrientations: mask]
    };
    prefs.ok_or_else(|| "创建屏幕方向偏好对象失败".into())
}

/// 获取 `UIApplication.sharedApplication.connectedScenes.allObjects` 数组。
fn connected_scenes_array() -> Result<Retained<AnyObject>, String> {
    let app_cls = AnyClass::get(c"UIApplication")
        .ok_or_else(|| "无法获取 UIApplication 类".to_string())?;
    if !responds_to_class(app_cls, sel!(sharedApplication)) {
        return Err("UIApplication 不支持 sharedApplication".into());
    }
    // SAFETY: `UIApplication` 类响应 `+sharedApplication`。
    let app: Option<Retained<AnyObject>> = unsafe { msg_send![app_cls, sharedApplication] };
    let app = app.ok_or_else(|| "UIApplication.sharedApplication 为空".to_string())?;
    if !responds_to_instance(&app, sel!(connectedScenes)) {
        return Err("当前系统不支持 connectedScenes".into());
    }
    // SAFETY: 已确认 `app` 响应 `connectedScenes`。
    let scenes: Option<Retained<AnyObject>> = unsafe { msg_send![&*app, connectedScenes] };
    let scenes = scenes.ok_or_else(|| "connectedScenes 为空".to_string())?;
    if !responds_to_instance(&scenes, sel!(allObjects)) {
        return Err("connectedScenes 不支持 allObjects".into());
    }
    // SAFETY: 已确认 `scenes` 响应 `allObjects`。
    let all_objects: Option<Retained<AnyObject>> = unsafe { msg_send![&*scenes, allObjects] };
    let all_objects = all_objects.ok_or_else(|| "无法枚举已连接窗口场景".to_string())?;
    if !responds_to_instance(&all_objects, sel!(count))
        || !responds_to_instance(&all_objects, sel!(objectAtIndex:))
    {
        return Err("场景列表对象接口异常".into());
    }
    Ok(all_objects)
}

/// 通过 iOS 16+ `UIWindowSceneGeometryPreferencesIOS` 更新场景几何方向。
fn try_request_orientation_ios16(prefs_cls: &AnyClass, landscape: bool) -> Result<(), String> {
    let prefs = create_geometry_preferences(prefs_cls, landscape)?;
    let all_objects = connected_scenes_array()?;
    // SAFETY: 已确认 `all_objects` 响应 `count`，返回 `NSUInteger` (`usize`)。
    let count: usize = unsafe { msg_send![&*all_objects, count] };
    let mut requested = false;
    let nil_error_handler: Option<&Block<dyn Fn(*mut AnyObject)>> = None;

    for idx in 0..count {
        // SAFETY: `idx < count` 保证索引有效，返回 `UIScene` 或 nil。
        let scene: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*all_objects, objectAtIndex: idx] };
        let Some(scene) = scene else {
            continue;
        };

        notify_root_view_controller_orientation(&scene);

        if responds_to_instance(&scene, sel!(requestGeometryUpdateWithPreferences:errorHandler:)) {
            // SAFETY: 已确认 `scene` 响应 `requestGeometryUpdateWithPreferences:errorHandler:`，
            // `&*prefs` 为有效几何偏好对象，`nil_error_handler` 使用准确的 `@?` Block 类型编码。
            let _: () = unsafe {
                msg_send![
                    &*scene,
                    requestGeometryUpdateWithPreferences: &*prefs,
                    errorHandler: nil_error_handler
                ]
            };
            requested = true;
        }
    }

    if requested {
        Ok(())
    } else {
        Err("未找到支持几何方向更新的活动窗口场景".into())
    }
}

/// iOS 15 兜底方向切换路径：仅在缺失 iOS 16+ API 时调用，并通过 `exception::catch` 捕获潜在 KVC 异常。
fn request_orientation_ios15(landscape: bool) -> Result<(), String> {
    let device_cls = AnyClass::get(c"UIDevice").ok_or_else(|| "无法获取 UIDevice 类".to_string())?;
    let number_cls = AnyClass::get(c"NSNumber").ok_or_else(|| "无法获取 NSNumber 类".to_string())?;
    if !responds_to_class(device_cls, sel!(currentDevice))
        || !responds_to_class(number_cls, sel!(numberWithInteger:))
    {
        return Err("当前设备不支持屏幕方向切换".into());
    }

    // SAFETY: `UIDevice` 类已解析且响应 `+currentDevice`。
    let device: Option<Retained<AnyObject>> = unsafe { msg_send![device_cls, currentDevice] };
    let device = device.ok_or_else(|| "UIDevice.currentDevice 为空".to_string())?;
    if !responds_to_instance(&device, sel!(setValue:forKey:)) {
        return Err("当前设备不支持方向属性设置".into());
    }

    // `UIDeviceOrientationLandscapeLeft` = 3；`UIDeviceOrientationPortrait` = 1。
    let orientation_value: isize = if landscape { 3 } else { 1 };
    // SAFETY: `NSNumber` 类响应 `+numberWithInteger:`。
    let number: Option<Retained<AnyObject>> =
        unsafe { msg_send![number_cls, numberWithInteger: orientation_value] };
    let number = number.ok_or_else(|| "创建方向数值对象失败".to_string())?;
    let key = NSString::from_str("orientation");

    // SAFETY: 已确认 `device` 响应 `setValue:forKey:`，并使用 `exception::catch` 拦截可能的 `NSUnknownKeyException`。
    let kvc_result = unsafe {
        exception::catch(AssertUnwindSafe(|| unsafe {
            let _: () = msg_send![&*device, setValue: &*number, forKey: &*key];
        }))
    };
    if kvc_result.is_err() {
        return Err("当前系统拒绝通过 KVC 切换屏幕方向".into());
    }

    if let Some(vc_cls) = AnyClass::get(c"UIViewController") {
        let attempt_sel = sel!(attemptRotationToDeviceOrientation);
        if responds_to_class(vc_cls, attempt_sel) {
            // SAFETY: 已通过类方法检查确认 `UIViewController` 响应 `+attemptRotationToDeviceOrientation`。
            let _: () = unsafe { msg_send![vc_cls, attemptRotationToDeviceOrientation] };
        }
    }
    Ok(())
}

/// 请求将 iOS 界面方向切换为横屏（`landscape = true`）或竖屏（`landscape = false`）。
///
/// 运行时强制校验主线程；存在 `UIWindowSceneGeometryPreferencesIOS`（iOS 16+）时仅走官方 Scene API，
/// 不再回退至已废弃的 `UIDevice` KVC 路径。
pub fn request_orientation(landscape: bool) -> Result<(), String> {
    let Some(_mtm) = MainThreadMarker::new() else {
        return Err("必须在主线程切换屏幕方向".into());
    };
    autoreleasepool(|_| {
        if let Some(prefs_cls) = AnyClass::get(c"UIWindowSceneGeometryPreferencesIOS") {
            try_request_orientation_ios16(prefs_cls, landscape)
        } else {
            request_orientation_ios15(landscape)
        }
    })
}
