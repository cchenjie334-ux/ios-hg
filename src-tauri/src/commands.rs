use serde_json::{json, Value};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "android")]
pub struct OrientationPlugin(pub tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn set_orientation(landscape: bool, plugin: tauri::State<'_, OrientationPlugin>) -> Result<(), String> {
    plugin.0.run_mobile_plugin_async::<()>("setOrientation", serde_json::json!({"landscape": landscape})).await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn set_orientation(app: tauri::AppHandle, landscape: bool) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(crate::ios_platform::request_orientation(landscape));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "屏幕方向切换已取消".to_string())?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn set_orientation(landscape: bool) -> Result<(), String> {
    let _ = landscape;
    Err("当前平台不支持原生屏幕方向切换".into())
}

#[tauri::command]
pub fn app_boot() -> Value {
    json!({"strict_security":crate::network_policy::strict_security()})
}
#[tauri::command]
pub fn security_set(strict: bool) -> Result<bool, String> {
    crate::network_policy::set_strict_security(strict)?;
    Ok(crate::network_policy::strict_security())
}
#[tauri::command]
pub fn debug_log(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    crate::logging::append_debug(&app.path().app_data_dir().map_err(|e| e.to_string())?, &msg)
}
#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = crate::network_policy::parse_target(&url)?;
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_external_media(app: tauri::AppHandle, url: String) -> Result<(), String> {
    hghub_hpp::model::url(&url, true, true).map_err(|e| e.message)?;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}
