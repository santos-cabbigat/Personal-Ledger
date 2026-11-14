#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
tools="${ANDROID_HOME:?}/build-tools/35.0.0"
platform="$ANDROID_HOME/platforms/android-35/android.jar"
out=build
mkdir -p "$out/classes" "$out/dex"
"$tools/aapt2" compile --dir res -o "$out/resources.zip"
"$tools/aapt2" link -o "$out/base.apk" --manifest AndroidManifest.xml -I "$platform" "$out/resources.zip"
javac --release 8 -classpath "$platform" -d "$out/classes" src/OpenApp.java
jar cf "$out/classes.jar" -C "$out/classes" .
"$tools/d8" --min-api 23 --lib "$platform" --output "$out/dex" "$out/classes.jar"
(cd "$out/dex" && zip -q -0 ../base.apk classes.dex)
"$tools/zipalign" -f -p 4 "$out/base.apk" "$out/launcher.apk"
"$tools/aapt" dump badging "$out/launcher.apk"
cp "$tools/lib/apksigner.jar" "$out/apksigner.jar"
