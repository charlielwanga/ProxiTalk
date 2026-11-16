# ProxiTalk Android — Android 13 test target

The selected product direction is hybrid: internet delivery when available and native BLE relay when offline. **Android 13 (API 33) is the current physical test target.** The project now has a minimal Android application module and secure WebView origin/deep-link path, but it still has no BLE implementation and has not been compiled or tested on a device.

## What is scaffolded

- `app/build.gradle`: Android app module, min SDK 24, compile/target SDK 35, Java 17, AndroidX WebKit.
- `MainActivity.java`: serves bundled web assets from `https://appassets.androidplatform.net`, restricts navigation to the bundled app, denies WebView camera/microphone/BT permissions, and accepts a narrowly validated Supabase PKCE callback.
- `AndroidManifest.xml`: internet access, Bluetooth permission declarations, backup disabled, cleartext disabled, and the `com.proxitalk.app://auth/callback` intent filter.
- `npm run build:android`: builds the web app and copies the static bundle into the ignored `android/app/src/main/assets/www/` directory.
- Supabase Auth redirect allow-list includes the app callback URI. The web app uses the native callback only when the fixed `ProxiTalkNative.getAuthRedirectUrl()` bridge is present.

## Still not implemented / verified

- BLE advertising, scanning, GATT transfer, fragmentation, store-and-forward, deduplication, acknowledgements, background relaying, or an Android foreground service. Manifest permissions are declarations only; there is no runtime BLE permission flow yet.
- iOS app/transport; Android 13 is the only device target confirmed so far.
- Native build/device verification. The workspace has no Java, Gradle, or Android SDK, and no Gradle wrapper. A GitHub Actions workflow installs JDK 17, Gradle 8.7, and Android SDK 35 to build a debug APK after this branch is pushed (or via manual workflow dispatch). That workflow has not yet run. The APK will be a sideloadable test build, not a Play Store/release-signed build.
- Real Android WebView verification of Supabase CORS, IndexedDB/Web Crypto persistence, email app handoff, and PKCE return-to-app. Do not assume native sign-in works until this test passes.
- Release signing, app icon, foreground-service policy, battery behavior, store privacy declarations, and accessibility/device validation.

## Get a test APK without Android Studio on the phone

You do not install Android Studio on the phone. After the branch is pushed, open the repository's **Actions** tab, select **Build ProxiTalk Android test APK**, and download the `proxitalk-android-debug-apk` artifact from a successful run. Extract the ZIP on the Android 13 phone and install the APK; Android may ask you to allow installs from the browser/file manager. This is a debug test APK, not a release-signed store build. The workflow can also be started with `workflow_dispatch`.

For local development on a computer, run `npm run build:android`, then open `android/` in Android Studio with JDK 17 and Android SDK 35 installed. The web assets are generated and ignored by Git; rerun `npm run build:android` after web changes.

## Next Android 13 acceptance tests

1. Install on two real Android 13 devices. Create two real email accounts after production SMTP is configured; do not use seeded/demo users.
2. Complete magic-link sign-in from the email app and verify the PKCE callback opens the same app/profile. Test cancel, expired link, and wrong-app handling.
3. Verify profile keys survive app restart; verify signed-in history is locally encrypted; test app-data clearing and document the no-recovery behavior.
4. Only after the radio protocol and BLE runtime service exist: test permission granted/denied, airplane mode, foreground/background/force-stop, interrupted transfer, duplicates/reordering, expiry, battery impact, and cloud fallback.
5. Review the protocol and native threat model before describing offline mesh as usable.
