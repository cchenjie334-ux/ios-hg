/** WebKit HTMLVideoElement extensions used for iOS Safari / WKWebView Picture-in-Picture. */
export interface WebKitVideoElement extends HTMLVideoElement {
  webkitPresentationMode?: "inline" | "fullscreen" | "picture-in-picture";
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
}

function defaultDocument(): Document | undefined {
  return typeof document !== "undefined" ? document : undefined;
}

/** Return true when the given video element is actively presented in standard or WebKit PiP. */
export function isVideoInPictureInPicture(
  video: HTMLVideoElement | null | undefined,
  doc: Document | undefined = defaultDocument(),
): boolean {
  if (!video) return false;
  if (doc?.pictureInPictureElement === video) return true;
  return (video as WebKitVideoElement).webkitPresentationMode === "picture-in-picture";
}

/** Toggle Picture-in-Picture across standard Document PiP and WebKit presentationMode APIs. */
export async function toggleVideoPictureInPicture(
  video: HTMLVideoElement | null | undefined,
  doc: Document | undefined = defaultDocument(),
): Promise<"entered" | "exited" | "unsupported"> {
  if (doc?.pictureInPictureElement) {
    await doc.exitPictureInPicture();
    return "exited";
  }

  const webkitVideo = video as WebKitVideoElement | null | undefined;
  if (
    webkitVideo &&
    webkitVideo.webkitSupportsPresentationMode?.("picture-in-picture") &&
    typeof webkitVideo.webkitSetPresentationMode === "function"
  ) {
    const inPip = webkitVideo.webkitPresentationMode === "picture-in-picture";
    webkitVideo.webkitSetPresentationMode(inPip ? "inline" : "picture-in-picture");
    return inPip ? "exited" : "entered";
  }

  if (
    video &&
    doc?.pictureInPictureEnabled &&
    typeof video.requestPictureInPicture === "function"
  ) {
    await video.requestPictureInPicture();
    return "entered";
  }

  return "unsupported";
}
