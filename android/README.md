# ProxiTalk Android — Android 13 test target

The selected product direction is hybrid: internet delivery when available and native BLE relay when offline. **Android 13 (API 33) is the first physical test target.** Web-to-Android online text delivery has been observed and acknowledged. The native app now includes an opt-in foreground BLE discovery prototype; this is not yet a message transport.

## Current Android build

- `MainActivity.java` serves bundled web assets from `https://appassets.androidplatform.net`, restricts navigation to the bundled app, and accepts the narrow Supabase PKCE callback.
- `BleMeshService.java` starts only after the user opts in, requests the Android BLE permissions, advertises/scans a ProxiTalk service UUID at low power, and displays an ongoing foreground notification. It exposes an anonymous count of recently seen ProxiTalk BLE advertisers; no device addresses or names are sent to JavaScript.
- BLE discovery has no GATT connection, packet transfer, message delivery, background store-and-forward, or cloud fallback yet. Do not describe it as offline messaging.
- `AndroidManifest.xml` declares Android 12+ BLE permissions, the connected-device foreground service and notifications. `allowBackup` remains disabled because the device key is non-exportable and cannot currently be recovered.
- `npm run build:android` builds the web app and copies it into ignored `android/app/src/main/assets/www/` assets.
- `.github/workflows/android-debug-apk.yml` builds a sideloadable debug APK through CI. It is not Play Store/release signed.

## BLE discovery test

1. Build and install a compatible test APK on two real Android devices with BLE support.
2. Sign in to real accounts, confirm each profile/key remains present, then open **Nearby discovery (Android)** in the map panel on both devices.
3. Grant the requested Nearby devices permissions and keep both apps in the foreground for the first test. The Android ongoing notification should say discovery is on; the panel should show a peer count after scanning.
4. Turn discovery off in the panel and verify the notification stops. Test permission denial, Bluetooth off, and a device without BLE.
5. Discovery is the only behavior tested here: no text or encrypted payload moves between the devices yet.

## Key and APK update safety

Each authenticated device has its own non-exportable private key in the app's local WebView storage. Clearing app data or uninstalling the app destroys access to that key. Do not replace/uninstall the user's installed APK until an update-signing/data-migration plan has been verified. Test builds may need a separate test profile; never use demo identities or seed fake conversations.

## Next native milestones

1. Add a reviewed packet format with recipient IDs, expiry, hop limits, unique IDs, and app-layer recipient-key encryption.
2. Implement authenticated GATT packet exchange and bounded fragmentation/reassembly.
3. Add local encrypted store-and-forward, deduplication, and recipient acknowledgements without losing drafts.
4. Test online fallback, permission denial, interrupted transfers, duplicate/reordered frames, background/force-stop, and battery behavior on two Android 13 devices.
5. Obtain a threat-model/security review before describing offline relay as usable.

## Build the test APK

You do not install Android Studio on the phone. After pushing a change, the GitHub Actions **Build ProxiTalk Android test APK** workflow creates `proxitalk-android-debug-apk`. Download/extract the artifact and sideload the APK only when the update path is safe for the device-bound key. For local development on a computer, run `npm run build:android`, then open `android/` in Android Studio with JDK 17 and Android SDK 35 installed.
