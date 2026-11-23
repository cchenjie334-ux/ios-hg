import Hls from "hls.js";
import type { Codec } from "./protocol";

export interface MediaCapabilities {
  codecs: Codec[];
  formats: ("hls" | "progressive")[];
}

/** Detect iOS / iPadOS (including desktop-mode Safari where UA reports Macintosh with touch points). */
export function isIosUserAgent(ua?: string, maxTouchPoints?: number): boolean {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const userAgent = ua ?? nav?.userAgent ?? "";
  const touchPoints = maxTouchPoints ?? (ua === undefined ? nav?.maxTouchPoints : 0) ?? 0;
  return /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1);
}

function hasNativeHls(video: HTMLVideoElement): boolean {
  return Boolean(
    video.canPlayType("application/vnd.apple.mpegurl") || video.canPlayType("application/x-mpegURL"),
  );
}

// Use exactly the path VideoSurface selects, including Hls.js's preference for
// ManagedMediaSource on non-iOS browsers. On iOS, prefer native AVPlayer HLS to
// preserve system PiP, AirPlay, and avoid ManagedMediaSource + Worker quirks.
export function hlsPlaybackPath(
  video: HTMLVideoElement,
  ios = isIosUserAgent(),
): "mse" | "native" | "unsupported" {
  if (ios && hasNativeHls(video)) return "native";
  if (Hls.isSupported()) return "mse";
  return hasNativeHls(video) ? "native" : "unsupported";
}

export function probeMediaCapabilities(ios = isIosUserAgent()): MediaCapabilities {
  const video = document.createElement("video");
  const mse = Hls.getMediaSource();
  const hlsPath = hlsPlaybackPath(video, ios);
  const candidates: [Codec, string[]][] = [
    ["h264", ["avc1.42E01E"]],
    ["hevc", ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"]],
    ["av1", ["av01.0.04M.08"]],
  ];
  const fileAudio = video.canPlayType('audio/mp4; codecs="mp4a.40.2"') === "probably";
  const mseAudio = hlsPath === "mse" && !!mse?.isTypeSupported('audio/mp4; codecs="mp4a.40.2"');
  const progressive = candidates.filter(([, profiles]) => fileAudio && profiles.some(
    profile => video.canPlayType(`video/mp4; codecs="${profile}"`) === "probably",
  )).map(([codec]) => codec);
  const hls = hlsPath === "mse" ? candidates.filter(([, profiles]) => mseAudio && profiles.some(
    profile => mse?.isTypeSupported(`video/mp4; codecs="${profile}"`),
  )).map(([codec]) => codec) : hlsPath === "native" ? progressive : [];
  // The protocol has no per-format codec matrix. Declare the conservative
  // intersection of enabled paths so a plugin can choose either advertised format.
  const paths = [progressive, hls].filter(codecs => codecs.length > 0);
  return {
    codecs: candidates.map(([codec]) => codec).filter(codec => paths.length > 0 && paths.every(path => path.includes(codec))),
    formats: [...(hls.length ? ["hls" as const] : []), ...(progressive.length ? ["progressive" as const] : [])],
  };
}
