fn main() {
    tauri_build::build();
    // 链接 AVFoundation 使 iOS 运行时可通过 AnyClass::get 解析 AVAudioSession。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=framework=AVFoundation");
    }
    // tauri-build links its Common Controls v6 manifest only into binary targets.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let out = std::env::var("OUT_DIR").unwrap();
        println!("cargo:rustc-link-arg-examples={out}/resource.lib");
    }
}
