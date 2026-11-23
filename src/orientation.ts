import { invoke, isTauri } from "@tauri-apps/api/core";
import { platform } from "./environment";

/** Rotate the native mobile container (Android/iOS); browser-only playback uses the Screen API. */
export async function setMobileOrientation(landscape: boolean): Promise<void> {
  if ((platform === "android" || platform === "ios") && isTauri()) {
    await invoke("set_orientation", { landscape });
    return;
  }
  const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> };
  if (landscape) {
    if (!orientation?.lock) throw new Error("当前环境不支持切换屏幕方向");
    await orientation.lock("landscape");
  } else {
    orientation?.unlock?.();
  }
}
