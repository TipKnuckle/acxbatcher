#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
swift build --package-path app -c release
APP="$ROOT/dist/ACX Batcher.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine"
cp app/.build/release/ACXBatcher "$APP/Contents/MacOS/ACXBatcher"
cp desktop-engine.mjs acx-page.mjs uploader.mjs plan.mjs "$APP/Contents/Resources/engine/"
cp -R node_modules "$APP/Contents/Resources/engine/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ACXBatcher</string>
<key>CFBundleIdentifier</key><string>com.tipknuckle.acxbatcher</string>
<key>CFBundleName</key><string>ACX Batcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
printf 'Built: %s\n' "$APP"
