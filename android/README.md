# ProxiTalk Android — Android 13 test target

The selected product direction is hybrid: internet delivery when available and native BLE handoff when offline. **Android 13 (API 33) is the first physical test target.** The app includes beta one-to-one WebRTC voice/video calls for saved contacts and an opt-in foreground BLE/GATT text path. Calls and BLE still require physical-device testing.

## Current Android build

- `MainActivity.java` serves bundled web assets from `https://appassets.androidplatform.net`, restricts navigation to the bundled app, and accepts the narrow Supabase PKCE callback used by email and Google sign-in. Microphone/camera WebView permission requests are limited to this app origin and require Android runtime permission.
- `BleMeshService.java` starts only after the user opts in, requests Android BLE permissions, advertises/scans at low power, and displays an ongoing foreground notification. It exposes only an anonymous peer count; device addresses/names stay native.
- The GATT prototype accepts bounded, fragmented JSON envelopes that contain only recipient-key-encrypted ciphertext plus routing metadata. It rejects plaintext `text`/`body` fields and expired packets.
- This is still an unauthenticated, one-hop carrier experiment: no sender identity proof, chat receive/send integration, recipient delivery receipt, durable storage, relay, or cloud fallback. Do not describe it as offline messaging.
- `AndroidManifest.xml` declares Android 12+ BLE permissions, the connected-device foreground service and notifications. `allowBackup` remains disabled because the device key is non-exportable and cannot currently be recovered.
- `npm run build:android` builds the web app and copies it into ignored `android/app/src/main/assets/www/` assets.
- Calls use WebRTC audio/video with direct peer-to-peer DTLS-SRTP media. Supabase stores only short-lived, encrypted-and-signed SDP/ICE signaling rows, protected by participant RLS. Calls are foreground-only, need both apps online/open, use public STUN only, and have no TURN relay, push ringing, or physical-device acceptance test. Some mobile networks will fail to connect.
- The gold-and-black ProxiTalk mark is used for Android launcher icons and the web/PWA brand. `versionCode` is incremented for each APK build.
- `.github/workflows/android-debug-apk.yml` builds a sideloadable debug APK through CI as artifact `proxitalk-android-v1.2.0-beta1` (30-day retention). It is not Play Store/release signed. Android updates require the same signing certificate; the CI debug keystore is not a durable release key, so compatibility with APKs from older runs must be verified before updating an installed copy.

## Calls (beta validation)

1. Build/install the APK on two real Android devices, sign into two different accounts, and add each account as a saved contact. Keep both apps open and online.
2. Start an audio call first; approve the microphone permission on each device. Then test video and approve camera permission only if requested.
3. Confirm incoming ringing, accept/decline, mute, camera toggle, hang up, missed-call timeout, permission denial, Bluetooth off, Wi-Fi/mobile-network changes, and sign-out during a call.
4. The call path requires a working direct ICE route. The project has STUN but no TURN server, so carrier NATs/firewalls may prevent a call. It has no push notifications or background ringing. Do not rely on calls for emergency use.
5. Supabase sees participant IDs, call IDs, signal kinds and timing, but signal payloads are encrypted to the recipient device and signed with the sender directory key. Peer-to-peer network addresses may be exposed to the other caller. This implementation has not had independent security review.

## BLE/GATT carrier validation

1. Use two real Android devices with BLE support and compatible test APKs. Protect existing device-bound keys; do not uninstall/reinstall without a verified update path.
2. Sign in to real accounts and confirm profile/key state before enabling **Nearby BLE (Android)** on both devices.
3. Grant the requested Nearby devices permissions. Keep both apps open for the first test; confirm the ongoing notification, anonymous peer count, and GATT connection count.
4. The transport bridge exposes `sendBlePacket`/`drainBlePackets` for encrypted-envelope testing. No chat messages are integrated yet. Test invalid/expired/plaintext payload rejection, frame reassembly, permission denial, Bluetooth off, and disconnects.
5. A GATT write is only a radio-hop transfer, not proof of recipient decryption or delivery. Sender authentication, end-to-end receipts, durable store-and-forward, and multi-hop routing remain unimplemented.

## Key and APK update safety

Each authenticated device has its own non-exportable private key in the app's local WebView storage. Clearing app data or uninstalling the app destroys access to that key. Do not replace/uninstall the user's installed APK until an update-signing/data-migration plan has been verified. Test builds may need a separate test profile; never use demo identities or seed fake conversations.

## Next native milestones

1. Review sender authentication that works offline; recipient encryption alone does not prevent sender spoofing.
2. Wire verified packet send/receive into chat without treating GATT writes as delivered messages.
3. Add authenticated recipient acknowledgements, deduplication, bounded expiry, and encrypted durable store-and-forward.
4. Test permission denial, interrupted/reordered frames, force-stop/background, battery behavior, and online fallback on two Android 13 devices.
5. Obtain a threat-model/security review before describing offline relay as usable.

## Build the test APK

You do not install Android Studio on the phone. After pushing a change, the GitHub Actions **Build ProxiTalk Android test APK** workflow creates `proxitalk-android-debug-apk`. Download/extract the artifact and sideload the APK only when the update path is safe for the device-bound key. For local development on a computer, run `npm run build:android`, then open `android/` in Android Studio with JDK 17 and Android SDK 35 installed.
