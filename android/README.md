# ProxiTalk — Android APK Build

This folder wraps the ProxiTalk web app in a native Android shell (WebView + Bluetooth permissions) so it can be built into an APK and published.

## What's here

| File | Purpose |
|---|---|
| `AndroidManifest.xml` | App manifest — Bluetooth, location (required for BLE scanning), internet (gateway sync) permissions |
| `MainActivity.java` | Native WebView host — loads the bundled web app, enables JS, file upload, mic |
| `build.gradle` | Gradle build config (compile SDK 34, min SDK 24) |
| `settings.gradle` | Gradle settings |

## Build the APK

**Option A — Android Studio (easiest)**
1. Install [Android Studio](https://developer.android.com/studio).
2. Open this `android/` folder as a project.
3. Copy the web app files (`index.html`, `css/`, `js/`, `manifest.json`, `sw.js`) into `android/app/src/main/assets/www/`.
4. Run ▶ on a device, or **Build → Build APK(s)**.

**Option B — Command line**
```bash
cd android
./gradlew assembleDebug
# APK at: app/build/outputs/apk/debug/app-debug.apk
```

## Permissions explained

- `BLUETOOTH` / `BLUETOOTH_ADMIN` / `BLUETOOTH_CONNECT` — BLE mesh discovery & relay
- `ACCESS_FINE_LOCATION` — Android requires location permission for BLE scanning
- `INTERNET` / `ACCESS_NETWORK_STATE` — gateway cloud sync
- `RECORD_AUDIO` — voice notes
- `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` — media sharing

## Next step: real BLE mesh

The web app currently *simulates* the mesh (virtual nodes + canvas visualiser). To make phones physically relay to each other:

1. Add the [Capacitor Bluetooth LE plugin](https://github.com/capacitor-community/bluetooth-le) or write a native Kotlin BLE mesh service in `MainActivity`.
2. Replace `MeshEngine.send()` in `js/mesh.js` with a bridge call: `window.ProxiTalkNative.sendPacket(json)`.
3. Advertise a ProxiTalk service UUID (`0000FEAA-…`) so nearby phones discover each other automatically.

The packet format (ID, TTL, hop path, ciphertext) is already defined in `js/mesh.js` — the native layer just transports it.
