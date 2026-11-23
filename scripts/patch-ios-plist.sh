#!/usr/bin/env bash
set -euo pipefail

PLIST="${1:?Usage: patch-ios-plist.sh <Info.plist path> [display_name]}"
DISPLAY_NAME="${2:-HGhub}"

if [[ ! -f "$PLIST" ]]; then
  echo "Info.plist not found: $PLIST" >&2
  exit 1
fi

PLIST_BUDDY="/usr/libexec/PlistBuddy"
if [[ ! -x "$PLIST_BUDDY" ]]; then
  echo "PlistBuddy not found or not executable: $PLIST_BUDDY" >&2
  exit 1
fi

ESCAPED_DISPLAY_NAME="${DISPLAY_NAME//\"/\\\"}"

"$PLIST_BUDDY" -c "Delete :CFBundleDisplayName" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :CFBundleDisplayName string \"$ESCAPED_DISPLAY_NAME\"" "$PLIST"

for key in \
  "UISupportedInterfaceOrientations" \
  "UISupportedInterfaceOrientations~iphone" \
  "UISupportedInterfaceOrientations~ipad"; do
  "$PLIST_BUDDY" -c "Delete :${key}" "$PLIST" 2>/dev/null || true
  "$PLIST_BUDDY" -c "Add :${key} array" "$PLIST"
  "$PLIST_BUDDY" -c "Add :${key}:0 string UIInterfaceOrientationPortrait" "$PLIST"
  "$PLIST_BUDDY" -c "Add :${key}:1 string UIInterfaceOrientationLandscapeLeft" "$PLIST"
  "$PLIST_BUDDY" -c "Add :${key}:2 string UIInterfaceOrientationLandscapeRight" "$PLIST"
done

"$PLIST_BUDDY" -c "Delete :NSAppTransportSecurity" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :NSAppTransportSecurity dict" "$PLIST"
"$PLIST_BUDDY" -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$PLIST"

"$PLIST_BUDDY" -c "Delete :UIBackgroundModes" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :UIBackgroundModes array" "$PLIST"
"$PLIST_BUDDY" -c "Add :UIBackgroundModes:0 string audio" "$PLIST"

"$PLIST_BUDDY" -c "Delete :UIFileSharingEnabled" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :UIFileSharingEnabled bool true" "$PLIST"

"$PLIST_BUDDY" -c "Delete :LSSupportsOpeningDocumentsInPlace" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :LSSupportsOpeningDocumentsInPlace bool true" "$PLIST"

"$PLIST_BUDDY" -c "Delete :UIRequiresFullScreen" "$PLIST" 2>/dev/null || true
"$PLIST_BUDDY" -c "Add :UIRequiresFullScreen bool false" "$PLIST"
